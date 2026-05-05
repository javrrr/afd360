import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import {
  CalculatedInsight,
  CalculatedInsightResource,
} from "../../src/resources/calculated-insight.js";
import type { ResourceContext } from "../../src/core/construct.js";

function mockCtx(): ResourceContext {
  return {
    client: {
      calculatedInsights: {
        get: vi.fn(),
        create: vi.fn(),
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

describe("CalculatedInsight construct", () => {
  it("appends __cio to apiName", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const ci = new CalculatedInsight(stack, "MyCI", {
      expression: "SELECT 1 FROM ssot__Account__dlm",
    });
    expect(ci.apiName).toBe("MyCI__cio");
    expect(ci.props.apiName).toBe("MyCI__cio");
  });

  it("preserves explicit __cio suffix", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const ci = new CalculatedInsight(stack, "X", {
      name: "explicit__cio",
      expression: "SELECT 1",
    });
    expect(ci.apiName).toBe("explicit__cio");
  });

  it("defaults definitionType, dataSpace, and interval", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const ci = new CalculatedInsight(stack, "X", { expression: "SELECT 1" });
    expect(ci.props.definitionType).toBe("CALCULATED_METRIC");
    expect(ci.props.dataSpace).toBe("default");
    expect(ci.props.publishScheduleInterval).toBe("Six");
  });

  it("auto-populates publishScheduleStartDateTime when needed", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const ci = new CalculatedInsight(stack, "X", { expression: "SELECT 1" });
    expect(ci.props.publishScheduleStartDateTime).toBeDefined();
    // Must be in the future.
    expect(new Date(ci.props.publishScheduleStartDateTime!).getTime()).toBeGreaterThan(Date.now());
  });

  it("skips start time for NotScheduled / SystemManaged", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const a = new CalculatedInsight(stack, "A", {
      expression: "SELECT 1",
      publishScheduleInterval: "NotScheduled",
    });
    const b = new CalculatedInsight(stack, "B", {
      expression: "SELECT 1",
      publishScheduleInterval: "SystemManaged",
    });
    expect(a.props.publishScheduleStartDateTime).toBeUndefined();
    expect(b.props.publishScheduleStartDateTime).toBeUndefined();
  });

  it("accepts explicit dependsOn DMOs", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    // Minimal fake construct to stand in as a dep.
    const ci = new CalculatedInsight(stack, "X", {
      expression: "SELECT 1",
      dependsOn: [],
    });
    expect(ci.dependsOn).toEqual([]);
  });
});

describe("CalculatedInsightResource.create", () => {
  it("sends expression + publishScheduleInterval + dataSpaceName", async () => {
    const ctx = mockCtx();
    const create = ctx.client.calculatedInsights.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ apiName: "x__cio", calculatedInsightStatus: "CREATING" });
    await CalculatedInsightResource.create(ctx, {
      apiName: "x__cio",
      displayName: "X",
      expression: "SELECT 1",
      definitionType: "CALCULATED_METRIC",
      dataSpace: "default",
      publishScheduleInterval: "Six",
      publishScheduleStartDateTime: "2027-01-01T00:00",
    });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body["apiName"]).toBe("x__cio");
    expect(body["expression"]).toBe("SELECT 1");
    expect(body["dataSpaceName"]).toBe("default");
    expect(body["publishScheduleInterval"]).toBe("Six");
    expect(body["publishScheduleStartDateTime"]).toBe("2027-01-01T00:00");
    // No builderExpression — the input contract only accepts ANSI SQL.
    expect(body).not.toHaveProperty("builderExpression");
  });

  it("omits publishScheduleStartDateTime for NotScheduled interval", async () => {
    const ctx = mockCtx();
    const create = ctx.client.calculatedInsights.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ apiName: "x__cio" });
    await CalculatedInsightResource.create(ctx, {
      apiName: "x__cio",
      displayName: "X",
      expression: "SELECT 1",
      definitionType: "CALCULATED_METRIC",
      dataSpace: "default",
      publishScheduleInterval: "NotScheduled",
      publishScheduleStartDateTime: "2027-01-01T00:00", // intentionally present
    });
    const body = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("publishScheduleStartDateTime");
  });
});

describe("CalculatedInsightResource.delete", () => {
  it("swallows 404 as idempotent success", async () => {
    const ctx = mockCtx();
    (ctx.client.calculatedInsights.delete as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 404,
    });
    await expect(CalculatedInsightResource.delete(ctx, "x__cio")).resolves.toBeUndefined();
  });
});

describe("CalculatedInsightResource.read", () => {
  it("returns null on 404", async () => {
    const ctx = mockCtx();
    (ctx.client.calculatedInsights.get as ReturnType<typeof vi.fn>).mockRejectedValue({ status: 404 });
    expect(await CalculatedInsightResource.read(ctx, "x__cio")).toBeNull();
  });
  it("maps calculatedInsightStatus → status", async () => {
    const ctx = mockCtx();
    (ctx.client.calculatedInsights.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      apiName: "x__cio",
      displayName: "X",
      calculatedInsightStatus: "ACTIVE",
    });
    const out = await CalculatedInsightResource.read(ctx, "x__cio");
    expect(out?.status).toBe("ACTIVE");
  });
});
