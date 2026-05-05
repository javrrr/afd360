import { describe, it, expect } from "vitest";
import { VERSION } from "../../src/index.js";

describe("smoke", () => {
  it("exports a VERSION string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
