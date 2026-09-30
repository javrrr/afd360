import { describe, it, expect, vi, afterEach } from "vitest";
import { computePruneOrder, executePrune } from "../../src/cli/prune.js";
import {
  RESOURCE_REGISTRY,
  PRUNE_TYPE_PRIORITY,
  pruneTypeRank,
} from "../../src/resources/registry.js";
import { ConnectionResource } from "../../src/resources/connection.js";
import { DmoResource } from "../../src/resources/dmo.js";
import { MappingResource } from "../../src/resources/mapping.js";
import { DataStreamResource } from "../../src/resources/data-stream.js";
import type { StackState, StateResource } from "../../src/core/state.js";
import type { Orphan } from "../../src/cli/ops.js";
import type { ResourceContext } from "../../src/core/construct.js";

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

const ctx = {} as ResourceContext;

describe("RESOURCE_REGISTRY", () => {
  it("keys every entry by the Resource's own .type string", () => {
    for (const [key, resource] of Object.entries(RESOURCE_REGISTRY)) {
      expect(resource.type).toBe(key);
    }
  });

  it("covers every type in PRUNE_TYPE_PRIORITY", () => {
    for (const type of PRUNE_TYPE_PRIORITY) {
      expect(RESOURCE_REGISTRY[type], `missing registry entry for ${type}`).toBeDefined();
    }
  });

  it("ranks Mapping before DMO before Connection (dependents first)", () => {
    expect(pruneTypeRank("Mapping")).toBeLessThan(pruneTypeRank("DMO"));
    expect(pruneTypeRank("DMO")).toBeLessThan(pruneTypeRank("Connection"));
  });

  it("ranks unknown types last", () => {
    expect(pruneTypeRank("Nonesuch")).toBe(PRUNE_TYPE_PRIORITY.length);
  });
});

describe("computePruneOrder", () => {
  it("deletes dependents before the resources they depend on (state dependsOn)", () => {
    // Conn ← Stream ← DMO ← Mapping (each dependsOn the previous). Delete order
    // must be the reverse: Mapping, DMO, Stream, Conn.
    const state = stateWith({
      "S/Conn": entry("Connection"),
      "S/Stream": entry("DataStream", { dependsOn: ["S/Conn"] }),
      "S/Dmo": entry("DMO", { dependsOn: ["S/Stream"] }),
      "S/Map": entry("Mapping", { dependsOn: ["S/Dmo", "S/Stream"] }),
    });
    const order = computePruneOrder(["S/Conn", "S/Stream", "S/Dmo", "S/Map"], state);
    expect(order).toEqual(["S/Map", "S/Dmo", "S/Stream", "S/Conn"]);
  });

  it("falls back to type-priority order when no dependsOn is recorded (legacy)", () => {
    const state = stateWith({
      "S/Conn": entry("Connection"),
      "S/Dmo": entry("DMO"),
      "S/Map": entry("Mapping"),
    });
    const order = computePruneOrder(["S/Conn", "S/Dmo", "S/Map"], state);
    // Mapping (rank 0) → DMO → Connection (last).
    expect(order).toEqual(["S/Map", "S/Dmo", "S/Conn"]);
  });

  it("respects edges even when they contradict type-priority", () => {
    // Contrived: a Connection that dependsOn a DMO (edge dominates type rank).
    const state = stateWith({
      "S/Dmo": entry("DMO"),
      "S/Conn": entry("Connection", { dependsOn: ["S/Dmo"] }),
    });
    // Conn depends on Dmo → Conn (dependent) deleted first.
    expect(computePruneOrder(["S/Dmo", "S/Conn"], state)).toEqual(["S/Conn", "S/Dmo"]);
  });

  it("ignores dependsOn edges pointing outside the prune set", () => {
    const state = stateWith({
      "S/Dmo": entry("DMO", { dependsOn: ["S/StillInManifest"] }),
      "S/Map": entry("Mapping", { dependsOn: ["S/Dmo"] }),
    });
    expect(computePruneOrder(["S/Dmo", "S/Map"], state)).toEqual(["S/Map", "S/Dmo"]);
  });
});

describe("executePrune", () => {
  afterEach(() => vi.restoreAllMocks());

  function orphan(uid: string, e: StateResource, kind: Orphan["kind"] = "prune"): Orphan {
    return { uniqueId: uid, entry: e, kind };
  }

  it("deletes owned orphans in dependency order and drops them from state", async () => {
    const calls: string[] = [];
    vi.spyOn(DmoResource, "delete").mockImplementation(async () => {
      calls.push("DMO");
    });
    vi.spyOn(MappingResource, "delete").mockImplementation(async () => {
      calls.push("Mapping");
    });
    const state = stateWith({
      "S/Dmo": entry("DMO"),
      "S/Map": entry("Mapping", { dependsOn: ["S/Dmo"] }),
    });
    const orphans = [orphan("S/Dmo", state.resources["S/Dmo"]!), orphan("S/Map", state.resources["S/Map"]!)];
    const n = await executePrune(ctx, orphans, state, () => {});
    expect(n).toBe(2);
    expect(calls).toEqual(["Mapping", "DMO"]); // dependent first
    expect(state.resources["S/Dmo"]).toBeUndefined();
    expect(state.resources["S/Map"]).toBeUndefined();
  });

  it("never deletes not-owned (forget) or stale orphans", async () => {
    const del = vi.spyOn(ConnectionResource, "delete").mockResolvedValue(undefined as never);
    const state = stateWith({
      "S/Adopted": entry("Connection", { owned: false }),
      "S/Stale": entry("Mapping", { salesforceId: undefined }),
    });
    const orphans = [
      orphan("S/Adopted", state.resources["S/Adopted"]!, "forget"),
      orphan("S/Stale", state.resources["S/Stale"]!, "stale"),
    ];
    const n = await executePrune(ctx, orphans, state, () => {});
    expect(n).toBe(0);
    expect(del).not.toHaveBeenCalled();
    // Left tracked — untracking a not-owned resource is `forget`'s job.
    expect(state.resources["S/Adopted"]).toBeDefined();
    expect(state.resources["S/Stale"]).toBeDefined();
  });

  it("skips (does not delete) an orphan whose type has no registry entry", async () => {
    const log: string[] = [];
    const state = stateWith({
      "S/Weird": entry("MysteryType"),
    });
    const n = await executePrune(
      ctx,
      [orphan("S/Weird", state.resources["S/Weird"]!)],
      state,
      (line) => log.push(line),
    );
    expect(n).toBe(0);
    expect(state.resources["S/Weird"]).toBeDefined(); // left tracked, not deleted
    expect(log.join("\n")).toContain("unknown resource type");
  });

  it("passes the live salesforceId through to Resource.delete", async () => {
    const del = vi.spyOn(DataStreamResource, "delete").mockResolvedValue(undefined as never);
    const state = stateWith({
      "S/Stream": entry("DataStream", { salesforceId: "1dsHxLIVE" }),
    });
    await executePrune(ctx, [orphan("S/Stream", state.resources["S/Stream"]!)], state, () => {});
    expect(del).toHaveBeenCalledWith(ctx, "1dsHxLIVE");
  });
});
