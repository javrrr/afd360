/**
 * Generic retry helper. Two usage modes:
 *
 * 1. **Baseline retry** (applied to every Connect API write) — retryOn5xx:
 *    3 attempts, 500/1000/2000 ms backoff with ±20% jitter. prior tooling saw
 *    transient 500s on many endpoints that resolved on retry.
 * 2. **Resource-specific retry** (opt-in, M4+): e.g. DataStream retries
 *    "Illegal argument" for ~90s. Expressed via predicate.
 *
 * data-360-sdk already retries 429/5xx inside its HttpClient, but with a
 * single-responsibility contract. Resource-level retry gives afd360 control
 * over what counts as retriable for specific operational quirks that are
 * not purely HTTP-status-driven.
 */

export interface RetryOptions {
  /** Number of attempts (1 = no retry). Default 3. */
  attempts?: number;
  /** Base interval in ms. Default 500. */
  intervalMs?: number;
  /** Exponential backoff base. Default 2 → 500/1000/2000. */
  backoff?: number;
  /** Max interval cap in ms. Default 30_000. */
  maxIntervalMs?: number;
  /** ±jitter fraction, e.g. 0.2 → ±20%. Default 0.2. */
  jitter?: number;
  /** Called on every retry with the error, attempt number, and total. */
  onRetry?: (err: unknown, attempt: number, total: number) => void;
}

/**
 * Run `fn`; if it throws and `shouldRetry(err)` returns true, retry with
 * exponential backoff + jitter. Rethrows the last error on exhaustion.
 */
export async function retryOn<T>(
  fn: () => Promise<T>,
  shouldRetry: (err: unknown) => boolean,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.intervalMs ?? 500;
  const backoff = opts.backoff ?? 2;
  const cap = opts.maxIntervalMs ?? 30_000;
  const jitter = opts.jitter ?? 0.2;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      opts.onRetry?.(err, attempt, attempts);
      const delay = Math.min(cap, base * backoff ** (attempt - 1));
      const withJitter = delay * (1 + (Math.random() * 2 - 1) * jitter);
      await sleep(withJitter);
    }
  }
  throw lastErr;
}

/** Baseline predicate: retry on any 5xx. Used by default for Connect API writes. */
export function is5xx(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && status >= 500 && status < 600;
}

/**
 * Does the error body (JSON or string) contain `substring`? Used by
 * quirk-specific retry predicates (A1 "Illegal argument", B1 "DMO not found",
 * C1 "DMO not fully materialized", etc.) where the error code lives in the
 * response body rather than the HTTP status. Case-insensitive.
 */
export function errBodyIncludes(err: unknown, substring: string): boolean {
  if (!err || typeof err !== "object") return false;
  const body = (err as { body?: unknown }).body;
  const message = (err as { message?: unknown }).message;
  const needle = substring.toLowerCase();
  const text = [
    typeof body === "string" ? body : JSON.stringify(body ?? ""),
    typeof message === "string" ? message : "",
  ]
    .join(" ")
    .toLowerCase();
  return text.includes(needle);
}

/** Convenience wrapper: baseline retry policy for Connect API writes. */
export function retryOn5xx<T>(
  fn: () => Promise<T>,
  opts: Omit<RetryOptions, never> = {},
): Promise<T> {
  return retryOn(fn, is5xx, opts);
}

/** Numeric HTTP status off an error, or undefined. */
function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : undefined;
}

/**
 * A DMO's **fact table** materializes asynchronously *after* its DLO→DMO
 * Mapping is created — the mapping POST returning 200 does NOT mean the fact
 * table is queryable yet. A CalculatedInsight (or anything that validates its
 * SQL against the fact table) created inside that window 400s with
 * `ENTITY_SAVE_ERROR "Error getting FactTable <dmo>__dlm"` /
 * `"Cannot find type for node <dmo>__dlm.<field>"`. The condition is purely
 * transient: the identical create succeeds once the fact table lands —
 * live-observed ~90s on a live org (2026-10-01), confirming it's
 * timing, not a bad definition. Correct ordering (CI after Mapping) is
 * necessary but insufficient; this predicate lets the CI create *wait out*
 * the materialization instead of aborting the deploy.
 *
 * Note: ordering is still enforced separately (CI dependsOn its DMOs'
 * Mappings — see attachMappingToCalculatedInsights); this retry only closes
 * the async gap between "mapping created" and "fact table queryable".
 */
