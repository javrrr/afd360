import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { Connection } from "../../src/resources/connection.js";
import {
  DataStream,
  DataStreamResource,
} from "../../src/resources/data-stream.js";
import { errBodyIncludes } from "../../src/client/retry.js";
import type { ResourceContext } from "../../src/core/construct.js";

function buildApp(): { app: App; stack: Stack; conn: Connection; stream: DataStream } {
  const app = new App();
  const stack = new Stack(app, "Rag", { targetOrg: "jaygentforce" });
  const conn = new Connection(stack, "Docs", {
    connectorType: "IngestApi",
    label: "Docs",
    schema: { label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
  });
  const stream = new DataStream(stack, "DocsStream", {
    connection: conn,
    sourceObject: "KB",
    primaryKey: { name: "Id" },
  });
  return { app, stack, conn, stream };
}

function mockCtx(): ResourceContext {
  return {
    client: {
      dataStreams: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
        patch: vi.fn(),
      },
    } as unknown as ResourceContext["client"],
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

describe("DataStream construct", () => {
  it("derives devName + DLO name; wires deps to Connection + ConnectionSchema", () => {
    const { conn, stream } = buildApp();
    expect(stream.devName).toBe("DocsStream");
    expect(stream.dlo.name).toBe("KB__dll");
    expect(stream.dependsOn).toContain(conn);
    expect(stream.dependsOn).toContain(conn.schema);
  });

  it("plan emits DataStream resource with deps on Connection + its Schema", () => {
    const { app } = buildApp();
    const plan = app.synth("0.0.1");
    const entry = plan.resources.find((r) => r.type === "DataStream")!;
    expect(entry.uniqueId).toBe("Rag/DocsStream");
    expect(entry.dependsOn.sort()).toEqual(["Rag/Docs", "Rag/Docs/DocsSchema"].sort());
  });

  it("hash excludes connectionName (deploy-time injected)", () => {
    const { stream } = buildApp();
    const withName = stream.resource.hash({ ...stream.props, connectionName: "A" });
    const without = stream.resource.hash({ ...stream.props, connectionName: "B" });
    expect(withName).toBe(without);
  });

  it("resolveProps returns null until parent Connection is deployed", () => {
    const { stream } = buildApp();
    expect(stream.resolveProps(new Map())).toBeNull();
  });

  it("resolveProps injects parent Connection apiName (not authored devName) once deployed", () => {
    const { conn, stream } = buildApp();
    // Simulate post-deploy state: platform auto-suffixed the connection's API name.
    const apiName = "afd360_c3_ingest_abcd1234";
    const deployed = new Map([
      [conn.uniqueId, { salesforceId: "0sH123", apiName }],
    ]);
    const resolved = stream.resolveProps(deployed);
    expect(resolved).not.toBeNull();
    expect(resolved!.connectionName).toBe(apiName);
  });
});

describe("DataStreamResource.isReady (quirk A2, live-observed)", () => {
  const out = { recordId: "r", name: "s" };
  it("accepts uppercase ACTIVE", async () => {
    const ctx = mockCtx();
    const get = ctx.client.dataStreams.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({ name: "s", status: "ACTIVE" });
    expect(await DataStreamResource.isReady!(ctx, out)).toBe(true);
  });
  it("accepts PROCESSING when DLO is ACTIVE (IngestApi provisioning-complete case)", async () => {
    const ctx = mockCtx();
    const get = ctx.client.dataStreams.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({
      name: "s",
      status: "PROCESSING",
      dataLakeObjectInfo: { status: "ACTIVE", name: "s__dll" },
    });
    expect(await DataStreamResource.isReady!(ctx, out)).toBe(true);
  });
  it("returns false when DLO is still provisioning", async () => {
    const ctx = mockCtx();
    const get = ctx.client.dataStreams.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({
      name: "s",
      status: "PROCESSING",
      dataLakeObjectInfo: { status: "PROCESSING" },
    });
    expect(await DataStreamResource.isReady!(ctx, out)).toBe(false);
  });
  it("throws on terminal ERROR or DELETING", async () => {
    const ctx = mockCtx();
    const get = ctx.client.dataStreams.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({ name: "s", status: "ERROR" });
    await expect(DataStreamResource.isReady!(ctx, out)).rejects.toThrow(/terminal state/);
    get.mockResolvedValueOnce({ name: "s", status: "DELETING" });
    await expect(DataStreamResource.isReady!(ctx, out)).rejects.toThrow(/terminal state/);
  });
});

describe("quirk A1 — errBodyIncludes('Illegal argument') predicate", () => {
  it("matches the tdc-observed error body string", () => {
    expect(
      errBodyIncludes({ status: 400, body: "Illegal argument: schema still provisioning" }, "Illegal argument"),
    ).toBe(true);
    expect(
      errBodyIncludes({ status: 400, body: { errorCode: "Illegal argument" } }, "Illegal argument"),
    ).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(errBodyIncludes({ status: 400, body: "Bad request" }, "Illegal argument")).toBe(false);
  });
});
