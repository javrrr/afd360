import { Data360Client } from "data-360-sdk";
import type { Session } from "./auth.js";

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
