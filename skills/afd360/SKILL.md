---
name: afd360
description: >
  Generate and edit afd360 manifests for Salesforce Data Cloud / Agentforce
  Data 360 configurations. afd360 declares Connections, DataStreams, DMOs,
  Mappings, Relationships, CalculatedInsights, and SearchIndexes as TypeScript
  code and deploys them idempotently.
  TRIGGER when: user mentions afd360, Data Cloud configuration, data stream
  setup, search index, DMO mapping, Snowflake/S3 connection to Data Cloud,
  RAG pipeline on Salesforce data, or asks to generate an afd360.config.ts.
  DO NOT TRIGGER when: working on Apex code (use sf-apex), LWC (use sf-lwc),
  or metadata-API deployments (use sf-deploy).
license: MIT
metadata:
  version: "0.1.0"
  last_updated: "2026-05-07"
---

## Prerequisites — run these before generating a manifest

The manifest uses `import { App } from "afd360"` (ES module syntax),
which requires `"type": "module"` in `package.json` and
`node_modules/afd360/` to exist.

**Always generate files in the CURRENT working directory.** Do NOT
create subdirectories — if the user wants a `data360/` subdir, they
will `cd` into it before invoking you.

If the current directory doesn't have a `package.json` with
`"type": "module"` and afd360 installed, run this first:

```sh
npx afd360 init .
npm install
```

**Do NOT use `npm init -y` — it defaults to `"type": "commonjs"` which
breaks ES module imports. Always use `npx afd360 init .` instead.**

After init + install, the directory will contain:

```
├── package.json        ← "type": "module", afd360 as dep
├── node_modules/       ← contains afd360
├── afd360.config.ts    ← empty scaffold — you'll overwrite this
└── .env.example
```

Generate files here. Run all `npx afd360` commands from here.

## Mental model

A manifest is a TypeScript file that builds a construct tree:

```
App
└── Stack ("MyStack", { targetOrg: "my-org" })
    ├── Connection
    ├── DataStream  (depends on Connection — auto-wired)
    ├── DMO
    ├── Mapping     (depends on DataStream + DMO — auto-wired)
    └── SearchIndex (depends on DMO + Mapping — auto-wired)
```

- **Constructs reference each other by variable**, not by name string.
  Pass `connection: connVar`, not `connection: "MyConn"`. This auto-wires
  `dependsOn` and determines deploy order.
- **Secrets are `${env.X}` tokens** resolved at deploy time from `.env`.
  Never hardcode credentials in the manifest.
- **Deploys are idempotent.** Second deploy = zero API writes.
- **v1 drift policy is delete-and-recreate.** No in-place PATCH.

## Choosing what to generate

| User intent | Resources to generate |
|---|---|
| "search / RAG over data" | Connection → DataStream → DMO → Mapping → SearchIndex |
| "join / relate two DMOs" | 2× (Connection → DataStream → DMO → Mapping) + Relationship |
| "metric / aggregation" | Connection → DataStream → DMO → Mapping → CalculatedInsight |
| "ingest data into Data Cloud" | Connection → DataStream (+ DMO + Mapping if typed surface needed) |
| "set up an X connection" | Connection only |

## Connector recipes

Read the connector-specific reference for the user's source system:

- **AwsS3**: see [connector-s3.md](references/connector-s3.md)
- **Snowflake**: see [connector-snowflake.md](references/connector-snowflake.md)
- **IngestApi**: see [connector-ingestapi.md](references/connector-ingestapi.md)

## Env-var conventions

| Token | When |
|---|---|
| `${env.NAME}` | Single-line value (credentials, account IDs, regions). |
| `${file:PATH}` | File contents, verbatim. Rare. |
| `${pem:PATH}` | PEM file with headers stripped. Snowflake private keys. |

When generating a manifest with `${env.X}` tokens, also generate or update
a `.env.example` listing every key. Never include real values.

## What to ask the user (don't guess)

- **Target org alias** — `sf org list` shows theirs. Don't invent.
- **Source-system identifiers** — bucket name, Snowflake
  `database.schema.object`, schema field set. User-specific.
- **Primary-key field** — confirm explicitly. "First column" or
  "column named Id" is a heuristic, not a guarantee.
- **DMO field schemas** when not derivable from a source the agent can read.
- **SearchIndex chunking fields** — which DMO fields hold long-text to
  index. Propose candidates from the DMO schema but always confirm.
- **Decorator fields** — fields like Title/Subject prepended onto chunks.
  Ask; the user usually has an opinion.

## What to default (don't ask)

- `label` → dev name on every resource.
- `category: "Other"` on DMO and DataStream.
- `refreshMode`: `UPSERT` (IngestApi/S3), `TOTAL_REPLACE` (Snowflake
  without an incremental column).
- `searchType: "HYBRID"`, `processingType: "NEAR_REALTIME"`.
- Vector embedding: `e5_large_v2` + HNSW + COSINE (construct defaults).
- `vectorRelatedFields`: source DMO PK. Add more only if user asks.
- `parentDirectory: "/"` on AwsS3.
- `hasPrivateNetworkRoute: "false"` on Snowflake.

## Anti-patterns

**Don't hardcode secrets.** Use `${env.X}`. The state file is committed
to git; secrets in the manifest leak to anyone with repo access.

**Don't hardcode org IDs.** Use the alias as `targetOrg`.

**Don't mix construct refs and name strings.** When both resources are in
the same manifest, pass the variable: `source: streamVar`. String refs
are only for resources NOT authored here (e.g.
`sourceDmo: "ssot__Account__dlm"`).

**Don't add `__c` / `__cio` / `__dlm` / `__dll` suffixes.** The platform
appends these. Authored names are bare: `"NTOProduct"` → `NTOProduct__dlm`.

**Don't generate resources the user didn't ask for.** "Just an S3
connection" means one Connection, not a full RAG pipeline.

**Don't invent field names.** If you don't have the schema, ask. Inventing
`Description__c` produces deploys that 400.

## Validation before handing back

1. `npx afd360 synth -c <path>` — offline, catches construct errors.
2. `npx afd360 diff --org <alias>` — live preview, no writes.
3. If either fails, show the error verbatim. Don't silently fix.

User's deploy sequence:
```
cp .env.example .env
npx afd360 whoami --org <alias>
npx afd360 diff --org <alias>
npx afd360 deploy --org <alias>
```

## When you're stuck

- **Don't know `targetOrg`** → "Run `sf org list` — which alias?"
- **Don't know Snowflake coordinates** → "What's the `database.schema.object`?"
- **Don't know DMO fields** → "Can you paste the output of
  `sf api request rest /services/data/v66.0/ssot/data-model-objects/<name>`?"
- **Don't know the PK** → "Which column is the primary key?"
- **Unsupported feature** → say so. Suggest the closest alternative or
  leave a TODO comment.

## Example manifests

Adapt the closest match — don't generate from scratch:

| Asset | Scenario |
|---|---|
| [connection-only-s3.ts](assets/connection-only-s3.ts) | S3 connection, no streams |
| [connection-only-snowflake.ts](assets/connection-only-snowflake.ts) | Snowflake connection, no streams |
| [ingest-api-stream.ts](assets/ingest-api-stream.ts) | IngestApi end-to-end (Connection + Schema + Stream) |
| [snowflake-rag-full.ts](assets/snowflake-rag-full.ts) | Full RAG over Snowflake table |
| [s3-rag-full.ts](assets/s3-rag-full.ts) | Full RAG over S3 CSV |
| [relationship-pair.ts](assets/relationship-pair.ts) | Two related DMOs with foreign key |
