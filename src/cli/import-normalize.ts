/**
 * Logical-id normalization for `afd360 import`. Many org-local names carry a
 * generated suffix (UUID fragments, short hex blobs, digit counters) that
 * would churn on every scratch-org refresh. The imported manifest should key
 * resources on a stable base; the original name is preserved in state.
 *
 * Examples observed on jaygentforce 2026-05-05:
 *   - `NTO_Products_tddoas_50ccbe07_7a07_466b_a43f_514fb01de06d` — IngestApi
 *     connection name. Trailing UUID-5 chain.
 *   - `AgentOpt_fac25829_be36_44d3_859d_26be3a611a76` — same shape.
 *   - `NTO_GoodsProduct_Search_tddogb` — tdc-style 5-char tail.
 *   - `AgentOpt_Tag_03837773` — digit counter.
 *
 * Strategy: apply patterns in priority order, stop at first match. Always
 * keep *some* base (don't eat a name down to nothing).
 */

/**
 * Returns the normalized logical id, or the original when nothing matches.
 * Pure function — no I/O.
 *
 * Design notes:
 *   - UUID-fragment tail (`_XXXXXXXX_XXXX_XXXX_XXXX_XXXXXXXXXXXX`) is matched
 *     first — it's the most distinctive pattern.
 *   - Generic hex tail (4+ hex chars at end) is second.
 *   - Digit tail (4+ digits) is last.
 *   - We require 4+ so legitimate short suffixes ("_v1", "_v2") survive.
 */
export function normalizeLogicalId(apiName: string): string {
  const MIN_PREFIX = 3;

  // UUID-5 tail: _XXXXXXXX_XXXX_XXXX_XXXX_XXXXXXXXXXXX. Unambiguous pattern;
  // always safe to strip.
  const uuid5 = apiName.match(
    /^(.+?)_[a-f0-9]{8}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{12}$/i,
  );
  if (uuid5 && uuid5[1]!.length >= 1) return uuid5[1]!;

  // Digit tail: _<4+ digits>. Also unambiguous — nobody meaningfully
  // suffixes an api name with a 4+ digit integer on purpose.
  const digits = apiName.match(/^(.+?)_\d{4,}$/);
  if (digits && digits[1]!.length >= MIN_PREFIX) return digits[1]!;

  // NOTE on short "hex-ish" tails: tdc-style names like `NTO_GoodsProduct_
  // Search_tddogb` use a 5-6 char lowercase-alphanumeric suffix. A regex for
  // that pattern also matches legitimate word-suffixed names like
  // `cdp_data_javier` — we can't reliably distinguish without a dictionary.
  // v1 leaves these alone; users can pass --preserve-names or hand-edit the
  // emitted manifest. If this becomes a real pain we can revisit with a
  // more targeted pattern (e.g. "tail contains no vowels" for short hex).
  return apiName;
}

/**
 * Detect collisions where two API names normalize to the same base. Callers
 * halt import and surface the list so the user can decide (typically they'll
 * re-run with `--preserve-names`).
 */
export function detectCollisions(
  apiNames: ReadonlyArray<string>,
): Map<string, string[]> {
  const byLogical = new Map<string, string[]>();
  for (const apiName of apiNames) {
    const logical = normalizeLogicalId(apiName);
    const arr = byLogical.get(logical) ?? [];
    arr.push(apiName);
    byLogical.set(logical, arr);
  }
  const collisions = new Map<string, string[]>();
  for (const [logical, apiNamesAtBase] of byLogical) {
    if (apiNamesAtBase.length > 1) collisions.set(logical, apiNamesAtBase);
  }
  return collisions;
}

/**
 * Default namespace skip list. Users can extend via `--include-namespace <ns>`
 * later; v1 is opinionated about what's org-local platform metadata vs.
 * user-authored.
 */
export const SKIP_PREFIXES: ReadonlyArray<string> = [
  "ssot__",              // Core Data Cloud standard DMOs + their connections
  "cdp_crm_dk1__",       // DK-assigned CRM extensions
  "cdpactvstrgptnr__",   // Activation partner namespace
  "einstein__",          // Einstein-provisioned resources
  "sfdc__",              // Internal SFDC namespace
];

export function shouldSkip(apiName: string, extraPrefixes: ReadonlyArray<string> = []): boolean {
  const all = [...SKIP_PREFIXES, ...extraPrefixes];
  return all.some((p) => apiName.startsWith(p));
}
