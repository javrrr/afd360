import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pc from "picocolors";
import { loadApp } from "./load-config.js";

const DEFAULT_CONFIG = "afd360.config.ts";
const DEFAULT_PLAN_PATH = ".afd360/plan.json";

export function registerSynth(program: Command): void {
  program
    .command("synth")
    .description("Compile the manifest into a canonical plan.json")
    .option("-c, --config <path>", "path to afd360.config.ts", DEFAULT_CONFIG)
    .option("-o, --out <path>", "output plan path", DEFAULT_PLAN_PATH)
    .action(async (opts: { config: string; out: string }) => {
      const app = await loadApp(opts.config);
      const plan = app.synth();
      await mkdir(dirname(opts.out), { recursive: true });
      await writeFile(opts.out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
      process.stdout.write(
        `${pc.green("synth")}  ${plan.stacks.length} stack(s), ${plan.resources.length} resource(s) → ${opts.out}\n`,
      );
    });
}
