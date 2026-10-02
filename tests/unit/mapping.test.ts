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
      // discoverability poll AND the source-field pre-validation in
      // Mapping.create don't block unit tests. Fields cover the sources the
      // create tests map (Id, a__c). Real S3 / IngestApi runs wait for fields
      // to materialize. Validation tests below override this per-case.
      dataLakeObjects: {
        get: vi.fn().mockResolvedValue({ fields: [{ name: "Id" }, { name: "a__c" }] }),
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

describe("MappingResource.create (source-field pre-validation)", () => {
  const props = {
    sourceDloName: "X__dll",
    targetDmoName: "Y__dlm",
    dataSpace: "default",
    fieldMappings: [
      { source: "Id__c", target: "Id__c" },
      { source: "Region_c__c", target: "Region__c" },
    ],
  };

  it("throws an actionable error naming the missing source field", async () => {
    const ctx = mockCtx();
    // Live DLO has Id__c but the source column is actually Territory_c__c, not
    // the derived Region_c__c (stale DLO / renamed source field).
    (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      fields: [{ developerName: "Id__c" }, { developerName: "Territory_c__c" }],
    });
    await expect(MappingResource.create(ctx, props)).rejects.toThrow(/"Region_c__c"/);
    await expect(MappingResource.create(ctx, props)).rejects.toThrow(
      /SourceField must not be null/,
    );
    // The create must not be attempted when validation fails.
    expect(ctx.client.dataModelObjects.createMappings).not.toHaveBeenCalled();
  });

  it("lists the available DLO fields to guide the fix", async () => {
    const ctx = mockCtx();
    (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      fields: [{ developerName: "Id__c" }, { developerName: "Territory_c__c" }],
    });
    await expect(MappingResource.create(ctx, props)).rejects.toThrow(
      /Available DLO fields: Id__c, Territory_c__c/,
    );
  });

  it("passes validation and creates when all sources exist", async () => {
    const ctx = mockCtx();
    (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      // Verbose shape (dataLakeFieldInfoRepresentation) + developerName key.
      dataLakeObjects: [
        {
          dataLakeFieldInfoRepresentation: [
            { developerName: "Id__c" },
            { developerName: "Region_c__c" },
          ],
        },
      ],
    });
    (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mockResolvedValue({
      developerName: "X_map_Y",
      sourceEntityDeveloperName: "X__dll",
      targetEntityDeveloperName: "Y__dlm",
    });
    const out = await MappingResource.create(ctx, props);
    expect(out.developerName).toBe("X_map_Y");
    expect(ctx.client.dataModelObjects.createMappings).toHaveBeenCalledOnce();
  });

  it("skips validation (defers to the platform) when the DLO field set can't be read", async () => {
    const ctx = mockCtx();
    // No fields available — an unexpected shape. Don't falsely block; let the
    // create proceed and the platform be the source of truth.
    (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mockResolvedValue({
      developerName: "X_map_Y",
      sourceEntityDeveloperName: "X__dll",
      targetEntityDeveloperName: "Y__dlm",
    });
    // waitForDloDiscoverable would spin on an empty DLO, so give it fields on
    // the first poll but an empty set for name extraction is what we test —
    // simulate by returning fields with no recognizable name keys.
    (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      fields: [{ someUnknownKey: "x" }],
    });
    const out = await MappingResource.create(ctx, props);
    expect(out.developerName).toBe("X_map_Y");
  });
});

