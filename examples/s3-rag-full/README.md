# Example: full RAG pipeline over S3 CSV

**Use when** the user wants semantic / hybrid search over CSV data
sitting in S3. Common: knowledge articles exported as CSV, product
catalogs from a non-Snowflake source, anything where ingest is the
right model (vs. federation).

## What this deploys

```
S3 CSV file → DataStream → DLO → DMO → Mapping → SearchIndex
```

Data is *ingested* (copied into Data Cloud's lake), not federated.
Trade-off: ingest takes longer per refresh but query latency is
lower than federated Snowflake.

## What the user provides

- `targetOrg`.
- AWS access key + secret in `.env`.
- S3 bucket name (literal in manifest), file path within bucket.
- CSV column list — literal header names. Spaces are allowed (CSV
  preserves them); afd360 substitutes underscores in DLO field names
  automatically.
- DMO field set + field mappings.

## What's defaulted

- `fileType: "CSV"` — the only file type with full afd360 support
  today.
- `areHeadersIncludedInFile: "true"` — CSV with header row.
- `refreshMode: "UPSERT"`.
- DMO `category: "Other"`.
- SearchIndex defaults same as Snowflake.

## Adapt this

The CSV `fields[]` use the literal CSV header names — don't normalize
spaces or casing. The DLO column names are derived automatically
(spaces → underscores). The Mapping `fieldMappings[]` source values
are DLO column names with `__c` appended.
