/**
 * Op computation — pure function of (plan, state, live-reads) → actions.
 * Shared between `diff` (prints the list) and `deploy` (executes it).
 *
 * Decisions per resource:
 *   - state has entry + live present + hash matches  → noop
 *   - state has entry + live present + hash differs  → recreate (v1 policy: delete+create)
 *   - state has entry + live absent                  → create (drifted; state points at a gone id)
 *   - state has no entry + live present              → adopt (update state; treat as create's effect)
 *   - state has no entry + live absent               → create
 *
 * Adoption is the "unmanaged resource already exists" case — e.g. a user
 * manually created the Connection. In v1 we adopt without asking. If that
 * becomes noisy we can guard it behind --adopt.
 */

import type { ResourceConstruct, DeployedRef } from "../core/app.js";
import type { Construct, Resource, ResourceContext } from "../core/construct.js";
import type { StackState, StateResource } from "../core/state.js";
import { substituteEnv, UnresolvedEnvError } from "../core/env.js";

export type OpKind = "noop" | "create" | "adopt" | "recreate";

export interface Op {
  readonly uniqueId: string;
  readonly kind: OpKind;
  readonly construct: Construct & ResourceConstruct;
  /** Present for recreate/noop/adopt — the id we already know. */
  readonly currentId?: string;
  /** Hash authored for this resource (what we'd persist after deploy). */
  readonly plannedHash: string;
}

export async function computeOp(
  ctx: ResourceContext,
  c: Construct & ResourceConstruct,
  state: StackState,
  deployed: ReadonlyMap<string, DeployedRef>,
  opts: { strictEnv?: boolean } = {},
): Promise<Op> {
  const entry: StateResource | undefined = state.resources[c.uniqueId];
  // resolveProps returns null when required deps aren't deployed yet — that's
  // expected at diff-time for second-and-later resources. Hash over the
  // authored props in that case; lookupByProps is skipped because it requires
  // fully-resolved props (e.g. ConnectionSchema needs connectionId).
  const resolvedRaw = c.resolveProps ? c.resolveProps(deployed) : c.props;
  // Apply env substitution. deploy passes strictEnv:true so missing secrets
  // surface as a clear error before any API write. diff passes strictEnv:false
  // so it works offline-ish — hash still reflects authored (unresolved) props.
  let resolved: unknown = resolvedRaw;
  if (resolvedRaw) {
    try {
      resolved = substituteEnv(resolvedRaw);
    } catch (err) {
      if (err instanceof UnresolvedEnvError && !opts.strictEnv) {
        // Leave the ${env.X} tokens in place for hashing; lookupByProps may
        // still work when its required inputs aren't token-substituted.
        resolved = resolvedRaw;
      } else {
        throw err;
      }
    }
  }
  const hashInput = resolved ?? c.props;
  const plannedHash = c.resource.hash(hashInput);

  if (entry?.salesforceId) {
    const live = await c.resource.read(ctx, entry.salesforceId);
    if (!live) {
      return { uniqueId: c.uniqueId, kind: "create", construct: c, plannedHash };
    }
    if (c.resource.isFailed?.(live)) {
      // Live resource is in a terminal-failed state the API can't recover
      // (e.g. DataStream status=ERROR). Recreate unconditionally — even if
      // the hash matches, there's no other way back to a healthy state.
      return {
        uniqueId: c.uniqueId,
        kind: "recreate",
        construct: c,
        currentId: c.resource.idOf(live),
        plannedHash,
      };
    }
    if (entry.hash === plannedHash) {
      return {
        uniqueId: c.uniqueId,
        kind: "noop",
        construct: c,
        currentId: c.resource.idOf(live),
        plannedHash,
      };
    }
    return {
      uniqueId: c.uniqueId,
      kind: "recreate",
      construct: c,
      currentId: c.resource.idOf(live),
      plannedHash,
    };
  }

  // No state entry — try to look up by props before issuing a create.
  // Only attempt when props are fully resolved.
  if (resolved && c.resource.lookupByProps) {
    const byProps = await c.resource.lookupByProps(ctx, resolved as never);
    if (byProps) {
      // If the found resource is in a failed state, don't adopt it —
      // recreate. Otherwise we'd adopt a broken resource and never heal.
      if (c.resource.isFailed?.(byProps)) {
        return {
          uniqueId: c.uniqueId,
          kind: "recreate",
          construct: c,
          currentId: c.resource.idOf(byProps),
          plannedHash,
        };
      }
      // Drift check — if the live resource's key fields don't match what's
      // authored (e.g. a DMO with category=ENGAGEMENT when the manifest
      // says Other), adopting would leave the DMO as-is and silently
      // return noop on future diffs. Force a recreate instead.
      const matches =
        !c.resource.matchesAuthored ||
        c.resource.matchesAuthored(byProps, resolved as never);
      if (!matches) {
        return {
          uniqueId: c.uniqueId,
          kind: "recreate",
          construct: c,
          currentId: c.resource.idOf(byProps),
          plannedHash,
        };
      }
      return {
        uniqueId: c.uniqueId,
        kind: "adopt",
        construct: c,
        currentId: c.resource.idOf(byProps),
        plannedHash,
      };
    }
  }
  return { uniqueId: c.uniqueId, kind: "create", construct: c, plannedHash };
}

