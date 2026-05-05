#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { VERSION } from "../index.js";
import { registerWhoami } from "./whoami.js";
import { registerSynth } from "./synth.js";
import { registerDiff } from "./diff.js";
import { registerDeploy } from "./deploy.js";
import { registerDestroy } from "./destroy.js";

const program = new Command();

program
  .name("afd360")
  .description("Agentforce Data 360 SDK CLI")
  .version(VERSION);

registerWhoami(program);
registerSynth(program);
registerDiff(program);
registerDeploy(program);
registerDestroy(program);

// Future: M10 import, M11 init.

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${pc.red("error:")} ${msg}\n`);
  // Surface Connect API error bodies — they carry errorCode + message that
  // explain what the bare status text ("Bad Request") hides.
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; body?: unknown };
    if (typeof e.status === "number") {
      process.stderr.write(`${pc.red("status:")} ${e.status}\n`);
    }
    if (e.body !== undefined) {
      const bodyStr = typeof e.body === "string" ? e.body : JSON.stringify(e.body, null, 2);
      process.stderr.write(`${pc.red("body:")}   ${bodyStr}\n`);
    }
  }
  process.exit(1);
});
