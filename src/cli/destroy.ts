import { Command } from "commander";
import pc from "picocolors";
import { loadApp } from "./load-config.js";
import { getSession } from "../client/auth.js";
import { createClient } from "../client/factory.js";
import { readState, writeState } from "../core/state.js";
import { reverseTopologicalSort, topologicalSort } from "../core/graph.js";
import { isResourceConstruct } from "../core/app.js";
import type { ResourceConstruct, DeployedRef } from "../core/app.js";
import type { Construct, ResourceContext } from "../core/construct.js";
import { substituteEnv, UnresolvedEnvError } from "../core/env.js";

const DEFAULT_CONFIG = "afd360.config.ts";

export function registerDestroy(program: Command): void {
  program
    .command("destroy")
    .description("Remove everything this manifest manages from the org")
    .option("-c, --config <path>", "path to afd360.config.ts", DEFAULT_CONFIG)
    .option("-o, --org <alias>", "override stack targetOrg")
    .action(async (opts: { config: string; org?: string }) => {
      const app = await loadApp(opts.config);
      if (app.stacks.length !== 1) {
        throw new Error(
          `afd360 v1 supports one stack per config; found ${app.stacks.length}.`,
        );
      }
      const stack = app.stacks[0]!;
      const orgAlias = opts.org ?? stack.targetOrg;

      const session = await getSession(orgAlias);
      const client = createClient(session);
      const ctx: ResourceContext = { client, session, orgAlias };

      const state = await readState(orgAlias, stack.id);
      const resources = collectResources(stack);
      const edges = resources.flatMap((r) =>
        r.dependsOn.map((d) => ({ from: d.uniqueId, to: r.uniqueId })),
      );
      const nodes = resources.map((r) => r.uniqueId);
      const reverseOrder = reverseTopologicalSort({ nodes, edges });
      const forwardOrder = topologicalSort({ nodes, edges });
      const byId = new Map(resources.map((r) => [r.uniqueId, r]));

      process.stdout.write(`${pc.bold("destroy")} ${orgAlias} (${stack.id})\n`);

      // Pre-pass: orphan adoption (see adoptOrphans for full rationale).
      await adoptOrphans({
        ctx,
        state,
        resourcesByUid: byId,
        forwardOrder,
        log: (uid, id) => process.stdout.write(`  ${pc.yellow("adopt")}  ${uid} (orphan ${id})\n`),
      });

      try {
        for (const uid of reverseOrder) {
          const c = byId.get(uid)!;
          const entry = state.resources[uid];
          if (!entry?.salesforceId) {
            process.stdout.write(`  ${pc.gray("skip")}   ${uid} (not on org)\n`);
            continue;
          }
          process.stdout.write(`  ${pc.red("delete")} ${uid}\n`);
          await c.resource.delete(ctx, entry.salesforceId);
          delete state.resources[uid];
        }
      } finally {
        // Persist whatever progress we made even on crash, so the next
        // destroy run doesn't re-attempt already-deleted resources.
        state.lastDeployedAt = new Date().toISOString();
        await writeState(orgAlias, state);
      }
      process.stdout.write(`${pc.bold("done")}  state cleared.\n`);
    });
}

function collectResources(scope: Construct): Array<Construct & ResourceConstruct> {
  const out: Array<Construct & ResourceConstruct> = [];
  const walk = (c: Construct): void => {
    if (isResourceConstruct(c)) out.push(c);
    for (const child of c.children) walk(child);
  };
  walk(scope);
  return out;
}

/**
 * Walk the construct graph forward (parents → children), and for each
 * resource that has no state entry, try `lookupByProps` to discover an
 * orphan on the org. If found, synthesize a state entry so the
 * reverse-order delete loop picks it up.
 *
 * This addresses the common destroy-blocker scenario: a previous deploy
 * crashed mid-loop, state has the parent (e.g. DMO) but is missing
 * children (e.g. SearchIndex). On destroy, the orphan SearchIndex
 * references the DMO and the DMO delete 412s with
 * MATCH_PRECONDITION_FAILED. Adopting first lets us delete the orphan,
 * which clears the blocker.
 *
 * Exported for testability.
 */
export async function adoptOrphans(args: {
  ctx: ResourceContext;
  state: import("../core/state.js").StackState;
  resourcesByUid: ReadonlyMap<string, Construct & ResourceConstruct>;
  forwardOrder: ReadonlyArray<string>;
  log?: (uid: string, salesforceId: string) => void;
}): Promise<void> {
  const { ctx, state, resourcesByUid, forwardOrder, log } = args;
  const adoptedDeployed = new Map<string, DeployedRef>(
    Object.entries(state.resources)
      .filter(([, v]) => v.salesforceId)
      .map(([k, v]) => [k, { salesforceId: v.salesforceId!, apiName: v.apiName }]),
  );
  for (const uid of forwardOrder) {
    const c = resourcesByUid.get(uid);
    if (!c) continue;
    if (state.resources[uid]?.salesforceId) continue;
    if (!c.resource.lookupByProps) continue;
    const rawResolved = c.resolveProps ? c.resolveProps(adoptedDeployed) : c.props;
    if (!rawResolved) continue; // parent not yet adopted → can't look up
    let resolved: unknown = rawResolved;
    try {
      resolved = substituteEnv(rawResolved);
    } catch (err) {
      if (err instanceof UnresolvedEnvError) continue;
      throw err;
    }
    const found = await c.resource.lookupByProps(ctx, resolved as never);
    if (!found) continue;
    const id = c.resource.idOf(found);
    const apiName = (found as { name?: string; apiName?: string }).name
      ?? (found as { apiName?: string }).apiName
      ?? c.id;
    log?.(uid, id);
    state.resources[uid] = {
      type: c.resource.type,
      apiName,
      salesforceId: id,
      hash: "sha256:adopted-for-destroy",
      createdAt: new Date().toISOString(),
    };
    adoptedDeployed.set(uid, { salesforceId: id, apiName });
  }
}