/**
 * Helper used by ops formatting / diff printing. Safe without talking to the org.
 */
export function summarizeOps(ops: readonly Op[]): string {
  const counts: Record<OpKind, number> = { noop: 0, create: 0, adopt: 0, recreate: 0 };
  for (const op of ops) counts[op.kind] += 1;
  return `${counts.create} create, ${counts.recreate} recreate, ${counts.adopt} adopt, ${counts.noop} noop`;
}

/**
 * Blast-radius analysis. v1 policy is delete-and-recreate on drift, so any
 * `recreate` op cascades to every transitive dependent in the DAG — the
 * children's stored salesforceIds point at resources that will be torn down
 * with the parent.
 *
 * Returns a map: parent uniqueId → list of dependent uniqueIds that will also
 * recreate as a consequence. Dependencies computed from the resources' own
 * `dependsOn` edges (same edges the deploy topo-sort uses).
 *
 * Callers (diff, deploy) use this to:
 *   - surface a warning listing cascading recreates
 *   - gate deploy behind `--force` or interactive confirmation when the
 *     cascade size is 2+ (arbitrary threshold; one is normal drift churn).
 */
export function computeBlastRadius(
  ops: readonly Op[],
  dependents: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const byId = new Map(ops.map((op) => [op.uniqueId, op]));
  const out = new Map<string, string[]>();
  for (const op of ops) {
    if (op.kind !== "recreate") continue;
    const cascade: string[] = [];
    const stack = [...(dependents.get(op.uniqueId) ?? [])];
    const seen = new Set<string>([op.uniqueId]);
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      // Only cascade through resources that are actually in the plan.
      if (!byId.has(next)) continue;
      cascade.push(next);
      for (const child of dependents.get(next) ?? []) stack.push(child);
    }
    if (cascade.length > 0) out.set(op.uniqueId, cascade);
  }
  return out;
}

/**
 * Build a dependents map (parent → child[]) from dependsOn edges (child → parent[]).
 * Separate function so it can be reused by diff, deploy, and tests.
 */
export function buildDependentsMap(
  resources: ReadonlyArray<Construct & ResourceConstruct>,
): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const r of resources) {
    for (const dep of r.dependsOn) {
      const arr = dependents.get(dep.uniqueId) ?? [];
      arr.push(r.uniqueId);
      dependents.set(dep.uniqueId, arr);
    }
  }
  return dependents;
}

/** The resource interface, re-exported so CLI code doesn't need a deep import. */
export type { Resource };
