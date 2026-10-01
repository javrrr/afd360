import type { Session } from "./auth.js";
import { buildBaseUrl } from "./factory.js";

/**
 * Raw Connect-API request helper.
 *
 * Every other afd360 resource talks to Data Cloud through the typed
 * `data-360-sdk` client (`ctx.client.<service>`). A few surfaces have no SDK
 * service — notably the Tableau-Next analytics layer: `/ssot/semantic/models`
 * (semantic models) and `/tableau/visualizations`. The SDK ships a
 * `SemanticModelInputRepresentation` schema but exposes NO service for it, so
 * those resources issue raw REST against the live org using the resolved `sf`
 * session (instanceUrl + accessToken + apiVersion).
 *
 * Errors are thrown as `RestError`, which carries `.status` (number) and
 * `.body` (parsed JSON or raw text) so the existing retry predicates
 * (`is5xx`, `isNotFound`, `errBodyIncludes` in client/retry.ts) work against
 * raw-REST resources with no special-casing.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ConnectRequestOptions {
  readonly method: HttpMethod;
  /**
   * Path under `/services/data/v<version>`, e.g. `/ssot/semantic/models`.
   * A leading slash is optional.
   */
  readonly path: string;
  /** JSON request body. Omit for GET/DELETE. */
  readonly body?: unknown;
  /**
   * Override the session's apiVersion for a version-gated endpoint. The
   * semantic-model + Tableau surfaces are version-sensitive (e.g. the
   * `/tableau/` endpoints reject v64/v65 with DOWNGRADE_VERSION_ERROR), so a
   * resource can pin the version it was verified against rather than inherit
   * whatever the `sf` CLI reports.
   */
  readonly apiVersion?: string;
  /** Request timeout in ms. Default 120_000 (matches the SDK writes we bump). */
  readonly timeoutMs?: number;
}

/**
 * Error shape compatible with the retry/not-found predicates in
 * client/retry.ts: exposes `status` (number) and `body` (parsed or raw).
 */
export class RestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;
  constructor(status: number, statusText: string, body: unknown, url: string) {
    super(`${status} ${statusText} for ${url}`);
    this.name = "RestError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export async function connectRequest<T = unknown>(
  session: Session,
  opts: ConnectRequestOptions,
): Promise<T> {
  const version = opts.apiVersion ?? session.apiVersion;
  const base = buildBaseUrl(session.instanceUrl, version);
  const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
  const url = `${base}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  const init: RequestInit = {
    method: opts.method,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      Accept: "application/json",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    signal: controller.signal,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  let res: Response;
  try {
    res = await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  const parsed = text ? safeJson(text) : undefined;
  if (!res.ok) {
    throw new RestError(res.status, res.statusText, parsed ?? text, url);
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
