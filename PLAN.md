# afd360 — Implementation Plan

Companion to `PRD.md`. Milestone-structured, each milestone ends with a validation checkpoint against the `jaygentforce` org.

---

## 0. Repo bootstrap (day 0, ~1h)

**What:** Stand up the project skeleton.

- `package.json` — ESM, Node 20+, deps: `data-360-sdk@^0.2.8`, `@salesforce/core` (for sf CLI session), `zod` (runtime validation of resource props), `commander` (CLI), `chalk` / `picocolors` (output), `tsup` (build), `vitest` (test)
- `tsconfig.json` — strict, NodeNext resolution
- `tsup.config.ts` — dual ESM + CJS, `sideEffects: false`
- `vitest.config.ts` — unit + integration workspaces
- Directory layout:
  ```
  src/
    cli/              # commander-based CLI entrypoints
    core/
      app.ts          # App + Stack constructs
      construct.ts    # base Resource interface
      graph.ts        # DAG: topological sort, cycle detection
      state.ts        # read/write .afd360/state/<org>.json
      env.ts          # ${env.X} substitution
      hash.ts         # canonical prop hashing
      poll.ts         # generic readiness poller (used by DataStream)
    client/
      auth.ts         # sf CLI session resolver (`sf org display --json`)
      factory.ts      # builds a data-360-sdk Data360Client from a session
    resources/        # one file per resource; calls data-360-sdk directly
      connection.ts
      data-stream.ts
      dmo.ts
      mapping.ts
      relationship.ts
      calculated-insight.ts
      search-index.ts
    index.ts          # public SDK exports
  templates/
    starter/          # `afd360 init` scaffolds this
  tests/
    unit/
    integration/      # gated behind AFD360_TEST_ORG env var
  ```

  Note there is no `surface/` tree. All v1 API calls go through `data-360-sdk`; no Metadata API deploy shim is needed.
- `.gitignore`: `node_modules`, `dist`, `.afd360/state/*.local.json` (allow committed state), `*.log`
- `README.md` stub

**Validation:** `npm run build` + `npm test` (zero tests yet, pass trivially).

---

## 1. Auth + sdk wiring (milestone 1, ~half day)

**What:** Build the minimum path to authenticated Connect API calls.

- `client/auth.ts` — `getSession(alias: string)` shells out to `sf org display --target-org <alias> --json`, returns `{ accessToken, instanceUrl }`. Cached in-memory per process.
- `client/factory.ts` — `createClient(session)` returns a configured `Data360Client` using `StaticTokenAuth` from `data-360-sdk`.
- `cli/whoami.ts` — `afd360 whoami --org <alias>` uses the client to resolve current identity (e.g. `client.connections.list({ pageSize: 1 })` as a liveness probe), prints user + org id.

### **Checkpoint C1 — auth works against jaygentforce**
```
afd360 whoami --org jaygentforce
# Expected: prints username javier.leung+jaygentforce@salesforce.com, org 00DWt00000G96PxMAJ
```

---

## 2. Core: App, Stack, Construct, Graph (milestone 2, ~1 day)

**What:** The primitives every resource builds on. No I/O yet; pure in-memory.

- `core/app.ts` — `App` (root), `Stack` (owns targetOrg), `Construct` (base class, takes `scope, id, props`).
- `core/construct.ts` — `Resource` interface (see PRD §7.4). Every resource gets a deterministic `uniqueId = stack/id`.
- `core/graph.ts` — given a set of constructs, build DAG from `dependsOn`, topological sort, detect cycles (throw with offending path).
- `core/hash.ts` — canonical-JSON-stringify + sha256. Used by `Resource.hash(props)` default impl.
- `core/env.ts` — recursively substitute `${env.X}` tokens in a props tree from `process.env`. Surface unresolved tokens with a list (sfdk pattern).
- `core/state.ts` — typed read/write for `.afd360/state/<org>.json`. Creates file if absent.

