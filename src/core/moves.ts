import type { StackState } from "./state.js";

/**
 * A declared construct rename. The resource previously tracked in state under
 * `from` (a uniqueId, exactly as it appears in `afd360 diff` / the state file)
 * is the SAME resource now authored under `to`. afd360 re-keys the state entry
 * instead of pruning the old id and creating a fresh one — the delete+create a
 * rename would otherwise produce (planning is keyed on uniqueId, so a renamed
 * construct reads as "old orphaned, new created").
 *
 * Declared on the Stack (`new Stack(app, id, { targetOrg, moved: [...] })`).
 * Analog: Terraform `moved` block, Pulumi `aliases`, CDK logical-id override.
 */
export interface MovedEntry {
  /** uniqueId the resource was tracked under before the rename. */
  readonly from: string;
  /** uniqueId it's authored under now (must match a current construct). */
  readonly to: string;
}

/** A move that actually re-keyed a state entry this run (for logging). */
export interface AppliedMove {
  readonly from: string;
  readonly to: string;
}

/**
 * Apply declared renames to a state object IN PLACE: re-key each `from` entry
 * to `to`, then fix up `dependsOn` references across every remaining entry so
 * prune ordering stays correct in the same run.
 *
 * - **Idempotent.** A move whose `from` is absent (already applied on a prior
 *   deploy, or never tracked) is skipped silently — so the `moved` entry can
 *   stay in the manifest across deploys without re-triggering.
 * - **Safe.** Throws when BOTH `from` and `to` already exist in state: the
 *   target id is a distinct tracked resource and re-keying would clobber it.
 *   The user resolves the collision (remove one, or `forget` the target) first.
 * - **No-op `from === to`** is ignored.
 *
 * Returns the moves that actually re-keyed an entry.
 */
export function applyMoves(
  state: StackState,
  moves: readonly MovedEntry[],
): AppliedMove[] {
  const applied: AppliedMove[] = [];
  for (const { from, to } of moves) {
    if (from === to) continue;
    const fromEntry = state.resources[from];
    if (!fromEntry) continue; // already moved / never tracked — idempotent no-op
    if (state.resources[to]) {
      throw new Error(
        `moved: cannot rename "${from}" → "${to}" — both exist in state. ` +
          `The target id is already a tracked resource; resolve the collision ` +
          `(remove one from the manifest, or \`afd360 forget "${to}"\`) before moving.`,
      );
    }
    state.resources[to] = fromEntry;
    delete state.resources[from];
    applied.push({ from, to });
  }
  if (applied.length > 0) {
    const remap = new Map(applied.map((m) => [m.from, m.to] as const));
    for (const entry of Object.values(state.resources)) {
      if (!entry.dependsOn) continue;
      entry.dependsOn = entry.dependsOn.map((d) => remap.get(d) ?? d);
    }
  }
  return applied;
}
