import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { Connection, ConnectionResource } from "../../src/resources/connection.js";
import { ConnectionSchemaResource } from "../../src/resources/connection-schema.js";
import type { ResourceContext } from "../../src/core/construct.js";

function mockDeleteCtx(): ResourceContext {
  return {
    client: {
      connections: {
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

describe("Connection construct", () => {
  it("exposes devName = authored name, fallback to logical id", () => {
    const app = new App();
    const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });
    const a = new Connection(stack, "DocsS3", { connectorType: "AwsS3", label: "Docs" });
    const b = new Connection(stack, "CustomIngest", {
      connectorType: "IngestApi",
      label: "Custom",
      name: "overridden_name",
    });
    expect(a.devName).toBe("DocsS3");
    expect(b.devName).toBe("overridden_name");
  });

  it("normalizes props.name so resource callers never see an undefined name", () => {
    // Regression: early S3 deploy POSTed name:"" and got
    // ILLEGAL_QUERY_PARAMETER_VALUE "dataConnection.developerName cannot be empty".
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const c = new Connection(stack, "MyConn", { connectorType: "AwsS3", label: "L" });
    expect(c.props.name).toBe("MyConn");
  });

  it("materializes a ConnectionSchema child when connectorType=IngestApi + schema supplied", () => {
    const app = new App();
    const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });
    const conn = new Connection(stack, "Docs", {
      connectorType: "IngestApi",
      label: "Docs",
      schema: {
        label: "KnowledgeBase",
        fields: [{ name: "id", dataType: "Text" }],
      },
    });
    expect(conn.schema).toBeDefined();
    expect(conn.schema!.uniqueId).toBe("RagDemo/Docs/DocsSchema");
    expect(conn.schema!.dependsOn).toEqual([conn]);
    expect(conn.schema!.resource).toBe(ConnectionSchemaResource);
  });

  it("rejects schema on non-IngestApi connectors", () => {
    const app = new App();
    const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });
    expect(() =>
      new Connection(stack, "Bad", {
        connectorType: "AwsS3",
        label: "Bad",
        schema: { label: "x", fields: [] },
      }),
    ).toThrow(/schema is only supported.*IngestApi/);
  });

  it("hash excludes the schema sub-tree", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    // Two constructs with the same name/label/connectorType but DIFFERENT
    // schemas should hash identically — schema is a separate resource whose
    // drift is tracked on its own state entry.
    const a = new Connection(stack, "A", {
      connectorType: "IngestApi",
      label: "L",
      name: "ConnName",
      schema: { label: "s", fields: [{ name: "f", dataType: "Text" }] },
    });
    const b = new Connection(stack, "B", {
      connectorType: "IngestApi",
      label: "L",
      name: "ConnName",
      schema: { label: "DIFFERENT", fields: [] },
    });
    expect(a.resource.hash(a.props)).toBe(b.resource.hash(b.props));
  });

  it("plan includes both Connection and its ConnectionSchema, with the right edge", () => {
    const app = new App();
    const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });
    new Connection(stack, "Docs", {
      connectorType: "IngestApi",
      label: "Docs",
      schema: { label: "KB", fields: [] },
    });
    const plan = app.synth("0.0.1");
    expect(plan.resources.map((r) => r.uniqueId).sort()).toEqual([
      "RagDemo/Docs",
      "RagDemo/Docs/DocsSchema",
    ]);
    const schemaEntry = plan.resources.find((r) => r.type === "ConnectionSchema")!;
    expect(schemaEntry.dependsOn).toEqual(["RagDemo/Docs"]);
  });
});

describe("ConnectionResource.isFailed", () => {
  it("returns true for status 'Error' (title-case, as returned by Connect API)", () => {
    expect(
      ConnectionResource.isFailed({
        id: "0xH",
        name: "X",
        connectorType: "SNOWFLAKE",
        status: "Error",
      }),
    ).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(
      ConnectionResource.isFailed({
        id: "0xH",
        name: "X",
        connectorType: "AwsS3",
        status: "ERROR",
      }),
    ).toBe(true);
  });
  it("returns false for Active / Processing / missing", () => {
    for (const status of ["Active", "Processing", undefined]) {
      expect(
        ConnectionResource.isFailed({
          id: "0xH",
          name: "X",
          connectorType: "AwsS3",
          status,
        }),
      ).toBe(false);
    }
  });
});

describe("ConnectionResource.delete — already-gone tolerance (D1)", () => {
  it("swallows 404 as idempotent success", async () => {
    const ctx = mockDeleteCtx();
    (ctx.client.connections.delete as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    await expect(ConnectionResource.delete(ctx, "0xH-gone")).resolves.toBeUndefined();
  });

  it("swallows 500 with 'not found' body", async () => {
    const ctx = mockDeleteCtx();
    (ctx.client.connections.delete as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 500,
      body: '[{"message":"The connection was not found."}]',
    });
    await expect(ConnectionResource.delete(ctx, "0xH-gone")).resolves.toBeUndefined();
  });
});

describe("ConnectionSchema resource", () => {
  it("composite id format is <connectionId>::<schemaName>", () => {
    expect(
      ConnectionSchemaResource.idOf({ connectionId: "0xH", schemaName: "KB" }),
    ).toBe("0xH::KB");
  });
});