Unit tests for: graph cycle detection, env substitution, hash stability, state round-trip.

**Validation:** unit tests pass. No org interaction.

---

## 3. First resource: Connection (+ ConnectionSchema for IngestApi) (milestone 3, ~1.5 days)

**What:** Prove the full loop — author → synth → deploy → verify → destroy — with the simplest resource, plus the schema registration step that every IngestApi-based RAG demo needs.

- `resources/connection.ts` — `Connection` construct + `ConnectionResource` impl. Methods call `client.connections.create/get/patch/delete` directly. `connectorType` is passed through as authored by the user; if they get the casing wrong the Connect API will reject the call with a clear error (same behavior `data-360-sdk` documents in its JSDoc). We do not maintain a casing registry in afd360.
- `resources/connection-schema.ts` — only applies when `connectorType === "IngestApi"`. Calls `client.connections.listSchema(connectionId)` to detect existence, `putSchema(connectionId, body)` to create. `isReady` polls until `availabilityStatus === "Available"` (tdc's pattern at `tdc/scripts/data-cloud/provision/schema.ts:12-20`). Default poll 12 × 10s = 120s.
  - Schema is effectively **immutable**: field additions require a new schema object + re-created DataStream + DLO + Mapping. Resource `hash()` change → delete-and-recreate, which `afd360 diff` will flag loudly (see milestone 9).
  - Authored as a property of Connection (`new Connection(stack, "DocsS3", { ..., schema: { name, fields: [...] } })`) so the user sees one construct; internally it materializes as a dependency edge Connection → ConnectionSchema.
  - Non-IngestApi connectors (Snowflake, SFDC, AzureBlob, etc.) skip this resource entirely.
- `cli/synth.ts` — loads `afd360.config.ts` (via `tsx`), runs `tsc --noEmit` as a type-check pre-flight, runs `app.synth()`, writes `.afd360/plan.json`.
- `cli/deploy.ts` — loads plan, reads live org for each resource, computes ops (create / update / noop), executes in topological order, updates state file.
- `cli/destroy.ts` — reverses the graph.
- `cli/diff.ts` — prints pending ops without executing.

### **Checkpoint C2 — single-resource round trip**
```
# 1. Author minimal manifest with just one S3 Connection
afd360 synth
afd360 diff       # shows 1 create
afd360 deploy     # creates it
afd360 diff       # shows 0 changes (idempotency check)
afd360 deploy     # no writes (idempotency check)
afd360 destroy    # removes it
```
Verify in jaygentforce Setup UI or via `sf data query` that the connection appears/disappears.

---

## 4. DataStream + DLO + async polling (milestone 4, ~2 days)

**What:** First async resource. Teaches the polling + retry pattern to the codebase.

- `core/poll.ts` — generic `pollUntil(check, { interval, timeout })` helper. `data-360-sdk` has no `waitForReady` — this is one of the real gaps afd360 fills.
- `core/retry.ts` — generic `retryOn(predicate, { attempts, interval, jitter, onRetry })`. Two usage modes:
  - **Baseline retry (applied to every Connect API write)**: 3 attempts, exponential backoff with jitter (500ms / 1s / 2s ± 20%), only on 5xx responses. tdc saw transient 500s across many endpoints (DMO delete, mapping delete, search index delete) that resolved on retry; this is the default-on policy so individual resources don't each reinvent it.
  - **Resource-specific retry (opt-in per resource)**: e.g. DataStream retries "Illegal argument" for ~90s (quirk A1), SearchIndex retries "DMO not materialized" for ~90s (quirk C1). Expressed via predicate: `retryOn(e => matches(e, "Illegal argument"), { attempts: 6, interval: 15_000 })`.
  - **Non-retryable conditions override**: quirks like `DUPLICATE_DLO_TO_DMO_MAPPING` (quirk B4) are swallowed as idempotent success, not retried.
  - **Logging + hooks**:
    - Every retry attempt logs at `DEBUG` level (visible with `afd360 deploy --verbose` or `LOG_LEVEL=debug`) so a user can see the retry happening without adding bespoke logging per resource.
    - `onRetry?(err, attempt, totalAttempts)` callback lets each resource surface a clean CLI status line (e.g. `DocsStream — retrying (attempt 2/6): Illegal argument`) without each call-site reimplementing the formatting. The CLI deploy runner wires a default `onRetry` that prints to stderr with chalk; resources pass it through unless they want a custom message.
- `resources/data-stream.ts` — depends on Connection.
  - **`create` wraps in retry** for transient "Illegal argument" errors (quirk A1): 6 × 15s.
  - **`isReady` polls until `status === "Active"`** (quirk A2 — NOT `RUNNING`). Poll interval 2s, max 60s by default (tdc's proven values); configurable at stack level.
  - Terminal ready implies DLO is created but **not necessarily discoverable for mapping** — downstream Mapping does its own readiness check (see Milestone 5).
- DLO representation: not a separate construct in v1 (created implicitly). Stream exposes `.dlo` reference for downstream Mapping.
- Wire polling into deploy runner: after `create`, call `isReady` in a loop before marking the node complete.

Quirks codified: **A1, A2** (see Appendix A).

### **Checkpoint C3 — async resource deploys and polls correctly**
```
# Manifest: Connection + DataStream
afd360 deploy --org jaygentforce
# Expected: connection created, then stream, then polls until ready (~1-2 min typical)
afd360 destroy
```

---

## 5. DMO + Mapping (milestone 5, ~2 days)

**What:** Cross-resource references without Salesforce IDs; field-level validation; first resource with real operational quirks.

- `resources/dmo.ts`:
  - `read` calls `client.dataModelObjects.get(name)` but **must handle 500 "DMO not found" as "doesn't exist"** (quirk B1). Match on error body, not status code.
  - `create` calls `client.dataModelObjects.create(props)`; custom fields only.
  - `isReady` polls until the DMO's `dataSpaceName` field is populated (quirk B2). Without this, downstream SearchIndex creation will 400. Poll interval 5s, max 90s.
  - `delete` cascades to mappings server-side; no separate mapping delete needed (quirk B3).
- `resources/mapping.ts`:
  - source = DataStream's DLO, target = DMO. `fieldMappings: [{ source, target }]`.
  - Before calling `createMappings`, wait for the source DLO to be discoverable: `client.dataLakeObjects.get()` returns fields. Can take 5–60s post-stream creation.
  - `create` **catches `DUPLICATE_DLO_TO_DMO_MAPPING` and treats as idempotent success** (quirk B4).
  - `listMappings` 404 normalization is already handled upstream in `data-360-sdk`; no wrapping needed.
  - `delete`: do not attempt. DMO cascade handles it (quirk B3). This resource's `delete` is a no-op that relies on the DMO's delete.
- Add `zod` schemas for DMO field definitions and Mapping field specs.

Quirks codified: **B1, B2, B3, B4**.

### **Checkpoint C4 — topological deploy with 4 resources**
```
# Manifest: Connection → DataStream → DMO → Mapping
afd360 deploy --org jaygentforce
# Expected ordering: conn, stream (+poll), dmo, mapping
```

---

## 6. Relationship (milestone 6, ~1.5 days — includes live validation)

**What:** DMO↔DMO foreign key resources.

**Conflicting evidence — must resolve in-milestone:**
- `data-360-sdk` exposes `client.dataModelObjects.createRelationships(dmoName, body)` at POST `/ssot/data-model-objects/{name}/relationships`. Unit test in the SDK exercises it successfully.
- **But** afd360-training (`scripts/data-cloud/ensure-dmo-relationship.ts:6-11`) found this endpoint returns opaque 500 UNKNOWN_EXCEPTION for **custom→standard** DMO FKs, and fell back to Metadata API (`FieldSrcTrgtRelationship` XML via `sf project deploy start`).
- Plausible explanation: the SDK's test only covered custom↔custom. The Connect API may genuinely be broken for custom→standard.

**Implementation strategy:**
1. **Live test first** against jaygentforce before coding: manually POST a custom→custom and a custom→standard relationship via `data-360-sdk` to confirm which cases work. Spend up to half a day here.
2. If Connect API works for all relevant cases → implement purely via `data-360-sdk` (the clean path).
3. If custom→standard is still broken → implement a dual-path resource:
   - Default: Connect API.
   - If source is a custom DMO and target is `ssot__*` or otherwise standard, render `FieldSrcTrgtRelationship` XML under `.afd360/metadata-deploy/` and shell out to `sf project deploy start`.
   - `client/metadata.ts` helper does this; kept behind a single function so the special case is localized.
4. Document whichever path is taken with a link to an issue filed against the Connect API.

- `resources/relationship.ts` — props: source DMO + field, target DMO + field, cardinality (`ManyToOne` | `OneToOne`), optional `relationshipOwner` and `dataSpaceName`.

### **Checkpoint C5 — Relationship deploys and destroys (path determined by live test)**
```
# Live verification step — do this FIRST, before writing resources/relationship.ts:
#   1. Create two custom DMOs in jaygentforce.
#   2. Try createRelationships(custom_A, { ..., targetObjectName: custom_B })  → expect success
#   3. Try createRelationships(custom_A, { ..., targetObjectName: "Account" }) → does it 500?
#   4. If (3) fails, confirm sf project deploy start with FieldSrcTrgtRelationship XML succeeds.
# Only THEN pick the implementation path.
afd360 deploy --org jaygentforce
afd360 destroy --org jaygentforce
```

---

## 7. CalculatedInsight (milestone 7, ~1 day)

**What:** Simple Connect API resource; `expression` (ANSI SQL) is the only expression field on the create/patch input contract. No `builderExpression` authoring needed — it's not on the input schema.

- `resources/calculated-insight.ts` — calls `client.calculatedInsights.create/get/patch/delete`. Accept `expression` as a required string prop.

### **Checkpoint C6.1 — CI appears, runs correctly**
```
afd360 deploy --org jaygentforce
# Expected: CI visible in Setup UI, status healthy
```

---

## 8. SearchIndex — RAG-complete (milestone 8, ~2 days)

**What:** The resource this whole project exists to deploy. Historically the most fragile.

- `resources/search-index.ts` — refs source DMO (optional chunk/vector DMOs). Props include `vectorEmbedding`, `chunkingConfiguration`, `preProcessingConfigurations`. Sensible defaults for the typical RAG-on-unstructured-docs path (OpenAI GPT-Large-3 embeddings, sentence-aware chunking, LLM-based parser).
- **Create wraps in retry** for "DMO not fully materialized" 400s (quirk C1): 6 × 15s. The DMO `isReady` check in milestone 5 reduces but does not eliminate this.
- **Validate chunk/vector DMO names do NOT have `__dlm` suffix** (quirk C2). Zod rejects props if they do — the platform appends `__dlm` itself and double-suffixed names NPE server-side.
- **Validate `vectorEmbedding.vectorEmbeddingRelatedFields` is populated** (quirk C3) — empty `{}` or `null` causes a server NPE. Required by platform but not in OpenAPI spec.
- **Validate `processingType` is set** (quirk C4) — required by platform but missing from OpenAPI.
- **Validate PK field is present in `fieldMapping`** (quirk C5) — omitted PK causes `MISSING_ARGUMENT`.
- Readiness: poll until `runtimeStatus === "READY"`.
- Delete by **ID, not developerName** (quirk C6) — the name-keyed delete path 404s.

Quirks codified: **C1–C6**.

### **Checkpoint C6 (from PRD) — full RAG pipeline deploys**
```
# Manifest: S3 Connection → DataStream → DMO → Mapping → SearchIndex
afd360 deploy --org jaygentforce
# Validate in Agentforce UI: index appears, status READY, source points at correct DMO
# Ingest a test doc through S3, run a query via Agent Builder, confirm retrieval works
```

---

## 9. Teardown + idempotency hardening (milestone 9, ~1.5 days)

**What:** Polish the two invariants that matter most.

- Reverse-topological destroy with graceful "resource-already-gone" handling (404 / 500 "not found" both = done, not error — quirks B1 + D1).
- **DataStream delete:** attempt with `shouldDeleteDataLakeObject: true`; on failure fall back to `shouldDeleteDataLakeObject: false` and clean up orphan DLO separately (quirk D2).
- **Mapping delete is a no-op** — cascaded by DMO delete (quirk B3).
- Idempotency hash: if `hash(props) === state.hash`, skip. Write tests for the no-op case.
- `afd360 diff` polish: clear output distinguishing create / update / delete / noop.
- **v1 update policy = delete-and-recreate on hash drift.** Neither prior project implemented PATCH; many fields (connector type, refreshMode, field schema) are de-facto immutable. Document this as v1.0 behavior; PATCH for mutable-only fields is v1.1 work.
- **Schema-impact diff warnings.** Drift on certain resources has large blast radius because the resource itself plus downstream dependents must be rebuilt. `diff` surfaces these prominently:
  - `ConnectionSchema` hash change → also rebuilds DataStream, DLO, Mapping(s), and any SearchIndex referencing the resulting DMO. Example diff line: `!! ConnectionSchema/DocsSchema — schema changed; this will DELETE AND RECREATE 4 downstream resources (DocsStream, DocsMapping, DocsIdx, ...). Continue? [y/N]`.
  - DMO field-set change → also rebuilds Mapping (adding a field to a DLO does not auto-propagate; quirk B6). Diff flags Mapping as implicit recreate.
  - Any schema-impact recreate requires `--force` flag or interactive confirmation to proceed. Default behavior is to halt.

Quirks codified: **D1, D2, B5, B6** (B5/B6 captured in Appendix A; their consequence is the diff-warning policy above).

### **Checkpoint C7 — clean teardown**
```
afd360 destroy --org jaygentforce
# Expected: removes resources in reverse order, state file cleared
# Verify in UI: no leftover artifacts
```

### **Checkpoint C8 — deploy is fully idempotent**
```
afd360 deploy --org jaygentforce  # fresh
afd360 deploy --org jaygentforce  # second run
# Expected: zero API writes on second run; log shows "no changes"
```

---

## 10. Import (reverse direction) (milestone 10, ~2 days)

**What:** Reading an existing org into a manifest stub. Not blocking for v1 demo but hugely useful.

- `cli/import.ts --org <alias> --out ./imported` — walk known resource types, emit TypeScript manifest scaffolds.
- Honors namespace filter (skip `ssot__*`, `cdp_crm_dk1__*`, `cdpactvstrgptnr__*` etc. by default).
- **Name normalization strategy for imported logical IDs:**
  - Many orgs (tdc-style) have suffixed names like `NTO_Products_tdd001_84d2`. Using those as logical IDs defeats the point — they're org-local and not stable across runs.
  - Import detects common suffix patterns (`_[a-z0-9]{4,}$`, `_\d+$`) and proposes a stripped logical ID. The API name is preserved in the generated state file; the logical ID becomes the clean base (e.g. `NTO_Products`).
  - `--preserve-names` flag opts out of normalization (useful when the suffix is meaningful, e.g. multi-tenant).
  - Output includes a comment block at the top of each generated file explaining any normalizations applied, so the user can review before committing.
  - Collisions during normalization (two resources stripping to the same base) cause import to halt with a clear error listing the conflicts.

No new checkpoint — validated informally by importing jaygentforce after C8.

---

## 11. Starter template + docs (milestone 11, ~half day)

- `afd360 init <dir>` copies `templates/starter/` → creates `afd360.config.ts` with a commented RAG pipeline example.
- `README.md` with quickstart.
- `docs/resources/` one page per resource type, generated from zod schemas.

---

## 12. CI + publish (milestone 12, ~half day)

- GitHub Actions: lint, typecheck, unit tests on every PR.
- Integration tests gated on `AFD360_TEST_ORG` secret.
- `npm publish` dry-run workflow.

---

## Checkpoint summary

| # | After milestone | Validates |
|---|----|-----------|
| C1 | 1 | Auth against jaygentforce |
| C2 | 3 | Single-resource deploy + state + destroy |
| C3 | 4 | Async polling |
| C4 | 5 | Topological deploy with references |
| C5 | 6 | Relationship CRUD via Connect API |
| C6 | 8 | Full RAG pipeline end-to-end |
| C7 | 9 | Clean destroy |
| C8 | 9 | Idempotency |

---

## Resolved decisions (from review 2026-05-04)

1. **Package name:** `afd360` (unscoped).
2. **TS runtime:** `tsx` for loading user `afd360.config.ts`; `tsc --noEmit` runs as a pre-flight step inside `afd360 synth` to surface type errors. Fast iteration + no lost type safety.
3. **YAML entry path:** out of v1. The compiled `plan.json` remains tool-agnostic, so a YAML loader can layer on cleanly later without re-architecting.
4. **`afd360 import`:** in v1 (milestone 10). High debugging value when iterating against jaygentforce.
5. **State file:** committed to git by default. No secrets are ever written to it; `.afd360/state/*.local.json` remains gitignored for local overrides.

---

## Rough timeline (calendar days of focused work)

- Milestones 0–3 (bootstrap → first Connection deployed): **~3 days**
- Milestones 4–6 (async polling + DMO/Mapping/Relationship, all Connect API): **~4 days**
- Milestones 7–9 (RAG complete + hardening): **~3 days**
- Milestones 10–12 (import + polish): **~3 days**

**Total: ~14 days of focused work to a shippable v1.** First milestone demo-able (C6) at ~day 11.

---

## Appendix A — Operational quirks (hard-won from tdc + afd360-training)

Each quirk below is a specific, evidence-backed behavior of the Connect API under deployment pressure. Every afd360 resource implementation **must** handle its assigned quirks. These are not suggestions; they are things both prior projects were forced to discover in production and that are not documented in OpenAPI / JSDoc.

### A — DataStream

- **A1. "Illegal argument" on create is transient.** Retry 6 × 15s (~90s total). Root cause: schema provisioning lag. Evidence: `tdc/scripts/data-cloud/provision/stream.ts:89-93`.
- **A2. Terminal ready status is `Active`, not `RUNNING` or `READY`.** Evidence: `tdc/scripts/data-cloud/provision/stream.ts:112`.

### B — DMO + Mapping

- **B1. DMO `get(name)` returns 500 with body text "DMO not found" when the DMO doesn't exist.** Not 404. Idempotency code must regex-match the error body, not rely on status code. Evidence: `afd360-training/scripts/data-cloud/ensure-dmo.ts:92-97`.
- **B2. SearchIndex 400s if DMO is not fully materialized even after `get` succeeds.** Poll until the DMO's `dataSpaceName` field is populated (~90s typical). Evidence: `tdc/scripts/data-cloud/provision/index.ts:126-163`.
- **B3. DMO mapping cannot be deleted directly — delete the target DMO and let the platform cascade.** Evidence: `tdc/scripts/data-cloud/provision/destroy.ts:35-36`.
- **B4. `createMappings` throws `DUPLICATE_DLO_TO_DMO_MAPPING` when the mapping already exists. This is an idempotent success, not a failure.** Swallow it. Evidence: `afd360-training/scripts/data-cloud/ensure-dmo.ts:64-70`.
- **B5. Adding a field to an existing DMO requires PATCH with a specific undocumented shape:** `dataType` (not `type`) and `isDynamicLookup: false` are both **mandatory** — neither is in the OpenAPI spec. Minimal reproducible call (from tdc session):
  ```
  sf api request rest --method PATCH "/services/data/v66.0/ssot/data-model-objects/NTOProduct__dlm" \
    --body '{"fields":[{"name":"ImagePath__c","label":"ImagePath","dataType":"Text","isDynamicLookup":false}]}'
  ```
  When implementing `resources/dmo.ts` PATCH, paste this into a comment in the source so the next reader sees the payload that actually works. Evidence: tdc session experience, 2026-05-04.
- **B6. Adding a new field to a DLO (via schema change) does NOT propagate to existing Mappings.** The Mapping must be recreated to include the new field. This means ConnectionSchema drift has Mapping-level blast radius; `afd360 diff` flags it (see milestone 9). Evidence: tdc session experience.

### C — SearchIndex

- **C1. Create 400s if the source DMO isn't fully materialized.** Retry 6 × 15s even when `dataSpaceName` check passes. Evidence: tdc commit `2c16ff9`.
- **C2. Chunk / vector DMO names must NOT include `__dlm` suffix.** Platform appends it; double-suffixed names NPE. Evidence: tdc commit `1806760`.
- **C3. `vectorEmbedding.vectorEmbeddingRelatedFields` is required by platform but missing from OpenAPI.** Empty `{}` or `null` causes server NPE. Evidence: tdc commit `2c16ff9`.
- **C4. `processingType` is required by platform but missing from OpenAPI.** Example valid value: `NEAR_REALTIME`.
- **C5. `fieldMapping` must explicitly include the PK field** or API rejects with `MISSING_ARGUMENT`. Evidence: tdc commit `1806760`.
- **C6. Delete search index by ID, not developerName.** Name-keyed delete 404s. Evidence: `tdc/scripts/data-cloud/provision/destroy.ts:16-25`.

### D — Teardown / cross-cutting

- **D1. Treat both 404 and 500-with-"not found" as "already gone"** during destroy. Continue the reverse-DAG walk; do not throw.
- **D2. DataStream delete with `shouldDeleteDataLakeObject: true` can fail if the DLO is still referenced.** Fall back to `shouldDeleteDataLakeObject: false` and clean up the orphan DLO after its dependents are removed. Evidence: `tdc/scripts/data-cloud/provision/destroy.ts:69-77`.

### E — Open question to resolve live (milestone 6)

- **E1. `createRelationships` via Connect API works for custom→custom but reportedly 500s for custom→standard DMO pairs.** Conflicting evidence: data-360-sdk has a passing unit test for the method; afd360-training found real-world 500s and fell back to Metadata API XML. Resolve by direct test against jaygentforce before writing `resources/relationship.ts`. See milestone 6.

---

## Source confidence ladder

When a future claim about Data 360 API behavior contradicts this plan, weigh sources in this order (highest confidence first):

1. **Direct live test against jaygentforce or another scratch org.** The only unambiguous evidence.
2. **tdc / afd360-training deployment code.** Two real projects that hit the API under load. Comments like "// retry for 90s because..." carry the weight of production incidents.
3. **data-360-sdk source.** Typed client, with some fixes baked in. But its tests may not cover every real-world case (see E1).
4. **aporg `docs/sdk-design.md`, `docs/sdk-deviations.md`, `docs/surface-matrix.md`.** Point-in-time research. Several items have been fixed upstream. Useful for framing, not for decisions.
5. **aporg `docs/metadata-shapes.md`.** Accurate for XML metadata shapes but out of scope for afd360 v1.
6. **sfdk.** Unreliable; do not cite as evidence for anything. Only mine for ideas (logical-id pattern, env substitution) that stand on their own merits.
