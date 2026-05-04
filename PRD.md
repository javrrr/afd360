# afd360 — Agentforce Data 360 SDK

**Status:** Draft v1 · **Date:** 2026-05-04 · **Owner:** @javrrr

---

## 1. Problem

Deploying a Data 360 configuration (connectors, data streams, DMOs, mappings, relationships, search indexes, etc.) to a Salesforce org today requires one of three painful paths:

1. **Clicks in Setup UI** — not repeatable, not reviewable, not portable across orgs.
2. **`sf project deploy` with a `package.xml`** — works for a subset of metadata types, but Data 360 has asymmetric coverage: `FieldSrcTrgtRelationship` is Metadata-API-only, Data Graphs / Identity Resolutions / Search Indexes / Activations are Connect-API-only, and several types have broken shapes in Metadata API (escaped-JSON `builderExpression` for calculated insights, masked credentials on `MktDataConnection`, etc.).
3. **Custom scripts** — every engagement ends up with a bespoke `provision.ts` that hand-codes create/poll/retry for each resource. We've done this three times now (`tdc`, `afd360-training`, `sfdk`) and keep rebuilding the same scaffolding.

There is no tool that lets someone declare *"I want these Data 360 resources in this org, in this shape"* and have it happen idempotently.

## 2. Goal

Ship an SDK — **afd360** — that provides a **CDK/Serverless-Framework-class experience** for deploying Data 360 configurations from a declarative manifest. The user writes a manifest, runs `afd360 deploy`, and the tool figures out what to create, update, or leave alone — routing each resource to the correct API surface (Connect vs Metadata) under the hood.

**Specific success criterion:** a manifest expressing an Agentforce RAG pipeline — *ingestion connector → data stream → DLO → DMO → mapping → search index* — can be authored once and deployed to the `jaygentforce` org, and re-running `deploy` is a no-op.

## 3. Non-Goals (v1)

- **Salesforce Core metadata** (Apex, LWC, flows, profiles). Use `sf project deploy` for those. afd360 may later orchestrate both surfaces but v1 is Data 360 only.
- **Agentforce agent / prompt / topic metadata.** Phase 2. See `docs/phase2-backlog.md` for captured-but-deferred quirks.
- **Cross-org migration with credentials.** Metadata API masks secrets; v1 requires the user to supply credentials via env-var substitution. We do not attempt to round-trip secrets.
- **CDP Ingestion API / pushing data into streams.** afd360 *provisions* the pipeline (Connection, DataStream, DMO, Mapping, SearchIndex) — it does not ingest data. Ingestion lives on the CDP Ingestion API (`*.c360a.salesforce.com`), which has its own auth flow (SF token → CDP token exchange via `/services/a360/token`), separate rate limits, and is typically driven by customer pipelines (ETL, Lambda, MuleSoft). Deferred to a possible companion SDK (`afd360-ingest`) or future afd360 phase. Captured in `docs/phase2-backlog.md`.
- **Connected App provisioning.** Required for OAuth flows into the Ingestion API, but not for the provisioning surface afd360 covers in v1. Deferred alongside ingestion.
- **GUI / web dashboard.** CLI + SDK only.
- **Full drift detection.** v1 detects "exists / doesn't exist / hash changed" but does not do a field-by-field three-way merge with unmanaged UI edits.
- **Rollback on deploy failure.** v1 halts on error and leaves partial state; the next `deploy` retries from where it left off (idempotency handles this).

## 4. Users

Primary: **Salesforce SEs and solution architects** building Agentforce RAG demos, POCs, and trainings. They are technical (JS/TS literate), often work across multiple orgs, and need to reset / rebuild environments frequently. They have `sf` CLI installed and an authenticated org.

Secondary: **Customer developers** productionizing a Data 360 config after a successful POC. They care more about reviewability (PR diffs) and CI/CD than about speed of iteration.

## 5. Reference experience

The model is **AWS CDK** and **Serverless Framework**, not Terraform or Pulumi:

```ts
// afd360.config.ts
import { App, Stack, Connection, DataStream, DMO, Mapping, SearchIndex } from "afd360";

const app = new App();
const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });

const conn = new Connection(stack, "DocsS3", {
  connectorType: "AwsS3",
  // credentials supplied via env at deploy time — never committed
  credentials: { accessKey: "${env.S3_ACCESS_KEY}", secret: "${env.S3_SECRET}" },
  params:      { bucket: "agentforce-demo-docs", region: "us-east-1" },
});

const stream = new DataStream(stack, "DocsStream", {
  connection: conn,
  sourceObject: "knowledge-base",
  category: "Engagement",
  refreshMode: "UPSERT",
});

const dmo = new DMO(stack, "Docs__dlm", { fields: [...] });
new Mapping(stack, "DocsMapping", { source: stream.dlo, target: dmo, fieldMappings: [...] });

new SearchIndex(stack, "DocsIdx", {
  sourceDmo: dmo,
  vectorEmbedding: { model: "OpenAIGPTLarge3", /* ... */ },
  chunkingConfiguration: { /* ... */ },
});

app.synth();
```

Then:

