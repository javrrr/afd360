# Building afd360 manifests with an AI agent

This file is for AI coding assistants generating afd360 manifests on
behalf of users. It contains the operational knowledge the TypeScript
types alone don't carry — connector-specific recipes, what to ask the
user vs. what to default, anti-patterns to avoid.

afd360 is the SDK for declaring Salesforce Data Cloud / Agentforce
Data 360 configurations as code. Users author a manifest
(`afd360.config.ts`), afd360 deploys it to a Salesforce org idempotently.

## When you're done reading this

In rough order:

1. `docs/resources.md` — full prop reference for every resource type.
2. `examples/` subdirectories — scenario manifests you can adapt.
3. The TypeScript types (`dist/index.d.ts` / source under `src/resources/`).
4. `PLAN.md` Appendix A — operational quirks the type system can't catch.

This file plus `examples/` should cover ~80% of cases. Reach for the
others when an example doesn't match the user's intent or types
disagree with what you generated.

## Project layout — CRITICAL: set up before generating files

afd360 is a self-contained project, like AWS CDK. A directory with
`package.json` (with `"type": "module"`), `node_modules/afd360/`, and
`afd360.config.ts` is one afd360 project. **The manifest uses
`import { App } from "afd360"` (ES module syntax), so both
`"type": "module"` in package.json AND `node_modules/afd360/` MUST
exist before the manifest can load.**

Before generating any files, set up the target directory using
`npx afd360 init` — it creates the correct `package.json`:

```sh
# If no package.json exists:
mkdir -p data360 && cd data360
npx afd360 init .
npm install
```

**Do NOT use `npm init -y` — it defaults to `"type": "commonjs"` which
breaks ES module imports. Always use `npx afd360 init .` instead.**

If you're invoked inside an SFDX project (you'll see `sfdx-project.json`
at the parent level and `force-app/` next to it), afd360 manifests
should NOT live inside `force-app/`. The convention is a sibling
subdirectory — `data360/` is the suggested name.

```
my-sfdx-project/
├── sfdx-project.json            ← user's SFDX project
├── force-app/main/default/      ← Apex, metadata-API content (NOT afd360)
└── data360/                     ← the afd360 project you're working in
    ├── package.json             ← must exist with afd360 as a dep
    ├── node_modules/            ← must contain afd360
    ├── afd360.config.ts         ← the manifest you're editing
    ├── .env.example
    └── .afd360/state/
```

Generate the `afd360.config.ts` and `.env.example` inside this
directory. All paths are relative to it, not the SFDX project root.
All `npx afd360` commands must be run from here.

## The mental model

A manifest is a TypeScript file that builds a tree:

```
App
└── Stack ("MyStack", { targetOrg: "my-org" })
    ├── Connection
    ├── DataStream  (depends on Connection — auto-wired)
    ├── DMO
    ├── Mapping     (depends on DataStream + DMO — auto-wired)
    └── SearchIndex (depends on DMO + Mapping — auto-wired)
```

Key facts to internalize:

- **Constructs reference each other directly**, not by name. When
  authoring, pass the construct variable: `new Mapping(stack, "M", {
  source: streamVar, target: dmoVar, ... })`. afd360 reads `dependsOn`
  from these references and orders deploys topologically.
- **State lives at `.afd360/state/<org>.json`**. Resource IDs and
  content hashes. Committed to git by default (no secrets ever land
  there).
- **Deploys are idempotent.** A manifest you've already deployed
  yields zero API writes on a second deploy. The runner classifies
  each resource as `noop`, `adopt`, `create`, or `recreate`.
- **v1 policy on drift is delete-and-recreate.** PATCH isn't
  implemented for most resources. Don't generate manifests that
  intentionally drift fields hoping for in-place updates.
- **Secrets never appear in the manifest.** Use `${env.X}`,
  `${file:PATH}`, or `${pem:PATH}` substitution tokens. afd360 reads
  these at deploy time from the user's `.env`.

## Resource catalog

