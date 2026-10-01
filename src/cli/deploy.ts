import { Command } from "commander";
import pc from "picocolors";
import { loadApp } from "./load-config.js";
import { getSession } from "../client/auth.js";
import { createClient } from "../client/factory.js";
import {
  readState,
  writeState,
  type StackState,
  type StateResource,
} from "../core/state.js";
import { topologicalSort } from "../core/graph.js";
import { isResourceConstruct } from "../core/app.js";
import type { ResourceConstruct, DeployedRef } from "../core/app.js";
import type { Construct, ResourceContext } from "../core/construct.js";
import { isProtected } from "../core/construct.js";
import { applyMoves } from "../core/moves.js";
import {
  computeOp,
  summarizeOps,
  buildDependentsMap,
  computeBlastRadius,
  computeRecreateDrainOrder,
  collectOrphans,
  orphanNote,
  type Op,
  type OpKind,
} from "./ops.js";
import { executePrune } from "./prune.js";
import { createInterface } from "node:readline";
import { pollUntil } from "../core/poll.js";
import { substituteEnv } from "../core/env.js";

const DEFAULT_CONFIG = "afd360.config.ts";

export function registerDeploy(program: Command): void {
  program
    .command("deploy")
    .description("Apply the manifest to an org (idempotent)")
    .option("-c, --config <path>", "path to afd360.config.ts", DEFAULT_CONFIG)
    .option("-o, --org <alias>", "override stack targetOrg")
    .option(
      "--force",
      "proceed without confirmation when a recreate cascades to 2+ downstream resources",
    )
    .option(
      "--prune",
      "after applying, DELETE owned resources removed from the manifest (orphans)",
    )
    .option(
      "--yes",
      "skip the prune confirmation prompt (for non-interactive use with --prune)",
    )
    .action(
      async (opts: {
        config: string;
        org?: string;
        force?: boolean;
        prune?: boolean;
        yes?: boolean;
      }) => {
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
      // Apply declared renames (Stack `moved`) before planning so a renamed
      // construct re-keys its state entry rather than orphaning the old id and
      // creating a new one. Idempotent across deploys. Logged after the header.
      const movedApplied = applyMoves(state, stack.moved);
      const resources = collectResources(stack);
      const order = topologicalSort({
        nodes: resources.map((r) => r.uniqueId),
        edges: resources.flatMap((r) =>
          r.dependsOn.map((d) => ({ from: d.uniqueId, to: r.uniqueId })),
        ),
      });
      const byId = new Map(resources.map((r) => [r.uniqueId, r]));
      const deployed = new Map<string, DeployedRef>(
        Object.entries(state.resources)
          .filter(([, v]) => v.salesforceId)
          .map(([k, v]) => [
            k,
            { salesforceId: v.salesforceId!, apiName: v.apiName },
          ]),
      );

      process.stdout.write(`${pc.bold("deploy")} ${orgAlias} (${stack.id})\n`);
      for (const m of movedApplied) {
        process.stdout.write(`  ${pc.cyan("moved")}  ${m.from} ${pc.gray("→")} ${m.to}\n`);
      }

      // Blast-radius pre-check: compute ops once with the initial deployed
      // map so we can warn on cascading recreates before issuing any writes.
      // This is a read-only pass (computeOp only calls GETs and lookupByProps);
      // the real execution loop below recomputes incrementally for accuracy.
      const previewOps: Op[] = [];
      for (const uid of order) {
        const c = byId.get(uid)!;
        previewOps.push(await computeOp(ctx, c, state, deployed, { strictEnv: true }));
      }
      const dependents = buildDependentsMap(resources);
      const cascades = computeBlastRadius(previewOps, dependents);
      const impactfulCascades = [...cascades.entries()].filter(
        ([, children]) => children.length >= 2,
      );
      if (impactfulCascades.length > 0) {
        process.stdout.write("\n");
        for (const [parent, children] of impactfulCascades) {
          process.stdout.write(
            pc.red(
              `  !! ${parent} — recreate will also recreate ${children.length} downstream resource${children.length === 1 ? "" : "s"}:\n`,
            ),
          );
          for (const child of children) {
            process.stdout.write(pc.red(`       ${child}\n`));
          }
        }
        process.stdout.write("\n");
        if (!opts.force) {
          const confirmed = await promptConfirm(
            `Proceed with destructive recreate? [y/N] `,
          );
          if (!confirmed) {
            process.stdout.write(
              `${pc.bold("abort")} deploy halted; re-run with --force to bypass confirmation.\n`,
            );
            return;
          }
        }
      }

      // Op computation must happen incrementally as we walk the topological
      // order — each resource's computeOp depends on the (up-to-date) deployed
      // map, which only gains parent entries once those parents finish.
      // Planning up-front would freeze an out-of-date deployed view for
      // second-and-later resources, turning their potential `adopt` into
      // a stale `create` (and running a redundant API write).
      //
      // The whole loop runs inside try/finally so partial progress gets
      // persisted to state even on mid-loop failure. Without this, a crash
      // after resource N succeeded but before resource N+1 could leave the
      // state file stale — and the next deploy would either double-create
      // (state missing entries) or skip (state has wrong id). Mirror the
      // destroy flow's try/finally (destroy.ts:~46).
      const ops: Op[] = [];
      let wrote = 0;
      try {
        // Cascading-recreate delete drain (finding: recreate delete-ordering
        // 412). A recreate is delete-then-create, and the platform blocks
        // deleting a resource a live dependent still references (412
        // MATCH_PRECONDITION_FAILED — e.g. a DMO under a CalculatedInsight /
        // SearchIndex / semantic model). The forward loop below deletes each
        // recreate root before it reaches the root's dependents, so we must
        // first delete those live dependents in reverse-topological order
        // (children first), exactly as `destroy` does. Each drained dependent
        // loses its state id + deployed entry, so the forward loop then
        // recreates it cleanly (computeOp sees no id + live gone → create).
        // Inside the try/finally so a mid-drain failure still persists the
        // deletes we did complete.
        const isDeletable = (uid: string): boolean => {
          const entry = state.resources[uid];
          if (!entry?.salesforceId) return false; // nothing live to delete
          const c = byId.get(uid);
          if (!c) return false;
          // Ownership gate — never delete a referenced (fromExisting) or merely
          // adopted (owned:false) resource, mirroring destroy's guards.
          if ((c as { isExisting?: boolean }).isExisting) return false;
          if (entry.owned === false) return false;
          return true;
        };
        const drainOrder = computeRecreateDrainOrder(
          cascades,
          [...order].reverse(),
          isDeletable,
        );
        for (const uid of drainOrder) {
          const c = byId.get(uid)!;
          const entry = state.resources[uid]!;
          process.stdout.write(
            `  ${pc.red("drain")}    ${uid} (recreate cascade — delete before parent)\n`,
          );
          await c.resource.delete(ctx, entry.salesforceId!);
          delete state.resources[uid];
          deployed.delete(uid);
        }

        for (const uid of order) {
          const c = byId.get(uid)!;
          const op = await computeOp(ctx, c, state, deployed, { strictEnv: true });
          ops.push(op);
          const rawResolved = c.resolveProps ? c.resolveProps(deployed) : c.props;
          if (!rawResolved && op.kind !== "noop") {
            throw new Error(
              `Deploy runner invariant broken: ${c.uniqueId} dependencies unresolved before its turn.`,
            );
          }
          // Substitute ${env.X} before any write. computeOp already did this
          // with strictEnv:true, so if we got here it's safe.
          const resolved = rawResolved ? substituteEnv(rawResolved) : rawResolved;
          switch (op.kind) {
            case "noop": {
              process.stdout.write(`  ${pc.gray("noop")}     ${c.uniqueId}\n`);
              const existing = state.resources[c.uniqueId];
              if (op.currentId && existing) {
                deployed.set(c.uniqueId, {
                  salesforceId: op.currentId,
                  apiName: existing.apiName ?? c.id,
                });
              } else if (op.currentId) {
                deployed.set(c.uniqueId, { salesforceId: op.currentId, apiName: c.id });
              }
              // Reconcile the RETAIN flag on the noop path too (see
              // reconcileProtected). Pure state edit, not an org write, so
              // `wrote` is untouched; the unconditional writeState in the
              // finally persists it.
              if (existing) reconcileProtected(existing, c);
              break;
            }
            case "adopt": {
              process.stdout.write(`  ${pc.yellow("adopt")}    ${c.uniqueId}\n`);
              // For adopt we need the live API name, not the authored one.
              // The caller already looked it up via lookupByProps — currentId is
              // the Salesforce id, and apiName comes from re-reading to be safe.
              const live = await c.resource.read(ctx, op.currentId!);
              const apiName = apiNameFromOutput(live, c.id);
              deployed.set(c.uniqueId, { salesforceId: op.currentId!, apiName });
              // adopt = the resource already existed; afd360 did not create it,
              // so record it as not-owned (owned:false). destroy leaves it be.
              state.resources[c.uniqueId] = stateEntry(c, op.currentId!, apiName, op.plannedHash, state.resources[c.uniqueId], false);
              wrote += 1;
              break;
            }
            case "recreate": {
              process.stdout.write(`  ${pc.red("recreate")} ${c.uniqueId}\n`);
              if (op.currentId) {
                await c.resource.delete(ctx, op.currentId);
                // Clear the stale id the moment the delete returns — if the
                // subsequent create fails (e.g. async-delete name lock, see
                // feedback_connection-recreate-duplicate-race.md), the next
                // deploy sees no id and falls through cleanly to create
                // instead of trying to read the gone resource first.
                delete state.resources[c.uniqueId];
              }
              const output = await c.resource.create(ctx, resolved as never);
              const id = c.resource.idOf(output);
              const apiName = apiNameFromOutput(output, c.id);
              // Persist state BEFORE the readiness poll. If isReady times
              // out (SearchIndex can take 15+ min), the resource is still
              // created on the org — the next deploy sees it in state, reads
              // it, hashes match → noop. Without this, a poll timeout leaves
              // the resource as an orphan that needs manual adoption.
              deployed.set(c.uniqueId, { salesforceId: id, apiName });
              // recreate = afd360 deleted the old resource and made a fresh one;
              // it owns the result.
              state.resources[c.uniqueId] = stateEntry(c, id, apiName, op.plannedHash, undefined, true);
              wrote += 1;
              await maybeWaitReady(ctx, c, output);
              break;
            }
            case "create": {
              process.stdout.write(`  ${pc.green("create")}   ${c.uniqueId}\n`);
              const output = await c.resource.create(ctx, resolved as never);
              const id = c.resource.idOf(output);
              const apiName = apiNameFromOutput(output, c.id);
              // Same pattern: persist before poll. See recreate comment.
              // create = afd360 provisioned it → owned.
              deployed.set(c.uniqueId, { salesforceId: id, apiName });
              state.resources[c.uniqueId] = stateEntry(c, id, apiName, op.plannedHash, state.resources[c.uniqueId], true);
              wrote += 1;
              await maybeWaitReady(ctx, c, output);
              break;
            }
            default: {
              const _exhaustive: never = op.kind;
              throw new Error(`Unknown op: ${String(_exhaustive)}`);
            }
          }
        }
      } finally {
        state.lastDeployedAt = new Date().toISOString();
        await writeState(orgAlias, state);
      }
      process.stdout.write(
        `${pc.bold("done")}  ${summarizeOps(ops)} — ${wrote} write${wrote === 1 ? "" : "s"}; state saved.\n`,
      );

      // Orphan handling. Orphans are state entries whose construct was removed
      // from the manifest. Safe by default: a plain deploy NEVER deletes one —
      // it warns and points at the remedy. `--prune` opts into deleting the
      // OWNED orphans (afd360 created them) after confirmation; not-owned /
      // stale orphans are never auto-deleted (that's `forget`'s job).
      const manifestIds = new Set(resources.map((r) => r.uniqueId));
      const orphans = collectOrphans(manifestIds, state);
      if (orphans.length > 0) {
        const prunable = orphans.filter((o) => o.kind === "prune");
        if (opts.prune && prunable.length > 0) {
          process.stdout.write(
            `\n${pc.red("prune")}  ${prunable.length} owned orphan${prunable.length === 1 ? "" : "s"} ` +
              `to delete from ${orgAlias}:\n`,
          );
          for (const o of prunable) process.stdout.write(`        ${o.uniqueId}\n`);
          const ok =
            opts.yes ||
            (await promptConfirm(
              `Delete ${prunable.length} owned orphan${prunable.length === 1 ? "" : "s"}? [y/N] `,
            ));
          if (ok) {
            // Own try/finally so a mid-prune failure still persists the deletes
            // that completed (mirrors the main deploy loop).
            try {
              const n = await executePrune(ctx, orphans, state, (line) =>
                process.stdout.write(pc.red(line) + "\n"),
              );
              process.stdout.write(
                `${pc.bold("done")}  pruned ${n} resource${n === 1 ? "" : "s"}; state saved.\n`,
              );
            } finally {
              await writeState(orgAlias, state);
            }
          } else {
            process.stdout.write(
              `${pc.bold("skip")}  prune declined; orphans left on the org.\n`,
            );
          }
        }
        // Re-warn about whatever orphans remain (all of them without --prune;
        // the not-owned / stale ones after a prune, since prune leaves those).
        const remaining = collectOrphans(manifestIds, state);
        if (remaining.length > 0) {
          process.stderr.write(
            `\n${pc.yellow("warn")}  ${remaining.length} resource${remaining.length === 1 ? "" : "s"} in state ` +
              `${remaining.length === 1 ? "is" : "are"} no longer in the manifest (not deleted):\n`,
          );
          for (const o of remaining) {
            process.stderr.write(`        ${o.uniqueId} ${pc.gray(`— ${orphanNote(o.kind)}`)}\n`);
          }
        }
      }
    });
}

