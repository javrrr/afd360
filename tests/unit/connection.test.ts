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

describe("ConnectionResource.delete — transient 500 retry", () => {
  it("retries on transient 500 (platform-side cleanup race) and eventually succeeds", async () => {
    vi.useFakeTimers();
    try {
      const del = vi
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockRejectedValueOnce({
          status: 500,
          body: '[{"errorCode":"UNKNOWN_EXCEPTION","message":"transient cleanup race"}]',
        })
        .mockResolvedValueOnce(undefined);
      const ctx = {
        client: {
          connections: { delete: del },
        } as unknown as ResourceContext["client"],
        session: {
          alias: "awt", username: "u", orgId: "00D",
          instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
        },
        orgAlias: "awt",
      } as ResourceContext;
      const promise = ConnectionResource.delete(ctx, "9cgbm000000Wj21AAC");
      // Advance past the 5s interval. Deliberately a few seconds longer to
      // give the retry helper's sleep promise time to resolve cleanly.
      await vi.advanceTimersByTimeAsync(6_000);
      await promise;
      expect(del).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConnectionResource.delete — already-gone tolerance (D1)", () => {
  it("swallows 404 as idempotent success", async () => {
    const ctx = mockDeleteCtx();
    (ctx.client.connections.delete as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    await expect(ConnectionResource.delete(ctx, "0xH-gone")).resolves.toBeUndefined();
  });

  it("swallows 500 with 'not found' body after retry budget exhausts", async () => {
    // is5xx fires the retry loop; the body-text isNotFound check happens AFTER
    // the loop gives up, in the catch handler. So we advance through all 6
    // retries (5 × 5s sleeps = 25s) before the final swallow happens.
    vi.useFakeTimers();
    try {
      const ctx = mockDeleteCtx();
      (ctx.client.connections.delete as ReturnType<typeof vi.fn>).mockRejectedValue({
        status: 500,
        body: '[{"message":"The connection was not found."}]',
      });
      const promise = ConnectionResource.delete(ctx, "0xH-gone");
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConnectionSchema resource", () => {
  it("composite id format is <connectionId>::<schemaName>", () => {
    expect(
      ConnectionSchemaResource.idOf({ connectionId: "0xH", schemaName: "KB" }),
    ).toBe("0xH::KB");
  });

  it("defaults field.label = field.name to avoid the server-NPE quirk", async () => {
    // Observed on awt 2026-05-06: PUT /ssot/connections/.../schema with any
    // field missing `label` returns 500 with Java NPE "this.text is null".
    // afd360 defaults label = name at the resource layer so user-authored
    // manifests can be terse.
    const putSchema = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      client: { connections: { putSchema } } as unknown as ResourceContext["client"],
      session: {
        alias: "awt", username: "u", orgId: "00D",
        instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
      },
      orgAlias: "awt",
    } as ResourceContext;
    await ConnectionSchemaResource.create(ctx, {
      connectionId: "1WMbm0000003f3RGAQ",
      schemaName: "KnowledgeBase",
      schema: {
        label: "KnowledgeBase",
        fields: [
          { name: "Id", dataType: "Text" }, // no label
          { name: "Body", label: "Body Text", dataType: "Text" }, // explicit label preserved
        ],
      },
    });
    const body = putSchema.mock.calls[0]![1] as {
      schemas: Array<{ fields: Array<{ name: string; label: string }> }>;
    };
    const fields = body.schemas[0]!.fields;
    expect(fields[0]).toMatchObject({ name: "Id", label: "Id", dataType: "Text" });
    expect(fields[1]).toMatchObject({ name: "Body", label: "Body Text", dataType: "Text" });
  });
});

describe("ConnectionResource.create — DUPLICATES_DETECTED retry", () => {
  it("retries on DUPLICATES_DETECTED (DELETE→CREATE race) and returns the eventual create output", async () => {
    vi.useFakeTimers();
    try {
      const create = vi
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockRejectedValueOnce({
          status: 400,
          body: '[{"errorCode":"DUPLICATES_DETECTED","message":"A data connector with the provided name: X already exists"}]',
        })
        .mockResolvedValueOnce({
          id: "0sH-new",
          name: "X",
          label: "X",
          connectorType: "SNOWFLAKE",
        });
      const ctx = {
        client: {
          connections: { create },
        } as unknown as ResourceContext["client"],
        session: {
          alias: "awt", username: "u", orgId: "00D",
          instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
        },
        orgAlias: "awt",
      } as ResourceContext;
      const promise = ConnectionResource.create(ctx, {
        connectorType: "SNOWFLAKE",
        label: "X",
        name: "X",
      });
      // Advance past the 10s retry backoff without real wall time. Flush
      // microtasks between advances so the retry helper's sleep Promise
      // resolves and the second attempt fires.
      await vi.advanceTimersByTimeAsync(11_000);
      const out = await promise;
      expect(out.id).toBe("0sH-new");
      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConnectionResource.lookupByProps", () => {
  function mockListCtx(connections: Array<{ id?: string; name?: string; label?: string; connectorType?: string; status?: string }>): ResourceContext {
    return {
      client: {
        connections: {
          list: vi.fn().mockResolvedValue({ connections }),
        },
      } as unknown as ResourceContext["client"],
      session: {
        alias: "awt", username: "u", orgId: "00D",
        instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
      },
      orgAlias: "awt",
    };
  }

  it("adopts an IngestApi Connection whose name the platform rewrote to <label>_<uuid>", async () => {
    // IngestApi quirk: POST /ssot/connections ignores authored `name` and
    // writes back `<label-underscored>_<uuid>`. A second deploy therefore
    // can't find the Connection by exact-name match; fall back to `label`.
    const ctx = mockListCtx([
      {
        id: "1WMbm0000003f3RGAQ",
        name: "Docs_Ingest_fb25bdc5_4a6e_4c9c_a2ce_dfacd3fc5ab9",
        label: "Docs Ingest",
        connectorType: "IngestApi",
      },
    ]);
    const out = await ConnectionResource.lookupByProps!(ctx, {
      connectorType: "IngestApi",
      label: "Docs Ingest",
      name: "DocsIngest",
    });
    expect(out?.id).toBe("1WMbm0000003f3RGAQ");
    expect(out?.name).toBe("Docs_Ingest_fb25bdc5_4a6e_4c9c_a2ce_dfacd3fc5ab9");
  });

  it("non-IngestApi connectors still require exact-name match (no label fallback)", async () => {
    // AwsS3 and Snowflake preserve authored names verbatim — exact-match is
    // the right contract, and two different S3 connections can share a label.
    const ctx = mockListCtx([
      {
        id: "0sH1",
        name: "different_name",
        label: "Docs S3",
        connectorType: "AwsS3",
      },
    ]);
    const out = await ConnectionResource.lookupByProps!(ctx, {
      connectorType: "AwsS3",
      label: "Docs S3",
      name: "DocsS3",
    });
    expect(out).toBeNull();
  });
});