| Construct | When to use |
|---|---|
| `Connection` | Always when authoring anything beyond an empty stack. Defines auth + parameters for talking to a source system. Required parent for `DataStream`. |
| `ConnectionSchema` | IngestApi only. Materialized inline as `Connection({ ..., schema: { ... } })`. Declares the field set the ingest endpoint will accept. |
| `DataStream` | When the user wants to bring data into a DLO from a source (S3 file, Snowflake table, IngestApi push, SFDC sObject). Always paired with a `Connection`. |
| `DMO` | When the user wants a structured, typed model on top of one or more DLOs — required for SearchIndex, CalculatedInsight, Mapping. |
| `Mapping` | When the user has a custom DMO. Wires DLO fields → DMO fields. Not needed for standard `ssot__*` DMOs. |
| `Relationship` | When two DMOs need a foreign-key relationship (e.g. transactions → accounts). Both DMOs must be mapped first. |
| `CalculatedInsight` | When the user wants a SQL aggregation over DMOs (counts, rollups, derived metrics). |
| `SearchIndex` | When the user wants RAG / semantic search over a DMO. Hybrid (vector + keyword) is the default. |

`docs/resources.md` has the full prop reference for each. Read that
when you need exact field names or shapes.

## Choosing what to generate

For each user request, walk this table from top to bottom. Stop at
the highest row that matches; everything above and including it is
what you generate.

| User intent signal | Generate |
|---|---|
| "I want to retrieve / search / RAG over data" | Connection → DataStream → DMO → Mapping → SearchIndex |
| "I want to combine / join data from two DMOs" | (× 2) Connection → DataStream → DMO → Mapping, then Relationship |
| "I want a metric / aggregation / count over data" | Connection → DataStream → DMO → Mapping → CalculatedInsight |
| "I want to ingest data into Data Cloud" | Connection → DataStream (+ DMO + Mapping if user wants typed DMO surface) |
| "I want to set up an X connection" (no further ask) | Connection only |
| "I want to test that afd360 works" | Connection only (IngestApi is simplest — no external creds) |

Once the resource set is fixed, walk through each resource and decide:
do I have enough info to author it, or do I need to ask the user? See
"What to ask vs. what to default" below.

## Connector-specific recipes

The TypeScript types accept any string for `connectorType` and most
parameters. These are the values that actually work, plus the
non-obvious requirements.

### AwsS3

```ts
new Connection(stack, "DocsS3", {
  connectorType: "AwsS3",
  label: "Docs S3",
  method: "Ingress",
  credentials: {
    authenticationOption: "accessKeyAndSecret",
    accessKey: "${env.AWS_ACCESS_KEY}",
    accessSecret: "${env.AWS_ACCESS_SECRET}",
  },
  parameters: {
    bucketName: "my-bucket",
    parentDirectory: "/",
  },
});
```

`DataStream` for AwsS3 needs `s3: { fileType, fileName, fields }`.
CSV column names are literal — preserve casing and spaces. Exactly
one field with `isPrimaryKey: true`.

### Snowflake (federated / BYOL)

```ts
new Connection(stack, "MySnow", {
  connectorType: "SNOWFLAKE",        // UPPERCASE — unlike AwsS3
  label: "Snowflake",
  method: "Ingress",
  credentials: {
    authenticationOption: "KeyPair",
    user: "${env.SNOWFLAKE_USER}",
    privateKey: "${pem:${env.SNOWFLAKE_PRIVATE_KEY_PATH}}",  // base64 body, not full PEM
  },
  parameters: {
    accountUrl: "${env.SNOWFLAKE_ACCOUNT_URL}",
    warehouse: "${env.SNOWFLAKE_WAREHOUSE}",
    region: "${env.SNOWFLAKE_REGION}",   // required for streams; not enforced by spec
    unloadData: "true",                  // required for streams; not enforced by spec
    hasPrivateNetworkRoute: "false",
  },
});
```

`DataStream` for Snowflake needs `snowflake: { database, schema,
object, fields }`. Snowflake uppercases unquoted identifiers — column
names should be UPPERCASE unless the user has quoted them at table
creation. Default `refreshMode` is `INCREMENTAL` and needs
`incrementalColumn`. Use `TOTAL_REPLACE` if no monotonic column
exists.

### IngestApi

```ts
new Connection(stack, "DocsIngest", {
  connectorType: "IngestApi",
  label: "Docs Ingest",
  schema: {
    label: "KnowledgeBase",
    fields: [
      { name: "Id", dataType: "Text" },
      { name: "Title", dataType: "Text" },
    ],
  },
});
```

