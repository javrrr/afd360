import type { ResourceContext } from "../core/construct.js";
import type { StackState } from "../core/state.js";
import { topologicalSort, CycleError } from "../core/graph.js";
import { RESOURCE_REGISTRY, pruneTypeRank } from "../resources/registry.js";
import type { Orphan } from "./ops.js";

/**
 * Delete order for a set of orphan uniqueIds: dependents before the resources
 * they depend on (children first), exactly as `destroy` tears down — the
 * platform 412s when deleting a resource a live dependent still references.
 *
 * The orphans' constructs are gone, so the live `dependsOn` graph is gone too.
 * We reconstruct edges from `StateResource.dependsOn` (persisted at deploy
 * time). Edge direction matches deploy/diff: `from` = dependency (parent),
 * `to` = dependent (child); topo-sort yields parents-first, reversed here to
 * children-first.
 *
 * Nodes are pre-sorted by descending type priority so that AFTER the reverse,
 * independent orphans (no recorded edge between them, e.g. legacy state with no
 * `dependsOn`) come out in `PRUNE_TYPE_PRIORITY` order — a safe fallback, since
 * orphans with no dependency path can be deleted in any relative order.
 */
export function computePruneOrder(
  uids: readonly string[],
  state: StackState,
): string[] {
  const set = new Set(uids);
  const rank = (uid: string): number => pruneTypeRank(state.resources[uid]?.type ?? "");
  // Descending rank so the post-reverse output is ascending (type-priority) order.
  const nodes = [...uids].sort((a, b) => rank(b) - rank(a));
  const edges: { from: string; to: string }[] = [];
  for (const uid of uids) {
    for (const dep of state.resources[uid]?.dependsOn ?? []) {
      if (set.has(dep)) edges.push({ from: dep, to: uid });
    }
  }
  try {
    return topologicalSort({ nodes, edges }).reverse();
  } catch (err) {
    // A cycle in last-known edges shouldn't happen (the manifest graph was a
    // DAG), but never fail prune on it — fall back to pure type-priority order.
    if (err instanceof CycleError) {
      return [...uids].sort((a, b) => rank(a) - rank(b));
    }
    throw err;
  }
}

/**
 * Delete the OWNED orphans (kind === "prune") from the org in dependency order,
 * dropping each from `state.resources` as it goes. Dispatches through
 * `RESOURCE_REGISTRY[type].delete`, reusing every per-resource delete quirk.
 *
 * Mutates `state` in place; the caller persists it (inside a try/finally so a
 * mid-prune failure still records the deletes that completed). Returns the
 * number of resources deleted.
 *
 * Not-owned (`forget`) and stale orphans are NOT touched here — prune only ever
 * deletes what afd360 created; untracking a not-owned resource is `forget`'s job.
 */
export async function executePrune(
  ctx: ResourceContext,
  orphans: readonly Orphan[],
  state: StackState,
  log: (line: string) => void,
): Promise<number> {
  const prunable = orphans.filter((o) => o.kind === "prune");
  if (prunable.length === 0) return 0;
  const order = computePruneOrder(
    prunable.map((o) => o.uniqueId),
    state,
  );
  let deleted = 0;
  for (const uid of order) {
    const entry = state.resources[uid];
    if (!entry) continue; // defensive — already removed
    const resource = RESOURCE_REGISTRY[entry.type];
    if (!resource) {
      log(`  skip     ${uid} — unknown resource type "${entry.type}"; forget it manually`);
      continue;
    }
    if (!entry.salesforceId) {
      // No live id (shouldn't occur for kind "prune", which requires one) —
      // nothing to delete, just untrack.
      delete state.resources[uid];
      continue;
    }
    log(`  prune    ${uid}`);
    await resource.delete(ctx, entry.salesforceId);
    delete state.resources[uid];
    deleted += 1;
  }
  return deleted;
}