export function isFactTableNotReady(err: unknown): boolean {
  return (
    errBodyIncludes(err, "Error getting FactTable") ||
    errBodyIncludes(err, "Cannot find type for node")
  );
}

/**
 * The platform's reference graph propagates asynchronously *after* a dependent
 * resource is deleted. Deleting a parent whose dependents were *just* deleted
 * (e.g. a recreate drain, or a reverse-topo destroy/prune) can fail because the
 * back-reference hasn't cleared yet. Two shapes seen on live orgs:
 *
 *   - **DMO** → `412 MATCH_PRECONDITION_FAILED` ("...referenced in other
 *     features") when a just-deleted CalculatedInsight / SearchIndex /
 *     semantic-model dependent's reference lingers (live-observed 2026-10-01).
 *   - **CalculatedInsight** → `DELETE_FAILED` ("can't delete this calculated
 *     insight because of these dependencies") when a just-deleted SemanticModel
 *     (which HARD-BLOCKS deleting the CIs it references) still points at it.
 *     This bites specifically on a CI *recreate* cascade: the drain deletes the
 *     SemanticModel first, but the CI delete in the forward loop can still race
 *     the reference-clear (field-reported 2026-10-04).
 *
 * Both are transient — a retry seconds later succeeds once the reference drops.
 * Deleting the dependents in the right order is necessary but insufficient (the
 * drain / reverse-topo already does that); this predicate lets the parent delete
 * wait out the async gap. A delete blocked by a *genuinely* still-present
 * dependent matches too and simply exhausts the retry budget before the real
 * error surfaces — the same accepted trade-off as {@link isFactTableNotReady}.
 */
export function isReferencedPreconditionFailure(err: unknown): boolean {
  if (statusOf(err) === 412) return true;
  return (
    errBodyIncludes(err, "MATCH_PRECONDITION_FAILED") ||
    errBodyIncludes(err, "referenced in other features") ||
    // CalculatedInsight delete-block ("...because of these dependencies").
    // Substring "dependenc" covers dependency/dependencies/dependent.
    errBodyIncludes(err, "DELETE_FAILED") ||
    errBodyIncludes(err, "dependenc")
  );
}

/**
 * Shared "resource is already gone" predicate. Use inside `read()` to return
 * `null`, or inside `delete()` to swallow the error as idempotent success.
 *
 * Four patterns we've seen across the Connect API (quirks B1, D1, and the
 * SearchIndex 400 variant observed on dev-org 2026-05-05):
 *
 *   - `404` — the clean, documented case. Always "not found".
 *   - `500` with body text matching `/not\s+found/i` — DMO quirk B1 and
 *     similar undocumented endpoints. Treat as "not found".
 *   - `400` with body text matching an extra substring — SearchIndex's
 *     `GET /ssot/search-index/{devName}` returns 400 INVALID_INPUT with
 *     `"...was not found"` instead of 404. Opt in per resource via
 *     `extra400Body`.
 *   - anything else — rethrow.
 *
 * Per-call overrides live in `opts.extra400Body` (string or regex) so a
 * resource can widen the match without each call-site reimplementing the
 * whole predicate.
 */
export interface NotFoundOptions {
  /** Substring (case-insensitive) or regex to match against the response body on a 400. */
  readonly extra400Body?: string | RegExp;
  /** Substring or regex for 500 bodies. Defaults to /not\s+found/i. */
  readonly body500?: string | RegExp;
}

export function isNotFound(err: unknown, opts: NotFoundOptions = {}): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (status === 404) return true;
  if (status === 400 && opts.extra400Body !== undefined) {
    return bodyMatches(err, opts.extra400Body);
  }
  if (status === 500) {
    // Default matcher — /not\s+found/i covers prior tooling's B1 quirk ("DMO not found")
    // and everything we've seen since. Callers rarely need to override.
    const matcher = opts.body500 ?? /not\s+found/i;
    return bodyMatches(err, matcher);
  }
  return false;
}

function bodyMatches(err: unknown, matcher: string | RegExp): boolean {
  if (typeof matcher === "string") return errBodyIncludes(err, matcher);
  if (!err || typeof err !== "object") return false;
  const body = (err as { body?: unknown }).body;
  const message = (err as { message?: unknown }).message;
  const text = [
    typeof body === "string" ? body : JSON.stringify(body ?? ""),
    typeof message === "string" ? message : "",
  ].join(" ");
  return matcher.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
