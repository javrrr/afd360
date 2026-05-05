import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO, DmoResource } from "../../src/resources/dmo.js";
import type { ResourceContext } from "../../src/core/construct.js";

function mockCtx(): ResourceContext {
  return {
    client: {
      dataModelObjects: {
        get: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
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

describe("DMO construct", () => {
  it("composes fullName = <devName>__dlm", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const d = new DMO(stack, "NTOProduct", {
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    expect(d.devName).toBe("NTOProduct");
    expect(d.fullName).toBe("NTOProduct__dlm");
  });

  it("accepts an authored name with or without __dlm", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const a = new DMO(stack, "A", {
      name: "Already__dlm",
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    expect(a.fullName).toBe("Already__dlm");
  });

  it("defaults category to 'Other' and dataSpace to 'default'", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const d = new DMO(stack, "D", {
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    expect(d.props.category).toBe("Other");
    expect(d.props.dataSpace).toBe("default");
  });
});

describe("DmoResource.read (quirk B1)", () => {
  it("returns null on 404 (current API behavior)", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    expect(await DmoResource.read(ctx, "X__dlm")).toBeNull();
  });
  it("also handles 500+body='not found' (legacy quirk — defensive)", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 500,
      body: { message: "DMO not found for the given name" },
    });
    expect(await DmoResource.read(ctx, "X__dlm")).toBeNull();
  });
  it("rethrows unrelated errors", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 403,
      body: "forbidden",
    });
    await expect(DmoResource.read(ctx, "X__dlm")).rejects.toMatchObject({ status: 403 });
  });
});

describe("DmoResource.isReady (quirk B2)", () => {
  const output = { name: "X__dlm" };
  it("true when dataSpaceName is populated", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "X__dlm",
      dataSpaceName: "default",
    });
    expect(await DmoResource.isReady!(ctx, output)).toBe(true);
  });
  it("false when dataSpaceName is missing or empty", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ name: "X__dlm" })
      .mockResolvedValueOnce({ name: "X__dlm", dataSpaceName: "" });
    expect(await DmoResource.isReady!(ctx, output)).toBe(false);
    expect(await DmoResource.isReady!(ctx, output)).toBe(false);
  });
});

describe("DmoResource.matchesAuthored (drift check)", () => {
  const props = {
    name: "X",
    label: "X",
    category: "Other" as const,
    dataSpace: "default",
    fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
  };
  it("accepts case-insensitive category match", () => {
    expect(
      DmoResource.matchesAuthored!(
        { name: "X__dlm", category: "OTHER", dataSpaceName: "default" },
        props,
      ),
    ).toBe(true);
  });
  it("rejects category drift (ENGAGEMENT vs Other)", () => {
    expect(
      DmoResource.matchesAuthored!(
        { name: "X__dlm", category: "ENGAGEMENT", dataSpaceName: "default" },
        props,
      ),
    ).toBe(false);
  });
  it("rejects dataSpace drift", () => {
    expect(
      DmoResource.matchesAuthored!(
        { name: "X__dlm", category: "OTHER", dataSpaceName: "other_space" },
        props,
      ),
    ).toBe(false);
  });
});

describe("DmoResource.create payload shape", () => {
  it("matches tdc's proven shape: plain name/label, fields with isPrimaryKey", async () => {
    const ctx = mockCtx();
    const create = ctx.client.dataModelObjects.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ name: "NTOProduct", label: "NTOProduct" });
    await DmoResource.create(ctx, {
      name: "NTOProduct",
      label: "NTO Product",
      category: "Other",
      dataSpace: "default",
      fields: [
        { name: "Id", label: "Id", dataType: "Text", isPrimaryKey: true },
        { name: "Title", label: "Title", dataType: "Text" },
      ],
    });
    expect(create).toHaveBeenCalledWith({
      name: "NTOProduct",
      label: "NTO Product",
      category: "Other",
      dataSpaceName: "default",
      fields: [
        { name: "Id", label: "Id", dataType: "Text", isPrimaryKey: true },
        { name: "Title", label: "Title", dataType: "Text", isPrimaryKey: false },
      ],
    });
  });

  it("returns output.name with __dlm suffix regardless of create response", async () => {
    const ctx = mockCtx();
    // Response lacks __dlm (simulating an edge case)
    (ctx.client.dataModelObjects.create as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "Foo",
      dataSpaceName: "default",
    });
    const out = await DmoResource.create(ctx, {
      name: "Foo",
      label: "Foo",
      category: "Other",
      dataSpace: "default",
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    expect(out.name).toBe("Foo__dlm");
  });
});

describe("DmoResource.delete — already-gone tolerance", () => {
  it("swallows 404 from the pre-check GET (already deleted)", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    await expect(DmoResource.delete(ctx, "Gone__dlm")).resolves.toBeUndefined();
    // delete should NOT be called when the pre-check confirms it's gone.
    expect(ctx.client.dataModelObjects.delete).not.toHaveBeenCalled();
  });

  it("swallows 500 'not found' body from the DELETE itself", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>).mockResolvedValue({ name: "X__dlm" });
    (ctx.client.dataModelObjects.delete as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 500,
      body: '[{"message":"DMO not found"}]',
    });
    await expect(DmoResource.delete(ctx, "X__dlm")).resolves.toBeUndefined();
  });

  it("re-verifies via GET on opaque 500 and treats verified-gone as success (quirk: DMO DELETE 500 on already-gone)", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ name: "X__dlm" })  // pre-check: present
      .mockRejectedValueOnce({ status: 404 });     // post-check after 500: gone
    (ctx.client.dataModelObjects.delete as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 500,
      body: '[{"message":"INTERNAL_ERROR: correlation id abc-123"}]',
    });
    await expect(DmoResource.delete(ctx, "X__dlm")).resolves.toBeUndefined();
  });
});
