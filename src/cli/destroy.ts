import { Command } from "commander";
import { createInterface } from "node:readline";
import pc from "picocolors";
import { loadApp } from "./load-config.js";
import { getSession } from "../client/auth.js";
import { createClient } from "../client/factory.js";
import { readState, writeState } from "../core/state.js";
import { applyMoves } from "../core/moves.js";
import { reverseTopologicalSort, topologicalSort } from "../core/graph.js";
import { isResourceConstruct } from "../core/app.js";
import type { ResourceConstruct, DeployedRef } from "../core/app.js";
import type { Construct, ResourceContext } from "../core/construct.js";
import { isProtected } from "../core/construct.js";
import { substituteEnv, UnresolvedEnvError } from "../core/env.js";

const DEFAULT_CONFIG = "afd360.config.ts";

export function registerDestroy(program: Command): void {
  program
    .command("destroy")
    .description("Remove everything this manifest manages from the org")
    .option("-c, --config <path>", "path to afd360.config.ts", DEFAULT_CONFIG)
    .option("-o, --org <alias>", "override stack targetOrg")
    .option(
      "-y, --yes",
      "skip the confirmation prompt (required for non-interactive / CI teardown)",
    )
    .option("--force", "alias for --yes")
    .action(async (opts: { config: string; org?: string; yes?: boolean; force?: boolean }) => {
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
      // Re-key any declared renames before planning the teardown, so a moved
      // construct's live resource is matched (and deleted) under its new id
      // rather than stranded as an orphan under the old one.
      const movedApplied = applyMoves(state, stack.moved);
      const resources = collectResources(stack);
      const edges = resources.flatMap((r) =>
        r.dependsOn.map((d) => ({ from: d.uniqueId, to: r.uniqueId })),
      );
      const nodes = resources.map((r) => r.uniqueId);
      const reverseOrder = reverseTopologicalSort({ nodes, edges });
      const forwardOrder = topologicalSort({ nodes, edges });
      const byId = new Map(resources.map((r) => [r.uniqueId, r]));

      process.stdout.write(`${pc.bold("destroy")} ${orgAlias} (${stack.id})\n`);
      for (const m of movedApplied) {
        process.stdout.write(`  ${pc.cyan("moved")}  ${m.from} ${pc.gray("→")} ${m.to}\n`);
      }

      // Pre-pass: orphan adoption (see adoptOrphans for full rationale). This
      // is read-only + in-memory state synthesis — no deletes happen yet, so
      // it's safe to run before the confirmation gate below.
      await adoptOrphans({
        ctx,
        state,
        resourcesByUid: byId,
        forwardOrder,
        log: (uid, id) => process.stdout.write(`  ${pc.yellow("adopt")}  ${uid} (orphan ${id})\n`),
      });

      // Confirmation gate. destroy is delete-and-recreate and not reversible,
      // so require an explicit go-ahead before the first delete. --force skips
      // it (the CI/automation escape hatch); in a non-TTY without --force the
      // prompt can't be answered, so promptConfirm returns false and we abort
      // rather than tear down unattended — the guard is an explicit flag, not
      // the absence of a prompt.
      const toDeleteCount = reverseOrder.filter(
        (uid) => state.resources[uid]?.salesforceId,
      ).length;
      const skipConfirm = opts.yes || opts.force;
      if (toDeleteCount > 0 && !skipConfirm) {
        const confirmed = await promptConfirm(
          `${pc.yellow("!")} This deletes ${pc.bold(String(toDeleteCount))} resource(s) from ` +
            `${pc.bold(orgAlias)} (stack "${stack.id}") and cannot be undone.\n` +
            `  Type 'yes' to proceed: `,
        );
        if (!confirmed) {
          process.stdout.write(
            `${pc.bold("abort")} nothing deleted; re-run with --yes for non-interactive teardown.\n`,
          );
          return;
        }
      }

      let protectedCount = 0;
      try {
        for (const uid of reverseOrder) {
          const c = byId.get(uid)!;
          const entry = state.resources[uid];
          if (!entry?.salesforceId) {
            process.stdout.write(`  ${pc.gray("skip")}   ${uid} (not on org)\n`);
            continue;
          }
          // Referenced-but-not-owned resources (e.g. Connection.fromExisting
          // wrapping the built-in Salesforce_Home) must survive destroy. Drop
          // the state entry so the reference stops being tracked, but never
          // issue the delete. The resource's delete is a no-op too — this is
          // the honest log.
          if ((c as { isExisting?: boolean }).isExisting) {
            process.stdout.write(`  ${pc.gray("skip")}   ${uid} (referenced, not owned)\n`);
            delete state.resources[uid];
            continue;
          }
          // Adopted resources (owned:false) pre-existed on the org — afd360
          // recorded them but did not create them (e.g. a `create` that
          // idempotently resolved to a platform-provisioned Home stream).
          // Deleting them would exceed our blast radius, so leave them and
          // just stop tracking. Legacy state files predate `owned` and are
          // treated as owned (deleted) for back-compat.
          if (entry.owned === false) {
            process.stdout.write(`  ${pc.gray("skip")}   ${uid} (adopted, not owned)\n`);
            delete state.resources[uid];
            continue;
          }
          // Protected (RETAIN) resources survive destroy — the user flagged the
          // construct with `protect()` (live) or it was flagged at its last
          // deploy (persisted as entry.protected). Unlike the not-owned skips
          // above, KEEP the state entry: the resource is still owned and still
          // tracked; we're only declining to delete it. Drop the protect() flag
          // to tear it down.
          if (isProtected(c) || entry.protected === true) {
            process.stdout.write(`  ${pc.cyan("skip")}   ${uid} (protected)\n`);
            protectedCount += 1;
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
      // A protected entry is retained (kept in state + on-org), so "state
      // cleared" would be a lie when any survive. Report the honest residual.
      if (protectedCount > 0) {
        process.stdout.write(
          `${pc.bold("done")}  ${protectedCount} protected resource${protectedCount === 1 ? "" : "s"} retained ` +
            `(drop protect() + redeploy to clear, then destroy); rest torn down.\n`,
        );
      } else {
        process.stdout.write(`${pc.bold("done")}  state cleared.\n`);
      }
    });
}

/**
 * Minimal confirmation prompt. Returns false (abort) in non-interactive
 * environments — CI-safe, since there's no user to answer; --yes/--force is
 * the escape hatch in scripts. Mirrors deploy.ts's promptConfirm so the two
 * commands behave identically. Accepts "yes" (destroy is destructive, so we
 * require the full word rather than a bare "y").
 */
export async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^yes$/i.test(answer.trim());
  } finally {
    rl.close();
  }
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
