import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";
import { Mapping } from "../../src/resources/mapping.js";
import {
  DataActionTarget,
  DataActionTargetResource,
} from "../../src/resources/data-action-target.js";
import { DataAction, DataActionResource } from "../../src/resources/data-action.js";
import type { ResourceContext } from "../../src/core/construct.js";

function mockCtx(actionItems: unknown[] = []): ResourceContext {
  return {
    client: {
      dataActionTargets: {
        get: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
      dataActions: {
        create: vi.fn(),
        listAll: vi.fn(() =>
          (async function* () {
            for (const i of actionItems) yield i;
          })(),
        ),
      },
    } as unknown as ResourceContext["client"],
    session: {
      alias: "dev-org",
      username: "admin@example.com",
      orgId: "00Dxx",
      instanceUrl: "https://x.my.salesforce.com",
      apiVersion: "68.0",
      accessToken: "tok",
    },
    orgAlias: "dev-org",
  } as unknown as ResourceContext;
}

describe("DataActionTarget construct", () => {
  it("defaults apiName / label from the construct id", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const t = new DataActionTarget(stack, "InsightTarget", {
      orgId: "00Dxx",
      orgLabel: "admin@example.com",
      targetEndpoint: "AccountInsightIngested__e",
    });
    expect(t.apiName).toBe("InsightTarget");
    expect(t.props.label).toBe("InsightTarget");
    expect(t.props.type).toBe("Core");
    expect(t.props.config).toEqual({
      orgId: "00Dxx",
      orgLabel: "admin@example.com",
      targetEndpoint: "AccountInsightIngested__e",
    });
  });

  it("throws when a Core target is missing orgId/orgLabel", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    expect(
      () => new DataActionTarget(stack, "T", { orgId: "00Dxx" }),
    ).toThrow(/requires both orgId and orgLabel/);
  });

  it("auto-wires explicit dependsOn", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const dep = new DataActionTarget(stack, "Dep", {
      orgId: "00Dxx",
      orgLabel: "a@b.c",
    });
    const t = new DataActionTarget(
      stack,
      "T",
      { orgId: "00Dxx", orgLabel: "a@b.c" },
      { dependsOn: [dep] },
    );
    expect(t.dependsOn).toContain(dep);
  });
});

describe("DataActionTargetResource", () => {
  it("create posts the proven Core body (type:Core, config orgId/orgLabel/targetEndpoint)", async () => {
    const ctx = mockCtx();
    const create = ctx.client.dataActionTargets.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ apiName: "T", status: "Processing" });
    await DataActionTargetResource.create(ctx, {
      apiName: "T",
      label: "T Label",
      type: "Core",
      config: {
        orgId: "00Dxx",
        orgLabel: "admin@example.com",
        targetEndpoint: "AccountInsightIngested__e",
      },
    });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      apiName: "T",
      label: "T Label",
      type: "Core",
      config: {
        orgId: "00Dxx",
        orgLabel: "admin@example.com",
        targetEndpoint: "AccountInsightIngested__e",
      },
    });
  });

  it("read maps the GET response; 404 → null", async () => {
    const ctx = mockCtx();
    const get = ctx.client.dataActionTargets.get as ReturnType<typeof vi.fn>;
    get.mockResolvedValue({ apiName: "T", type: "CORE", status: "Active" });
    const out = await DataActionTargetResource.read(ctx, "T");
    expect(out).toMatchObject({ apiName: "T", type: "CORE", status: "Active" });
    get.mockRejectedValue({ status: 404 });
    expect(await DataActionTargetResource.read(ctx, "missing")).toBeNull();
  });

  it("delete swallows 404 as idempotent success", async () => {
    const ctx = mockCtx();
    (ctx.client.dataActionTargets.delete as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 404,
    });
    await expect(DataActionTargetResource.delete(ctx, "gone")).resolves.toBeUndefined();
  });

  it("isReady: Active→true, Processing→false, Error→throws terminal", async () => {
    const ctx = mockCtx();
    await expect(
      DataActionTargetResource.isReady!(ctx, { apiName: "T", status: "Active" }),
    ).resolves.toBe(true);
    await expect(
      DataActionTargetResource.isReady!(ctx, { apiName: "T", status: "Processing" }),
    ).resolves.toBe(false);
    await expect(
      DataActionTargetResource.isReady!(ctx, {
        apiName: "T",
        status: "Error",
        statusErrorCode: "CreateFailed",
      }),
    ).rejects.toThrow(/terminal state ERROR \(CreateFailed\)/);
  });

  it("matchesAuthored: Core↔CORE case-insensitive, targetEndpoint not diffed", () => {
    const props = {
      apiName: "T",
      label: "T",
      type: "Core" as const,
      config: { orgId: "00Dxx", orgLabel: "a@b.c", targetEndpoint: "E__e" },
    };
    // Read-back normalizes type to CORE and DROPS targetEndpoint — still a match.
    expect(
      DataActionTargetResource.matchesAuthored!(
        { apiName: "T", type: "CORE", config: { orgId: "00Dxx" } },
        props,
      ),
    ).toBe(true);
    // orgId drift forces a recreate.
    expect(
      DataActionTargetResource.matchesAuthored!(
        { apiName: "T", type: "CORE", config: { orgId: "00Dyy" } },
        props,
      ),
    ).toBe(false);
  });
});

