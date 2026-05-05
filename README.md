# afd360

Agentforce Data 360 SDK — declare Data 360 configurations in a TypeScript
manifest and deploy them to a Salesforce org.

**Status:** v0.1 — RAG pipeline end-to-end (Connection, DataStream, DMO,
Mapping, Relationship, CalculatedInsight, SearchIndex). See
[`PLAN.md`](./PLAN.md) for milestone history and
[`docs/resources.md`](./docs/resources.md) for the resource reference.

## Quickstart

Prerequisites: Node 20+, the `sf` CLI authenticated to a Data Cloud org.

```sh
mkdir my-rag && cd my-rag
npx afd360 init .            # scaffolds afd360.config.ts + .env.example
npm install
cp .env.example .env         # fill in AWS_ACCESS_KEY / AWS_ACCESS_SECRET
# edit afd360.config.ts: set TARGET_ORG, SOURCE_BUCKET, SOURCE_FILE

npx afd360 whoami --org my-org
npx afd360 diff --org my-org
npx afd360 deploy --org my-org
```

Redeploys are idempotent — a clean manifest re-runs as `0 writes`. Drift on
a parent resource (e.g. `ConnectionSchema`) cascades through children under
v1's delete-and-recreate policy; `diff` flags cascades and `deploy`
halts for y/N confirmation unless `--force` is set.

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
