import { Command } from "commander";
import pc from "picocolors";
import { loadApp } from "./load-config.js";
import { getSession } from "../client/auth.js";
import { createClient } from "../client/factory.js";
import { readState, writeState } from "../core/state.js";
import { reverseTopologicalSort } from "../core/graph.js";
import { isResourceConstruct } from "../core/app.js";
import type { ResourceConstruct } from "../core/app.js";
import type { Construct, ResourceContext } from "../core/construct.js";

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
      const order = reverseTopologicalSort({
        nodes: resources.map((r) => r.uniqueId),
        edges: resources.flatMap((r) =>
          r.dependsOn.map((d) => ({ from: d.uniqueId, to: r.uniqueId })),
        ),
      });
      const byId = new Map(resources.map((r) => [r.uniqueId, r]));

      process.stdout.write(`${pc.bold("destroy")} ${orgAlias} (${stack.id})\n`);

      try {
        for (const uid of order) {
          const c = byId.get(uid)!;
          const entry = state.resources[uid];
          if (!entry?.salesforceId) {
            process.stdout.write(`  ${pc.gray("skip")}   ${uid} (not in state)\n`);
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
