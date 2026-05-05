/**
 * C8 invariant — running `deploy` twice against a clean state does zero
 * writes on the second run.
 *
 * We don't go through the CLI entry point (that's integration territory), but
 * we do simulate the op loop end-to-end: for each resource in topological
 * order, call computeOp → apply the op to a fake state → advance the deployed
 * map. Then do the same walk again with the post-first-run state and assert
 * every op comes back `noop`.
 */
import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import { CalculatedInsight } from "../../src/resources/calculated-insight.js";
import { computeOp } from "../../src/cli/ops.js";
import { isResourceConstruct } from "../../src/core/app.js";
import { topologicalSort } from "../../src/core/graph.js";
import type { StackState, StateResource } from "../../src/core/state.js";
import type { Construct, ResourceContext } from "../../src/core/construct.js";
import type { ResourceConstruct, DeployedRef } from "../../src/core/app.js";

function buildApp(): App {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "jaygentforce" });
  const dmo = new DMO(stack, "NTOProduct", {
    fields: [
      { name: "Id", dataType: "Text", isPrimaryKey: true },
      { name: "Name", dataType: "Text" },
    ],
  });
  new CalculatedInsight(stack, "ProductCount", {
    expression: "SELECT COUNT(NTOProduct__dlm.Id__c) AS c__c FROM NTOProduct__dlm",
    publishScheduleInterval: "NotScheduled",
    dependsOn: [dmo],
  });
  return app;
}

function collectResources(scope: Construct): Array<Construct & ResourceConstruct> {
  const out: Array<Construct & ResourceConstruct> = [];
  const walk = (c: Construct): void => {
    if (isResourceConstruct(c)) out.push(c);
    for (const child of c.children) walk(child);
  };
  walk(scope);
  return out;
}

function mockCtx(): ResourceContext {
  return {
    client: {
      dataModelObjects: {
        get: vi.fn(),
        create: vi.fn(),
        delete: vi.fn(),
      },
      calculatedInsights: {
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

describe("idempotency — repeat deploy against an already-applied state", () => {
  it("second run yields all noops and zero API writes", async () => {
    const app = buildApp();
    const stack = app.stacks[0]!;
    const resources = collectResources(stack);
    const order = topologicalSort({
      nodes: resources.map((r) => r.uniqueId),
      edges: resources.flatMap((r) =>
        r.dependsOn.map((d) => ({ from: d.uniqueId, to: r.uniqueId })),
      ),
    });
    const byId = new Map(resources.map((r) => [r.uniqueId, r]));

    // ── First run: simulate creates ─────────────────────────────────────────
    const ctx = mockCtx();
    const dmoGet = ctx.client.dataModelObjects.get as ReturnType<typeof vi.fn>;
    const dmoCreate = ctx.client.dataModelObjects.create as ReturnType<typeof vi.fn>;
    const ciGet = ctx.client.calculatedInsights.get as ReturnType<typeof vi.fn>;
    const ciCreate = ctx.client.calculatedInsights.create as ReturnType<typeof vi.fn>;

    // Fresh org: lookupByProps returns null (404) for both.
    dmoGet.mockRejectedValue({ status: 404 });
    ciGet.mockRejectedValue({ status: 404 });
    dmoCreate.mockResolvedValue({
      name: "NTOProduct__dlm",
      label: "NTOProduct",
      category: "Other",
      dataSpaceName: "default",
    });
    ciCreate.mockResolvedValue({
      apiName: "ProductCount__cio",
      displayName: "ProductCount",
      calculatedInsightStatus: "ACTIVE",
    });

    const state: StackState = {
      stackName: "S",
      targetOrg: "jaygentforce",
      lastDeployedAt: null,
      resources: {},
    };
    const deployed = new Map<string, DeployedRef>();
    const firstRunOps: string[] = [];

    for (const uid of order) {
      const c = byId.get(uid)!;
      const op = await computeOp(ctx, c, state, deployed);
      firstRunOps.push(op.kind);
      if (op.kind === "create") {
        const resolved = c.resolveProps ? c.resolveProps(deployed) : c.props;
        const out = await c.resource.create(ctx, resolved as never);
        const id = c.resource.idOf(out);
        const apiName = (out as { name?: string; apiName?: string }).name ??
                        (out as { apiName?: string }).apiName ?? c.id;
        deployed.set(uid, { salesforceId: id, apiName });
        const entry: StateResource = {
          type: c.resource.type,
          apiName,
          salesforceId: id,
          hash: op.plannedHash,
          createdAt: new Date().toISOString(),
        };
        state.resources[uid] = entry;
      }
    }
    expect(firstRunOps).toEqual(["create", "create"]);

    // Total API writes on run 1: each create (2).
    const run1Writes = dmoCreate.mock.calls.length + ciCreate.mock.calls.length;
    expect(run1Writes).toBe(2);

    // ── Second run: same state, live still present ──────────────────────────
    dmoCreate.mockClear();
    ciCreate.mockClear();
    const dmoDelete = ctx.client.dataModelObjects.delete as ReturnType<typeof vi.fn>;
    const ciDelete = ctx.client.calculatedInsights.delete as ReturnType<typeof vi.fn>;

    // For the second run, get() should return the live resources (not 404).
    dmoGet.mockReset();
    ciGet.mockReset();
    dmoGet.mockResolvedValue({
      name: "NTOProduct__dlm",
      label: "NTOProduct",
      category: "Other",
      dataSpaceName: "default",
    });
    ciGet.mockResolvedValue({
      apiName: "ProductCount__cio",
      displayName: "ProductCount",
      calculatedInsightStatus: "ACTIVE",
    });

    const secondRunOps: string[] = [];
    for (const uid of order) {
      const c = byId.get(uid)!;
      const op = await computeOp(ctx, c, state, deployed);
      secondRunOps.push(op.kind);
    }

    expect(secondRunOps).toEqual(["noop", "noop"]);
    expect(dmoCreate).not.toHaveBeenCalled();
    expect(ciCreate).not.toHaveBeenCalled();
    expect(dmoDelete).not.toHaveBeenCalled();
    expect(ciDelete).not.toHaveBeenCalled();
  });
});
