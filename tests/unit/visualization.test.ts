import { describe, it, expect, vi, beforeEach } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import type { ResourceContext } from "../../src/core/construct.js";

// Mock the raw-REST seam (now only the v64 model-id resolve) so CRUD tests
// assert wire calls without an org.
const { connectRequest } = vi.hoisted(() => ({ connectRequest: vi.fn() }));
vi.mock("../../src/client/rest.js", () => ({ connectRequest }));

// The `/tableau/visualizations` transport now runs through the tableau-next-sdk
// client (ctx.tableauClient.visualizations); mock its service methods.
const tnViz = {
  get: vi.fn(),
  listAll: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
};

async function* asyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

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
    tableauClient: {
      visualizations: tnViz,
    } as unknown as ResourceContext["tableauClient"],
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
    // Slot `type` is the structural "Field" discriminator (NOT a display dataType);
    // dim vs. measure is carried by role + displayCategory.
    expect(dim!.type).toBe("Field");
    expect(dim!.function).toBeUndefined(); // dimensions carry no aggregation

    expect(meas!.slot).toBe("F3");
    expect(meas!.displayCategory).toBe("Continuous");
    expect(meas!.type).toBe("Field");
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
    tnViz.get.mockReset();
    tnViz.listAll.mockReset();
    tnViz.create.mockReset();
    tnViz.delete.mockReset();
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

  it("resolves the model id via GET (raw REST, v64) then POSTs the viz through the TN client; binds dataSource + fields-by-slot", async () => {
    // Only the model-id resolve hits connectRequest now (v64 ssot surface).
    connectRequest.mockResolvedValue({ id: "2SM000", apiName: "SalesModel" });
    tnViz.create.mockResolvedValue({ id: "1AK000", name: "Chart" });

    const out = await VisualizationResource.create(ctx(), resolvedProps());
    expect(out.id).toBe("1AK000");

    // The ONLY connectRequest call is the v64 model-id GET.
    expect(connectRequest).toHaveBeenCalledTimes(1);
    const modelCall = connectRequest.mock.calls[0]![1] as {
      method: string;
      path: string;
      apiVersion?: string;
    };
    expect(modelCall).toMatchObject({
      method: "GET",
      path: "/ssot/semantic/models/SalesModel",
      apiVersion: "64.0",
    });

    // The viz POST goes through the TN client with the hand-built body.
    expect(tnViz.create).toHaveBeenCalledTimes(1);
    const body = tnViz.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "Chart",
      dataSource: { type: "SemanticModel", name: "SalesModel", id: "2SM000" },
      workspace: { name: "Analytics", id: "1Dy000" },
      interactions: [],
    });
    // fields is an OBJECT keyed by slot id, not an array. Each slot's `type` is
    // the structural "Field" discriminator — a display dataType (Text/Number) is
    // 400 POST_BODY_PARSE_ERROR at v67.
    const fields = body["fields"] as Record<string, Record<string, unknown>>;
    expect(fields["F2"]).toMatchObject({ objectName: "Orders", fieldName: "Region", role: "Dimension", type: "Field" });
    expect(fields["F3"]).toMatchObject({ fieldName: "Amount", role: "Measure", function: "UserAgg", type: "Field" });
    // visualSpecification is REQUIRED + value-gated at v67 — all NINE members
    // must be present with real (non-empty) values. The server derives columns
    // from measure-axis slots and rows from dimension-axis slots.
    const spec = body["visualSpecification"] as Record<string, unknown>;
    expect(spec["columns"]).toEqual(["F3"]); // measure (axis "column")
    expect(spec["rows"]).toEqual(["F2"]); // dimension (axis "row")
    expect(spec["layout"]).toBe("Vizql");
    expect(spec["measureValues"]).toEqual([]);
    expect(Object.keys(spec).sort()).toEqual(
      ["columns", "forecasts", "layout", "legends", "marks", "measureValues", "referenceLines", "rows", "style"].sort(),
    );
    // marks.panes is a SINGLE object (not an array); chart type is panes.type,
    // with a parallel headers object and an (empty) fields map.
    const marks = spec["marks"] as Record<string, Record<string, unknown>>;
    expect(marks["panes"]!["type"]).toBe("Bar");
    expect(Array.isArray(marks["panes"])).toBe(false);
    expect(marks["headers"]!["type"]).toBe("Text");
    expect(marks["fields"]).toEqual({});
    // style carries a REAL, fully-populated value (an empty {} is what the
    // platform's "Value required for [...]" chain rejected). All 12 members.
    const style = spec["style"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(style).sort()).toEqual(
      ["axis", "encodings", "fieldLabels", "fit", "fonts", "headers", "lines", "marks", "referenceLines", "shading", "showDataPlaceholder", "title"].sort(),
    );
    // Slot-keyed members key by ROLE: axis + encodings → measures (F3); headers.fields → dims (F2).
    const axisFields = style["axis"]!["fields"] as Record<string, Record<string, unknown>>;
    expect(axisFields["F3"]).toMatchObject({ isVisible: true, isZeroLineVisible: true });
    // axis uses "NumberShort"; encodings uses "Number" — intentionally different.
    expect((((axisFields["F3"]!["scale"] as Record<string, unknown>)["format"] as Record<string, unknown>)["numberFormatInfo"] as Record<string, unknown>)["type"]).toBe("NumberShort");
    expect(axisFields["F2"]).toBeUndefined();
    const encodingFields = style["encodings"]!["fields"] as Record<string, Record<string, unknown>>;
    expect((((encodingFields["F3"]!["defaults"] as Record<string, unknown>)["format"] as Record<string, unknown>)["numberFormatInfo"] as Record<string, unknown>)["type"]).toBe("Number");
    expect(encodingFields["F2"]).toBeUndefined();
    const headerFields = style["headers"]!["fields"] as Record<string, unknown>;
    expect(headerFields["F2"]).toMatchObject({ isVisible: true, showMissingValues: false });
    expect(headerFields["F3"]).toBeUndefined();
    // headers keeps its static columns/rows siblings alongside the slot-keyed fields.
    expect(style["headers"]!["columns"]).toMatchObject({ mergeRepeatedCells: true });
    // A couple of the static members are present + verbatim.
    expect(style["fit"]).toBe("Standard");
    expect((style["fonts"] as Record<string, Record<string, unknown>>)["actionableHeaders"]).toEqual({ color: "#0250d9", size: 13 });

    // view is a populated viewSpecification scaffold, not {}.
    const view = body["view"] as Record<string, unknown>;
    expect(view["name"]).toBe("Chart_default");
    expect(view["viewSpecification"]).toBeDefined();
  });

  it("falls back to name-only dataSource when the model GET surfaces no id", async () => {
    connectRequest.mockResolvedValue({ apiName: "SalesModel" }); // no id
    tnViz.create.mockResolvedValue({ id: "1AK000" });
    await VisualizationResource.create(ctx(), resolvedProps());
    const body = tnViz.create.mock.calls[0]![0] as { dataSource: Record<string, unknown> };
    expect(body.dataSource).toEqual({ type: "SemanticModel", name: "SalesModel" });
    expect(body.dataSource["id"]).toBeUndefined();
  });

  it("create still POSTs when the model GET errors (non-fatal id resolution)", async () => {
    connectRequest.mockRejectedValue({ status: 500, body: {} });
    tnViz.create.mockResolvedValue({ id: "1AK000" });
    const out = await VisualizationResource.create(ctx(), resolvedProps());
    expect(out.id).toBe("1AK000");
  });

  it("delete swallows a 404 as idempotent success", async () => {
    tnViz.delete.mockRejectedValue({ status: 404, body: { message: "not found" } });
    await expect(VisualizationResource.delete(ctx(), "1AK000")).resolves.toBeUndefined();
  });

  it("read returns null when the viz does not exist", async () => {
    tnViz.get.mockRejectedValue({ status: 404, body: {} });
    await expect(VisualizationResource.read(ctx(), "gone")).resolves.toBeNull();
  });

  it("lookupByProps lists and matches on developer name", async () => {
    tnViz.listAll.mockReturnValue(
      asyncGen([
        { id: "1AKaaa", name: "Other" },
        { id: "1AK000", name: "Chart" },
      ]),
    );
    const found = await VisualizationResource.lookupByProps!(ctx(), resolvedProps());
    expect(found?.id).toBe("1AK000");
  });
});

describe("Visualization — escape hatches", () => {
  it("emits a caller-supplied visualSpecification + view verbatim", async () => {
    connectRequest.mockReset();
    connectRequest.mockResolvedValue({ id: "2SM000" });
    tnViz.create.mockReset();
    tnViz.create.mockResolvedValue({ id: "1AK000" });
    const { stack, model } = stackWithModel();
    const viz = new Visualization(stack, "Chart", {
      model,
      workspace: { name: "W" },
      fields: [field],
      visualSpecification: { custom: true },
      view: { foo: "bar" },
    });
    await VisualizationResource.create(ctx(), viz.props);
    const body = tnViz.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body["visualSpecification"]).toEqual({ custom: true });
    expect(body["view"]).toEqual({ foo: "bar" });
  });
});

describe("Visualization prune registry", () => {
  it("is registered and sorts for delete before SemanticModel", () => {
    expect(RESOURCE_REGISTRY["Visualization"]).toBe(VisualizationResource);
    expect(pruneTypeRank("Visualization")).toBeLessThan(pruneTypeRank("SemanticModel"));
    expect(PRUNE_TYPE_PRIORITY).toContain("Visualization");
  });
});
