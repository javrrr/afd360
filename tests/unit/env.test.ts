import { describe, it, expect } from "vitest";
import { substituteEnv, UnresolvedEnvError } from "../../src/core/env.js";

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
