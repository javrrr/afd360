# Phase 2 Backlog

Scope captured but deferred past v1. Each item has enough operational detail that we don't re-discover the quirks later. When we pick any of these up, promote the item to `PRD.md` + `PLAN.md` with a milestone.

---

## CDP Ingestion API (afd360-ingest or v1.x)

afd360 v1 provisions the pipeline (Connection → DataStream → DMO → Mapping → SearchIndex). It does NOT push data into the stream. That's the **CDP Ingestion API**, which is a separate surface.

**Why deferred**: Different auth flow, different base URL, batching + rate-limiting concerns, and customers typically drive ingestion from their own pipelines (Lambda, MuleSoft, ETL). Keeping it out of v1 keeps the scope tight.

**If/when we bring it in, operational details to preserve** (evidence: tdc `scripts/data-cloud/cdp-client/*`):

- **Auth**: SF OAuth token → CDP token exchange via `POST /services/a360/token`. Result is a short-lived CDP-scoped token keyed to a tenant-specific host `*.c360a.salesforce.com`, not the org's instance URL.
- **Base URL**: tenant-specific, discoverable from the token exchange response. Not the instance URL.
- **Endpoint shape**: `POST {tenantUrl}/api/v1/ingest/sources/{sourceName}/{objectName}` where `sourceName` = Connection dev name and `objectName` = schema object name.
- **Batching**: large payloads split into batches. Observed rate-limit behavior: HTTP 403 (not 429) on batches 200-400 when hammered. Built-in backoff required.
- **Adjacent resource**: Connected App (see next section) is a prerequisite for obtaining the OAuth token.

**Design implication for afd360 if we absorb this**: `Data360Client` today is Connect-API-only. An ingestion client would need its own auth path, base URL, and retry policy. Not a direct extension of what exists — likely a separate `Ingestor` class or a companion SDK `afd360-ingest`.

---

## Connected App lifecycle

Required for any OAuth flow into the Ingestion API. Not covered by afd360 v1 because provisioning in v1 uses the SE's `sf` CLI session, not a customer-facing OAuth app.

**Why deferred**: No v1 use case. The moment ingestion comes in scope, this does too.

**Critical operational detail** (evidence: tdc agent's memory `feedback_connected_app.md`):

- **Cannot be created via Connect API.** Requires Metadata API deploy of `ConnectedApp` XML — this is a cross-surface resource just like `FieldSrcTrgtRelationship` (milestone 6 quirk E1).
- **Consumer key is preserved by Salesforce across deploys** IF the app is re-deployed in place.
- **If the app is deleted and re-created, a new consumer key is generated.** This invalidates every client that stored the old key.
- **Rule: NEVER delete a Connected App in an environment that has live clients.** Update in place only.
- **CDP scopes required**: `api`, `refresh_token`, `cdp_query_api`, `cdp_ingest_api` (depending on usage).

**Design implication for afd360 if we absorb this**: a Connected App resource in afd360 would need a hard-coded safety rail: `destroy` never deletes, only de-provisions config. Different from every other v1 resource.

---

## Agentforce metadata (v2+)

Captured so the scope boundary with Core metadata is clear. afd360 v1 is Data 360 only; Agentforce bot / agent / prompt metadata is Phase 2.

**Why deferred**: Different metadata API surface (mostly XML via `sf project deploy`), distinct set of quirks, and ready today via `sf project deploy` for users who need it.

**Quirks worth capturing now** (evidence: tdc `scripts/agentforce/deploy.ts`, `scripts/agentforce/redeploy-agent.ts`):

- **`AiAuthoringBundle` locks after publish.** To change content post-publish, the bundle must be deleted and re-created. No edit-in-place.
- **`BotDefinition` ID changes on republish.** Any `MessagingChannel` `SessionHandlerId` referencing the old bot ID breaks. Re-wire after every republish.
- **Routing flows with `AgentBased routeWork` do not work for Agentforce agents.** The `MessagingChannel` must bind `SessionHandlerId` directly to the bot, bypassing routing flows.
- **MIAW Custom Client deployments require manual Setup UI publish.** No API for the publish step. If afd360 v2 touches these, `deploy` must halt with a clear "go publish via Setup UI, then re-run" message.

**Design implication for afd360 if we absorb this**: Agentforce resources are *metadata-first* (opposite of v1's Connect-API-first). We'd need a proper `surface/metadata/` tree (which v1 specifically avoided) and a way to coordinate the Setup-UI-manual-step for MIAW. Don't start this until v1 is solid.

---

## How to use this doc

- When starting v2 planning, read this file in full. It's the hand-off from operational knowledge that would otherwise evaporate.
- Each section above is load-bearing: the quirks are real (someone hit them in production), not theoretical.
- Promote items to `PRD.md` / `PLAN.md` only when there's a committed milestone. Until then, this is the holding area.
