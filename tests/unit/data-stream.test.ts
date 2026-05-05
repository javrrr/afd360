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

describe("DataStreamResource.isReady (revised contract)", () => {
  const out = { recordId: "r", name: "s" };
  it("accepts uppercase ACTIVE", async () => {
    const ctx = mockCtx();
    const get = ctx.client.dataStreams.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({ name: "s", status: "ACTIVE" });
    expect(await DataStreamResource.isReady!(ctx, out)).toBe(true);
  });
  it("returns false on PROCESSING (keep polling)", async () => {
    // Reversed from a prior afd360 iteration — PROCESSING for IngestApi
    // streams is NOT a ready state; they self-transition to ERROR if data
    // never ingests. Evidence: jaygentforce C3 on 2026-05-05.
    const ctx = mockCtx();
    const get = ctx.client.dataStreams.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({
      name: "s",
      status: "PROCESSING",
      dataLakeObjectInfo: { status: "ACTIVE" },
    });
    expect(await DataStreamResource.isReady!(ctx, out)).toBe(false);
  });
  it("throws on terminal ERROR or DELETING with actionable message", async () => {
    const ctx = mockCtx();
    const get = ctx.client.dataStreams.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValueOnce({ name: "s", status: "ERROR", lastRunStatus: "NONE" });
    await expect(DataStreamResource.isReady!(ctx, out)).rejects.toThrow(
      /terminal state ERROR.*afd360 destroy.*afd360 deploy/s,
    );
    get.mockResolvedValueOnce({ name: "s", status: "DELETING" });
    await expect(DataStreamResource.isReady!(ctx, out)).rejects.toThrow(/terminal state/);
  });
});

describe("DataStreamResource.isFailed", () => {
  it("returns true for ERROR (any casing)", () => {
    expect(DataStreamResource.isFailed!({ recordId: "r", name: "s", status: "ERROR" })).toBe(true);
    expect(DataStreamResource.isFailed!({ recordId: "r", name: "s", status: "error" })).toBe(true);
  });
  it("returns false for healthy or transient statuses", () => {
    for (const status of ["ACTIVE", "PROCESSING", "DELETING", undefined]) {
      expect(
        DataStreamResource.isFailed!({ recordId: "r", name: "s", status }),
      ).toBe(false);
    }
  });
});

describe("DataStream AwsS3 path", () => {
  function buildS3Fixture() {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const conn = new Connection(stack, "S3", {
      connectorType: "AwsS3",
      label: "S3",
      method: "Ingress",
      credentials: { authenticationOption: "accessKeyAndSecret", accessKey: "a", accessSecret: "b" },
      parameters: { bucketName: "b", parentDirectory: "/" },
    });
    return { stack, conn };
  }

  it("requires s3 attributes for AwsS3 connections", () => {
    const { stack, conn } = buildS3Fixture();
    expect(() => new DataStream(stack, "Bad", {
      connection: conn,
      sourceObject: "x",
      primaryKey: { name: "id" },
    })).toThrow(/s3 attributes/);
  });

  it("rejects s3 attrs on an IngestApi connection", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const conn = new Connection(stack, "IA", {
      connectorType: "IngestApi",
      label: "IA",
      schema: { label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
    });
    expect(() => new DataStream(stack, "X", {
      connection: conn,
      sourceObject: "KB",
      primaryKey: { name: "Id" },
      s3: { fileType: "CSV", fileName: "x.csv" },
    })).toThrow(/only meaningful for AwsS3/);
  });

  it("builds CONNECTORSFRAMEWORK payload with advancedAttributes", async () => {
    const { stack, conn } = buildS3Fixture();
    const stream = new DataStream(stack, "Stream", {
      connection: conn,
      sourceObject: "orders",
      primaryKey: { name: "id" },
      s3: {
        fileType: "CSV",
        importDirectory: "demo",
        fileName: "orders.csv",
        areHeadersIncludedInFile: "true",
      },
    });
    const ctx = mockCtx();
    const create = (ctx.client.dataStreams as unknown as { create: ReturnType<typeof vi.fn> }).create;
    create.mockResolvedValue({ name: "Stream", recordId: "1ds" });
    await DataStreamResource.create(ctx, {
      ...stream.props,
      connectionName: "S3_resolved",
    });
    expect(create).toHaveBeenCalledTimes(1);
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body["datastreamType"]).toBe("CONNECTORSFRAMEWORK");
    expect(body["connectorInfo"]).toMatchObject({
      // DataConnector (NOT AwsS3) is the create-time discriminator — see
      // SDK's DataStreamConnectorInput discriminated union. GET responses
      // echo back "AwsS3" but POSTing that gets a Jackson subtype error.
      connectorType: "DataConnector",
      connectorDetails: { name: "S3_resolved", type: "AwsS3" },
    });
    expect(body["advancedAttributes"]).toMatchObject({
      fileType: "CSV",
      fileName: "orders.csv",
      importDirectory: "demo",
    });
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
