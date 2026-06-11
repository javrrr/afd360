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
      s3: {
        fileType: "CSV",
        fileName: "x.csv",
        fields: [{ name: "id", dataType: "Text", isPrimaryKey: true }],
      },
    })).toThrow(/only meaningful for AwsS3/);
  });

  it("builds CONNECTORSFRAMEWORK payload with datasource prefix + sourceFields + mappings", async () => {
    const { stack, conn } = buildS3Fixture();
    const stream = new DataStream(stack, "Stream", {
      connection: conn,
      sourceObject: "orders",
      primaryKey: { name: "Id" },
      s3: {
        fileType: "CSV",
        importDirectory: "demo",
        fileName: "orders.csv",
        areHeadersIncludedInFile: "true",
        fields: [
          { name: "Id", dataType: "Text", isPrimaryKey: true },
          { name: "Engine rpm", dataType: "Number" },
          { name: "Time Stamp", dataType: "DateTime", format: "yyyy/MM/dd HH:mm:ss" },
        ],
      },
    });
    const ctx = mockCtx();
    const create = (ctx.client.dataStreams as unknown as { create: ReturnType<typeof vi.fn> }).create;
    create.mockResolvedValue({ name: "Stream", recordId: "1ds" });
    await DataStreamResource.create(ctx, {
      ...stream.props,
      connectionName: "S3_resolved",
    });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body["datastreamType"]).toBe("CONNECTORSFRAMEWORK");
    // datasource gets the AwsS3_ prefix — the platform expects the prefixed
    // value; bare connection name fails with no-matching-file errors.
    expect(body["datasource"]).toBe("AwsS3_S3_resolved");
    expect(body["connectorInfo"]).toMatchObject({
      connectorType: "DataConnector",
      // no `type` field — adding it gets JSON_PARSER_ERROR "Unrecognized field type"
      connectorDetails: { name: "S3_resolved" },
    });
    // sourceFields: CSV-native names preserved (spaces intact).
    expect(body["sourceFields"]).toEqual([
      { name: "Id", dataType: "Text" },
      { name: "Engine rpm", dataType: "Number" },
      { name: "Time Stamp", dataType: "DateTime", format: "yyyy/MM/dd HH:mm:ss" },
    ]);
    // mappings: spaces → underscores on the DLO side (auto-derived dloName).
    expect(body["mappings"]).toEqual([
      { sourceFieldLabel: "Id", targetFieldName: "Id", targetFieldReturntype: "Text" },
      { sourceFieldLabel: "Engine rpm", targetFieldName: "Engine_rpm", targetFieldReturntype: "Number" },
      { sourceFieldLabel: "Time Stamp", targetFieldName: "Time_Stamp", targetFieldReturntype: "DateTime" },
    ]);
    // DLO fields pre-declared — required so mappings' targetFieldName can resolve.
    expect((body["dataLakeObjectInfo"] as Record<string, unknown>)["dataLakeFieldInputRepresentations"]).toHaveLength(3);
    // One-shot-frequency default.
    expect((body["refreshConfig"] as Record<string, unknown>)["frequency"]).toEqual({ frequencyType: "None" });
  });

  it("requires eventDateTimeFieldName when category is Engagement", () => {
    const { stack, conn } = buildS3Fixture();
    expect(() => new DataStream(stack, "Bad", {
      connection: conn,
      sourceObject: "x",
      category: "Engagement",
      primaryKey: { name: "id" },
      s3: {
        fileType: "CSV",
        fileName: "x.csv",
        fields: [{ name: "id", dataType: "Text", isPrimaryKey: true }],
      },
    })).toThrow(/Engagement.*eventDateTimeFieldName/);
  });
});

