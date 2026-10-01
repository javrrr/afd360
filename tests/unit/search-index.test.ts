import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import {
  SearchIndex,
  SearchIndexResource,
} from "../../src/resources/search-index.js";
import { Mapping } from "../../src/resources/mapping.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";
import type { ResourceContext } from "../../src/core/construct.js";

function mockCtx(): ResourceContext {
  return {
    client: {
      searchIndex: {
        get: vi.fn(),
        create: vi.fn(),
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

describe("SearchIndex construct", () => {
  it("defaults chunkDmoName / vectorDmoName without __dlm", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const si = new SearchIndex(stack, "MyIdx", {
      sourceDmo: "ssot__KnowledgeArticleVersion__dlm",
      fields: [{ fieldDeveloperName: "ssot__Description__c" }],
    });
    expect(si.props.chunkDmoDeveloperName).toBe("MyIdx_chunk");
    expect(si.props.vectorDmoDeveloperName).toBe("MyIdx_index");
    // No __dlm — platform appends (quirk C2).
    expect(si.props.chunkDmoDeveloperName.endsWith("__dlm")).toBe(false);
    expect(si.props.vectorDmoDeveloperName.endsWith("__dlm")).toBe(false);
  });

  it("rejects chunkDmoName with __dlm suffix", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    expect(
      () =>
        new SearchIndex(stack, "MyIdx", {
          sourceDmo: "ssot__KnowledgeArticleVersion__dlm",
          chunkDmoName: "MyIdx_chunk__dlm",
          fields: [{ fieldDeveloperName: "ssot__Description__c" }],
        }),
    ).toThrow(/must not end with "__dlm"/);
  });

  it("rejects vectorDmoName with __dlm suffix", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    expect(
      () =>
        new SearchIndex(stack, "MyIdx", {
          sourceDmo: "ssot__KnowledgeArticleVersion__dlm",
          vectorDmoName: "MyIdx_index__dlm",
          fields: [{ fieldDeveloperName: "ssot__Description__c" }],
        }),
    ).toThrow(/must not end with "__dlm"/);
  });

  it("rejects sourceDmo not ending with __dlm", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    expect(
      () =>
        new SearchIndex(stack, "MyIdx", {
          sourceDmo: "NTOProduct",
          fields: [{ fieldDeveloperName: "Name__c" }],
        }),
    ).toThrow(/must be a full DMO name ending in __dlm/);
  });

  it("rejects empty fields list", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    expect(
      () =>
        new SearchIndex(stack, "MyIdx", {
          sourceDmo: "NTOProduct__dlm",
          fields: [],
        }),
    ).toThrow(/at least one chunking field/);
  });

  it("auto-derives PK from DMO construct into vectorRelatedFields", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const dmo = new DMO(stack, "NTOProduct", {
      fields: [
        { name: "Id", dataType: "Text", isPrimaryKey: true },
        { name: "Description", dataType: "Text" },
      ],
    });
    const si = new SearchIndex(stack, "MyIdx", {
      sourceDmo: dmo,
      fields: [{ fieldDeveloperName: "Description__c" }],
    });
    expect(si.props.vectorRelatedFields).toHaveLength(1);
    expect(si.props.vectorRelatedFields[0]).toEqual({
      dmoDeveloperName: "NTOProduct__dlm",
      fieldDeveloperName: "Id__c",
    });
  });

  it("infers ssot__Id__c PK for standard ssot DMOs when not authored", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const si = new SearchIndex(stack, "MyIdx", {
      sourceDmo: "ssot__KnowledgeArticleVersion__dlm",
      fields: [{ fieldDeveloperName: "ssot__Description__c" }],
    });
    expect(si.props.vectorRelatedFields[0]!.fieldDeveloperName).toBe("ssot__Id__c");
  });

  it("preserves explicit vectorRelatedFields (C3 quirk — must be non-empty)", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const si = new SearchIndex(stack, "MyIdx", {
      sourceDmo: "ssot__KnowledgeArticleVersion__dlm",
      fields: [{ fieldDeveloperName: "ssot__ArticleContentText__c" }],
      vectorRelatedFields: [
        { dmoDeveloperName: "ssot__KnowledgeArticleVersion__dlm", fieldDeveloperName: "ssot__Language__c" },
      ],
    });
    expect(si.props.vectorRelatedFields).toHaveLength(1);
    expect(si.props.vectorRelatedFields[0]!.fieldDeveloperName).toBe("ssot__Language__c");
  });

  it("auto-wires dependsOn on a DMO construct source", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const dmo = new DMO(stack, "D", {
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    const si = new SearchIndex(stack, "MyIdx", {
      sourceDmo: dmo,
      fields: [{ fieldDeveloperName: "Id__c" }],
    });
    expect(si.dependsOn).toContain(dmo);
  });
});

