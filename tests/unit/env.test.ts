import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  substituteEnv,
  UnresolvedEnvError,
  FileReadError,
} from "../../src/core/env.js";

describe("substituteEnv", () => {
  it("substitutes tokens in strings", () => {
    const out = substituteEnv(
      { key: "${env.ACCESS_KEY}" },
      { ACCESS_KEY: "abc123" },
    );
    expect(out).toEqual({ key: "abc123" });
  });

  it("walks nested objects and arrays", () => {
    const out = substituteEnv(
      {
        credentials: {
          accessKey: "${env.AK}",
          secret: "${env.SK}",
        },
        flags: ["plain", "${env.FLAG}"],
      },
      { AK: "x", SK: "y", FLAG: "on" },
    );
    expect(out).toEqual({
      credentials: { accessKey: "x", secret: "y" },
      flags: ["plain", "on"],
    });
  });

  it("leaves non-string primitives untouched", () => {
    const out = substituteEnv({ n: 1, b: true, nil: null }, {});
    expect(out).toEqual({ n: 1, b: true, nil: null });
  });

  it("aggregates all unresolved tokens into one error", () => {
    try {
      substituteEnv(
        { a: "${env.FOO}", b: ["${env.BAR}", "${env.FOO}"] },
        {},
      );
      throw new Error("expected UnresolvedEnvError");
    } catch (err) {
      expect(err).toBeInstanceOf(UnresolvedEnvError);
      expect((err as UnresolvedEnvError).missing).toEqual(["BAR", "FOO"]);
    }
  });

  it("handles multiple tokens in a single string", () => {
    const out = substituteEnv("s3://${env.BUCKET}/${env.PATH}", {
      BUCKET: "b",
      PATH: "p",
    });
    expect(out).toBe("s3://b/p");
  });
});

describe("substituteEnv — ${file:...} reader", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "afd360-env-file-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads file contents verbatim", async () => {
    const path = join(dir, "key.p8");
    const content = "-----BEGIN PRIVATE KEY-----\nABCDEF==\n-----END PRIVATE KEY-----\n";
    await writeFile(path, content);
    const out = substituteEnv({ privateKey: `\${file:${path}}` });
    expect(out).toEqual({ privateKey: content });
  });

  it("resolves ${env.X} inside the file path first", async () => {
    const path = join(dir, "nested.txt");
    await writeFile(path, "hello");
    const out = substituteEnv(
      { value: "${file:${env.KEY_PATH}}" },
      { KEY_PATH: path },
    );
    expect(out).toEqual({ value: "hello" });
  });

  it("throws FileReadError listing every missing file", () => {
    const missingA = join(dir, "a-does-not-exist");
    const missingB = join(dir, "b-does-not-exist");
    try {
      substituteEnv({ a: `\${file:${missingA}}`, b: `\${file:${missingB}}` });
      throw new Error("expected FileReadError");
    } catch (err) {
      expect(err).toBeInstanceOf(FileReadError);
      const paths = (err as FileReadError).paths.map((p) => p.path).sort();
      expect(paths).toEqual([missingA, missingB].sort());
    }
  });

  it("env errors take precedence over file errors", () => {
    try {
      substituteEnv({ a: "${file:${env.MISSING}}" });
      throw new Error("expected UnresolvedEnvError");
    } catch (err) {
      expect(err).toBeInstanceOf(UnresolvedEnvError);
    }
  });
});
