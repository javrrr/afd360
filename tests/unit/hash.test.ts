import { describe, it, expect } from "vitest";
import { canonicalStringify, hashProps } from "../../src/core/hash.js";

describe("canonicalStringify", () => {
  it("sorts object keys", () => {
    expect(canonicalStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });
  it("sorts keys recursively", () => {
    const a = canonicalStringify({ outer: { b: 2, a: 1 } });
    const b = canonicalStringify({ outer: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });
  it("preserves array order", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
  });
  it("drops undefined values at object level", () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
  it("handles null", () => {
    expect(canonicalStringify(null)).toBe("null");
    expect(canonicalStringify({ a: null })).toBe('{"a":null}');
  });
  it("throws on non-finite numbers", () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow();
    expect(() => canonicalStringify(Infinity)).toThrow();
  });
  it("throws on functions and bigints", () => {
    expect(() => canonicalStringify(() => 1)).toThrow();
    expect(() => canonicalStringify(BigInt(1))).toThrow();
  });
});

describe("hashProps", () => {
  it("produces stable hashes across key orderings", () => {
    expect(hashProps({ a: 1, b: 2 })).toBe(hashProps({ b: 2, a: 1 }));
  });
  it("differs when values differ", () => {
    expect(hashProps({ a: 1 })).not.toBe(hashProps({ a: 2 }));
  });
  it("returns sha256:hex format", () => {
    const h = hashProps({ a: 1 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
