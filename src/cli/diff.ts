import { Command } from "commander";
import pc from "picocolors";
import { loadApp } from "./load-config.js";
import { getSession } from "../client/auth.js";
import { createClient } from "../client/factory.js";
import { readState } from "../core/state.js";
import { topologicalSort } from "../core/graph.js";
import { isResourceConstruct } from "../core/app.js";
import type { Construct, ResourceContext } from "../core/construct.js";
import type { ResourceConstruct } from "../core/app.js";
import { computeOp, summarizeOps, type OpKind } from "./ops.js";

const DEFAULT_CONFIG = "afd360.config.ts";

const LABELS: Record<OpKind, (s: string) => string> = {
  noop: (s) => pc.gray(s),
  create: (s) => pc.green(s),
  adopt: (s) => pc.yellow(s),
  recreate: (s) => pc.red(s),
};

export function registerDiff(program: Command): void {
  program
    .command("diff")
    .description("Show pending operations without applying them")
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

      process.stdout.write(`${pc.bold("diff")} ${orgAlias} (${stack.id})\n`);

      const ops = [];
      for (const uid of order) {
        const c = byId.get(uid)!;
        const op = await computeOp(ctx, c, state, deployedIds);
        ops.push(op);
        const tag = op.kind.padEnd(8, " ");
        process.stdout.write(`  ${LABELS[op.kind](tag)} ${c.uniqueId}\n`);
      }
      process.stdout.write(`  ${summarizeOps(ops)}\n`);
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
