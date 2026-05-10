# IngestApi connector recipe

## Connection + Schema

IngestApi is the simplest connector — no external credentials, no cloud
setup. Auth is the user's `sf` CLI session. Schema goes inline on the
Connection.

```ts
new Connection(stack, "DocsIngest", {
  connectorType: "IngestApi",
  label: "Docs Ingest",
  schema: {
    name: "KnowledgeBase",
    label: "KnowledgeBase",
    fields: [
      { name: "Id",    dataType: "Text" },
      { name: "Title", dataType: "Text" },
      { name: "Body",  dataType: "Text" },
    ],
  },
});
```

### Non-obvious behaviors

- The platform **rewrites the connection name** on create (authored
  `"DocsIngest"` becomes `"Docs_Ingest_<uuid>"`). afd360 handles this
  internally — the user doesn't need to account for it.
- Field `label` on schema fields defaults to `name` if omitted. The
  platform NPEs when `label` is missing server-side; afd360 defaults it.
- Schema is effectively **immutable**. Adding a field requires a new
  schema → new DataStream → new Mapping. `afd360 diff` flags this blast
  radius.

## DataStream

IngestApi streams only need the PK field declared — the platform derives
the rest from the ConnectionSchema.

```ts
new DataStream(stack, "DocsStream", {
  connection: conn,
  sourceObject: "KnowledgeBase",    // matches schema.name or schema.label
  label: "Docs Stream",
  category: "Other",
  refreshMode: "UPSERT",
  primaryKey: { name: "Id", dataType: "Text" },
});
```

After deploy, the user pushes records via the Ingestion API:

```
POST /services/data/v66.0/ssot/ingest/sources/<connectionName>/<sourceObject>
```

## Env keys

None required — IngestApi auth is the user's `sf` CLI session.
