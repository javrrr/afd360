#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "../index.js";

const program = new Command();

program
  .name("afd360")
  .description("Agentforce Data 360 SDK CLI")
  .version(VERSION);

// Subcommands land here milestone by milestone:
//   M1: whoami
//   M3: synth, diff, deploy, destroy
//   M10: import
//   M11: init

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
