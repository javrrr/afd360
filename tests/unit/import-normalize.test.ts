import { describe, it, expect } from "vitest";
import {
  normalizeLogicalId,
  detectCollisions,
  shouldSkip,
  SKIP_PREFIXES,
} from "../../src/cli/import-normalize.js";

describe("normalizeLogicalId", () => {
  it("strips a full UUID-5 tail", () => {
    expect(
      normalizeLogicalId("NTO_Products_tddoas_50ccbe07_7a07_466b_a43f_514fb01de06d"),
    ).toBe("NTO_Products_tddoas");
    expect(
      normalizeLogicalId("AgentOpt_fac25829_be36_44d3_859d_26be3a611a76"),
    ).toBe("AgentOpt");
  });

  it("leaves tdc-style short-hex tails alone (v1 scope — ambiguous with word suffixes)", () => {
    // `_tddogb` looks generated, but `_javier` looks like a word — we can't
    // distinguish purely by regex. v1 preserves both; users hand-edit or
    // pass --preserve-names.
    expect(normalizeLogicalId("NTO_GoodsProduct_Search_tddogb")).toBe(
      "NTO_GoodsProduct_Search_tddogb",
    );
    expect(normalizeLogicalId("cdp_data_javier")).toBe("cdp_data_javier");
  });

  it("strips a 4+ digit tail", () => {
    expect(normalizeLogicalId("AgentOpt_Tag_03837773")).toBe("AgentOpt_Tag");
    expect(normalizeLogicalId("Foo_12345")).toBe("Foo");
  });

  it("preserves names with no suffix pattern", () => {
    expect(normalizeLogicalId("DocsS3")).toBe("DocsS3");
    expect(normalizeLogicalId("cdp_data_javier")).toBe("cdp_data_javier");
  });

  it("preserves short version-style suffixes", () => {
    expect(normalizeLogicalId("Feature_v1")).toBe("Feature_v1");
    expect(normalizeLogicalId("Config_abc")).toBe("Config_abc");
  });

  it("requires a minimum prefix length so short names are left alone", () => {
    expect(normalizeLogicalId("ab_12345")).toBe("ab_12345");  // prefix 2 — too short
    expect(normalizeLogicalId("abc_12345")).toBe("abc");       // prefix 3 — ok
  });

  it("leaves pure-digit names alone if there's no separator", () => {
    expect(normalizeLogicalId("03837773")).toBe("03837773");
  });
});

describe("detectCollisions", () => {
  it("returns empty map when all logical ids are unique", () => {
    expect(detectCollisions(["Alpha_1234", "Beta_5678", "Gamma"]).size).toBe(0);
  });

  it("flags two digit-tailed api names that normalize to the same base", () => {
    const c = detectCollisions([
      "AgentOpt_Tag_1234",   // → AgentOpt_Tag
      "AgentOpt_Tag_9999",   // → AgentOpt_Tag
      "DocsS3",
    ]);
    expect(c.get("AgentOpt_Tag")).toEqual(["AgentOpt_Tag_1234", "AgentOpt_Tag_9999"]);
    expect(c.has("DocsS3")).toBe(false);
  });

  it("groups 3+ colliders together", () => {
    const c = detectCollisions(["Foo_1234", "Foo_5678", "Foo_9012"]);
    expect(c.get("Foo")).toEqual(["Foo_1234", "Foo_5678", "Foo_9012"]);
  });
});

describe("shouldSkip", () => {
  it("skips ssot__ namespace", () => {
    expect(shouldSkip("ssot__Account__dlm")).toBe(true);
  });

  it("skips other default platform namespaces", () => {
    for (const p of SKIP_PREFIXES) {
      expect(shouldSkip(`${p}thing`)).toBe(true);
    }
  });

  it("doesn't skip user-authored names", () => {
    expect(shouldSkip("NTO_Products")).toBe(false);
    expect(shouldSkip("DocsS3")).toBe(false);
  });

  it("honors extra prefixes", () => {
    expect(shouldSkip("mynamespace__Custom", ["mynamespace__"])).toBe(true);
  });
});