/**
 * Reconcile the RETAIN flag of an EXISTING state entry against the construct's
 * current `protect()` status. Used on the `noop` deploy path.
 *
 * `stateEntry()` — the only other place `protected` is written — runs ONLY on
 * create/recreate/adopt. A resource whose shape is unchanged deploys as a noop,
 * which never rebuilds its state entry, so without this reconciliation the flag
 * is frozen at whatever the last WRITE recorded. The consequence found in Phase
 * 3 live validation: dropping `protect()` from an unchanged construct left a
 * stale `protected: true` in state forever, making the resource permanently
 * undeletable — and the "drop protect() to delete" hint a lie. Flipping protect
 * ON for an unchanged construct had the symmetric gap.
 *
 * Mutates in place: sets `protected: true` when flagged, deletes the key when
 * not (so a cleared flag leaves no residue). Pure state surgery — no org I/O.
 */
export function reconcileProtected(
  entry: StateResource,
  c: Construct & ResourceConstruct,
): void {
  if (isProtected(c)) entry.protected = true;
  else delete entry.protected;
}

export function stateEntry(
  c: Construct & ResourceConstruct,
  id: string,
  apiName: string,
  hash: string,
  prev: StateResource | undefined,
  owned: boolean,
): StateResource {
  const now = new Date().toISOString();
  const entry: StateResource = {
    type: c.resource.type,
    apiName,
    salesforceId: id,
    hash,
    createdAt: prev?.createdAt ?? now,
    // Provenance drives destroy: only owned resources are deleted. See
    // StateResource.owned. Always written explicitly so state is unambiguous.
    owned,
  };
  if (prev) entry.updatedAt = now;
  // Record last-known dependency edges so orphan prune can reverse-topo-sort
  // deletions after the constructs are removed from the manifest. Only when
  // non-empty, to keep leaf-resource entries clean.
  const deps = c.dependsOn.map((d) => d.uniqueId);
  if (deps.length > 0) entry.dependsOn = deps;
  // Persist the RETAIN marker so orphan prune honors it once the construct is
  // gone. Only when set, to keep entries clean.
  if (isProtected(c)) entry.protected = true;
  return entry;
}