No credentials — IngestApi auth is the user's `sf` CLI session. Schema
goes inline on the Connection, not as a separate construct. Field
`label` defaults to `name` if omitted.

The platform rewrites the connection name on create (authored
"DocsIngest" becomes "Docs_Ingest_<uuid>"). afd360 handles this
internally; you don't need to do anything special.

## Env-var conventions

| Token | When |
|---|---|
| `${env.NAME}` | Single-line value. Most credentials, account IDs, region strings. |
| `${file:PATH}` | File contents, used as-is. Rare. |
| `${pem:PATH}` | PEM file contents with headers stripped + whitespace removed. Snowflake private keys specifically. |

When you generate a manifest with `${env.X}` tokens, also generate or
update a `.env.example` listing every key the manifest references.
Never include real values.

Connector-by-connector key conventions:

- **AwsS3**: `AWS_ACCESS_KEY`, `AWS_ACCESS_SECRET`. Bucket name
  usually as a literal string in the manifest — buckets are
  identifiers, not secrets.
- **Snowflake**: `SNOWFLAKE_ACCOUNT_URL`, `SNOWFLAKE_USER`,
  `SNOWFLAKE_WAREHOUSE`, `SNOWFLAKE_REGION`,
  `SNOWFLAKE_PRIVATE_KEY_PATH`.
- **IngestApi**: no secrets needed.

## What to ask the user

If you don't have a value and can't sensibly default, **ask**. Don't
invent. Specifically, always ask for:

- **Target org alias** (`targetOrg` on the Stack). The user runs
  `sf org list` to see theirs. Default candidates ("default",
  "my-org") are not sensible.
- **Source-system identifiers**. Bucket name, Snowflake
  database.schema.table, IngestApi schema field set. These are
  user-specific and the agent has no basis to guess.
- **DMO field schemas** when not derivable from a CSV the agent has
  read. Field names, types, which is the PK.
- **Field-mapping intent** when DLO column names don't trivially
  match DMO field names (e.g. CSV header "Customer ID" → DMO field
  "CustomerId").
- **Primary-key field** when the user gave you a column list but
  didn't mark which is the PK. "First column" / "column named Id"
  are heuristics, not guarantees — confirm explicitly. Wrong PK at
  deploy time produces a stream that can't UPSERT correctly.
- **SearchIndex chunking fields** — which DMO fields hold the
  long-text the user wants indexed. The agent should propose
  candidates if the DMO schema is known, but always confirm.
- **Decorator fields for chunking** — fields like Title or Subject
  that prepend onto chunks for context. Almost always worth asking;
  it improves retrieval quality and the user usually has an opinion.

## What to default (don't ask)

- **`label` defaults to dev name** on every resource. Don't ask.
- **`category: "Other"`** on DMO and DataStream unless the user
  signals otherwise (Engagement = event-time data, Profile = identity).
- **`refreshMode`**: `UPSERT` for IngestApi/AwsS3, `INCREMENTAL` for
  Snowflake (asking only the `incrementalColumn`).
- **`searchType: "HYBRID"` + `processingType: "NEAR_REALTIME"`** on
  SearchIndex.
- **Vector embedding config** — leave it to construct defaults
  (`e5_large_v2` + HNSW + COSINE). The user only needs this if they're
  doing something unusual.
- **`vectorRelatedFields` on SearchIndex** — defaults to the source
  DMO's PK. Add more (e.g. category fields) if the user asks for
  filterable retrieval, but don't volunteer.
- **`parentDirectory: "/"`** on AwsS3 connections.
- **`hasPrivateNetworkRoute: "false"`** on Snowflake connections.

## Anti-patterns

Each of these is a generation mistake to avoid, with the reasoning so
you can apply the principle to novel cases.

**Don't hardcode secrets.** Use `${env.X}`. afd360's state file is
committed to git by default; secrets in the manifest would also leak
to anyone who synths the plan or shares the repo. The user's `.env` is
gitignored.

**Don't hardcode org IDs.** Use the alias as `targetOrg` (e.g.
`"my-prod"`); afd360 resolves the alias via the user's `sf` CLI
session at deploy time. Hardcoded org IDs lock the manifest to one
specific org.