describe("DataAction construct", () => {
  function target(stack: Stack): DataActionTarget {
    return new DataActionTarget(stack, "Target", {
      orgId: "00Dxx",
      orgLabel: "a@b.c",
      targetEndpoint: "AccountInsightIngested__e",
    });
  }

  it("resolves source/target names, defaults, and projected-field fallbacks", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const t = target(stack);
    const da = new DataAction(stack, "Notify", {
      source: "AccountInsight__dlm",
      projectedFields: [{ fieldApiName: "AccountId__c" }],
      condition: "AccountId__c != null",
      target: t,
    });
    expect(da.props.sourceName).toBe("AccountInsight__dlm");
    expect(da.props.sourceType).toBe("DataModelEntity");
    expect(da.props.subscriptions).toEqual(["Create", "Update"]);
    expect(da.props.targetNames).toEqual(["Target"]);
    expect(da.props.actionConditionExpression).toBe("AccountId__c != null");
    expect(da.props.projectedFields[0]).toEqual({
      objectApiName: "AccountInsight__dlm",
      fieldApiName: "AccountId__c",
      fieldAliasName: "AccountId__c",
    });
    expect(da.dependsOn).toContain(t);
  });

  it("rejects a DataModelEntity source without __dlm", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const t = target(stack);
    expect(
      () =>
        new DataAction(stack, "Notify", {
          source: "AccountInsight",
          projectedFields: [{ fieldApiName: "AccountId__c" }],
          target: t,
        }),
    ).toThrow(/must be a full DMO name ending in __dlm/);
  });

  it("rejects an empty projectedFields list", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const t = target(stack);
    expect(
      () =>
        new DataAction(stack, "Notify", {
          source: "AccountInsight__dlm",
          projectedFields: [],
          target: t,
        }),
    ).toThrow(/at least one projected field/);
  });

  it("auto-wires dependsOn on a DMO construct source", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const t = target(stack);
    const dmo = new DMO(stack, "AccountInsight", {
      fields: [{ name: "AccountId", dataType: "Text", isPrimaryKey: true }],
    });
    const da = new DataAction(stack, "Notify", {
      source: dmo,
      projectedFields: [{ fieldApiName: "AccountId__c" }],
      target: t,
    });
    expect(da.props.sourceName).toBe("AccountInsight__dlm");
    expect(da.dependsOn).toContain(dmo);
  });
});

describe("DataAction auto-deps on Mapping siblings", () => {
  function buildStack(order: "mapping-first" | "action-first"): {
    mapping: Mapping;
    da: DataAction;
  } {
    const app = new App();
    const stack = new Stack(app, "DA", { targetOrg: "x" });
    const conn = new Connection(stack, "Conn", {
      connectorType: "IngestApi",
      label: "Conn",
      schema: { name: "AI", label: "AI", fields: [{ name: "AccountId", dataType: "Text" }] },
    });
    const stream = new DataStream(stack, "Stream", {
      connection: conn,
      sourceObject: "AI",
      primaryKey: { name: "AccountId" },
    });
    const dmo = new DMO(stack, "AccountInsight", {
      fields: [{ name: "AccountId", dataType: "Text", isPrimaryKey: true }],
    });
    const t = new DataActionTarget(stack, "Target", { orgId: "00Dxx", orgLabel: "a@b.c" });
    const mkMapping = () =>
      new Mapping(stack, "Map", {
        source: stream,
        target: dmo,
        fieldMappings: [{ source: "AccountId__c", target: "AccountId__c" }],
      });
    const mkAction = () =>
      new DataAction(stack, "Notify", {
        source: dmo,
        projectedFields: [{ fieldApiName: "AccountId__c" }],
        target: t,
      });
    if (order === "mapping-first") {
      const mapping = mkMapping();
      const da = mkAction();
      return { mapping, da };
    }
    const da = mkAction();
    const mapping = mkMapping();
    return { mapping, da };
  }

  it("wires Mapping → DataAction when Mapping is authored first", () => {
    const { mapping, da } = buildStack("mapping-first");
    expect(da.dependsOn).toContain(mapping);
  });

  it("wires Mapping → DataAction when DataAction is authored first (reciprocal)", () => {
    const { mapping, da } = buildStack("action-first");
    expect(da.dependsOn).toContain(mapping);
  });
});