```
afd360 synth           # compile TS to canonical JSON plan under .afd360/
afd360 diff            # show plan vs live org
afd360 deploy          # apply; idempotent
afd360 destroy         # teardown in reverse dependency order
afd360 import          # reverse: read live org, emit a manifest stub
```

## 6. Scope of resources (v1)

Driven by Agentforce RAG requirements. **All v1 resources are served by the Connect API via `data-360-sdk`.** No Metadata API surface is needed in v1.

| Resource           | SDK namespace                     | v1 ops   | Source of truth for coverage |
|--------------------|-----------------------------------|----------|------------------------------|
| Connection         | `client.connections`              | C/R/U/D  | `data-360-sdk/src/generated/services/connections.base.ts` |
| ConnectionSchema   | `client.connections.listSchema/putSchema` | C/R (U=replace) | For `IngestApi` connector only. Registers field definitions; must reach `availabilityStatus === "Available"` before DataStream can reference it. Schema is effectively immutable — field additions require a new schema object (v1 triggers delete-and-recreate). |
| DataStream         | `client.dataStreams`              | C/R/U/D  | `data-streams.base.ts`; no built-in readiness helper — afd360 polls `get().status` |
| DLO                | implicit via DataStream           | R only   | `client.dataLakeObjects` available but typically not authored directly |
| DMO                | `client.dataModelObjects`         | C/R/U/D  | `data-model-objects.base.ts` |
| Mapping (DLO→DMO)  | `client.dataModelObjects.*Mappings` | C/R/U/D | Same file; 404-means-empty already handled in the SDK resource override at `src/resources/data-model-objects.ts` |
| Relationship       | `client.dataModelObjects.*Relationships` | C/R/U/D | Connect API sufficient for custom↔custom; custom→standard unresolved — see PLAN Appendix A quirk E1 |
| CalculatedInsight  | `client.calculatedInsights`       | C/R/U/D  | Input schema accepts `expression` (ANSI SQL) on create; no `builderExpression` in input contract |
| SearchIndex        | `client.searchIndex`              | C/R/U/D  | `search-index.base.ts`; no special async handling required |

**Out of v1 but planned for v1.1:** DataGraph, IdentityResolution, Segment, Activation, ActivationTarget, DataTransform, DataAction, DataActionTarget.

**Explicitly deferred:** DataKit (upstream `list` / `listAvailableComponents` still unstable per `data-360-sdk/src/resources/data-kits.ts`), DataCleanRoom (no customer demand), DataSpace (non-default use unusual in RAG).

## 7. Key design decisions

### 7.1 Manifest authoring = TypeScript constructs, not YAML

Following CDK, not Serverless. Reason: Data 360 resources have complex, typed shapes (LLM prompts, field mappings, nested configs). IDE autocomplete and compile-time validation are worth more than YAML's approachability. The compiled artifact (`.afd360/plan.json`) *is* declarative and tool-agnostic; YAML authoring can layer on later.

### 7.2 Two-stage pipeline: synth → apply

`synth` compiles the TS app into a canonical JSON plan (resources + dependency graph + inputs with env-vars unresolved). `apply` is a pure function of (plan, live-org-state, env) → operations. This separation makes testing trivial (snapshot the plan), lets CI validate without hitting an org, and gives us a natural place to hash-compare for idempotency.

### 7.3 Logical IDs, not API names

Manifest constructs take a **stable logical id** (e.g. `"DocsS3"`). The SDK maintains a local state file (`.afd360/state/<org>.json`) mapping `logicalId → { apiName, salesforceId, hash }`. This is the bridge across orgs and the basis for idempotent re-runs. Lesson directly imported from sfdk's `ManifestDocument` design.

### 7.4 Resources self-declare how to create/update/poll

Each resource type implements a `Resource` interface:

```ts
interface Resource<Props, Output> {
  readonly type: string;
  readonly surface: "connect" | "metadata";
  read(ctx, id):         Promise<Output | null>;     // is it in the org?
  create(ctx, props):    Promise<Output>;            // POST
  update(ctx, id, diff): Promise<Output>;            // PATCH / PUT
  delete(ctx, id):       Promise<void>;
  isReady?(ctx, output): Promise<boolean>;           // for async resources
  hash(props):           string;                     // for drift detection
}
```

No more hardcoded `DEPLOY_GROUPS` arrays (sfdk's mistake). No more ad-hoc polling in `provision/index.ts` (tdc's pattern, but scattered).

### 7.5 Dependency graph is topological, not phased

Resources declare `dependsOn` via construct references (`stream.connection`). Deploy walks the DAG in topological order; destroy walks in reverse. No hardcoded phases. This handles the 11-layer dependency chain from sdk-design.md cleanly and lets us add new resource types without touching an ordering table.

### 7.6 Auth = sf CLI session first, OAuth2 later

v1 resolves auth via `sf org display --target-org <alias> --json`, grabbing the access token + instance URL. Matches `udlo-notifier`'s approach and avoids forcing OAuth setup on SEs. `OAuth2Auth` support from `data-360-sdk` can be exposed in v1.1 for CI pipelines.