**Don't mix construct references and name strings.** When a resource
references another resource you're authoring in the same manifest,
pass the variable: `source: streamVar`, not `source: "MyStream"`. The
construct ref auto-wires `dependsOn`; the string doesn't, so deploy
order can race. String references are only correct for resources NOT
authored by the manifest (e.g. `sourceDmo: "ssot__Account__dlm"` for a
standard DMO).

**Don't author SearchIndex `fields` without confirming DMO field
names exist.** The platform 400s with "Either DMO X or DMO field Y
does not exist" if the field name is wrong. If the DMO is also being
authored in the same manifest, the field names come from the DMO
construct and are checked at deploy time. If the DMO is a string
reference (e.g. `ssot__KnowledgeArticleVersion__dlm`), ask the user
to confirm the field exists or have them paste the GET response.

**Don't add `__c` / `__cio` / `__dlm` / `__dll` suffixes to authored
names.** afd360 / the platform appends these on create. DMO authored
as `"NTOProduct"` → live name `"NTOProduct__dlm"`. Field authored as
`"Description"` → live name `"Description__c"`. CalculatedInsight
authored as `"ProductCount"` → live name `"ProductCount__cio"`.
Authored names with these suffixes work for some resources but break
hash idempotency for others.

**Don't generate resources the user didn't ask for.** If the user
says "I just want an S3 connection", don't add a DataStream "while
you're at it." Each extra resource adds an API call, a state entry,
and a delete during destroy. Ship minimum viable.

**Don't invent field names for unknown DMOs.** If the user mentions
"NTO Product DMO" but you don't have its schema, ask. Inventing
`Description__c` because that's what NTO often has produces deploys
that 400.

## Validation flow before handing back

After generating, before the user runs `deploy`:

1. **Run `npx afd360 synth -c <manifest-path>`** if you have shell
   access. This loads the manifest, runs construct constructors, emits
   `.afd360/plan.json`. No org I/O. Catches construct-time errors
   (missing required props, bad enum values, dependency cycles)
   cheaply.
2. **If you have an org alias and the user has authed**, run
   `npx afd360 diff --org <alias>`. Reads the live org, computes ops,
   doesn't write anything. Surfaces "create" vs. "adopt" so the user
   knows what would happen.
3. **If either fails**, surface the error to the user verbatim. Don't
   try to silently fix the manifest based on an error you don't fully
   understand.

The user's command sequence after you hand back is normally:

```
cp .env.example .env                # fill in real values
npx afd360 whoami --org <alias>     # verify auth
npx afd360 diff --org <alias>       # preview
npx afd360 deploy --org <alias>     # apply
```

## When you're stuck

Specific stuck states + what to ask the user:

- **Don't know what `targetOrg` to use** → "What sf CLI org alias is
  this for? Run `sf org list` to see them."
- **Don't know Snowflake table coordinates** → "Can you give me the
  fully-qualified Snowflake source as `database.schema.object`?"
- **Don't know DMO field names** → "Can you paste the output of
  `sf api request rest /services/data/v66.0/ssot/data-model-objects/<DMO name>`?"
- **Don't know which column is the PK** → "Which column is the
  primary key for this table?" The first column or one named "Id" is
  often correct but not always — better to confirm than guess.
- **User asked for something afd360 doesn't yet support** (e.g.
  Databricks DataStream, file-level chunking) → say so explicitly.
  Suggest the closest alternative or hand back a TODO comment in the
  manifest. Don't fabricate the unsupported shape.

## Cross-reference: examples/

The `examples/` directory ships scenario manifests you can adapt:

| Subdir | Use when |
|---|---|
| `examples/connection-only-s3/` | User wants only an S3 connection, no streams. |
| `examples/connection-only-snowflake/` | User wants only a Snowflake connection. |
| `examples/ingest-api-stream/` | User wants the simplest end-to-end (Connection + Schema + Stream + DMO). |
| `examples/snowflake-rag-full/` | User wants RAG / search index on Snowflake data. |
| `examples/s3-rag-full/` | User wants RAG / search index on CSV data in S3. |
| `examples/relationship-pair/` | User wants two related DMOs with a foreign key. |

Each subdir has its own `README.md` explaining the scenario, an
`afd360.config.ts`, and a `.env.example`. Adapt the closest match to
the user's request — don't generate from scratch unless none of these
fit.
