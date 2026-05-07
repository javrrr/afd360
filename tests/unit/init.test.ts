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

  it("copies the starter template into a new directory, restoring dotfiles", async () => {
    const target = join(workdir, "my-project");
    await runInit(target);
    // All 4 template files present. `.gitignore` and `.env.example` are
    // stored in the template as `gitignore` / `env.example` because npm
    // pack drops dotfiles; init restores the leading dot on copy.
    for (const f of ["afd360.config.ts", ".env.example", ".gitignore", "package.json"]) {
      const info = await stat(join(target, f));
      expect(info.isFile()).toBe(true);
    }
    // The un-dotted source names must NOT leak into the output.
    await expect(stat(join(target, "gitignore"))).rejects.toThrow();
    await expect(stat(join(target, "env.example"))).rejects.toThrow();
    // Manifest imports the minimal scaffold — App + Stack only. The
    // user (or their AI assistant) adds resources explicitly.
    const manifest = await readFile(join(target, "afd360.config.ts"), "utf8");
    expect(manifest).toContain('from "afd360"');
    expect(manifest).toContain("App");
    expect(manifest).toContain("Stack");
    expect(manifest).toContain("export default app");
    // Empty starter shouldn't import or instantiate any resource
    // class. Comment lines that show example syntax are fine; what
    // matters is the actual import list at the top.
    const importLine = manifest.match(/import \{([^}]+)\} from "afd360"/);
    expect(importLine).not.toBeNull();
    const imports = importLine![1]!.split(",").map((s) => s.trim());
    expect(imports).toEqual(expect.arrayContaining(["App", "Stack"]));
    expect(imports).not.toContain("Connection");
    expect(imports).not.toContain("SearchIndex");
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