### 7.7 `data-360-sdk` is the transport; afd360 does not re-wrap it

`data-360-sdk` (v0.2.8+) is a hard runtime dependency. It owns:

- Typed request/response shapes generated from the Connect OpenAPI spec
- Auth (static token / refreshable token / OAuth2 client credentials)
- Retry with exponential backoff + `Retry-After` respect
- Pagination (`list`, `listAll`, `paginate`, `collectAll`)
- Resource-override patches for known upstream API quirks (e.g. `listMappings` 404-is-empty handled internally at `data-360-sdk/src/resources/data-model-objects.ts`; `dataGraphs.list` synthesized from `getMetadata`)
- JSDoc-level documentation of remaining deviations (connector-type casing, `listSchema` partial coverage, identity-resolution id-vs-name) that are inherent to the Connect API itself

**afd360 does not re-implement, mirror, or shadow any of the above.** We call `data-360-sdk` methods directly from inside each `Resource` implementation. If a new API quirk surfaces, we file it against `data-360-sdk` and fix it there — afd360 should not grow a parallel deviations layer.

What afd360 adds on top:

- Declarative model (App / Stack / Construct / Resource interface)
- Topological planning + idempotent apply
- Per-resource readiness polling (DataStream in particular — SDK has no `waitForReady`)
- State file for name↔id tracking across runs
- CLI (`synth`, `diff`, `deploy`, `destroy`, `import`)

### 7.8 Namespace filtering: opt-in for standard prefixes

By default, afd360 ignores resources with managed prefixes (`ssot__*`, `cdp_crm_dk1__*`, etc.) during `import` and `diff`. Users can opt in per-resource-type. This keeps the state file manageable (aporg found 3,778 standard DMO relationships alone).

## 8. State file format

```json
{
  "stackName": "RagDemo",
  "targetOrg": "jaygentforce",
  "lastDeployedAt": "2026-05-04T21:30:00Z",
  "resources": {
    "DocsS3": {
      "type": "Connection",
      "apiName": "DocsS3",
      "salesforceId": "0sH...",
      "hash": "sha256:...",
      "createdAt": "..."
    }
  }
}
```

Committed to git by default (cheap, valuable history). Secrets never written.

## 9. Explicit non-questions (resolved assumptions)

- **Manifest format** → TypeScript constructs (see 7.1).
- **v1 RAG scope** → Connection, DataStream, DMO, Mapping, Relationship, CalculatedInsight, SearchIndex (see §6).
- **Auth** → sf CLI session only in v1 (see 7.6).
- **YAML support** → not v1; plan-JSON is already tool-agnostic so layering YAML on later is cheap.
- **Rollback** → not v1; idempotent re-deploy covers the common retry case.

## 10. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Connect API quirks that affect *type shape* (response keys, input types, pagination) | Fix in `data-360-sdk`, not afd360. File upstream. |
| Connect API quirks that are *operational* (terminal statuses, transient errors, cascade semantics, missing-OpenAPI required fields) | These live in afd360. See PLAN.md Appendix A — every prior project hit them. Each resource implementation owns its assigned quirks, evidence-cited from tdc / afd360-training. |
| DMO / DataStream / SearchIndex readiness timing varies between orgs | Polling is per-resource-type, not global. Tunable `maxWait` + `pollInterval` at stack level. Defaults match tdc's proven values (quirks A2, B2, C1). |
| Users expect to author `builderExpression` for CalculatedInsights | Only `expression` (ANSI SQL) is on the Connect API input contract. afd360 accepts only `expression`. Document clearly. |
| jaygentforce org schema drifts mid-development | `afd360 import` can regenerate a manifest snapshot at any time. |
| A data source (aporg doc, SDK test, my own inference) contradicts live org behavior | Live org wins. See PLAN.md "Source confidence ladder." Open question on Relationship custom→standard FKs (quirk E1) is the immediate example. |

## 11. Success metrics for v1

1. A documented RAG-pipeline manifest deploys cleanly to `jaygentforce` on a fresh run.
2. Re-running `deploy` with no changes performs **zero** API writes.
3. `destroy` removes every resource created by afd360 without touching other org state.
4. A regression test suite runs `synth` → canonical-JSON snapshot comparison, without touching any org.
5. An integration test suite runs `deploy` → `diff` (empty) → `destroy` against a scratch org in under 15 min.

## 12. Checkpoints against jaygentforce

See `PLAN.md` §6 for the full milestone-by-milestone validation plan. Briefly:

- **C1** — `afd360 whoami` against jaygentforce. Proves auth path.
- **C2** — Deploy a single Connection. Proves sdk wrapper + state file.
- **C3** — Deploy Connection → DataStream → DLO. Proves polling.
- **C4** — Add DMO + Mapping. Proves topological deploy.
- **C5** — Add Relationship (Metadata API). Proves two-surface coordination.
- **C6** — Add SearchIndex. RAG-complete; end-to-end demo.
- **C7** — Full teardown via `destroy`. Proves reverse-graph execution.
- **C8** — Re-deploy is no-op. Proves idempotency / hashing.
