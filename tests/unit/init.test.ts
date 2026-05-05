/**
 * Smoke coverage for `afd360 init`. We exercise the CLI command via its
 * action function rather than child-process-ing, so the test runs fast and
 * fails loudly on a real error.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerInit } from "../../src/cli/init.js";

async function runInit(dir: string): Promise<void> {
  const program = new Command();
  // Suppress commander's global exit-on-error so a thrown action bubbles
  // up as a proper rejection instead of killing the test process.
  program.exitOverride();
  registerInit(program);
  await program.parseAsync(["node", "afd360", "init", dir]);
}

describe("afd360 init", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "afd360-init-"));
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("copies the starter template into a new directory", async () => {
    const target = join(workdir, "my-project");
    await runInit(target);
    // All 4 template files present.
    for (const f of ["afd360.config.ts", ".env.example", ".gitignore", "package.json"]) {
      const info = await stat(join(target, f));
      expect(info.isFile()).toBe(true);
    }
    // Manifest is non-empty and imports from "afd360".
    const manifest = await readFile(join(target, "afd360.config.ts"), "utf8");
    expect(manifest).toContain('from "afd360"');
    expect(manifest).toContain("App");
    expect(manifest).toContain("SearchIndex");
  });

  it("refuses to overwrite an existing afd360.config.ts", async () => {
    const target = join(workdir, "existing");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "afd360.config.ts"), "// user's work\n");
    await expect(runInit(target)).rejects.toThrow(
      /already contains an afd360\.config\.ts/,
    );
    // User's file is untouched.
    const contents = await readFile(join(target, "afd360.config.ts"), "utf8");
    expect(contents).toBe("// user's work\n");
  });
});
