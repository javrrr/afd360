/**
 * Generic readiness poller. Returns the first truthy result from `check`;
 * throws `PollTimeoutError` if the budget elapses first.
 *
 * Used by async resources that expose a terminal status field (DataStream,
 * DMO, ConnectionSchema, SearchIndex). The SDK has no built-in waitForReady —
 * this is one of the gaps afd360 fills (PRD §7.7).
 */

export interface PollOptions {
  /** Poll interval in ms (default: 2000). */
  intervalMs?: number;
  /** Total budget in ms (default: 120_000). */
  timeoutMs?: number;
  /** Optional hook fired on each poll attempt (0-indexed). */
  onAttempt?: (attempt: number) => void;
}

export class PollTimeoutError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly elapsedMs: number,
  ) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

export async function pollUntil<T>(
  check: () => Promise<T | null | undefined | false>,
  opts: PollOptions = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const start = Date.now();
  let attempt = 0;

  while (true) {
    opts.onAttempt?.(attempt);
    const result = await check();
    if (result) return result as T;
    attempt += 1;
    const elapsed = Date.now() - start;
    if (elapsed + intervalMs > timeoutMs) {
      throw new PollTimeoutError(
        `pollUntil timed out after ${attempt} attempt(s) in ${elapsed}ms`,
        attempt,
        elapsed,
      );
    }
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
