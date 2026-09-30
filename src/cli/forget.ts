import { Command } from "commander";
import pc from "picocolors";
import { loadApp } from "./load-config.js";
import { readState, writeState } from "../core/state.js";
import { isResourceConstruct } from "../core/app.js";
import type { ResourceConstruct } from "../core/app.js";
import type { Construct } from "../core/construct.js";
import { collectOrphans } from "./ops.js";

const DEFAULT_CONFIG = "afd360.config.ts";

interface ForgetOpts {
  config: string;
  org?: string;
  allOrphans?: boolean;
  force?: boolean;
}

/**
 * `forget` — stop tracking resources in state WITHOUT deleting them from the
 * org. State-only surgery: the counterpart to `deploy --prune` (which deletes).
 *
 * Use it to drop tracking of a not-owned / referenced resource, to clear stale
 * state cruft, or to reset a resource so the next deploy re-adopts it. Never
 * touches the org — no session or client is created. See
 * docs/design-orphan-prune.md §5.4.
 */
export function registerForget(program: Command): void {
  program
    .command("forget [uniqueIds...]")
    .description("Stop tracking resources in state without deleting them from the org")
    .option("-c, --config <path>", "path to afd360.config.ts", DEFAULT_CONFIG)
    .option("-o, --org <alias>", "override stack targetOrg")
    .option(
      "--all-orphans",
      "forget every not-owned / stale orphan (state entries whose construct was removed)",
    )
    .option(
      "--force",
      "forget even when a manifest resource still depends on the target",
    )
    .action(async (uniqueIds: string[], opts: ForgetOpts) => {
      const app = await loadApp(opts.config);
      if (app.stacks.length !== 1) {
        throw new Error(
          `afd360 v1 supports one stack per config; found ${app.stacks.length}.`,
        );
      }
      const stack = app.stacks[0]!;
      const orgAlias = opts.org ?? stack.targetOrg;

      const state = await readState(orgAlias, stack.id);
      const resources = collectResources(stack);
      const manifestIds = new Set(resources.map((r) => r.uniqueId));

      process.stdout.write(`${pc.bold("forget")} ${orgAlias} (${stack.id})\n`);

      // Build the target set. Explicit uniqueIds always count; --all-orphans
      // adds the not-owned + stale orphans (NOT owned/prunable ones — those are
      // `--prune`'s job; forgetting a live owned resource would silently strand
      // it on the org untracked).
      const targets = new Set<string>(uniqueIds);
      if (opts.allOrphans) {
        for (const o of collectOrphans(manifestIds, state)) {
          if (o.kind !== "prune") targets.add(o.uniqueId);
        }
      }

      if (targets.size === 0) {
        const orphans = collectOrphans(manifestIds, state);
        if (orphans.length === 0) {
          process.stdout.write(
            `  ${pc.gray("nothing to forget — no orphans in state, and no uniqueIds given.")}\n`,
          );
          return;
        }
        process.stdout.write(
          `  ${pc.gray("no uniqueIds given. Candidates (pass a uniqueId, or --all-orphans for the not-owned/stale ones):")}\n`,
        );
        for (const o of orphans) {
          process.stdout.write(`    ${o.uniqueId} ${pc.gray(`(${o.kind})`)}\n`);
        }
        return;
      }

      // Every target must be a real state entry — a typo would otherwise
      // silently no-op. List the known keys to help correct it.
      const missing = [...targets].filter((t) => !(t in state.resources));
      if (missing.length > 0) {
        const known = Object.keys(state.resources).sort();
        throw new Error(
          `forget: not in state: ${missing.map((m) => `"${m}"`).join(", ")}.` +
            (known.length > 0
              ? ` Known state keys: ${known.join(", ")}.`
              : " State has no resources."),
        );
      }

      // Dependency guard: refuse to forget a resource that a STILL-PRESENT
      // manifest resource depends on — that would strand the next deploy (the
      // dependent resolves its parent from state; forgetting the parent drops
      // that link). --force overrides.
      if (!opts.force) {
        const blockers = findForgetBlockers(resources, targets);
        if (blockers.length > 0) {
          throw new Error(
            `forget: refusing — a manifest resource still depends on a forget target:\n` +
              blockers.map((b) => `  ${b}`).join("\n") +
              `\nForgetting a live dependency would strand the next deploy. ` +
              `Remove the dependent too, or re-run with --force.`,
          );
        }
      }

      for (const t of targets) {
        const entry = state.resources[t]!;
        delete state.resources[t];
        const note = entry.owned === false ? ", not owned" : "";
        process.stdout.write(
          `  ${pc.yellow("forget")} ${t} ${pc.gray(`(${entry.type}${note})`)}\n`,
        );
      }
      await writeState(orgAlias, state);
      const n = targets.size;
      process.stdout.write(
        `${pc.bold("done")}  dropped ${n} state entr${n === 1 ? "y" : "ies"}; ` +
          `${n === 1 ? "it remains" : "they remain"} on the org (nothing deleted).\n`,
      );
    });
}

/**
 * Find manifest resources that still depend on a forget target. Each blocker is
 * formatted `dependent → target`. Pure so it can be unit-tested without the CLI
 * plumbing. A non-empty result means forgetting the target would strand the
 * next deploy (unless `--force`).
 */
export function findForgetBlockers(
  resources: ReadonlyArray<Construct & ResourceConstruct>,
  targets: ReadonlySet<string>,
): string[] {
  const blockers: string[] = [];
  for (const r of resources) {
    for (const dep of r.dependsOn) {
      if (targets.has(dep.uniqueId)) blockers.push(`${r.uniqueId} → ${dep.uniqueId}`);
    }
  }
  return blockers;
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