describe("SearchIndexResource.create — payload shape", () => {
  it("uses developer names only — no output-only name fields (500 quirk)", async () => {
    const ctx = mockCtx();
    const create = ctx.client.searchIndex.create as ReturnType<typeof vi.fn>;
    const get = ctx.client.searchIndex.get as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ id: "18l0000000X" });
    get.mockResolvedValue({
      id: "18l0000000X",
      developerName: "MyIdx",
      runtimeStatus: null,
    });
    await SearchIndexResource.create(ctx, {
      developerName: "MyIdx",
      label: "MyIdx Search",
      sourceDmoDeveloperName: "NTOProduct__dlm",
      chunkDmoDeveloperName: "MyIdx_chunk",
      chunkDmoLabel: "MyIdx chunk",
      vectorDmoDeveloperName: "MyIdx_index",
      vectorDmoLabel: "MyIdx index",
      searchType: "HYBRID",
      processingType: "NEAR_REALTIME",
      fields: [{ fieldDeveloperName: "LongDescription__c" }],
      vectorRelatedFields: [
        { dmoDeveloperName: "NTOProduct__dlm", fieldDeveloperName: "Id__c" },
      ],
      vectorEmbedding: {
        similarityMetric: "COSINE",
        embeddingModel: { id: "e5_large_v2", userValues: [] },
        index: { id: "HNSW", userValues: [] },
      },
      dataSpace: "default",
    });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    const fieldCfg = (body["chunkingConfiguration"] as any).fieldLevelConfigurations[0];
    // Output-only name fields must NOT appear on input — echoing them 500s.
    expect(fieldCfg).not.toHaveProperty("sourceDmoName");
    expect(fieldCfg).not.toHaveProperty("sourceDmoFieldName");
    const related = (body["vectorEmbedding"] as any).vectorEmbeddingRelatedFields[0];
    expect(related).not.toHaveProperty("relatedDmoName");
    expect(related).not.toHaveProperty("relatedDmoFieldName");
    // developer names and relationships present.
    expect(related).toEqual({
      relatedDmoDeveloperName: "NTOProduct__dlm",
      relatedDmoFieldDeveloperName: "Id__c",
      relationships: [],
    });
  });

  it("maps decorators through to the wire payload", async () => {
    const ctx = mockCtx();
    const create = ctx.client.searchIndex.create as ReturnType<typeof vi.fn>;
    const get = ctx.client.searchIndex.get as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ id: "18l0000000Y" });
    get.mockResolvedValue({ id: "18l0000000Y", developerName: "MyIdx" });
    await SearchIndexResource.create(ctx, {
      developerName: "MyIdx",
      label: "MyIdx Search",
      sourceDmoDeveloperName: "ssot__KnowledgeArticleVersion__dlm",
      chunkDmoDeveloperName: "MyIdx_chunk",
      chunkDmoLabel: "MyIdx chunk",
      vectorDmoDeveloperName: "MyIdx_index",
      vectorDmoLabel: "MyIdx index",
      searchType: "HYBRID",
      processingType: "NEAR_REALTIME",
      fields: [
        {
          fieldDeveloperName: "ssot__ArticleContentText__c",
          decorators: [
            {
              decoratorId: "prepend",
              dmoDeveloperName: "ssot__KnowledgeArticleVersion__dlm",
              dmoFieldDeveloperName: "ssot__Description__c",
            },
          ],
        },
      ],
      vectorRelatedFields: [
        { dmoDeveloperName: "ssot__KnowledgeArticleVersion__dlm", fieldDeveloperName: "ssot__Id__c" },
      ],
      vectorEmbedding: {
        similarityMetric: "COSINE",
        embeddingModel: { id: "e5_large_v2", userValues: [] },
        index: { id: "HNSW", userValues: [] },
      },
      dataSpace: "default",
    });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    const dec = (body["chunkingConfiguration"] as any).fieldLevelConfigurations[0]
      .decorators[0];
    expect(dec).toEqual({
      decoratorId: "prepend",
      dmoDeveloperName: "ssot__KnowledgeArticleVersion__dlm",
      dmoFieldDeveloperName: "ssot__Description__c",
      relationships: [],
    });
  });
});

