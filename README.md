# afd360

Agentforce Data 360 SDK — declare Data 360 configurations in a TypeScript
manifest and deploy them to a Salesforce org.

**Status:** v0.1 — RAG pipeline end-to-end (Connection, DataStream, DMO,
Mapping, Relationship, CalculatedInsight, SearchIndex). See
[`PLAN.md`](./PLAN.md) for milestone history and
[`docs/resources.md`](./docs/resources.md) for the resource reference.

> **Building manifests with an AI coding assistant?** See
> [`AGENTS.md`](./AGENTS.md) for operational guidance and
> [`examples/`](./examples/) for scenario manifests. Both are designed
> to give an agent enough context to generate accurate manifests on a
> user's behalf without hallucinating field names or values.

## Project layout

afd360 is its own self-contained project — same convention as AWS CDK.
A directory with `afd360.config.ts`, `package.json`, and `node_modules/`
is one afd360 project. Don't try to host afd360 inside another project's
file tree (e.g. an SFDX project's `force-app/`); keep it as a sibling
subdirectory.

### Standalone

```sh
mkdir my-rag && cd my-rag
npx afd360 init .            # scaffolds afd360.config.ts + .env.example
npm install
cp .env.example .env         # fill in AWS_ACCESS_KEY / AWS_ACCESS_SECRET
# edit afd360.config.ts: set TARGET_ORG, SOURCE_BUCKET, SOURCE_FILE
```

### Inside an SFDX project (recommended for Data Cloud + CRM development)

Same pattern, just nested. Pick a subdirectory — `data360/` is the
suggested convention — and run `afd360 init` inside it:

```sh
cd my-sfdx-project
afd360 init data360 && cd data360
npm install
cp .env.example .env
# edit afd360.config.ts
```

Layout:

```
my-sfdx-project/
├── sfdx-project.json
├── force-app/main/default/      ← Apex, permission sets, metadata-API content
└── data360/                     ← afd360 subproject, fully self-contained
    ├── package.json
    ├── tsconfig.json
    ├── afd360.config.ts
    ├── .env (gitignored)
    └── .afd360/state/
```

`force-app/` and `data360/` are independent — afd360 manifests use the
Connect API, not the metadata API, so the two declarative surfaces don't
overlap. Run afd360 commands from inside `data360/`.

For multiple stacks (e.g. RAG vs. ingest, or prod vs. staging), create
multiple subdirectories: `data360-rag/`, `data360-ingest/`. Each is its
own afd360 project with its own state.

### Deploy

From inside the afd360 project directory (`my-rag/`, `data360/`, etc.):

```sh
npx afd360 whoami --org my-org
npx afd360 diff --org my-org
npx afd360 deploy --org my-org
```

Redeploys are idempotent — a clean manifest re-runs as `0 writes`. Drift on
a parent resource (e.g. `ConnectionSchema`) cascades through children under
v1's delete-and-recreate policy; `diff` flags cascades and `deploy`
halts for y/N confirmation unless `--force` is set.

## Prompting tips for AI assistants

When you want an AI coding assistant (Claude, Cursor, Codex, etc.) to
generate or edit an afd360 manifest, **mention afd360 by name in your
first prompt**. Most agents don't auto-scan `node_modules/`, so without
the package name they won't discover the SDK or its agent-targeted docs.

A working prompt: *"Use afd360 to set up a Snowflake search index over
our Products table."*

The agent will read `node_modules/afd360/AGENTS.md` and the relevant
example under `node_modules/afd360/examples/`, then ask you for the
specifics it needs.

## Commands

| Command | What it does |
|---|---|
| `afd360 init <dir>` | Scaffold a starter project (S3 → Stream → DMO → Mapping → SearchIndex) |
| `afd360 import --org <alias> --out <dir>` | Read an existing org's Connections into a manifest + state seed |
| `afd360 whoami --org <alias>` | Verify auth + Data 360 reachability |
| `afd360 synth` | Compile the manifest into `.afd360/plan.json` (no I/O) |
| `afd360 diff --org <alias>` | Preview pending ops against the live org |
| `afd360 deploy --org <alias>` | Apply the manifest (idempotent) |
| `afd360 destroy --org <alias>` | Remove everything this manifest manages |

## Manifest shape

```ts
import { App, Stack, Connection, DataStream, DMO, Mapping, SearchIndex } from "afd360";

const app = new App();
const stack = new Stack(app, "Rag", { targetOrg: "my-org" });

const conn = new Connection(stack, "DocsS3", { /* ... */ });
const stream = new DataStream(stack, "DocsStream", { connection: conn, /* ... */ });
const dmo = new DMO(stack, "Articles", { /* ... */ });
new Mapping(stack, "ArticlesMapping", { source: stream, target: dmo, /* ... */ });
new SearchIndex(stack, "ArticlesIdx", { sourceDmo: dmo, /* ... */ });

export default app;
```

Dependencies are auto-wired from the construct references (`connection:
conn`, `source: stream`, etc.), so `dependsOn` is rarely needed explicitly.

## State

`.afd360/state/<org>.json` tracks the Salesforce ids + content hashes of
deployed resources. Committed to git by default — it's the source of truth
for what's where. Secrets never land in state.

## Secrets

All credential values in the manifest are `${env.X}` tokens resolved at
deploy time from `.env` (or the real process env). afd360 never reads or
writes live credential material to the manifest or state.

## Resource quirks

The Connect API has ~15 operational quirks that both tdc and
afd360-training had to discover in production — all documented inline in
the resource modules and codified in afd360's behavior. Notable:

- DataStream `PROCESSING → ERROR` without ingestion traffic; recovery is delete+recreate (A4).
- DMO `get()` historically 500'd "not found"; now clean 404 on jaygentforce — afd360 handles both (B1).
- SearchIndex input rejects output-only name fields (`sourceDmoName`) with opaque 500 (C-series).
- `createRelationships` requires both source and target DMOs mapped first (E1 resolved).

See [`PLAN.md` Appendix A](./PLAN.md#appendix-a--operational-quirks-hard-won-from-tdc--afd360-training)
for the full list, and [`docs/resources.md`](./docs/resources.md) for
per-resource reference.

## Development

```sh
npm install
npm run build
npm test
npm run typecheck
```

Integration tests (`tests/integration/c*/`) are driven through the CLI
against a real org; they're gated on `AFD360_TEST_ORG` and not run by
default. Per-checkpoint manifests under `tests/integration/` document the
paved-path scenarios.

## Feedback

File issues at the repo tracker; include an afd360 version, the `sf org
display --json` output (redact tokens), and the minimal manifest that
reproduces the behavior.
