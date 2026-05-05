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
): Promise<Op> {
  const entry: StateResource | undefined = state.resources[c.uniqueId];
  // resolveProps returns null when required deps aren't deployed yet — that's
  // expected at diff-time for second-and-later resources. Hash over the
  // authored props in that case; lookupByProps is skipped because it requires
  // fully-resolved props (e.g. ConnectionSchema needs connectionId).
  const resolved = c.resolveProps ? c.resolveProps(deployed) : c.props;
  const hashInput = resolved ?? c.props;
  const plannedHash = c.resource.hash(hashInput);

  if (entry?.salesforceId) {
    const live = await c.resource.read(ctx, entry.salesforceId);
    if (!live) {
      return { uniqueId: c.uniqueId, kind: "create", construct: c, plannedHash };
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

/** The resource interface, re-exported so CLI code doesn't need a deep import. */
export type { Resource };
