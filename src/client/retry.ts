/**
 * Generic retry helper. Two usage modes:
 *
 * 1. **Baseline retry** (applied to every Connect API write) — retryOn5xx:
 *    3 attempts, 500/1000/2000 ms backoff with ±20% jitter. tdc saw
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
