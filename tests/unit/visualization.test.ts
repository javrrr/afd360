import { describe, it, expect, vi, beforeEach } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import type { ResourceContext } from "../../src/core/construct.js";

// Mock the raw-REST seam so CRUD tests assert wire calls without an org.
const { connectRequest } = vi.hoisted(() => ({ connectRequest: vi.fn() }));
vi.mock("../../src/client/rest.js", () => ({ connectRequest }));

const { Visualization, VisualizationResource } = await import(
  "../../src/resources/visualization.js"
);
const { SemanticModel } = await import("../../src/resources/semantic-model.js");
const { RESOURCE_REGISTRY, PRUNE_TYPE_PRIORITY, pruneTypeRank } = await import(
  "../../src/resources/registry.js"
);

function stackWithModel(): { stack: Stack; model: InstanceType<typeof SemanticModel> } {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "x" });
  const dmo = new DMO(stack, "Fact", {
    fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
  });
  const model = new SemanticModel(stack, "SalesModel", {
    dataObjects: [
      {
        apiName: "Orders",
        source: dmo,
        dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text", isPrimaryKey: true }],
      },
    ],
  });
  return { stack, model };
}

function ctx(): ResourceContext {
  return {
    client: {} as unknown as ResourceContext["client"],
    session: {
      alias: "o", username: "u", orgId: "00D",
      instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
    },
    orgAlias: "o",
  };
}

const field = {
  objectName: "Orders",
  fieldName: "Region",
  role: "Dimension" as const,
  axis: "row" as const,
};
const measureField = {
  objectName: "Orders",
  fieldName: "Amount",
  role: "Measure" as const,
  axis: "column" as const,
};

describe("Visualization construct — model resolution", () => {
  it("resolves a SemanticModel construct → modelApiName + wires dependsOn", () => {
    const { stack, model } = stackWithModel();
    const viz = new Visualization(stack, "Chart", {
      model,
      workspace: { name: "Analytics", id: "1Dy000" },
      fields: [field, measureField],
    });
    expect(viz.props.modelApiName).toBe("SalesModel");
    expect(viz.dependsOn).toContain(model);
  });

  it("accepts a raw model apiName string (no dep)", () => {
    const { stack } = stackWithModel();
    const viz = new Visualization(stack, "Chart", {
      model: "SomeOtherModel",
      workspace: { name: "Analytics" },
      fields: [field],
    });
    expect(viz.props.modelApiName).toBe("SomeOtherModel");
    expect(viz.dependsOn).toEqual([]);
  });

  it("throws when no fields are placed", () => {
    const { stack, model } = stackWithModel();
    expect(
      () => new Visualization(stack, "Chart", { model, workspace: { name: "W" }, fields: [] }),
    ).toThrow(/at least one field is required/);
  });
});

describe("Visualization construct — field + slot defaults", () => {
  it("assigns slot ids F2, F3… in author order and defaults role-specific attrs", () => {
    const { stack, model } = stackWithModel();
    const viz = new Visualization(stack, "Chart", {
      model,
      workspace: { name: "W" },
      fields: [field, measureField],
    });
    const [dim, meas] = viz.props.fields;
    expect(dim!.slot).toBe("F2");
    expect(dim!.displayCategory).toBe("Discrete");
    expect(dim!.type).toBe("Text");
    expect(dim!.function).toBeUndefined(); // dimensions carry no aggregation

    expect(meas!.slot).toBe("F3");
    expect(meas!.displayCategory).toBe("Continuous");
    expect(meas!.type).toBe("Number");
    expect(meas!.function).toBe("UserAgg");
  });

  it("defaults chartType to Bar", () => {
    const { stack, model } = stackWithModel();
    const viz = new Visualization(stack, "Chart", { model, workspace: { name: "W" }, fields: [field] });
    expect(viz.props.chartType).toBe("Bar");
  });
});

