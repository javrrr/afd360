import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { Connection } from "../../src/resources/connection.js";
import { computeOp } from "../../src/cli/ops.js";
import type { StackState } from "../../src/core/state.js";
import type { ResourceContext } from "../../src/core/construct.js";

function buildStack(): { conn: Connection } {
  const app = new App();
  const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });
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
      alias: "jaygentforce",
      username: "u",
      orgId: "00D",
      instanceUrl: "https://x",
      apiVersion: "66.0",
      accessToken: "tok",
    },
    orgAlias: "jaygentforce",
  };
}

function emptyState(): StackState {
  return {
    stackName: "RagDemo",
    targetOrg: "jaygentforce",
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
    const stack = new Stack(app, "Rag", { targetOrg: "jaygentforce" });
    const conn = new Connection(stack, "DocsS3", {
      connectorType: "AwsS3",
      label: "DocsS3",
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
