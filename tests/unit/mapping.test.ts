import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";
import { DMO } from "../../src/resources/dmo.js";
import { Mapping, MappingResource } from "../../src/resources/mapping.js";
import type { ResourceContext } from "../../src/core/construct.js";

function buildFixture() {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "x" });
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
  const dmo = new DMO(stack, "Product", {
    fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
  });
  return { app, stack, conn, stream, dmo };
}

function mockCtx(): ResourceContext {
  return {
    client: {
      dataModelObjects: {
        createMappings: vi.fn(),
        listMappings: vi.fn(),
      },
      // DLO get is stubbed to return a ready DLO immediately so the
      // discoverability poll in Mapping.create doesn't block unit tests.
      // Real S3 / IngestApi runs wait for fields to materialize.
      dataLakeObjects: {
        get: vi.fn().mockResolvedValue({ fields: [{ name: "Id" }] }),
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

describe("Mapping construct", () => {
  it("resolves source DLO name + target DMO full name", () => {
    const { stream, dmo } = buildFixture();
    const app = new App();
    const s = new Stack(app, "S2", { targetOrg: "x" });
    const mapping = new Mapping(s, "M", {
      source: stream,
      target: dmo,
      fieldMappings: [{ source: "Id__c", target: "Id__c" }],
    });
    expect(mapping.props.sourceDloName).toBe("KB__dll");
    expect(mapping.props.targetDmoName).toBe("Product__dlm");
    expect(mapping.props.dataSpace).toBe("default");
  });

  it("depends on both source stream and target DMO", () => {
    const { stream, dmo } = buildFixture();
    const app = new App();
    const s = new Stack(app, "S2", { targetOrg: "x" });
    const m = new Mapping(s, "M", {
      source: stream,
      target: dmo,
      fieldMappings: [],
    });
    expect(m.dependsOn).toContain(stream);
    expect(m.dependsOn).toContain(dmo);
  });

  it("oneToOne helper appends __c to bare names", () => {
    expect(Mapping.oneToOne(["Id", "Title__c"])).toEqual([
      { source: "Id__c", target: "Id__c" },
      { source: "Title__c", target: "Title__c" },
    ]);
  });
});

describe("Mapping.homeFields (same-org CRM Home DLO field-name rule)", () => {
  it("standard fields get a single __c on both sides", () => {
    expect(Mapping.homeFields(["Id", "Name", "OpportunityId"])).toEqual([
      { source: "Id__c", target: "Id__c" },
      { source: "Name__c", target: "Name__c" },
      { source: "OpportunityId__c", target: "OpportunityId__c" },
    ]);
  });

  it("custom fields flatten __c → _c on the DLO source (double-c), single __c on the DMO target", () => {
    expect(Mapping.homeFields(["CompetitorName__c", "PricePerMW__c"])).toEqual([
      { source: "CompetitorName_c__c", target: "CompetitorName__c" },
      { source: "PricePerMW_c__c", target: "PricePerMW__c" },
    ]);
  });

  it("mixes standard and custom fields in one call", () => {
    expect(Mapping.homeFields(["Id", "OpportunityId", "WalletSharePct__c"])).toEqual([
      { source: "Id__c", target: "Id__c" },
      { source: "OpportunityId__c", target: "OpportunityId__c" },
      { source: "WalletSharePct_c__c", target: "WalletSharePct__c" },
    ]);
  });

  it("differs from oneToOne for custom fields (the bug it fixes)", () => {
    // oneToOne would wrongly emit source === target === "Foo__c"; homeFields
    // corrects the source to the platform's flattened double-c dev name.
    expect(Mapping.oneToOne(["Foo__c"])).toEqual([{ source: "Foo__c", target: "Foo__c" }]);
    expect(Mapping.homeFields(["Foo__c"])).toEqual([
      { source: "Foo_c__c", target: "Foo__c" },
    ]);
  });
});

describe("MappingResource.hash", () => {
  it("stable across fieldMappings reordering", () => {
    const a = MappingResource.hash({
      sourceDloName: "X__dll",
      targetDmoName: "Y__dlm",
      dataSpace: "default",
      fieldMappings: [
        { source: "a__c", target: "a__c" },
        { source: "b__c", target: "b__c" },
      ],
    });
    const b = MappingResource.hash({
      sourceDloName: "X__dll",
      targetDmoName: "Y__dlm",
      dataSpace: "default",
      fieldMappings: [
        { source: "b__c", target: "b__c" },
        { source: "a__c", target: "a__c" },
      ],
    });
    expect(a).toBe(b);
  });
});

describe("MappingResource.create (quirk B4 — DUPLICATE_DLO_TO_DMO_MAPPING)", () => {
  const props = {
    sourceDloName: "X__dll",
    targetDmoName: "Y__dlm",
    dataSpace: "default",
    fieldMappings: [{ source: "a__c", target: "a__c" }],
  };

  it("swallows DUPLICATE and returns the existing mapping", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 400,
      body: { errorCode: "DUPLICATE_DLO_TO_DMO_MAPPING", message: "already exists" },
    });
    (ctx.client.dataModelObjects.listMappings as ReturnType<typeof vi.fn>).mockResolvedValue({
      objectSourceTargetMaps: [
        {
          developerName: "X_map_Y",
          sourceEntityDeveloperName: "X__dll",
          targetEntityDeveloperName: "Y__dlm",
        },
      ],
    });
    const out = await MappingResource.create(ctx, props);
    expect(out.developerName).toBe("X_map_Y");
  });

  it("rethrows unrelated errors", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 400,
      body: { errorCode: "SOMETHING_ELSE" },
    });
    await expect(MappingResource.create(ctx, props)).rejects.toMatchObject({ status: 400 });
  });

  it("rewrites the opaque MISSING_ARGUMENT PK error into an actionable message", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 400,
      body: {
        errorCode: "MISSING_ARGUMENT",
        message: "Unable to find Primary Key of DLO in POST request of Mapping Creation",
      },
    });
    await expect(MappingResource.create(ctx, props)).rejects.toThrow(
      /primary key must be included in fieldMappings/,
    );
  });
});

describe("MappingResource.delete (quirk B3 — cascade from DMO)", () => {
  it("is a no-op — does not call the API", async () => {
    const ctx = mockCtx();
    // No delete method mocked; if the resource tries to call one, the test fails.
    await MappingResource.delete(ctx, "any::id::here::X");
    // Sanity: confirm nothing was spied into existence
    expect(ctx.client.dataModelObjects).not.toHaveProperty("deleteMappings");
  });
});