/**
 * Extract the API-assigned dev name from a resource's output. Falls back to
 * the authored logical id when a resource output doesn't carry a `name` — e.g.
 * ConnectionSchema's composite id case, where the schemaName IS the name.
 */
function apiNameFromOutput(output: unknown, fallback: string): string {
  if (output && typeof output === "object") {
    const o = output as { name?: unknown; schemaName?: unknown };
    if (typeof o.name === "string" && o.name.length > 0) return o.name;
    if (typeof o.schemaName === "string" && o.schemaName.length > 0) return o.schemaName;
  }
  return fallback;
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
 * Resource-agnostic "wait until ready" hook. Runs the resource's isReady (if
 * any) in a pollUntil loop. Constructs can override the defaults via
 * `readyIntervalMs` / `readyTimeoutMs` fields — e.g. DataStream uses 2s × 60s,
 * ConnectionSchema uses 10s × 120s.
 *
 * A poll timeout does NOT throw — state is already persisted (the caller
 * writes state before calling this), so a timeout just means "the resource
 * was created but we couldn't confirm it reached READY within our budget."
 * The user sees a warning and the next deploy sees the resource in state,
 * reads its live status, and either noops (if it reached READY) or
 * surfaces the status via diff. This is a better UX than aborting the
 * whole deploy on a slow-but-healthy resource (SearchIndex on a freshly
 * mapped Snowflake DMO regularly takes 12–15 min).
 */
