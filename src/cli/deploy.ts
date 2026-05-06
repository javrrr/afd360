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
import {
  computeOp,
  summarizeOps,
  buildDependentsMap,
  computeBlastRadius,
  type Op,
  type OpKind,
} from "./ops.js";
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
    .action(async (opts: { config: string; org?: string; force?: boolean }) => {
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
              if (op.currentId) {
                const existing = state.resources[c.uniqueId];
                deployed.set(c.uniqueId, {
                  salesforceId: op.currentId,
                  apiName: existing?.apiName ?? c.id,
                });
              }
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
              state.resources[c.uniqueId] = stateEntry(c, op.currentId!, apiName, op.plannedHash, state.resources[c.uniqueId]);
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
              await maybeWaitReady(ctx, c, output);
              const id = c.resource.idOf(output);
              const apiName = apiNameFromOutput(output, c.id);
              deployed.set(c.uniqueId, { salesforceId: id, apiName });
              state.resources[c.uniqueId] = stateEntry(c, id, apiName, op.plannedHash, undefined);
              wrote += 1;
              break;
            }
            case "create": {
              process.stdout.write(`  ${pc.green("create")}   ${c.uniqueId}\n`);
              const output = await c.resource.create(ctx, resolved as never);
              await maybeWaitReady(ctx, c, output);
              const id = c.resource.idOf(output);
              const apiName = apiNameFromOutput(output, c.id);
              deployed.set(c.uniqueId, { salesforceId: id, apiName });
              state.resources[c.uniqueId] = stateEntry(c, id, apiName, op.plannedHash, state.resources[c.uniqueId]);
              wrote += 1;
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
    });
}

function stateEntry(
  c: Construct & ResourceConstruct,
  id: string,
  apiName: string,
  hash: string,
  prev: StateResource | undefined,
): StateResource {
  const now = new Date().toISOString();
  const entry: StateResource = {
    type: c.resource.type,
    apiName,
    salesforceId: id,
    hash,
    createdAt: prev?.createdAt ?? now,
  };
  if (prev) entry.updatedAt = now;
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
  await pollUntil<true>(
    async () => ((await c.resource.isReady!(ctx, output as never)) ? true : null),
    { intervalMs, timeoutMs },
  );
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
