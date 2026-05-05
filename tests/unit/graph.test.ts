import { describe, it, expect } from "vitest";
import {
  topologicalSort,
  reverseTopologicalSort,
  CycleError,
  UnknownNodeError,
} from "../../src/core/graph.js";

describe("topologicalSort", () => {
  it("returns nodes in dependency order", () => {
    const order = topologicalSort({
      nodes: ["conn", "stream", "dmo", "mapping"],
      edges: [
        { from: "conn", to: "stream" },
        { from: "stream", to: "mapping" },
        { from: "dmo", to: "mapping" },
      ],
    });
    expect(order.indexOf("conn")).toBeLessThan(order.indexOf("stream"));
    expect(order.indexOf("stream")).toBeLessThan(order.indexOf("mapping"));
    expect(order.indexOf("dmo")).toBeLessThan(order.indexOf("mapping"));
  });

  it("handles disconnected components", () => {
    const order = topologicalSort({
      nodes: ["a", "b", "c", "d"],
      edges: [{ from: "a", to: "b" }],
    });
    expect(order).toHaveLength(4);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
  });

  it("throws CycleError with the offending path", () => {
    try {
      topologicalSort({
        nodes: ["a", "b", "c"],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "a" },
        ],
      });
      throw new Error("expected CycleError");
    } catch (err) {
      expect(err).toBeInstanceOf(CycleError);
      const cycle = (err as CycleError).cycle;
      // Some rotation of a -> b -> c -> a.
      expect(cycle[0]).toBe(cycle[cycle.length - 1]);
      expect(new Set(cycle).size).toBe(3);
    }
  });

  it("throws UnknownNodeError when an edge references a missing node", () => {
    expect(() =>
      topologicalSort({ nodes: ["a"], edges: [{ from: "a", to: "b" }] }),
    ).toThrow(UnknownNodeError);
  });

  it("reverseTopologicalSort produces the inverse order", () => {
    const fwd = topologicalSort({
      nodes: ["conn", "stream", "mapping"],
      edges: [
        { from: "conn", to: "stream" },
        { from: "stream", to: "mapping" },
      ],
    });
    const rev = reverseTopologicalSort({
      nodes: ["conn", "stream", "mapping"],
      edges: [
        { from: "conn", to: "stream" },
        { from: "stream", to: "mapping" },
      ],
    });
    expect(rev).toEqual([...fwd].reverse());
  });
});
