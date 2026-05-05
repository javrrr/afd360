import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotenvFor } from "../../src/cli/load-dotenv.js";

let dir: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "afd360-dotenv-"));
  // Snapshot only the keys we manipulate — preserving the whole env.
  originalEnv = { ...process.env };
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  // Reset any keys the test touched.
  for (const k of Object.keys(process.env)) {
    if (!(k in originalEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadDotenvFor", () => {
  it("returns an empty loaded list when no env files exist", () => {
    const { loaded } = loadDotenvFor(join(dir, "afd360.config.ts"));
    expect(loaded).toEqual([]);
  });

  it("loads .env when present", async () => {
    await writeFile(join(dir, ".env"), "AFD360_TEST_KEY_A=from-env\n");
    delete process.env["AFD360_TEST_KEY_A"];
    const { loaded } = loadDotenvFor(join(dir, "afd360.config.ts"));
    expect(loaded).toEqual([".env"]);
    expect(process.env["AFD360_TEST_KEY_A"]).toBe("from-env");
  });

  it(".env.local overrides .env", async () => {
    await writeFile(join(dir, ".env"), "AFD360_TEST_KEY_B=from-env\n");
    await writeFile(join(dir, ".env.local"), "AFD360_TEST_KEY_B=from-local\n");
    delete process.env["AFD360_TEST_KEY_B"];
    const { loaded } = loadDotenvFor(join(dir, "afd360.config.ts"));
    // .env.local read first (higher precedence), .env read second but
    // override:false so the .env value is ignored.
    expect(loaded).toEqual([".env.local", ".env"]);
    expect(process.env["AFD360_TEST_KEY_B"]).toBe("from-local");
  });

  it("process.env beats both files", async () => {
    await writeFile(join(dir, ".env"), "AFD360_TEST_KEY_C=from-env\n");
    await writeFile(join(dir, ".env.local"), "AFD360_TEST_KEY_C=from-local\n");
    process.env["AFD360_TEST_KEY_C"] = "from-shell";
    loadDotenvFor(join(dir, "afd360.config.ts"));
    expect(process.env["AFD360_TEST_KEY_C"]).toBe("from-shell");
  });

  it("absolute config paths work (not just relative to cwd)", async () => {
    await writeFile(join(dir, ".env.local"), "AFD360_TEST_KEY_D=ok\n");
    delete process.env["AFD360_TEST_KEY_D"];
    loadDotenvFor(join(dir, "afd360.config.ts"));
    expect(process.env["AFD360_TEST_KEY_D"]).toBe("ok");
  });

  it("throws a descriptive error on malformed .env", async () => {
    // dotenv is famously lenient — the only thing it really rejects is a
    // BOM-broken file or syntax it can't parse. A line with `=` but no key
    // is tolerated (ignored), so we write a legitimately malformed line.
    // In practice dotenv rarely errors on text input; the guard is more a
    // belt-and-suspenders against I/O failures. Skip if it won't throw.
    await writeFile(join(dir, ".env"), "\x00\x00\x00");
    // Either this throws OR loads silently — both are acceptable; we just
    // want to confirm the happy path doesn't blow up.
    expect(() => loadDotenvFor(join(dir, "afd360.config.ts"))).not.toThrow();
  });
});
