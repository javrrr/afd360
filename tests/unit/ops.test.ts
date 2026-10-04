import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { Connection } from "../../src/resources/connection.js";
import {
  computeOp,
  computeBlastRadius,
  computeRecreateDrainOrder,
  buildDependentsMap,
  collectOrphans,
  type Op,
} from "../../src/cli/ops.js";
import type { StackState } from "../../src/core/state.js";
import type { ResourceContext } from "../../src/core/construct.js";

function buildStack(): { conn: Connection } {
  const app = new App();
  const stack = new Stack(app, "RagDemo", { targetOrg: "dev-org" });
  const conn = new Connection(stack, "DocsS3", {
    connectorType: "AwsS3",
    label: "DocsS3",
  });
  return { conn };
}

function mockCtx(overrides: Partial<ResourceContext["client"]> = {}): ResourceContext {
  const client = {
    connections: {
      get: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      ...overrides.connections,
    },
  } as unknown as ResourceContext["client"];
  return {
    client,
    session: {
      alias: "dev-org",
      username: "u",
      orgId: "00D",
      instanceUrl: "https://x",
      apiVersion: "66.0",
      accessToken: "tok",
    },
    orgAlias: "dev-org",
  };
}

function emptyState(): StackState {
  return {
    stackName: "RagDemo",
    targetOrg: "dev-org",
    lastDeployedAt: null,
    resources: {},
  };
}