describe("SearchIndexResource.create — orphan-safety gate (a live org)", () => {
  const resourceProps = {
    developerName: "PtIdx",
    label: "PtIdx Search",
    sourceDmoDeveloperName: "PrunetestChunk__dlm",
    chunkDmoDeveloperName: "PtIdx_chunk",
    chunkDmoLabel: "PtIdx chunk",
    vectorDmoDeveloperName: "PtIdx_index",
    vectorDmoLabel: "PtIdx index",
    searchType: "HYBRID" as const,
    processingType: "NEAR_REALTIME" as const,
    fields: [{ fieldDeveloperName: "Body__c" }],
    vectorRelatedFields: [
      { dmoDeveloperName: "PrunetestChunk__dlm", fieldDeveloperName: "Id__c" },
    ],
    vectorEmbedding: {
      similarityMetric: "COSINE",
      embeddingModel: { id: "e5_large_v2", userValues: [] },
      index: { id: "HNSW", userValues: [] },
    },
    dataSpace: "default",
  };

  // The create retry budget is a hardcoded 6 × 15s (constant backoff). Drive it
  // with fake timers so these exhaustion-path tests run instantly instead of
  // waiting ~75s of real backoff.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recovers the landed index when create exhausts retries but the POST side-effected", async () => {
    const ctx = mockCtx();
    const create = ctx.client.searchIndex.create as ReturnType<typeof vi.fn>;
    const get = ctx.client.searchIndex.get as ReturnType<typeof vi.fn>;
    // Every create attempt returns "not materialized" — exhausts the budget.
    create.mockRejectedValue({ status: 400, body: { message: "DMO is not fully materialized" } });
    // But the index DID land on-org — recovery GET finds it.
    get.mockResolvedValue({
      id: "18l0000000Z",
      developerName: "PtIdx",
      runtimeStatus: null,
    });
    const p = SearchIndexResource.create(ctx, resourceProps);
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out.id).toBe("18l0000000Z");
    expect(out.developerName).toBe("PtIdx");
    // Create was attempted the full budget; recovery GET then confirmed landing.
    expect(create).toHaveBeenCalledTimes(6);
    expect(get).toHaveBeenCalledWith("PtIdx");
  });

  it("rethrows the original error when nothing landed on-org", async () => {
    const ctx = mockCtx();
    const create = ctx.client.searchIndex.create as ReturnType<typeof vi.fn>;
    const get = ctx.client.searchIndex.get as ReturnType<typeof vi.fn>;
    create.mockRejectedValue({ status: 400, body: { message: "DMO is not fully materialized" } });
    // Recovery GET returns not-found (400 "was not found") → null → no false success.
    get.mockRejectedValue({ status: 400, body: { message: "PtIdx was not found" } });
    const p = SearchIndexResource.create(ctx, resourceProps);
    const assertion = expect(p).rejects.toMatchObject({ status: 400 });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("rethrows the original create error when the recovery GET itself errors", async () => {
    const ctx = mockCtx();
    const create = ctx.client.searchIndex.create as ReturnType<typeof vi.fn>;
    const get = ctx.client.searchIndex.get as ReturnType<typeof vi.fn>;
    create.mockRejectedValue({ status: 503, body: { message: "upstream unavailable" } });
    // Recovery GET throws a non-notfound error — must not mask the create error.
    get.mockRejectedValue({ status: 500, body: { message: "boom" } });
    const p = SearchIndexResource.create(ctx, resourceProps);
    const assertion = expect(p).rejects.toMatchObject({ status: 503 });
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("SearchIndexResource.delete", () => {
  it("deletes by id (quirk C6 — developerName path 404s)", async () => {
    const ctx = mockCtx();
    const del = ctx.client.searchIndex.delete as ReturnType<typeof vi.fn>;
    del.mockResolvedValue(undefined);
    await SearchIndexResource.delete(ctx, "18l0000000X");
    expect(del).toHaveBeenCalledWith("18l0000000X", { timeout: 120_000 });
  });

  it("swallows 404 as idempotent success", async () => {
    const ctx = mockCtx();
    (ctx.client.searchIndex.delete as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    await expect(SearchIndexResource.delete(ctx, "missing")).resolves.toBeUndefined();
  });
});

describe("SearchIndexResource.isReady", () => {
  it("returns false while runtimeStatus is null or PROCESSING", async () => {
    const ctx = mockCtx();
    await expect(
      SearchIndexResource.isReady!(ctx, {
        id: "x", developerName: "X", runtimeStatus: undefined,
      }),
    ).resolves.toBe(false);
    await expect(
      SearchIndexResource.isReady!(ctx, {
        id: "x", developerName: "X", runtimeStatus: "PROCESSING",
      }),
    ).resolves.toBe(false);
  });

  it("returns true on READY", async () => {
    const ctx = mockCtx();
    await expect(
      SearchIndexResource.isReady!(ctx, {
        id: "x", developerName: "X", runtimeStatus: "READY",
      }),
    ).resolves.toBe(true);
  });

  it("returns true on SUBMITTED (index accepted and operational)", async () => {
    const ctx = mockCtx();
    await expect(
      SearchIndexResource.isReady!(ctx, {
        id: "x", developerName: "X", runtimeStatus: "SUBMITTED",
      }),
    ).resolves.toBe(true);
  });

  it("returns true on IN_PROGRESS (index actively processing chunks)", async () => {
    const ctx = mockCtx();
    await expect(
      SearchIndexResource.isReady!(ctx, {
        id: "x", developerName: "X", runtimeStatus: "IN_PROGRESS",
      }),
    ).resolves.toBe(true);
  });

  it("throws on FAILED (terminal)", async () => {
    const ctx = mockCtx();
    await expect(
      SearchIndexResource.isReady!(ctx, {
        id: "x", developerName: "X", runtimeStatus: "FAILED",
      }),
    ).rejects.toThrow(/terminal state FAILED/);
  });
});

describe("SearchIndex auto-deps on Mapping siblings", () => {
  function buildStack(order: "mapping-first" | "index-first"): {
    stack: Stack;
    dmo: DMO;
    stream: DataStream;
    mapping: Mapping;
    idx: SearchIndex;
  } {
    const app = new App();
    const stack = new Stack(app, "Rag", { targetOrg: "x" });
    const conn = new Connection(stack, "Conn", {
      connectorType: "IngestApi",
      label: "Conn",
      schema: { name: "KB", label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
    });
    const stream = new DataStream(stack, "Stream", {
      connection: conn,
      sourceObject: "KB",
      primaryKey: { name: "Id" },
    });
    const dmo = new DMO(stack, "Articles", {
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    if (order === "mapping-first") {
      const mapping = new Mapping(stack, "Map", {
        source: stream,
        target: dmo,
        fieldMappings: [{ source: "Id__c", target: "Id__c" }],
      });
      const idx = new SearchIndex(stack, "Idx", {
        sourceDmo: dmo,
        fields: [{ fieldDeveloperName: "Id__c" }],
      });
      return { stack, dmo, stream, mapping, idx };
    } else {
      const idx = new SearchIndex(stack, "Idx", {
        sourceDmo: dmo,
        fields: [{ fieldDeveloperName: "Id__c" }],
      });
      const mapping = new Mapping(stack, "Map", {
        source: stream,
        target: dmo,
        fieldMappings: [{ source: "Id__c", target: "Id__c" }],
      });
      return { stack, dmo, stream, mapping, idx };
    }
  }

  it("wires Mapping → SearchIndex when Mapping is authored first", () => {
    const { mapping, idx } = buildStack("mapping-first");
    expect(idx.dependsOn).toContain(mapping);
  });

  it("wires Mapping → SearchIndex when SearchIndex is authored first (reciprocal)", () => {
    const { mapping, idx } = buildStack("index-first");
    expect(idx.dependsOn).toContain(mapping);
  });

  it("does not wire a Mapping that targets a different DMO", () => {
    const app = new App();
    const stack = new Stack(app, "Rag", { targetOrg: "x" });
    const conn = new Connection(stack, "Conn", {
      connectorType: "IngestApi",
      label: "Conn",
      schema: { name: "KB", label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
    });
    const stream = new DataStream(stack, "Stream", {
      connection: conn,
      sourceObject: "KB",
      primaryKey: { name: "Id" },
    });
    const articlesDmo = new DMO(stack, "Articles", {
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    const otherDmo = new DMO(stack, "Other", {
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    const otherMapping = new Mapping(stack, "OtherMap", {
      source: stream,
      target: otherDmo,
      fieldMappings: [{ source: "Id__c", target: "Id__c" }],
    });
    const idx = new SearchIndex(stack, "Idx", {
      sourceDmo: articlesDmo,
      fields: [{ fieldDeveloperName: "Id__c" }],
    });
    expect(idx.dependsOn).not.toContain(otherMapping);
  });
});
