# Example: full RAG pipeline over Snowflake

**Use when** the user wants semantic / hybrid search over a Snowflake
table. Most common scenario: product catalogs, knowledge bases, FAQ
data sitting in a Snowflake warehouse the user wants to RAG over.

## What this deploys

End-to-end:

```
Snowflake table → DataStream → DLO → DMO → Mapping → SearchIndex
```

5 resources, federated (zero-copy — data stays in Snowflake, queried
on demand).

## What the user provides

- `targetOrg`.
- Snowflake account URL, user, warehouse, region; private key path.
- Source table coordinates (`database.schema.object`).
- Source-table column list with types and which is the PK.
- DMO field set (almost always parallels the Snowflake columns).
- Field mappings (DLO column → DMO field). Often 1:1 with renames.
- Which DMO fields to chunk for SearchIndex (typically long-text
  description columns).
- Optional: which fields to use as decorators (prepended onto chunks
  for context, e.g. Title, Subject).

## What's defaulted

- `refreshMode: "TOTAL_REPLACE"` on the DataStream. Switch to
  `"INCREMENTAL"` with `incrementalColumn` if the table has a
  monotonically-increasing column (timestamp or version).
- DMO `category: "Other"`.
- SearchIndex `searchType: "HYBRID"`,
  `processingType: "NEAR_REALTIME"` — current best defaults for
  Agentforce RAG.
- Vector embedding: `e5_large_v2` + HNSW + COSINE — Data Cloud
  default. Don't change unless the user asks.
- `vectorRelatedFields`: source DMO PK + `Category1` + `ProductSKU`
  in this example. Add filterable fields the user might want to
  filter retrieval on.

## Adapt this

Three places to update:

1. **The `snowflake.fields` list** on the DataStream — these are the
   *Snowflake column names* (Snowflake uppercases unquoted identifiers,
   so column names are typically UPPERCASE).
2. **The `DMO` `fields` list** — these are the user's friendly DMO
   field names. Convention: CamelCase, no `__c` suffix (afd360 adds
   it).
3. **The `Mapping.fieldMappings`** — pairs of DLO column (UPPERCASE +
   `__c`) → DMO field (CamelCase + `__c`). The platform appends `__c`
   to both sides, so authored entries always include the suffix.

The example here uses an NTO Products schema (Id, Name, Description,
LongDescription, etc.) as a representative shape. Replace the field
lists with the user's actual columns; the structure stays the same.

## SearchIndex notes

The example chunks `LongDescription__c` and `Description__c` and
prepends `Name__c` onto each chunk. This is the aporg KA_Knowledge
shape and works well for retrieval. Adapt the chunked field set to
whatever long-text the user wants searchable; keep the
prepend-decorator pattern on a Title/Name-equivalent field for
context.

## Patience note

A Snowflake-backed SearchIndex on a freshly-mapped DMO takes ~10–15
minutes to reach `runtimeStatus = READY` the first time. afd360's
default poll budget is 15 min. If the deploy times out, re-running
`deploy` adopts the now-READY index from the org via `lookupByProps`.