describe("VisualizationResource — CRUD wire calls", () => {
  // Block body — a returned mock would become a vitest cleanup hook.
  beforeEach(() => {
    connectRequest.mockReset();
  });

  function resolvedProps() {
    const { stack, model } = stackWithModel();
    const viz = new Visualization(stack, "Chart", {
      model,
      workspace: { name: "Analytics", id: "1Dy000" },
      chartType: "Bar",
      fields: [field, measureField],
    });
    return viz.props;
  }

  it("resolves the model id via GET then POSTs the viz; binds dataSource + fields-by-slot", async () => {
    connectRequest.mockImplementation(async (_s: unknown, opts: { method: string; path: string }) => {
      if (opts.method === "GET" && opts.path.startsWith("/ssot/semantic/models/")) {
        return { id: "2SM000", apiName: "SalesModel" };
      }
      return { id: "1AK000", name: "Chart" }; // POST response
    });

    const out = await VisualizationResource.create(ctx(), resolvedProps());
    expect(out.id).toBe("1AK000");

    const calls = connectRequest.mock.calls.map((c) => ({
      method: (c[1] as { method: string }).method,
      path: (c[1] as { path: string }).path,
      apiVersion: (c[1] as { apiVersion?: string }).apiVersion,
    }));
    expect(calls).toEqual([
      { method: "GET", path: "/ssot/semantic/models/SalesModel", apiVersion: "64.0" },
      { method: "POST", path: "/tableau/visualizations", apiVersion: "67.0" },
    ]);

    const body = connectRequest.mock.calls[1]![1] as { body: Record<string, unknown> };
    expect(body.body).toMatchObject({
      name: "Chart",
      dataSource: { type: "SemanticModel", name: "SalesModel", id: "2SM000" },
      workspace: { name: "Analytics", id: "1Dy000" },
      interactions: [],
    });
    // fields is an OBJECT keyed by slot id, not an array.
    const fields = body.body["fields"] as Record<string, Record<string, unknown>>;
    expect(fields["F2"]).toMatchObject({ objectName: "Orders", fieldName: "Region", role: "Dimension" });
    expect(fields["F3"]).toMatchObject({ fieldName: "Amount", role: "Measure", function: "UserAgg" });
    // visualSpecification routes slots to axes + picks the chart.
    const spec = body.body["visualSpecification"] as Record<string, unknown>;
    expect(spec["columns"]).toEqual(["F3"]);
    expect(spec["rows"]).toEqual(["F2"]);
    expect(spec["marks"]).toEqual({ panes: [{ type: "Bar" }] });
  });

  it("falls back to name-only dataSource when the model GET surfaces no id", async () => {
    connectRequest.mockImplementation(async (_s: unknown, opts: { method: string; path: string }) => {
      if (opts.method === "GET") return { apiName: "SalesModel" }; // no id
      return { id: "1AK000" };
    });
    await VisualizationResource.create(ctx(), resolvedProps());
    const body = connectRequest.mock.calls[1]![1] as { body: { dataSource: Record<string, unknown> } };
    expect(body.body.dataSource).toEqual({ type: "SemanticModel", name: "SalesModel" });
    expect(body.body.dataSource["id"]).toBeUndefined();
  });

  it("create still POSTs when the model GET errors (non-fatal id resolution)", async () => {
    connectRequest.mockImplementation(async (_s: unknown, opts: { method: string }) => {
      if (opts.method === "GET") throw { status: 500, body: {} };
      return { id: "1AK000" };
    });
    const out = await VisualizationResource.create(ctx(), resolvedProps());
    expect(out.id).toBe("1AK000");
  });

  it("delete swallows a 404 as idempotent success", async () => {
    connectRequest.mockRejectedValue({ status: 404, body: { message: "not found" } });
    await expect(VisualizationResource.delete(ctx(), "1AK000")).resolves.toBeUndefined();
  });

  it("read returns null when the viz does not exist", async () => {
    connectRequest.mockRejectedValue({ status: 404, body: {} });
    await expect(VisualizationResource.read(ctx(), "gone")).resolves.toBeNull();
  });

  it("lookupByProps lists and matches on developer name", async () => {
    connectRequest.mockResolvedValue({
      visualizations: [
        { id: "1AKaaa", name: "Other" },
        { id: "1AK000", name: "Chart" },
      ],
    });
    const found = await VisualizationResource.lookupByProps!(ctx(), resolvedProps());
    expect(found?.id).toBe("1AK000");
  });
});

describe("Visualization — escape hatches", () => {
  it("emits a caller-supplied visualSpecification + view verbatim", async () => {
    connectRequest.mockReset();
    connectRequest.mockImplementation(async (_s: unknown, opts: { method: string }) =>
      opts.method === "GET" ? { id: "2SM000" } : { id: "1AK000" },
    );
    const { stack, model } = stackWithModel();
    const viz = new Visualization(stack, "Chart", {
      model,
      workspace: { name: "W" },
      fields: [field],
      visualSpecification: { custom: true },
      view: { foo: "bar" },
    });
    await VisualizationResource.create(ctx(), viz.props);
    const body = connectRequest.mock.calls[1]![1] as { body: Record<string, unknown> };
    expect(body.body["visualSpecification"]).toEqual({ custom: true });
    expect(body.body["view"]).toEqual({ foo: "bar" });
  });
});

describe("Visualization prune registry", () => {
  it("is registered and sorts for delete before SemanticModel", () => {
    expect(RESOURCE_REGISTRY["Visualization"]).toBe(VisualizationResource);
    expect(pruneTypeRank("Visualization")).toBeLessThan(pruneTypeRank("SemanticModel"));
    expect(PRUNE_TYPE_PRIORITY).toContain("Visualization");
  });
});
