import { Data360Client } from "data-360-sdk";
// RELEASE-PREP GOTCHA: tableau-next-sdk is wired via a LOCAL `file:` dependency
// (`file:../tableau-next-sdk` in package.json) for testing. Before an afd360
// release this MUST be swapped for the npm-published `tableau-next-sdk@^<version>`
// — afd360 cannot be published while pointing at a local path. Sequence:
// publish tableau-next-sdk → bump this dep to the npm version → release afd360.
import { TableauNextClient } from "tableau-next-sdk";
// RELEASE-PREP GOTCHA (same as above): tableau-semantics-sdk is wired via a LOCAL
// `file:` dependency (`file:../tableau-semantics-sdk`) for testing. Before an
// afd360 release this MUST be swapped for the npm-published
// `tableau-semantics-sdk@^<version>` — afd360 cannot be published on a local
// path. Sequence: publish tableau-semantics-sdk → bump this dep → release afd360.
import { TableauSemanticsClient } from "tableau-semantics-sdk";
import type { Session } from "./auth.js";

/**
 * API version the Tableau Next `/tableau/*` surface is pinned to. Below v66 the
 * platform returns DOWNGRADE_VERSION_ERROR, so the TN client is always built at
 * v67 regardless of the session's default Data Cloud api version — matching the
 * per-call `apiVersion` the Visualization/Dashboard constructs used to pass to
 * `connectRequest`.
 */
export const TABLEAU_API_VERSION = "67.0";

export function buildBaseUrl(instanceUrl: string, apiVersion: string): string {
  const trimmed = instanceUrl.replace(/\/+$/, "");
  return `${trimmed}/services/data/v${apiVersion}`;
}

export function createClient(session: Session): Data360Client {
  return new Data360Client({
    instanceUrl: buildBaseUrl(session.instanceUrl, session.apiVersion),
    auth: { type: "static", accessToken: session.accessToken },
  });
}

/**
 * Build the Tableau Next client used by the Visualization + Dashboard
 * constructs for their `/tableau/*` transport. Pinned to {@link TABLEAU_API_VERSION}.
 * (SemanticModel stays on the raw-REST seam / `connectRequest` — its
 * `/ssot/semantic/models` surface is in neither published OpenAPI spec, so it is
 * not part of this SDK.)
 */
export function createTableauClient(session: Session): TableauNextClient {
  return new TableauNextClient({
    instanceUrl: buildBaseUrl(session.instanceUrl, TABLEAU_API_VERSION),
    auth: { type: "static", accessToken: session.accessToken },
  });
}

/**
 * API version the Tableau semantic-model surface (`/ssot/semantic/models`) is
 * pinned to. The SDK bakes no version — it appends the resource path to the
 * `instanceUrl` verbatim — so the version lives entirely in the base URL we
 * build here. afd360's hand-rolled seam talked v64; tableau-semantics-sdk is
 * generated from the v65 spec, so this surface moves to v65. (The Tableau viz
 * layer is still a DIFFERENT version — v67 — see {@link TABLEAU_API_VERSION}.)
 *
 * LIVE-VALIDATION GATE: the v64→v65 move is NOT yet confirmed against a real
 * org. The SemanticModel body builders still carry v64-captured leaf names and
 * values (e.g. `sourceCreation: "DataCloud"`, `queryUnrelatedDataObjects:
 * "Union"`) which the v65 spec's modeled enums (`Manual|Import`,
 * `Allow|Disallow`) hint may have changed — but the input schemas are open
 * objects, so only a live v65 deploy can confirm. See semantic-model.ts.
 */
export const SEMANTICS_API_VERSION = "65.0";

/**
 * Build the Tableau Semantics client used by the SemanticModel construct for
 * its `/ssot/semantic/models` transport. Pinned to {@link SEMANTICS_API_VERSION}.
 * Replaces the hand-rolled `connectRequest` seam SemanticModel used to use.
 */
export function createSemanticsClient(session: Session): TableauSemanticsClient {
  return new TableauSemanticsClient({
    instanceUrl: buildBaseUrl(session.instanceUrl, SEMANTICS_API_VERSION),
    auth: { type: "static", accessToken: session.accessToken },
  });
}