describe("computeOp", () => {
  it("emits 'create' when state is empty and the org has no matching resource", async () => {
    const { conn } = buildStack();
    const ctx = mockCtx();
    (ctx.client.connections.list as ReturnType<typeof vi.fn>).mockResolvedValue({ connections: [] });
    const op = await computeOp(ctx, conn, emptyState(), new Map());
    expect(op.kind).toBe("create");
  });

  it("emits 'adopt' when state is empty but the org already has a matching resource", async () => {
    const { conn } = buildStack();
    const ctx = mockCtx();
    (ctx.client.connections.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      connections: [{ id: "0sH", name: "DocsS3", label: "DocsS3", connectorType: "AwsS3" }],
    });
    const op = await computeOp(ctx, conn, emptyState(), new Map());
    expect(op.kind).toBe("adopt");
    expect(op.currentId).toBe("0sH");
  });

  it("emits 'noop' when state hash matches and live is present", async () => {
    const { conn } = buildStack();
    const ctx = mockCtx();
    (ctx.client.connections.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "0sH",
      name: "DocsS3",
      label: "DocsS3",
      connectorType: "AwsS3",
    });
    const hash = conn.resource.hash(conn.props);
    const state = emptyState();
    state.resources["RagDemo/DocsS3"] = {
      type: "Connection",
      apiName: "DocsS3",
      salesforceId: "0sH",
      hash,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const op = await computeOp(
      ctx,
      conn,
      state,
      new Map([["RagDemo/DocsS3", { salesforceId: "0sH", apiName: "DocsS3" }]]),
    );
    expect(op.kind).toBe("noop");
  });

  it("emits 'recreate' when state hash differs from planned", async () => {
    const { conn } = buildStack();
    const ctx = mockCtx();
    (ctx.client.connections.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "0sH",
      name: "DocsS3",
      label: "DocsS3",
      connectorType: "AwsS3",
    });
    const state = emptyState();
    state.resources["RagDemo/DocsS3"] = {
      type: "Connection",
      apiName: "DocsS3",
      salesforceId: "0sH",
      hash: "sha256:OLD",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const op = await computeOp(ctx, conn, state, new Map());
    expect(op.kind).toBe("recreate");
  });

  it("emits 'recreate' when live resource is isFailed (DataStream status=ERROR)", async () => {
    const app = new App();
    const stack = new Stack(app, "Rag", { targetOrg: "dev-org" });
    const conn = new Connection(stack, "DocsIngest", {
      connectorType: "IngestApi",
      label: "Docs",
      schema: { name: "KB", label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
    });
    const { DataStream } = await import("../../src/resources/data-stream.js");
    const stream = new DataStream(stack, "DocsStream", {
      connection: conn,
      sourceObject: "KB",
      primaryKey: { name: "Id" },
    });
    const state = emptyState();
    state.resources["Rag/DocsStream"] = {
      type: "DataStream",
      apiName: "DocsStream_abc",
      salesforceId: "1dsHx",
      hash: stream.resource.hash(stream.props),
      createdAt: "2026-01-01T00:00:00Z",
    };
    const ctx = mockCtx();
    // Mock dataStreams.get for read() — returns ERROR status.
    const client = ctx.client as unknown as {
      dataStreams: { get: ReturnType<typeof vi.fn> };
    };
    client.dataStreams = { get: vi.fn() };
    client.dataStreams.get.mockResolvedValue({
      name: "DocsStream_abc",
      recordId: "1dsHx",
      status: "ERROR",
      dataLakeObjectInfo: { status: "ACTIVE", name: "KB__dll" },
    });
    const deployed = new Map([
      [conn.uniqueId, { salesforceId: "0sH", apiName: "DocsS3_abc" }],
    ]);
    const op = await computeOp(ctx, stream, state, deployed);
    expect(op.kind).toBe("recreate");
  });

  it("ownership gate: holds an adopted (owned:false) resource at noop despite hash drift", async () => {
    // Provenance: a `create` that resolved to a pre-existing resource is
    // recorded owned:false. On a later deploy with drifted props, the normal
    // policy would recreate (delete+create) — but we must never delete a
    // resource afd360 didn't provision, so the gate holds it at noop.
    const { conn } = buildStack();
    const ctx = mockCtx();
    (ctx.client.connections.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "0sH",
      name: "DocsS3",
      label: "DocsS3",
      connectorType: "AwsS3",
    });
    const state = emptyState();
    state.resources["RagDemo/DocsS3"] = {
      type: "Connection",
      apiName: "DocsS3",
      salesforceId: "0sH",
      hash: "sha256:OLD-drifted", // deliberately mismatched
      createdAt: "2026-01-01T00:00:00Z",
      owned: false,
    };
    const op = await computeOp(ctx, conn, state, new Map());
    expect(op.kind).toBe("noop");
    expect(op.currentId).toBe("0sH");
  });

  it("ownership gate: an owned:true resource still recreates on hash drift", async () => {
    // Guard the gate's specificity — provenance must not suppress drift
    // handling for resources afd360 actually created.
    const { conn } = buildStack();
    const ctx = mockCtx();
    (ctx.client.connections.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "0sH",
      name: "DocsS3",
      label: "DocsS3",
      connectorType: "AwsS3",
    });
    const state = emptyState();
    state.resources["RagDemo/DocsS3"] = {
      type: "Connection",
      apiName: "DocsS3",
      salesforceId: "0sH",
      hash: "sha256:OLD-drifted",
      createdAt: "2026-01-01T00:00:00Z",
      owned: true,
    };
    const op = await computeOp(ctx, conn, state, new Map());
    expect(op.kind).toBe("recreate");
  });

  it("emits 'create' when state references a gone resource (drift)", async () => {
    const { conn } = buildStack();
    const ctx = mockCtx();
    (ctx.client.connections.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // Override read via throwing a 404 directly:
    (ctx.client.connections.get as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    const state = emptyState();
    state.resources["RagDemo/DocsS3"] = {
      type: "Connection",
      apiName: "DocsS3",
      salesforceId: "0sH-gone",
      hash: "sha256:whatever",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const op = await computeOp(ctx, conn, state, new Map());
    expect(op.kind).toBe("create");
  });
});

describe("computeBlastRadius", () => {
  function mkOp(uniqueId: string, kind: Op["kind"]): Op {
    return {
      uniqueId,
      kind,
      construct: { uniqueId } as never,
      plannedHash: "sha256:x",
    };
  }

  it("returns empty map when no recreates", () => {
    const ops = [mkOp("A", "create"), mkOp("B", "noop")];
    const deps = new Map([["A", ["B"]]]);
    expect(computeBlastRadius(ops, deps).size).toBe(0);
  });

  it("lists direct dependents for a single-level cascade", () => {
    const ops = [mkOp("A", "recreate"), mkOp("B", "create"), mkOp("C", "noop")];
    const deps = new Map([["A", ["B", "C"]]]);
    const radius = computeBlastRadius(ops, deps);
    expect(radius.get("A")).toEqual(expect.arrayContaining(["B", "C"]));
    expect(radius.get("A")).toHaveLength(2);
  });

  it("walks transitive dependents (parent → child → grandchild)", () => {
    const ops = [
      mkOp("Schema", "recreate"),
      mkOp("Stream", "create"),
      mkOp("DMO", "noop"),
      mkOp("Mapping", "create"),
    ];
    const deps = new Map([
      ["Schema", ["Stream"]],
      ["Stream", ["DMO"]],
      ["DMO", ["Mapping"]],
    ]);
    const radius = computeBlastRadius(ops, deps);
    expect(radius.get("Schema")).toEqual(
      expect.arrayContaining(["Stream", "DMO", "Mapping"]),
    );
    expect(radius.get("Schema")).toHaveLength(3);
  });

  it("stops at resources not in the plan (external refs)", () => {
    const ops = [mkOp("A", "recreate"), mkOp("B", "create")];
    const deps = new Map([
      ["A", ["B", "NotInPlan"]],
      ["NotInPlan", ["Would-be-grandchild"]],
    ]);
    const radius = computeBlastRadius(ops, deps);
    expect(radius.get("A")).toEqual(["B"]);
  });

  it("handles a recreate with no dependents", () => {
    const ops = [mkOp("Solo", "recreate")];
    const radius = computeBlastRadius(ops, new Map());
    expect(radius.size).toBe(0);
  });
});

describe("computeRecreateDrainOrder (recreate delete-ordering)", () => {
  // A recreate is delete-then-create. The platform 412s when deleting a
  // resource a live dependent still references, so dependents of a recreate
  // must be deleted BEFORE the recreate root — in reverse-topological order,
  // exactly as destroy tears down. This helper computes that drain list.
  const allDeletable = () => true;

  it("returns dependents of a recreate, children-first (reverse-topo)", () => {
    // Forward order: Conn → DMO → Mapping → CI. DMO recreates; its transitive
    // dependents (Mapping, CI) must drain first, deepest-first.
    const forwardOrder = ["Conn", "DMO", "Mapping", "CI"];
    const cascades = new Map([["DMO", ["Mapping", "CI"]]]);
    const drain = computeRecreateDrainOrder(
      cascades,
      [...forwardOrder].reverse(),
      allDeletable,
    );
    // reverse of forward = [CI, Mapping, DMO, Conn]; filtered to the drain set.
    expect(drain).toEqual(["CI", "Mapping"]);
  });

  it("excludes the recreate root itself (forward loop handles it)", () => {
    const cascades = new Map([["DMO", ["CI"]]]);
    const drain = computeRecreateDrainOrder(cascades, ["CI", "DMO", "Conn"], allDeletable);
    expect(drain).not.toContain("DMO");
    expect(drain).toEqual(["CI"]);
  });

  it("unions dependents across multiple recreate roots without duplicates", () => {
    // Two recreate roots sharing a common downstream dependent (Viz).
    const cascades = new Map([
      ["ModelA", ["Viz"]],
      ["ModelB", ["Viz"]],
    ]);
    const drain = computeRecreateDrainOrder(cascades, ["Viz", "ModelA", "ModelB"], allDeletable);
    expect(drain).toEqual(["Viz"]);
  });

  it("filters out non-deletable resources (referenced / adopted / not live)", () => {
    const cascades = new Map([["DMO", ["CI", "AdoptedThing", "RefThing"]]]);
    const isDeletable = (uid: string): boolean => uid === "CI";
    const drain = computeRecreateDrainOrder(
      cascades,
      ["RefThing", "AdoptedThing", "CI", "DMO"],
      isDeletable,
    );
    expect(drain).toEqual(["CI"]);
  });

  it("returns empty when there are no cascades", () => {
    expect(computeRecreateDrainOrder(new Map(), ["A", "B"], allDeletable)).toEqual([]);
  });

  it("orders a transitive grandchild before its parent", () => {
    // Forward: DMO → CI → Model → Viz. DMO recreates; drain deepest-first.
    const forwardOrder = ["DMO", "CI", "Model", "Viz"];
    const cascades = new Map([["DMO", ["CI", "Model", "Viz"]]]);
    const drain = computeRecreateDrainOrder(
      cascades,
      [...forwardOrder].reverse(),
      allDeletable,
    );
    expect(drain).toEqual(["Viz", "Model", "CI"]);
  });

  it("drains a recreated CI's SemanticModel/Viz/Dashboard consumers before the CI (field-reported 2026-10-04)", () => {
    // The reported gap: a CI hash-drifts (recreate) while its downstream
    // SemanticModel → Visualization → Dashboard consumers are UNCHANGED (noop,
    // only the CI drifted). A SemanticModel hard-blocks deleting the CI it
    // references, so the CI delete must happen AFTER the consumers are drained.
    // This locks blast-radius + drain across that exact topology end-to-end.
    const forwardOrder = ["CI", "Model", "Viz", "Dash"];
    const dependents = new Map([
      ["CI", ["Model"]],
      ["Model", ["Viz"]],
      ["Viz", ["Dash"]],
    ]);
    const ops: Op[] = [
      { uniqueId: "CI", kind: "recreate", construct: { uniqueId: "CI" } as never, plannedHash: "sha256:x" },
      { uniqueId: "Model", kind: "noop", construct: { uniqueId: "Model" } as never, plannedHash: "sha256:x" },
      { uniqueId: "Viz", kind: "noop", construct: { uniqueId: "Viz" } as never, plannedHash: "sha256:x" },
      { uniqueId: "Dash", kind: "noop", construct: { uniqueId: "Dash" } as never, plannedHash: "sha256:x" },
    ];
    const cascades = computeBlastRadius(ops, dependents);
    // Even though the consumers are noop, the recreated CI's blast radius covers
    // all three transitively.
    expect(cascades.get("CI")).toEqual(expect.arrayContaining(["Model", "Viz", "Dash"]));

    const drain = computeRecreateDrainOrder(cascades, [...forwardOrder].reverse(), allDeletable);
    // Children-first: Dashboard, then Visualization, then SemanticModel — and the
    // CI (the recreate root) is NOT drained here (the forward loop deletes it
    // once its consumers are gone).
    expect(drain).toEqual(["Dash", "Viz", "Model"]);
    expect(drain).not.toContain("CI");
  });
});

describe("collectOrphans (orphan classification)", () => {
  function stateWith(
    resources: StackState["resources"],
  ): StackState {
    return {
      stackName: "RagDemo",
      targetOrg: "dev-org",
      lastDeployedAt: null,
      resources,
    };
  }

  it("returns nothing when every state entry is still in the manifest", () => {
    const state = stateWith({
      "S/A": { type: "Connection", apiName: "A", salesforceId: "0sHA", hash: "h", createdAt: "t", owned: true },
    });
    expect(collectOrphans(new Set(["S/A"]), state)).toEqual([]);
  });

  it("classifies an owned, live entry not in the manifest as 'prune'", () => {
    const state = stateWith({
      "S/Gone": { type: "DMO", apiName: "Gone__dlm", salesforceId: "0dm", hash: "h", createdAt: "t", owned: true },
    });
    const orphans = collectOrphans(new Set<string>(), state);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.kind).toBe("prune");
    expect(orphans[0]!.uniqueId).toBe("S/Gone");
  });

  it("treats a legacy entry with no `owned` field as owned → 'prune'", () => {
    // Back-compat: pre-provenance state files have no owned flag; matches the
    // owned-by-default convention in computeOp/destroy.
    const state = stateWith({
      "S/Legacy": { type: "Connection", apiName: "L", salesforceId: "0sH", hash: "h", createdAt: "t" },
    });
    expect(collectOrphans(new Set<string>(), state)[0]!.kind).toBe("prune");
  });

  it("classifies a not-owned (adopted/fromExisting) live entry as 'forget'", () => {
    const state = stateWith({
      "S/Adopted": { type: "Connection", apiName: "A", salesforceId: "0sH", hash: "h", createdAt: "t", owned: false },
    });
    expect(collectOrphans(new Set<string>(), state)[0]!.kind).toBe("forget");
  });

  it("classifies an entry with no salesforceId as 'stale' (regardless of ownership)", () => {
    const state = stateWith({
      "S/Stale": { type: "Mapping", apiName: "M", hash: "h", createdAt: "t", owned: true },
    });
    expect(collectOrphans(new Set<string>(), state)[0]!.kind).toBe("stale");
  });

  it("classifies an owned, live, protected entry as 'protected' (prune skips it)", () => {
    const state = stateWith({
      "S/Keep": { type: "DMO", apiName: "Keep__dlm", salesforceId: "0dm", hash: "h", createdAt: "t", owned: true, protected: true },
    });
    const orphans = collectOrphans(new Set<string>(), state);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.kind).toBe("protected");
  });

  it("prefers 'forget' over 'protected' when a protected entry is also not-owned", () => {
    // owned:false is checked first — a not-owned resource is never afd360's to
    // delete regardless of the protect flag, so forget (untrack) is the remedy.
    const state = stateWith({
      "S/Odd": { type: "Connection", apiName: "O", salesforceId: "0sO", hash: "h", createdAt: "t", owned: false, protected: true },
    });
    expect(collectOrphans(new Set<string>(), state)[0]!.kind).toBe("forget");
  });

  it("prefers 'stale' over 'protected' when a protected entry has no salesforceId", () => {
    const state = stateWith({
      "S/Odd": { type: "DMO", apiName: "O", hash: "h", createdAt: "t", owned: true, protected: true },
    });
    expect(collectOrphans(new Set<string>(), state)[0]!.kind).toBe("stale");
  });

  it("classifies a mix and skips manifest-present entries", () => {
    const state = stateWith({
      "S/Kept": { type: "Connection", apiName: "K", salesforceId: "0sK", hash: "h", createdAt: "t", owned: true },
      "S/Prune": { type: "DMO", apiName: "P__dlm", salesforceId: "0dm", hash: "h", createdAt: "t", owned: true },
      "S/Forget": { type: "Connection", apiName: "F", salesforceId: "0sF", hash: "h", createdAt: "t", owned: false },
      "S/Stale": { type: "Mapping", apiName: "M", hash: "h", createdAt: "t" },
    });
    const byId = new Map(collectOrphans(new Set(["S/Kept"]), state).map((o) => [o.uniqueId, o.kind]));
    expect(byId.get("S/Kept")).toBeUndefined();
    expect(byId.get("S/Prune")).toBe("prune");
    expect(byId.get("S/Forget")).toBe("forget");
    expect(byId.get("S/Stale")).toBe("stale");
    expect(byId.size).toBe(3);
  });
});

describe("buildDependentsMap", () => {
  it("inverts dependsOn edges", () => {
    const stack = new Stack(new App(), "S", { targetOrg: "x" });
    const parent = new Connection(stack, "Parent", { connectorType: "AwsS3", label: "P" });
    const child = new Connection(stack, "Child", { connectorType: "AwsS3", label: "C" });
    // Manually assign dependsOn to avoid reaching into construct internals
    (child as unknown as { dependsOn: readonly unknown[] }).dependsOn = [parent];
    const deps = buildDependentsMap([parent, child] as never);
    expect(deps.get(parent.uniqueId)).toEqual([child.uniqueId]);
  });
});