describe("DataStream BigQuery path", () => {
  function buildBQFixture(): { stack: Stack; conn: Connection } {
    const app = new App();
    const stack = new Stack(app, "BQ", { targetOrg: "x" });
    const conn = new Connection(stack, "BQ", {
      connectorType: "BigQuery",
      label: "BQ",
      method: "Ingress",
      credentials: {
        authenticationOption: "ServiceAccountKey",
        serviceAccountKey: "${file:/path/to/key.json}",
      },
      parameters: {
        projectId: "my-gcp-project",
      },
    });
    return { stack, conn };
  }

  it("requires bigquery attributes for BigQuery connections", () => {
    const { stack, conn } = buildBQFixture();
    expect(() => new DataStream(stack, "Bad", {
      connection: conn,
      sourceObject: "x",
      primaryKey: { name: "id" },
    })).toThrow(/bigquery attributes/);
  });

  it("rejects bigquery attrs on a non-BigQuery connection", () => {
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
      bigquery: {
        project: "p", dataset: "d", table: "t",
        fields: [{ name: "id", dataType: "Text", isPrimaryKey: true }],
      },
    })).toThrow(/only meaningful for BigQuery/);
  });

  it("rejects INCREMENTAL refreshMode without bigquery.incrementalColumn", () => {
    const { stack, conn } = buildBQFixture();
    expect(() => new DataStream(stack, "Bad", {
      connection: conn,
      sourceObject: "orders",
      primaryKey: { name: "id" },
      refreshMode: "INCREMENTAL",
      bigquery: {
        project: "p", dataset: "d", table: "orders",
        fields: [{ name: "id", dataType: "Text", isPrimaryKey: true }],
      },
    })).toThrow(/INCREMENTAL.*incrementalColumn/);
  });

  it("rejects empty bigquery.fields", async () => {
    const { stack, conn } = buildBQFixture();
    const stream = new DataStream(stack, "Empty", {
      connection: conn,
      sourceObject: "empty",
      primaryKey: { name: "id" },
      refreshMode: "TOTAL_REPLACE",
      bigquery: { project: "p", dataset: "d", table: "empty", fields: [] },
    });
    const ctx = mockCtx();
    await expect(
      DataStreamResource.create(ctx, { ...stream.props, connectionName: "BQ_resolved" }),
    ).rejects.toThrow(/bigquery\.fields is required/);
  });

  it("rejects bigquery.fields without exactly one isPrimaryKey", async () => {
    const { stack, conn } = buildBQFixture();
    const stream = new DataStream(stack, "NoPk", {
      connection: conn,
      sourceObject: "x",
      primaryKey: { name: "id" },
      refreshMode: "TOTAL_REPLACE",
      bigquery: {
        project: "p", dataset: "d", table: "x",
        fields: [{ name: "id", dataType: "Text" }],
      },
    });
    const ctx = mockCtx();
    await expect(
      DataStreamResource.create(ctx, { ...stream.props, connectionName: "BQ_resolved" }),
    ).rejects.toThrow(/exactly one isPrimaryKey/);
  });

  it("builds Direct_Access payload (no datasource, federated routing) with sourceFields + mappings + advancedAttributes", async () => {
    const { stack, conn } = buildBQFixture();
    const stream = new DataStream(stack, "OrdersStream", {
      connection: conn,
      sourceObject: "Orders",
      label: "Orders (BigQuery)",
      primaryKey: { name: "sales_orders_id", dataType: "Number" },
      refreshMode: "INCREMENTAL",
      bigquery: {
        project: "demo-gcp-project",
        dataset: "sales_demo",
        table: "orders",
        incrementalColumn: "order_datetime",
        fields: [
          { name: "order_id",       dataType: "Number", isPrimaryKey: true },
          { name: "customer_id",    dataType: "Number" },
          { name: "order_datetime", dataType: "DateTime" },
          { name: "order_value",    dataType: "Number" },
        ],
      },
    });
    const ctx = mockCtx();
    const create = (ctx.client.dataStreams as unknown as { create: ReturnType<typeof vi.fn> }).create;
    create.mockResolvedValue({
      name: "OrdersStream",
      recordId: "1ds-bq",
      dataLakeObjectInfo: { name: "Orders__dll" },
    });
    await DataStreamResource.create(ctx, {
      ...stream.props,
      connectionName: "BQ_resolved",
    });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;

    // Direct_Access routing — the critical flag for BYOL connectors.
    expect(body["dataAccessMode"]).toBe("Direct_Access");
    expect(body["datastreamType"]).toBe("DATA_CONNECTORS");
    // No top-level `datasource` for Direct_Access; binding is via connectorDetails.name.
    expect(body["datasource"]).toBeUndefined();
    expect(body["connectorInfo"]).toMatchObject({
      connectorType: "DataConnector",
      connectorDetails: { name: "BQ_resolved" },
    });
    // BigQuery rides the Snowflake `database`/`schema`/`object` advanced-
    // attributes shape — NOT BigQuery-native `project`/`dataset`/`table`.
    // The Connect API's Direct_Access path is generic.
    expect(body["advancedAttributes"]).toEqual({
      database: "demo-gcp-project",  // BQ project → Snowflake "database"
      schema: "sales_demo",          // BQ dataset → Snowflake "schema"
      object: "orders",              // BQ table   → Snowflake "object"
      incrementalColumn: "order_datetime",
    });
    // sourceFields use authored names verbatim (BigQuery is case-sensitive).
    expect(body["sourceFields"]).toEqual([
      { name: "order_id",       dataType: "Number" },
      { name: "customer_id",    dataType: "Number" },
      { name: "order_datetime", dataType: "DateTime" },
      { name: "order_value",    dataType: "Number" },
    ]);
    // mappings: BigQuery column names contain no spaces, so dloName = name.
    expect(body["mappings"]).toEqual([
      { sourceFieldLabel: "order_id",       targetFieldName: "order_id",       targetFieldReturntype: "Number" },
      { sourceFieldLabel: "customer_id",    targetFieldName: "customer_id",    targetFieldReturntype: "Number" },
      { sourceFieldLabel: "order_datetime", targetFieldName: "order_datetime", targetFieldReturntype: "DateTime" },
      { sourceFieldLabel: "order_value",    targetFieldName: "order_value",    targetFieldReturntype: "Number" },
    ]);
    // DLO field-reps must pre-declare every column or the mapping rejects.
    const dlo = body["dataLakeObjectInfo"] as Record<string, unknown>;
    expect(dlo["name"]).toBe("Orders__dll");
    expect(dlo["dataLakeFieldInputRepresentations"]).toHaveLength(4);
    // No frequency block for Direct_Access — schedule is the connector's job.
    expect((body["refreshConfig"] as Record<string, unknown>)["refreshMode"]).toBe("INCREMENTAL");
  });

  it("accepts SDK-canonical TitleCase 'BigQuery' on the Connection construct", () => {
    const { stack, conn } = buildBQFixture();
    // No throw at construction.
    const stream = new DataStream(stack, "S", {
      connection: conn,
      sourceObject: "t",
      primaryKey: { name: "id", dataType: "Text" },
      refreshMode: "TOTAL_REPLACE",
      bigquery: {
        project: "p", dataset: "d", table: "t",
        fields: [{ name: "id", dataType: "Text", isPrimaryKey: true }],
      },
    });
    expect(stream.props.connectorType).toBe("BIGQUERY");
  });
});

