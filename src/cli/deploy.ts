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
import type { ResourceConstruct } from "../core/app.js";
import type { Construct, ResourceContext } from "../core/construct.js";
import {
  computeOp,
  summarizeOps,
  type Op,
  type OpKind,
} from "./ops.js";
import {
  ConnectionSchemaResource,
  waitForSchemaReady,
} from "../resources/connection-schema.js";

const DEFAULT_CONFIG = "afd360.config.ts";

export function registerDeploy(program: Command): void {
  program
    .command("deploy")
    .description("Apply the manifest to an org (idempotent)")
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
      const order = topologicalSort({
        nodes: resources.map((r) => r.uniqueId),
        edges: resources.flatMap((r) =>
          r.dependsOn.map((d) => ({ from: d.uniqueId, to: r.uniqueId })),
        ),
      });
      const byId = new Map(resources.map((r) => [r.uniqueId, r]));
      const deployedIds = new Map<string, string>(
        Object.entries(state.resources)
          .filter(([, v]) => v.salesforceId)
          .map(([k, v]) => [k, v.salesforceId!]),
      );

      process.stdout.write(`${pc.bold("deploy")} ${orgAlias} (${stack.id})\n`);

      const ops: Op[] = [];
      for (const uid of order) {
        const c = byId.get(uid)!;
        ops.push(await computeOp(ctx, c, state, deployedIds));
      }
      process.stdout.write(`  ${summarizeOps(ops)}\n`);

      let wrote = 0;
      for (const op of ops) {
        const c = op.construct;
        const resolved = c.resolveProps ? c.resolveProps(deployedIds) : c.props;
        switch (op.kind) {
          case "noop": {
            process.stdout.write(`  ${pc.gray("noop")}     ${c.uniqueId}\n`);
            if (op.currentId) deployedIds.set(c.uniqueId, op.currentId);
            break;
          }
          case "adopt": {
            process.stdout.write(`  ${pc.yellow("adopt")}    ${c.uniqueId}\n`);
            if (op.currentId) deployedIds.set(c.uniqueId, op.currentId);
            state.resources[c.uniqueId] = stateEntry(c, op.currentId!, op.plannedHash, state.resources[c.uniqueId]);
            wrote += 1;
            break;
          }
          case "recreate": {
            process.stdout.write(`  ${pc.red("recreate")} ${c.uniqueId}\n`);
            if (op.currentId) {
              await c.resource.delete(ctx, op.currentId);
            }
            const output = await c.resource.create(ctx, resolved as never);
            await maybeWaitReady(ctx, c, output);
            const id = c.resource.idOf(output);
            deployedIds.set(c.uniqueId, id);
            state.resources[c.uniqueId] = stateEntry(c, id, op.plannedHash, state.resources[c.uniqueId]);
            wrote += 1;
            break;
          }
          case "create": {
            process.stdout.write(`  ${pc.green("create")}   ${c.uniqueId}\n`);
            const output = await c.resource.create(ctx, resolved as never);
            await maybeWaitReady(ctx, c, output);
            const id = c.resource.idOf(output);
            deployedIds.set(c.uniqueId, id);
            state.resources[c.uniqueId] = stateEntry(c, id, op.plannedHash, state.resources[c.uniqueId]);
            wrote += 1;
            break;
          }
          default: {
            const _exhaustive: never = op.kind;
            throw new Error(`Unknown op: ${String(_exhaustive)}`);
          }
        }
      }

      state.lastDeployedAt = new Date().toISOString();
      await writeState(orgAlias, state);
      process.stdout.write(
        `${pc.bold("done")}  ${wrote} write${wrote === 1 ? "" : "s"}, state saved.\n`,
      );
    });
}

function stateEntry(
  c: Construct & ResourceConstruct,
  id: string,
  hash: string,
  prev: StateResource | undefined,
): StateResource {
  const now = new Date().toISOString();
  const entry: StateResource = {
    type: c.resource.type,
    apiName: c.id,
    salesforceId: id,
    hash,
    createdAt: prev?.createdAt ?? now,
  };
  if (prev) entry.updatedAt = now;
  return entry;
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
 * ConnectionSchema has isReady; wire it here explicitly until we have a more
 * general "poll after create" contract. Other resources' isReady is hooked in
 * M4 (DataStream) and M5 (DMO).
 */
async function maybeWaitReady<T>(
  ctx: ResourceContext,
  c: Construct & ResourceConstruct,
  output: T,
): Promise<void> {
  if (c.resource === (ConnectionSchemaResource as unknown)) {
    const o = output as { connectionId: string; schemaName: string };
    await waitForSchemaReady(ctx, o.connectionId, o.schemaName);
    return;
  }
  if (c.resource.isReady) {
    // Generic loop — 2s × 60 attempts by default, resource-specific timeouts land later.
    for (let i = 0; i < 60; i++) {
      if (await c.resource.isReady(ctx, output as never)) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`${c.uniqueId}: isReady timed out after 120s`);
  }
}

export type { Op, OpKind };
