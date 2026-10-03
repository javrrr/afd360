import { Data360Client } from "data-360-sdk";
// RELEASE-PREP GOTCHA: tableau-next-sdk is wired via a LOCAL `file:` dependency
// (`file:../tableau-next-sdk` in package.json) for testing. Before an afd360
// release this MUST be swapped for the npm-published `tableau-next-sdk@^<version>`
// — afd360 cannot be published while pointing at a local path. Sequence:
// publish tableau-next-sdk → bump this dep to the npm version → release afd360.
import { TableauNextClient } from "tableau-next-sdk";
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
