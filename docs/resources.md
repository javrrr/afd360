# Resource reference

Every afd360 resource is a TypeScript class in `src/resources/`. This page
summarizes the authored props, defaults, and the operational quirks each
resource codifies. For anything below marked **quirk X**, see
[`PLAN.md` Appendix A](../PLAN.md#appendix-a--operational-quirks-hard-won-from-tdc--afd360-training).

Each construct's first argument is its parent `Stack`; the second is a
logical id unique within the stack; the third is the props object.

---

## Connection

Source: [`src/resources/connection.ts`](../src/resources/connection.ts)

```ts
new Connection(stack, "DocsS3", {
  connectorType: "AwsS3",       // AwsS3 | IngestApi | Snowflake | AzureBlob | Databricks | SalesforceDotCom
  label: "Docs S3",
  name: "DocsS3",                // optional; defaults to logical id
  method: "Ingress",             // Data Connection family only; Ingress (default) | Egress
  credentials: {                 // Data Connection family only
    authenticationOption: "accessKeyAndSecret",
    accessKey: "${env.AWS_ACCESS_KEY}",
    accessSecret: "${env.AWS_ACCESS_SECRET}",
  },
  parameters: {                  // Data Connection family only
    bucketName: "my-bucket",
    parentDirectory: "/",
  },
  schema: { /* IngestApi only — see below */ },
});
```

- Passes `connectorType` verbatim; wrong casing yields
  `ILLEGAL_QUERY_PARAMETER_VALUE` from the API — afd360 doesn't maintain a
  casing registry.
- `credentials` / `parameters` keys split by the connector's `secure` flag;
  wrong bucket silently drops the value and the create fails with
  `"required, but missed"`.
- Snowflake `privateKey` wants a single-line base64 string with PEM headers
  stripped — use the `${pem:PATH}` substitution token to preload.
- IngestApi connection `name` is rewritten by the platform to
  `<label>_<uuid>` on create; afd360 keys state on the rewritten name so
  `datasource` references still resolve.

## ConnectionSchema

Source: [`src/resources/connection-schema.ts`](../src/resources/connection-schema.ts)

Materialized inline from a `Connection({ ..., schema: { ... } })` prop when
`connectorType === "IngestApi"`. Not a standalone construct in v1.

```ts
new Connection(stack, "DocsIngest", {
  connectorType: "IngestApi",
  label: "Docs",
  schema: {
    label: "KnowledgeBase",
    name: "KnowledgeBase",       // optional; defaults to logical id
    fields: [
      { name: "Id", dataType: "Text" },
      { name: "Body", dataType: "Text" },
    ],
  },
});
```

- `availabilityStatus` readiness accepts both `"Available"` and `"In Use"`
  (the latter once a DataStream references it).
- Schema drift rebuilds the schema itself — and cascades to DataStream,
  DLO, Mapping, and any SearchIndex downstream. `afd360 diff` flags this.

## DataStream

Source: [`src/resources/data-stream.ts`](../src/resources/data-stream.ts)

```ts
new DataStream(stack, "DocsStream", {
  connection: conn,              // Connection construct reference (auto-wires dependsOn)
  sourceObject: "articles",       // schema object name (IngestApi) / stable id (AwsS3)
  name: "DocsStream",             // optional; defaults to logical id
  label: "Articles",
  category: "Other",              // Engagement | Profile | Other
  refreshMode: "UPSERT",          // UPSERT | REPLACE | APPEND
  primaryKey: { name: "Id", dataType: "Text" },
  eventDateTimeFieldName: "ts",   // required when category is Engagement
  // AwsS3 only — see below
  s3: {
    fileType: "CSV",              // CSV | PARQUET
    fileName: "articles.csv",
    importDirectory: "docs",
    areHeadersIncludedInFile: "true",
    fields: [
      { name: "Id", dataType: "Text", isPrimaryKey: true },
      { name: "Body", dataType: "Text" },
    ],
  },
});
```

- **Quirk A1:** "Illegal argument" on create is transient schema-provisioning
  lag; afd360 retries 6 × 15s.
- **Quirk A2:** status values are UPPERCASE; ready = `ACTIVE`. Default
  poll window is 5 min.
- **Quirk A4:** IngestApi streams can self-transition `PROCESSING → ERROR`
  without ingestion traffic. Connect API has no retry action — recovery is
  delete+recreate. `isFailed(ERROR)` forces a recreate even when the hash
  matches.
- **Quirk D2:** `delete` with `shouldDeleteDataLakeObject: true` sometimes
  returns 204 but silently leaves the DLO behind; afd360 verifies and
  cleans up orphan DLOs explicitly.
- For AwsS3: source fields use literal CSV header names (spaces allowed);
  DLO names substitute underscores. Exactly one field must have
  `isPrimaryKey: true`.

## DMO

Source: [`src/resources/dmo.ts`](../src/resources/dmo.ts)

```ts
new DMO(stack, "Articles", {
  name: "Articles",               // optional; __dlm suffix appended by platform
  label: "Articles",
  category: "Other",              // Other | Engagement | Profile
  dataSpace: "default",
  fields: [
    { name: "Id", label: "Id", dataType: "Text", isPrimaryKey: true },
    { name: "Body", label: "Body", dataType: "Text" },
  ],
});
```

- **Quirk B1:** GET historically returned 500 with body "not found"; the
  live API now returns a clean 404. afd360 handles both.
- **Quirk B2:** `isReady` polls until `dataSpaceName` is populated
  (~90s typical) — without this, downstream SearchIndex creation 400s.
- **Quirk B3:** DMO delete cascades to Mapping server-side; Mapping.delete
  is a no-op.
- **Quirk B5:** field-add PATCH requires `dataType` (not `type`) and
  `isDynamicLookup: false`; both mandatory, neither in the OpenAPI spec.
  v1 does not implement PATCH — hash drift triggers delete-and-recreate.

## Mapping

Source: [`src/resources/mapping.ts`](../src/resources/mapping.ts)

```ts
new Mapping(stack, "ArticlesMapping", {
  source: stream,                 // DataStream construct (provides the DLO)
  target: dmo,                    // DMO construct
  fieldMappings: [
    { source: "Id__c", target: "Id__c" },
    { source: "Body__c", target: "Body__c" },
  ],
});
```

- **Quirk B4:** `createMappings` throws `DUPLICATE_DLO_TO_DMO_MAPPING` if
  the mapping already exists — swallowed as idempotent success.
- **Quirk B3:** delete is a no-op — DMO cascade handles it.

## Relationship

Source: [`src/resources/relationship.ts`](../src/resources/relationship.ts)

```ts
new Relationship(stack, "OrderAccount", {
  source: orderDmo,               // DMO construct
  sourceField: "AccountId",       // __c appended if missing
  target: accountDmo,             // DMO construct OR dev-name string (e.g. "ssot__Account__dlm")
  targetField: "Id",
  cardinality: "ManyToOne",       // ManyToOne | OneToOne
  relationshipOwner: "DataCloud", // DataCloud | Sobject
});
```

- **Quirk E1 (resolved):** the Connect API works for all DMO pairs that have
  mappings — not restricted to custom↔custom. The payload uses
  `relationshipOwner` (not the docs' `owner`); no `creationType` field.
- Both source and target DMOs must already have DLO→DMO mappings, or the
  API rejects with `"No ObjectSourceTargetMaps were found"`.

## CalculatedInsight

Source: [`src/resources/calculated-insight.ts`](../src/resources/calculated-insight.ts)

```ts
new CalculatedInsight(stack, "ProductCount", {
  name: "ProductCount",           // optional; __cio appended by platform
  displayName: "Product Count",
  expression: `SELECT COUNT(NTOProduct__dlm.Id__c) AS c__c FROM NTOProduct__dlm`,
  definitionType: "CALCULATED_METRIC",
  publishScheduleInterval: "Six", // NotScheduled | SystemManaged | One | Six | Twelve | TwentyFour | ...
  publishScheduleStartDateTime: "2027-01-01T00:00:00Z", // future-dated
  dependsOn: [productDmo],        // afd360 can't statically parse SQL for deps
});
```

- **Slow create** — server-side work (SQL validation + schedule + dep graph)
  can exceed the SDK's 30s default timeout. afd360 bumps to 120s per call.
- **Async delete** — 204 is immediate but the record sits at
  `status = DELETING` for minutes. `lookupByProps` treats DELETING as
  absent so mid-teardown deploys propose `create` rather than `adopt`.
- **Idempotency trap:** `publishScheduleStartDateTime` must be
  future-dated; default is `now + 1h`, which drifts every synth and forces
  recreate. Pin it or use `publishScheduleInterval: "NotScheduled"`.

## SearchIndex

Source: [`src/resources/search-index.ts`](../src/resources/search-index.ts)

```ts
new SearchIndex(stack, "ArticlesIdx", {
  name: "ArticlesIdx",
  label: "Articles Search",
  sourceDmo: articlesDmo,         // DMO construct OR full dev name (e.g. "ssot__KnowledgeArticleVersion__dlm")
  chunkDmoName: "ArticlesIdx_chunk",   // optional; NO __dlm suffix
  vectorDmoName: "ArticlesIdx_index",  // optional; NO __dlm suffix
  searchType: "HYBRID",           // HYBRID | VECTOR
  processingType: "NEAR_REALTIME",
  fields: [
    {
      fieldDeveloperName: "Body__c",
      decorators: [
        {
          decoratorId: "prepend",  // prepend | append
          dmoDeveloperName: "Articles__dlm",
          dmoFieldDeveloperName: "Title__c",
        },
      ],
    },
  ],
  vectorRelatedFields: [           // default: source DMO PK
    { dmoDeveloperName: "Articles__dlm", fieldDeveloperName: "Id__c" },
  ],
  vectorEmbedding: {               // defaults: e5_large_v2 + HNSW + COSINE
    embeddingModel: { id: "e5_large_v2", userValues: [/* dimension, max_token_limit */] },
    index: { id: "HNSW", userValues: [/* hnswEfConstruction, M */] },
    similarityMetric: "COSINE",
  },
});
```

- **Quirk C1:** create 400s if the source DMO isn't fully materialized;
  afd360 retries 6 × 15s on "not materialized".
- **Quirk C2:** chunk / vector DMO names must NOT end with `__dlm` — the
  platform appends it. Authoring `__dlm` throws at construct time.
- **Quirk C3:** `vectorEmbeddingRelatedFields` must be non-empty or the
  server NPEs. afd360 defaults to the source DMO's PK.
- **Quirk C6:** DELETE by Salesforce id, not developerName (name-keyed path
  404s). afd360's `idOf` returns the platform id.
- **Undocumented quirk** (afd360 discovered 2026-05-05): POST input rejects
  output-only name fields (`sourceDmoName`, `sourceDmoFieldName`,
  `relatedDmoName`, `relatedDmoFieldName`) with an opaque 500. afd360 passes
  developer names only.
- `lookupByProps` treats `400 INVALID_INPUT "was not found"` as a miss —
  the GET-by-devName path returns that instead of a 404.
- Create takes several minutes to reach `runtimeStatus = READY`; default
  poll window is 10 min.

---

## Adopt vs. create vs. recreate

When `afd360 deploy` processes a resource it picks one op per entry:

- **create** — no state entry, no live resource. Issues the create.
- **adopt** — no state entry, live resource found via `lookupByProps`.
  Writes state only; no API write for the resource itself.
- **noop** — state hash matches the authored hash. Zero API writes.
- **recreate** — state hash differs, OR the live resource is in a
  terminal-failed state (`isFailed` returns true). Deletes then creates.

v1 policy is **delete-and-recreate on any drift**. PATCH exists in the SDK
but field-level immutability across connector types made full-surface PATCH
unreliable; wait for v1.1.

## Idempotency + blast radius

`afd360 diff` is a read-only preview; `deploy` re-computes ops as it walks
the DAG (so parents' writes update children's views of the deployed
state). When a recreate cascades to 2+ downstream resources, `deploy`
halts for an interactive y/N confirmation — pass `--force` in CI.