describe("DataActionResource", () => {
  const resourceProps = {
    developerName: "Notify",
    dataActionName: "Notify",
    dataspace: "default",
    sourceName: "AccountInsight__dlm",
    sourceType: "DataModelEntity" as const,
    subscriptions: ["Create", "Update"] as const,
    projectedFields: [
      {
        objectApiName: "AccountInsight__dlm",
        fieldApiName: "AccountId__c",
        fieldAliasName: "AccountId__c",
      },
    ],
    targetNames: ["Target"],
    actionConditionExpression: "AccountId__c != null",
  };

  it("create posts the proven body + dataspace param", async () => {
    const ctx = mockCtx();
    const create = ctx.client.dataActions.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ developerName: "Notify", dataActionStatus: "Processing" });
    await DataActionResource.create(ctx, resourceProps);
    const [body, params] = create.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(params).toEqual({ dataspace: "default" });
    expect(body).toMatchObject({
      dataActionName: "Notify",
      developerName: "Notify",
      dataspace: "default",
      actionConditionExpression: "AccountId__c != null",
      dataActionTargetNames: ["Target"],
    });
    expect((body.dataActionSources as any[])[0]).toEqual({
      sourceName: "AccountInsight__dlm",
      sourceType: "DataModelEntity",
      sourceCdcSubscriptions: ["Create", "Update"],
    });
    expect((body.dataActionProjectedFields as any[])[0]).toEqual({
      objectApiName: "AccountInsight__dlm",
      fieldApiName: "AccountId__c",
      fieldAliasName: "AccountId__c",
    });
  });

  it("read pages the dataspace-scoped list and matches on developerName", async () => {
    const ctx = mockCtx([
      { developerName: "Other", dataSpaceDevName: "default" },
      { developerName: "Notify", dataSpaceDevName: "default", dataActionStatus: "Active" },
    ]);
    const out = await DataActionResource.read(ctx, "default::Notify");
    expect(out).toMatchObject({ developerName: "Notify", dataspace: "default", status: "Active" });
    expect(ctx.client.dataActions.listAll).toHaveBeenCalledWith({ dataspace: "default" });
  });

  it("read returns null when no list entry matches", async () => {
    const ctx = mockCtx([{ developerName: "Other", dataSpaceDevName: "default" }]);
    expect(await DataActionResource.read(ctx, "default::Notify")).toBeNull();
  });

  it("idOf composes <dataspace>::<developerName>", () => {
    expect(DataActionResource.idOf({ developerName: "Notify", dataspace: "sales" })).toBe(
      "sales::Notify",
    );
    expect(DataActionResource.idOf({ developerName: "Notify" })).toBe("default::Notify");
  });

  it("delete calls DELETE /ssot/data-actions/{name}?dataspace=… and swallows 404", async () => {
    const ctx = mockCtx();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 204, statusText: "No Content", text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    await DataActionResource.delete(ctx, "default::Notify");
    const url = fetchMock.mock.calls[0]![0] as string;
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(url).toContain("/ssot/data-actions/Notify?dataspace=default");

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => JSON.stringify({ message: "not found" }),
    });
    await expect(DataActionResource.delete(ctx, "default::Notify")).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("isReady: Active→true, Processing→false, Error→throws", async () => {
    const ctx = mockCtx();
    await expect(
      DataActionResource.isReady!(ctx, { developerName: "N", status: "Active" }),
    ).resolves.toBe(true);
    await expect(
      DataActionResource.isReady!(ctx, { developerName: "N", status: "Processing" }),
    ).resolves.toBe(false);
    await expect(
      DataActionResource.isReady!(ctx, {
        developerName: "N",
        status: "Error",
        statusErrorCode: "CreateFailed",
      }),
    ).rejects.toThrow(/terminal state ERROR \(CreateFailed\)/);
  });
});