async function maybeWaitReady<T>(
  ctx: ResourceContext,
  c: Construct & ResourceConstruct,
  output: T,
): Promise<void> {
  if (!c.resource.isReady) return;
  const intervalMs =
    (c as { readyIntervalMs?: number }).readyIntervalMs ?? 2_000;
  const timeoutMs =
    (c as { readyTimeoutMs?: number }).readyTimeoutMs ?? 120_000;
  try {
    await pollUntil<true>(
      async () => ((await c.resource.isReady!(ctx, output as never)) ? true : null),
      { intervalMs, timeoutMs },
    );
  } catch (err) {
    // Terminal failures (e.g. SearchIndex FAILED, DataStream ERROR) are
    // thrown by isReady itself and should propagate — they're real errors
    // that need user attention. Poll *timeout* is different: the resource
    // is created and may still be converging.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("timed out")) {
      process.stderr.write(
        `${pc.yellow("warn")}  ${c.uniqueId} — readiness poll timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          `Resource was created; it may still be converging. ` +
          `Re-run \`afd360 diff\` or check the Data Cloud UI.\n`,
      );
      return;
    }
    throw err; // real failures (FAILED status, network errors) propagate
  }
}

/**
 * Minimal y/N confirmation prompt. Returns false (abort) in non-interactive
 * environments — CI-safe, since there's no user to answer. `--force` is the
 * escape hatch in scripts.
 */
async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export type { Op, OpKind };
