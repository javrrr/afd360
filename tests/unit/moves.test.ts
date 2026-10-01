import { describe, it, expect } from "vitest";
import { applyMoves } from "../../src/core/moves.js";
import type { StackState, StateResource } from "../../src/core/state.js";

function entry(type: string, over: Partial<StateResource> = {}): StateResource {
  return {
    type,
    apiName: `${type}_api`,
    salesforceId: `id-${type}`,
    hash: "h",
    createdAt: "t",
    owned: true,
    ...over,
  };
}

function stateWith(resources: StackState["resources"]): StackState {
  return { stackName: "S", targetOrg: "org", lastDeployedAt: null, resources };
}

describe("applyMoves", () => {
  it("re-keys a state entry from the old uniqueId to the new one", () => {
    const state = stateWith({ "S/Old": entry("DMO", { salesforceId: "0dm" }) });
    const applied = applyMoves(state, [{ from: "S/Old", to: "S/New" }]);
    expect(applied).toEqual([{ from: "S/Old", to: "S/New" }]);
    expect(state.resources["S/Old"]).toBeUndefined();
    expect(state.resources["S/New"]).toBeDefined();
    expect(state.resources["S/New"]!.salesforceId).toBe("0dm");
  });

  it("preserves the entry identity (same object re-keyed, not a copy)", () => {
    const original = entry("DMO");
    const state = stateWith({ "S/Old": original });
    applyMoves(state, [{ from: "S/Old", to: "S/New" }]);
    expect(state.resources["S/New"]).toBe(original);
  });

  it("is an idempotent no-op when `from` is absent (already renamed)", () => {
    // Second deploy: the entry already lives under the new key. The `moved`
    // directive stays in the manifest, so applyMoves must silently do nothing.
    const state = stateWith({ "S/New": entry("DMO") });
    const applied = applyMoves(state, [{ from: "S/Old", to: "S/New" }]);
    expect(applied).toEqual([]);
    expect(state.resources["S/New"]).toBeDefined();
    expect(state.resources["S/Old"]).toBeUndefined();
  });

  it("skips a from===to no-op without reporting it", () => {
    const state = stateWith({ "S/Same": entry("DMO") });
    const applied = applyMoves(state, [{ from: "S/Same", to: "S/Same" }]);
    expect(applied).toEqual([]);
    expect(state.resources["S/Same"]).toBeDefined();
  });

  it("throws when both `from` and `to` already exist in state (collision)", () => {
    const state = stateWith({
      "S/Old": entry("DMO"),
      "S/New": entry("DMO"),
    });
    expect(() => applyMoves(state, [{ from: "S/Old", to: "S/New" }])).toThrow(/both exist/);
  });

  it("fixes up dependsOn references in OTHER entries to the new key", () => {
    const state = stateWith({
      "S/Old": entry("DMO"),
      "S/Map": entry("Mapping", { dependsOn: ["S/Old", "S/Other"] }),
    });
    applyMoves(state, [{ from: "S/Old", to: "S/New" }]);
    expect(state.resources["S/Map"]!.dependsOn).toEqual(["S/New", "S/Other"]);
  });

  it("applies multiple moves in one pass", () => {
    const state = stateWith({
      "S/A": entry("Connection"),
      "S/B": entry("DMO", { dependsOn: ["S/A"] }),
    });
    const applied = applyMoves(state, [
      { from: "S/A", to: "S/A2" },
      { from: "S/B", to: "S/B2" },
    ]);
    expect(applied).toHaveLength(2);
    expect(state.resources["S/A2"]).toBeDefined();
    expect(state.resources["S/B2"]).toBeDefined();
    // dependsOn on the moved B2 entry re-points at the moved A2 key.
    expect(state.resources["S/B2"]!.dependsOn).toEqual(["S/A2"]);
  });

  it("does nothing (returns []) for an empty moves list", () => {
    const state = stateWith({ "S/A": entry("DMO") });
    expect(applyMoves(state, [])).toEqual([]);
    expect(state.resources["S/A"]).toBeDefined();
  });
});
