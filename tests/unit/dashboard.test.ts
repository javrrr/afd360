import { describe, it, expect, vi, beforeEach } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import type { ResourceContext } from "../../src/core/construct.js";

// Mock the raw-REST seam so CRUD tests assert wire calls without an org.
const { connectRequest } = vi.hoisted(() => ({ connectRequest: vi.fn() }));
vi.mock("../../src/client/rest.js", () => ({ connectRequest }));

const { Dashboard, DashboardResource, deterministicPageUuid, buildCreateBody } = await import(
  "../../src/resources/dashboard.js"
);
const { Visualization } = await import("../../src/resources/visualization.js");
const { SemanticModel } = await import("../../src/resources/semantic-model.js");
const { RESOURCE_REGISTRY, PRUNE_TYPE_PRIORITY, pruneTypeRank } = await import(
  "../../src/resources/registry.js"
);

function stackWithViz(): { stack: Stack; viz: InstanceType<typeof Visualization> } {
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
  const viz = new Visualization(stack, "RevenueChart", {
    model,
    workspace: { name: "Analytics" },
    fields: [{ objectName: "Orders", fieldName: "Region", role: "Dimension", axis: "row" }],
  });
  return { stack, viz };
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

describe("Dashboard construct — widget binding + resolution", () => {
  it("resolves a Visualization construct → viz name + wires dependsOn", () => {
    const { stack, viz } = stackWithViz();
    const dash = new Dashboard(stack, "Overview", {
      workspace: "Analytics_WS",
      widgets: [{ visualization: viz }],
    });
    expect(dash.props.widgets[0]!.vizName).toBe("RevenueChart");
    expect(dash.dependsOn).toContain(viz);
  });

  it("accepts a raw viz dev-name string (no dep)", () => {
    const { stack } = stackWithViz();
    const dash = new Dashboard(stack, "Overview", {
      workspace: "Analytics_WS",
      widgets: [{ visualization: "SomeExistingViz" }],
    });
    expect(dash.props.widgets[0]!.vizName).toBe("SomeExistingViz");
    expect(dash.dependsOn).toEqual([]);
  });

  it("throws when no widgets are supplied", () => {
    const { stack } = stackWithViz();
    expect(
      () => new Dashboard(stack, "Overview", { workspace: "WS", widgets: [] }),
    ).toThrow(/at least one widget/);
  });

  it("throws when workspace is missing", () => {
    const { stack, viz } = stackWithViz();
    expect(
      () => new Dashboard(stack, "Overview", { workspace: "", widgets: [{ visualization: viz }] }),
    ).toThrow(/workspace/);
  });
});

describe("Dashboard construct — layout defaults", () => {
  it("assigns widget keys visualization_1, 2… and defaults a single full-width tile", () => {
    const { stack, viz } = stackWithViz();
    const dash = new Dashboard(stack, "Overview", {
      workspace: "WS",
      widgets: [{ visualization: viz }],
    });
    const w = dash.props.widgets[0]!;
    expect(w.key).toBe("visualization_1");
    expect(w.column).toBe(0);
    expect(w.row).toBe(0);
    expect(w.colspan).toBe(48); // full default grid
    expect(w.rowspan).toBe(23);
    expect(w.legendPosition).toBe("Right");
  });

  it("stacks default tiles vertically so they do not overlap", () => {
    const { stack, viz } = stackWithViz();
    const dash = new Dashboard(stack, "Overview", {
      workspace: "WS",
      widgets: [{ visualization: viz }, { visualization: "SecondViz" }],
    });
    const [a, b] = dash.props.widgets;
    expect(a!.row).toBe(0);
    expect(b!.key).toBe("visualization_2");
    expect(b!.row).toBe(23); // below the first 23-row tile
  });

  it("honors explicit position + grid overrides", () => {
    const { stack, viz } = stackWithViz();
    const dash = new Dashboard(stack, "Overview", {
      workspace: "WS",
      columnCount: 24,
      widgets: [{ visualization: viz, column: 2, row: 5, colspan: 10, rowspan: 8, legendPosition: "Bottom" }],
    });
    const w = dash.props.widgets[0]!;
    expect(w).toMatchObject({ column: 2, row: 5, colspan: 10, rowspan: 8, legendPosition: "Bottom" });
    expect(dash.props.columnCount).toBe(24);
  });
});

describe("deterministicPageUuid", () => {
  it("is stable for the same seed (idempotent hash) and well-formed", () => {
    const a = deterministicPageUuid("Overview");
    const b = deterministicPageUuid("Overview");
    expect(a).toBe(b);
    // 8-4-4-4-12, version nibble 5, variant nibble in 8..b.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs across seeds", () => {
    expect(deterministicPageUuid("A")).not.toBe(deterministicPageUuid("B"));
  });
});

describe("DashboardResource — create body", () => {
  it("builds the confirmed POST shape: name-only viz source, discriminator, grid, no server ids", () => {
    const { stack, viz } = stackWithViz();
    const dash = new Dashboard(stack, "Sales_Overview", {
      label: "Sales Overview",
      workspace: "Analytics_WS",
      widgets: [{ visualization: viz }],
    });
    const body = buildCreateBody(dash.props) as Record<string, unknown>;

    expect(body["name"]).toBe("Sales_Overview");
    expect(body["label"]).toBe("Sales Overview");
    expect(body["workspaceIdOrApiName"]).toBe("Analytics_WS");
    expect(body["customConfig"]).toMatchObject({ queryCacheEnabled: true, queryCacheStaleness: "30min" });

    // layouts[0].pages[0] carries the positioned widget + a uuid page name.
    const layout = (body["layouts"] as Array<Record<string, unknown>>)[0]!;
    expect(layout["columnCount"]).toBe(48);
    const page = (layout["pages"] as Array<Record<string, unknown>>)[0]!;
    expect(page["name"]).toBe(deterministicPageUuid("Sales_Overview"));
    const layoutWidget = (page["widgets"] as Array<Record<string, unknown>>)[0]!;
    expect(layoutWidget).toEqual({ name: "visualization_1", column: 0, row: 0, colspan: 48, rowspan: 23 });

    // top-level widgets object binds the viz BY NAME, keeps the discriminator,
    // and carries NO source.type.
    const widgets = body["widgets"] as Record<string, Record<string, unknown>>;
    const w = widgets["visualization_1"]!;
    expect(w["type"]).toBe("visualization");
    expect(w["source"]).toEqual({ name: "RevenueChart" });
    expect((w["parameters"] as Record<string, unknown>)["legendPosition"]).toBe("Right");

    // No server-managed fields leak into the input body.
    for (const k of ["id", "createdBy", "createdDate", "url", "permissions", "customViews", "status"]) {
      expect(body[k]).toBeUndefined();
    }
    const layoutUnknown = layout as Record<string, unknown>;
    expect(layoutUnknown["id"]).toBeUndefined();
    expect((page as Record<string, unknown>)["id"]).toBeUndefined();
  });
});

describe("DashboardResource — CRUD wire calls", () => {
  beforeEach(() => {
    connectRequest.mockReset();
  });

  function resolvedProps() {
    const { stack, viz } = stackWithViz();
    const dash = new Dashboard(stack, "Overview", {
      workspace: "WS",
      widgets: [{ visualization: viz }],
    });
    return dash.props;
  }

  it("POSTs to /tableau/dashboards at v67.0", async () => {
    connectRequest.mockResolvedValue({ id: "0FK000", name: "Overview" });
    const out = await DashboardResource.create(ctx(), resolvedProps());
    expect(out.id).toBe("0FK000");
    const call = connectRequest.mock.calls[0]![1] as { method: string; path: string; apiVersion: string };
    expect(call).toMatchObject({ method: "POST", path: "/tableau/dashboards", apiVersion: "67.0" });
  });

  it("read returns null when the dashboard does not exist", async () => {
    connectRequest.mockRejectedValue({ status: 404, body: {} });
    await expect(DashboardResource.read(ctx(), "gone")).resolves.toBeNull();
  });

  it("read treats a 400 'was not found' body as absent", async () => {
    connectRequest.mockRejectedValue({ status: 400, body: { message: "Dashboard was not found" } });
    await expect(DashboardResource.read(ctx(), "gone")).resolves.toBeNull();
  });

  it("lookupByProps lists and matches on developer name (wrapped shape)", async () => {
    connectRequest.mockResolvedValue({
      dashboards: [
        { id: "0FKaaa", name: "Other" },
        { id: "0FK000", name: "Overview" },
      ],
    });
    const found = await DashboardResource.lookupByProps!(ctx(), resolvedProps());
    expect(found?.id).toBe("0FK000");
  });

  it("lookupByProps tolerates a bare-array list shape", async () => {
    connectRequest.mockResolvedValue([{ id: "0FK000", name: "Overview" }]);
    const found = await DashboardResource.lookupByProps!(ctx(), resolvedProps());
    expect(found?.id).toBe("0FK000");
  });

  it("delete swallows a 404 as idempotent success", async () => {
    connectRequest.mockRejectedValue({ status: 404, body: { message: "not found" } });
    await expect(DashboardResource.delete(ctx(), "0FK000")).resolves.toBeUndefined();
  });

  it("update throws (v1 delete-and-recreate policy)", async () => {
    await expect(DashboardResource.update(ctx(), "0FK000", resolvedProps())).rejects.toThrow(/not implemented/);
  });

  it("idOf prefers id, falls back to name", () => {
    expect(DashboardResource.idOf({ id: "0FK000", name: "Overview" })).toBe("0FK000");
    expect(DashboardResource.idOf({ id: "", name: "Overview" })).toBe("Overview");
  });
});

describe("Dashboard prune registry", () => {
  it("is registered and sorts for delete before Visualization", () => {
    expect(RESOURCE_REGISTRY["Dashboard"]).toBe(DashboardResource);
    expect(pruneTypeRank("Dashboard")).toBeLessThan(pruneTypeRank("Visualization"));
    expect(PRUNE_TYPE_PRIORITY).toContain("Dashboard");
  });
});
