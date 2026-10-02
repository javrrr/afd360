import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { Connection } from "../../src/resources/connection.js";
import {
  DataStream,
  DataStreamResource,
  ExistingDataStreamResource,
} from "../../src/resources/data-stream.js";
import { errBodyIncludes } from "../../src/client/retry.js";
import type { ResourceContext } from "../../src/core/construct.js";

function buildApp(): { app: App; stack: Stack; conn: Connection; stream: DataStream } {
  const app = new App();
  const stack = new Stack(app, "Rag", { targetOrg: "dev-org" });
  const conn = new Connection(stack, "Docs", {
    connectorType: "IngestApi",
    label: "Docs",
    schema: { name: "KB", label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
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

describe("DataStream IngestApi schema-name validation", () => {
  it("throws when sourceObject != the schema object name (defaulted from construct id)", () => {
    const app = new App();
    const stack = new Stack(app, "Ing", { targetOrg: "org" });
    // schema.name omitted -> defaults to construct id "DocsSchema"; sourceObject
    // "KnowledgeBase" (the label mental model) mismatches -> opaque 400 at deploy.
    const conn = new Connection(stack, "Docs", {
      connectorType: "IngestApi",
      label: "Docs",
      schema: { label: "KnowledgeBase", fields: [{ name: "Id", dataType: "Text" }] },
    });
    expect(() => new DataStream(stack, "Stream", {
      connection: conn,
      sourceObject: "KnowledgeBase",
      primaryKey: { name: "Id" },
    })).toThrow(/sourceObject "KnowledgeBase" must equal the IngestApi schema object name "DocsSchema"/);
  });

  it("accepts a matching sourceObject when schema.name is set", () => {
    const app = new App();
    const stack = new Stack(app, "Ing", { targetOrg: "org" });
    const conn = new Connection(stack, "Docs", {
      connectorType: "IngestApi",
      label: "Docs",
      schema: { name: "KnowledgeBase", label: "KnowledgeBase", fields: [{ name: "Id", dataType: "Text" }] },
    });
    expect(() => new DataStream(stack, "Stream", {
      connection: conn,
      sourceObject: "KnowledgeBase",
      primaryKey: { name: "Id" },
    })).not.toThrow();
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
    // never ingests. Evidence: dev-org C3 on 2026-05-05.
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
      schema: { name: "KB", label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
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
        alias: "dev-org", username: "u", orgId: "00D",
        instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
      },
      orgAlias: "dev-org",
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

  it("re-issues the DLO delete until GET confirms it's gone (deferred cascade no-op)", async () => {
    vi.useFakeTimers();
    try {
      const ctx = mockDeleteCtx();
      const client = ctx.client as unknown as {
        dataStreams: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
        dataLakeObjects: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
      };
      client.dataStreams.get.mockResolvedValue({
        name: "X", recordId: "X", dataLakeObjectInfo: { name: "KB__dll" },
      });
      client.dataStreams.delete.mockResolvedValue(undefined); // cascade 204 but no-op's the DLO
      // DLO still present on the first verify (the cascade deferred), gone on
      // the second verify after the explicit delete is re-issued.
      client.dataLakeObjects.get
        .mockResolvedValueOnce({ name: "KB__dll" })
        .mockRejectedValueOnce({ status: 404 });
      client.dataLakeObjects.delete.mockResolvedValue(undefined);

      const p = DataStreamResource.delete(ctx, "X");
      await vi.advanceTimersByTimeAsync(10_000); // cover the 5s poll interval
      await expect(p).resolves.toBeUndefined();
      expect(client.dataLakeObjects.delete).toHaveBeenCalledTimes(1);
      expect(client.dataLakeObjects.get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns (not silently) and returns without throwing if the DLO never clears within budget", async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const ctx = mockDeleteCtx();
      const client = ctx.client as unknown as {
        dataStreams: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
        dataLakeObjects: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
      };
      client.dataStreams.get.mockResolvedValue({
        name: "X", recordId: "X", dataLakeObjectInfo: { name: "KB__dll" },
      });
      client.dataStreams.delete.mockResolvedValue(undefined);
      client.dataLakeObjects.get.mockResolvedValue({ name: "KB__dll" }); // always present
      client.dataLakeObjects.delete.mockResolvedValue(undefined); // 204 but perpetually no-op's

      const p = DataStreamResource.delete(ctx, "X");
      await vi.advanceTimersByTimeAsync(70_000); // exhaust the 60s budget
      await expect(p).resolves.toBeUndefined(); // best-effort: must NOT throw
      const emitted = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(emitted).toMatch(/left its backing DLO "KB__dll" on-org/);
      expect(emitted).toMatch(/DELETE \/ssot\/data-lake-objects\/KB__dll/);
    } finally {
      stderr.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("quirk A1 — errBodyIncludes('Illegal argument') predicate", () => {
  it("matches the prior tooling-observed error body string", () => {
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

describe("SalesforceHome (same-org CRM / Home) DataStream", () => {
  function buildHomeFixture(sourceObject = "Account", category?: "Profile" | "Other") {
    const app = new App();
    const stack = new Stack(app, "Home", { targetOrg: "dev-org" });
    const home = Connection.salesforceHome(stack);
    const stream = new DataStream(stack, `${sourceObject}Home`, {
      connection: home,
      sourceObject,
      ...(category ? { category } : {}),
      primaryKey: { name: "Id" },
    });
    return { app, stack, home, stream };
  }

  it("Connection.salesforceHome encodes the platform constants", () => {
    const app = new App();
    const stack = new Stack(app, "Home", { targetOrg: "dev-org" });
    const home = Connection.salesforceHome(stack);
    expect(home.isExisting).toBe(true);
    // Connection dev name (used for connectorDetails.name / adopt-by-name).
    expect(home.devName).toBe("SalesforceDotCom_Home");
    expect(home.props.connectorType).toBe("SalesforceDotCom");
    // dataSource differs from the dev name — this is the stream's `datasource`.
    expect(home.dataSourceName).toBe("Salesforce_Home");
  });

  it("names the DLO <Object>_Home__dll (not <Object>__dll)", () => {
    const { stream } = buildHomeFixture("Account");
    expect(stream.dlo.name).toBe("Account_Home__dll");
  });

  it("resolveProps threads the connection's dataSource as datasourceName", () => {
    const { home, stream } = buildHomeFixture("Account");
    const deployed = new Map([
      [home.uniqueId, { salesforceId: "0hMbm000002SghVEAS", apiName: "SalesforceDotCom_Home" }],
    ]);
    const resolved = stream.resolveProps(deployed)!;
    expect(resolved.connectionName).toBe("SalesforceDotCom_Home");
    expect(resolved.datasourceName).toBe("Salesforce_Home");
  });

  it("builds the confirmed SFDC POST body (asymmetry-safe: no type/advancedAttributes/sourceFields)", async () => {
    const { home, stream } = buildHomeFixture("Account", "Profile");
    const ctx = mockCtx();
    const create = (ctx.client.dataStreams as unknown as { create: ReturnType<typeof vi.fn> }).create;
    create.mockResolvedValue({ name: "AccountHome", recordId: "1ds" });
    const deployed = new Map([
      [home.uniqueId, { salesforceId: "0hMbm000002SghVEAS", apiName: "SalesforceDotCom_Home" }],
    ]);
    await DataStreamResource.create(ctx, stream.resolveProps(deployed)!);
    const body = create.mock.calls[0]![0] as Record<string, unknown>;

    expect(body["datastreamType"]).toBe("SFDC");
    // datasource = connection's dataSource, NOT the dev name, NOT prefixed.
    expect(body["datasource"]).toBe("Salesforce_Home");
    // connectorType is the SalesforceDotCom discriminator; connectorDetails
    // carries the connection dev name + sourceObject, and NO `type` (echoing
    // the GET's connectorDetails.type 400s with JSON_PARSER_ERROR).
    expect(body["connectorInfo"]).toEqual({
      connectorType: "SalesforceDotCom",
      connectorDetails: { name: "SalesforceDotCom_Home", sourceObject: "Account" },
    });
    // No S3-style fields — auto-introspection is PK-driven.
    expect(body["advancedAttributes"]).toBeUndefined();
    expect(body["sourceFields"]).toBeUndefined();
    expect(body["mappings"]).toBeUndefined();
    const dlo = body["dataLakeObjectInfo"] as Record<string, unknown>;
    expect(dlo["name"]).toBe("Account_Home__dll");
    expect(dlo["recordModifiedFieldName"]).toBe("SystemModstamp");
    expect(dlo["dataLakeFieldInputRepresentations"]).toEqual([
      { name: "Id", label: "Id", dataType: "Text", isPrimaryKey: true },
    ]);
    expect(body["refreshConfig"]).toEqual({
      refreshMode: "UPSERT",
      frequency: { frequencyType: "BATCH" },
    });
  });

  it("honors a recordModifiedFieldName override", async () => {
    const app = new App();
    const stack = new Stack(app, "Home", { targetOrg: "dev-org" });
    const home = Connection.salesforceHome(stack);
    const stream = new DataStream(stack, "RegionHome", {
      connection: home,
      sourceObject: "P_Region__c",
      primaryKey: { name: "Id" },
      recordModifiedFieldName: "LastModifiedDate",
    });
    const ctx = mockCtx();
    const create = (ctx.client.dataStreams as unknown as { create: ReturnType<typeof vi.fn> }).create;
    create.mockResolvedValue({ name: "RegionHome", recordId: "1ds" });
    const deployed = new Map([
      [home.uniqueId, { salesforceId: "0h1", apiName: "SalesforceDotCom_Home" }],
    ]);
    await DataStreamResource.create(ctx, stream.resolveProps(deployed)!);
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    const dlo = body["dataLakeObjectInfo"] as Record<string, unknown>;
    // Custom object: trailing __c is stripped before _Home__dll. Confirmed
    // live on a live org — "P_Region__c" materialized as "P_Region_Home__dll".
    expect(dlo["name"]).toBe("P_Region_Home__dll");
    expect(dlo["recordModifiedFieldName"]).toBe("LastModifiedDate");
  });

  it("strips a trailing __c from custom objects when deriving the DLO name", () => {
    const app = new App();
    const stack = new Stack(app, "Home", { targetOrg: "dev-org" });
    const home = Connection.salesforceHome(stack);
    // Standard object: name passes through unchanged.
    const std = new DataStream(stack, "AccountHome", {
      connection: home,
      sourceObject: "Account",
      primaryKey: { name: "Id" },
    });
    expect(std.dlo.name).toBe("Account_Home__dll");
    // Custom object: __c collapses out (NOT "P_Region__c_Home__dll").
    const custom = new DataStream(stack, "RegionHome2", {
      connection: home,
      sourceObject: "P_Region__c",
      primaryKey: { name: "Id" },
    });
    expect(custom.dlo.name).toBe("P_Region_Home__dll");
  });

  it("adopts a pre-existing Home stream by its _Home__dll name (not <Object>__dll)", async () => {
    // The platform provisions Home streams whose live `name` (e.g.
    // "Account_Home") differs from the authored dev name ("AccountHome"), so
    // the only stable natural key is the DLO name. Regression: lookupByProps
    // must derive that as "Account_Home__dll" — matching against "Account__dll"
    // misses it and the op is misclassified `create` (a diff/reality mismatch).
    const { home, stream } = buildHomeFixture("Account", "Profile");
    const ctx = mockCtx();
    const list = (ctx.client.dataStreams as unknown as { list: ReturnType<typeof vi.fn> }).list;
    const get = (ctx.client.dataStreams as unknown as { get: ReturnType<typeof vi.fn> }).get;
    list.mockResolvedValue({
      dataStreams: [
        {
          name: "Account_Home",
          recordId: "1dsbm000001PqXVAA0",
          label: "Account Home",
          dataLakeObjectInfo: { name: "Account_Home__dll" },
        },
      ],
    });
    get.mockResolvedValue({ name: "Account_Home", recordId: "1dsbm000001PqXVAA0" });
    const deployed = new Map([
      [home.uniqueId, { salesforceId: "0hMbm000002SghVEAS", apiName: "SalesforceDotCom_Home" }],
    ]);
    const found = await DataStreamResource.lookupByProps!(ctx, stream.resolveProps(deployed)!);
    // Found the platform stream via the correct DLO name, and read it by id.
    expect(get).toHaveBeenCalledWith("1dsbm000001PqXVAA0");
    expect(found).not.toBeNull();
  });

  it("rejects a freshly-created (non-referenced) SalesforceDotCom connection", () => {
    const app = new App();
    const stack = new Stack(app, "Home", { targetOrg: "dev-org" });
    // A normal `new Connection` with connectorType SalesforceDotCom is the
    // unsupported external/OAuth path — only the referenced Home connector works.
    const ext = new Connection(stack, "ExtCrm", {
      connectorType: "SalesforceDotCom",
      label: "External CRM",
    });
    expect(
      () =>
        new DataStream(stack, "ExtStream", {
          connection: ext,
          sourceObject: "Account",
          primaryKey: { name: "Id" },
        }),
    ).toThrow(/only supported for the built-in same-org CRM/);
  });
});

describe("DataStream.fromExisting (reference lifecycle)", () => {
  function buildRef(sourceObject = "Account") {
    const app = new App();
    const stack = new Stack(app, "Home", { targetOrg: "dev-org" });
    const home = Connection.salesforceHome(stack);
    const stream = DataStream.fromExisting(stack, `${sourceObject}Ref`, {
      connection: home,
      sourceObject,
    });
    return { app, stack, home, stream };
  }

  it("swaps in the reference lifecycle and derives a Mapping-usable DLO name", () => {
    const { stream } = buildRef("Account");
    expect(stream.isExisting).toBe(true);
    expect(stream.resource).toBe(ExistingDataStreamResource);
    // The DLO name is derived identically to an owned Home stream, so it's a
    // valid Mapping source (the whole point of fromExisting — FINDING M3).
    expect(stream.dlo.name).toBe("Account_Home__dll");
  });

  it("an owned DataStream keeps DataStreamResource + isExisting=false", () => {
    const app = new App();
    const stack = new Stack(app, "Home", { targetOrg: "dev-org" });
    const home = Connection.salesforceHome(stack);
    const owned = new DataStream(stack, "AccountHome", {
      connection: home,
      sourceObject: "Account",
      primaryKey: { name: "Id" },
    });
    expect(owned.isExisting).toBe(false);
    expect(owned.resource).toBe(DataStreamResource);
  });

  it("serves as a Mapping source (dlo.name + auto-wired dependency)", async () => {
    const { stack, stream } = buildRef("Account");
    const { Mapping } = await import("../../src/resources/mapping.js");
    const mapping = new Mapping(stack, "AccountMap", {
      source: stream,
      target: "ssot__Account__dlm",
      fieldMappings: [{ source: "Id__c", target: "Id__c" }],
    });
    expect(mapping.props.sourceDloName).toBe("Account_Home__dll");
    expect(mapping.dependsOn).toContain(stream);
  });

  it("create adopts the pre-existing stream by DLO name — never POSTs", async () => {
    const { home, stream } = buildRef("Account");
    const ctx = mockCtx();
    const list = (ctx.client.dataStreams as unknown as { list: ReturnType<typeof vi.fn> }).list;
    const get = (ctx.client.dataStreams as unknown as { get: ReturnType<typeof vi.fn> }).get;
    const create = (ctx.client.dataStreams as unknown as { create: ReturnType<typeof vi.fn> }).create;
    list.mockResolvedValue({
      dataStreams: [
        { name: "Account_Home", recordId: "1dsPqXVAA0", dataLakeObjectInfo: { name: "Account_Home__dll" } },
      ],
    });
    get.mockResolvedValue({ name: "Account_Home", recordId: "1dsPqXVAA0" });
    const deployed = new Map([
      [home.uniqueId, { salesforceId: "0hM", apiName: "SalesforceDotCom_Home" }],
    ]);
    const out = await ExistingDataStreamResource.create(ctx, stream.resolveProps(deployed)!);
    expect(out.recordId).toBe("1dsPqXVAA0");
    expect(create).not.toHaveBeenCalled();
  });

  it("create throws when no matching pre-existing stream is present", async () => {
    const { home, stream } = buildRef("Ghost");
    const ctx = mockCtx();
    const list = (ctx.client.dataStreams as unknown as { list: ReturnType<typeof vi.fn> }).list;
    list.mockResolvedValue({ dataStreams: [] });
    const deployed = new Map([
      [home.uniqueId, { salesforceId: "0hM", apiName: "SalesforceDotCom_Home" }],
    ]);
    await expect(
      ExistingDataStreamResource.create(ctx, stream.resolveProps(deployed)!),
    ).rejects.toThrow(/REFERENCES a pre-existing stream/);
  });

  it("delete is a no-op — the referenced stream and its DLO survive destroy", async () => {
    const ctx = mockCtx();
    const del = (ctx.client.dataStreams as unknown as { delete: ReturnType<typeof vi.fn> }).delete;
    await ExistingDataStreamResource.delete(ctx, "1dsPqXVAA0");
    expect(del).not.toHaveBeenCalled();
  });
});