describe("DataStreamResource.delete — already-gone tolerance", () => {
  function mockDeleteCtx(): ResourceContext {
    return {
      client: {
        dataStreams: {
          get: vi.fn(),
          delete: vi.fn(),
        },
        dataLakeObjects: {
          get: vi.fn(),
          delete: vi.fn(),
        },
      } as unknown as ResourceContext["client"],
      session: {
        alias: "jaygentforce", username: "u", orgId: "00D",
        instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
      },
      orgAlias: "jaygentforce",
    };
  }

  it("swallows 404 from the pre-read and never calls delete", async () => {
    const ctx = mockDeleteCtx();
    const client = ctx.client as unknown as { dataStreams: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } };
    client.dataStreams.get.mockRejectedValue({ status: 404 });
    await expect(DataStreamResource.delete(ctx, "recordId-gone")).resolves.toBeUndefined();
    expect(client.dataStreams.delete).not.toHaveBeenCalled();
  });

  it("swallows 404 from the cascade DELETE and still attempts DLO cleanup", async () => {
    const ctx = mockDeleteCtx();
    const client = ctx.client as unknown as {
      dataStreams: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
      dataLakeObjects: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    };
    client.dataStreams.get.mockResolvedValue({
      name: "X", recordId: "X", dataLakeObjectInfo: { name: "KB__dll" },
    });
    client.dataStreams.delete.mockRejectedValue({ status: 404 });
    client.dataLakeObjects.get.mockRejectedValue({ status: 404 });  // DLO also gone
    await expect(DataStreamResource.delete(ctx, "X")).resolves.toBeUndefined();
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
