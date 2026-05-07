# Example: IngestApi stream end-to-end

**Use when** the user wants to push data into Data Cloud via the
Ingestion API. Simplest end-to-end shape — no external credentials,
no DMO/Mapping (DLO is queryable directly).

## What this deploys

- `Connection` of type `IngestApi` with an inline `ConnectionSchema`
  declaring the field set.
- `DataStream` consuming that schema.

After deploy, the user pushes records to the resulting ingest endpoint
via the Connect API:

```
POST /services/data/v66.0/ssot/ingest/sources/<connectionName>/<sourceObject>
```

## What the user provides

- `targetOrg`.
- The schema field set: name, label (optional), data type, which is
  the PK.
- The `sourceObject` name (the schema object the stream consumes —
  matches `schema.label`).

## What's defaulted

- `category: "Other"` — switch to `"Engagement"` if the records carry
  an event timestamp the user wants to surface, in which case
  `eventDateTimeFieldName` becomes required.
- `refreshMode: "UPSERT"` — upsert by primary key. Other modes
  (`REPLACE`, `INCREMENTAL`) work but UPSERT is the default for ingest.
- Schema field `label` defaults to `name` if omitted.

## Adapt this

Replace `KnowledgeBase` (the schema label) and the field set with the
user's data shape. Replace the `Title` / `Body` example fields. The
`primaryKey: { name: "Id" }` must match a field with `name: "Id"` in
the schema.