describe("MappingResource.create (IngestApi DLO name resolution)", () => {
  // Build a ctx whose get() throws for the derived ghost name but returns a
  // ready field set for `realDlo`, and whose list() returns `dlos`.
  function resolveCtx(realDlo: string, dlos: Array<{ name: string }>): ResourceContext {
    const ctx = mockCtx();
    (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockImplementation(
      async (name: string) => {
        if (name === realDlo) return { fields: [{ developerName: "Id__c" }] };
        throw new Error("404 not found");
      },
    );
    (
      ctx.client.dataLakeObjects as unknown as { list: ReturnType<typeof vi.fn> }
    ).list = vi.fn().mockResolvedValue({ dataLakeObjects: dlos });
    (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mockImplementation(
      async (body: { sourceEntityDeveloperName: string }) => ({
        developerName: "map1",
        sourceEntityDeveloperName: body.sourceEntityDeveloperName,
        targetEntityDeveloperName: "Y__dlm",
      }),
    );
    return ctx;
  }

  const props = (sourceDloName: string) => ({
    sourceDloName,
    targetDmoName: "Y__dlm",
    dataSpace: "default",
    fieldMappings: [{ source: "Id__c", target: "Id__c" }],
  });

  it("resolves the truncated data DLO when the object segment is clipped", async () => {
    // Platform clips "LongFeedObjectName" → "LongFeedObjectNam" in the data DLO
    // devname; the full-token includes() misses. The PR_ profile sibling keeps
    // the UNtruncated token (shorter hash) and must NOT be chosen.
    const dataDlo = "Str_Ingest_LongFeedObjectNam_A1B2C3D4__dll";
    const prDlo = "PR_Str_Ingest_LongFeedObjectName_A1B2__dll";
    const ctx = resolveCtx(dataDlo, [{ name: prDlo }, { name: dataDlo }]);
    const out = await MappingResource.create(ctx, props("LongFeedObjectName__dll"));
    expect(out.sourceEntityDeveloperName).toBe(dataDlo);
    const body = (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { sourceEntityDeveloperName: string };
    expect(body.sourceEntityDeveloperName).toBe(dataDlo);
  });

  it("excludes the PR_ profile sibling even on an exact token match", async () => {
    // Both DLOs embed the full token "Feed"; the data DLO (non-PR_) wins.
    const dataDlo = "Str_Ingest_Feed_H1__dll";
    const prDlo = "PR_Str_Ingest_Feed_H2__dll";
    const ctx = resolveCtx(dataDlo, [{ name: prDlo }, { name: dataDlo }]);
    const out = await MappingResource.create(ctx, props("Feed__dll"));
    expect(out.sourceEntityDeveloperName).toBe(dataDlo);
  });

  it("falls back to the derived name when no unambiguous data DLO matches", async () => {
    // Two non-PR_ candidates share the prefix → ambiguous → don't guess; the
    // derived name is returned and the (mocked-ready) poll lets create proceed.
    const derived = "Feed__dll";
    const ctx = mockCtx();
    (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      fields: [{ developerName: "Id__c" }],
    });
    (
      ctx.client.dataLakeObjects as unknown as { list: ReturnType<typeof vi.fn> }
    ).list = vi
      .fn()
      .mockResolvedValue({ dataLakeObjects: [{ name: "A_Feed_x__dll" }, { name: "B_Feed_y__dll" }] });
    (ctx.client.dataModelObjects.createMappings as ReturnType<typeof vi.fn>).mockResolvedValue({
      developerName: "map1",
      sourceEntityDeveloperName: derived,
      targetEntityDeveloperName: "Y__dlm",
    });
    const out = await MappingResource.create(ctx, props(derived));
    expect(out.sourceEntityDeveloperName).toBe(derived);
  });
});

describe("MappingResource.create (DLO-never-materialized timeout message)", () => {
  it("rethrows the poll timeout as actionable provisioning-lag / re-run guidance", async () => {
    vi.useFakeTimers();
    try {
      const ctx = mockCtx();
      // Derived name resolves (fast path) but the DLO never exposes fields —
      // a provisioning lag. The readiness poll must time out. (NOT a
      // never-ingested condition: afd360 connectors declare the DLO schema up
      // front, so fields appear at stream-create — a live org corrected the
      // original "push data first" framing on 2026-10-02.)
      (ctx.client.dataLakeObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        fields: [],
      });
      const p = MappingResource.create(ctx, {
        sourceDloName: "X__dll",
        targetDmoName: "Y__dlm",
        dataSpace: "default",
        fieldMappings: [{ source: "Id__c", target: "Id__c" }],
      });
      const assertion = expect(p).rejects.toThrow(/provisioning lag|Re-run `afd360 deploy`/);
      // Drive the 180s poll budget to exhaustion under fake timers.
      await vi.advanceTimersByTimeAsync(200_000);
      await assertion;
      // The opaque poll message must NOT be what surfaces.
      await expect(p).rejects.not.toThrow(/pollUntil timed out/);
      // And the retired "push data / first ingest" directive must be gone.
      await expect(p).rejects.not.toThrow(/ingest/);
    } finally {
      vi.useRealTimers();
    }
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
