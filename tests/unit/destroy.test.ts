/**
 * `afd360 destroy` orphan-adoption coverage.
 *
 * Regression for the awt teardown failure on 2026-05-07: state had a DMO
 * but not the SearchIndex/Mapping that referenced it (an earlier deploy
 * had crashed before persisting them). Destroy walked state, didn't see
 * the SearchIndex, skipped it, and the DMO delete 412'd because the
 * orphan SearchIndex still referenced it on the org.
 *
 * Test exercises `adoptOrphans` directly — the CLI plumbing around it is
 * exercised through integration manifests.
 */
import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import { SearchIndex } from "../../src/resources/search-index.js";
import { adoptOrphans } from "../../src/cli/destroy.js";
import { isResourceConstruct } from "../../src/core/app.js";
import { topologicalSort } from "../../src/core/graph.js";
import type { ResourceContext, Construct } from "../../src/core/construct.js";
import type { ResourceConstruct } from "../../src/core/app.js";
import type { StackState } from "../../src/core/state.js";

function buildOrphanScenario(): {
  resourcesByUid: Map<string, Construct & ResourceConstruct>;
  forwardOrder: string[];
} {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "fake" });
  const dmo = new DMO(stack, "D", {
    fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
  });
  new SearchIndex(stack, "Idx", {
    sourceDmo: dmo,
    fields: [{ fieldDeveloperName: "Id__c" }],
  });
  const collected: Array<Construct & ResourceConstruct> = [];
  const walk = (c: Construct): void => {
    if (isResourceConstruct(c)) collected.push(c);
    for (const child of c.children) walk(child);
  };
  walk(stack);
  const resourcesByUid = new Map(collected.map((r) => [r.uniqueId, r]));
  const forwardOrder = topologicalSort({
    nodes: collected.map((r) => r.uniqueId),
    edges: collected.flatMap((r) =>
      r.dependsOn.map((d) => ({ from: d.uniqueId, to: r.uniqueId })),
    ),
  });
  return { resourcesByUid, forwardOrder };
}

function mockCtxWithSearchIndex(returns: unknown): ResourceContext {
  return {
    client: {
      searchIndex: {
        get: vi.fn().mockResolvedValue(returns),
      },
    } as unknown as ResourceContext["client"],
    session: {
      alias: "fake", username: "u", orgId: "00D",
      instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
    },
    orgAlias: "fake",
  };
}

describe("adoptOrphans", () => {
  it("discovers an orphan SearchIndex via lookupByProps and writes it into state", async () => {
    const { resourcesByUid, forwardOrder } = buildOrphanScenario();
    const ctx = mockCtxWithSearchIndex({
      id: "18l0000000orph",
      developerName: "Idx",
      runtimeStatus: "READY",
      sourceDmoDeveloperName: "D__dlm",
    });
    // State has the DMO but is missing the SearchIndex.
    const state: StackState = {
      stackName: "S",
      targetOrg: "fake",
      lastDeployedAt: null,
      resources: {
        "S/D": {
          type: "DMO",
          apiName: "D__dlm",
          salesforceId: "D__dlm",
          hash: "sha256:x",
          createdAt: "2026-05-07T00:00:00.000Z",
        },
      },
    };
    const adopted: Array<{ uid: string; id: string }> = [];
    await adoptOrphans({
      ctx,
      state,
      resourcesByUid,
      forwardOrder,
      log: (uid, id) => adopted.push({ uid, id }),
    });
    expect(adopted).toEqual([{ uid: "S/Idx", id: "18l0000000orph" }]);
    expect(state.resources["S/Idx"]).toMatchObject({
      type: "SearchIndex",
      salesforceId: "18l0000000orph",
    });
  });

  it("does nothing when the orphan isn't on the org (lookupByProps returns null)", async () => {
    const { resourcesByUid, forwardOrder } = buildOrphanScenario();
    const ctx: ResourceContext = {
      client: {
        searchIndex: {
          get: vi.fn().mockRejectedValue({ status: 404 }),
        },
      } as unknown as ResourceContext["client"],
      session: {
        alias: "fake", username: "u", orgId: "00D",
        instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
      },
      orgAlias: "fake",
    };
    const state: StackState = {
      stackName: "S",
      targetOrg: "fake",
      lastDeployedAt: null,
      resources: {
        "S/D": {
          type: "DMO",
          apiName: "D__dlm",
          salesforceId: "D__dlm",
          hash: "sha256:x",
          createdAt: "2026-05-07T00:00:00.000Z",
        },
      },
    };
    await adoptOrphans({ ctx, state, resourcesByUid, forwardOrder });
    expect(state.resources["S/Idx"]).toBeUndefined();
  });

  it("leaves resources that already have state entries untouched", async () => {
    const { resourcesByUid, forwardOrder } = buildOrphanScenario();
    const get = vi.fn();
    const ctx: ResourceContext = {
      client: {
        searchIndex: { get },
      } as unknown as ResourceContext["client"],
      session: {
        alias: "fake", username: "u", orgId: "00D",
        instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
      },
      orgAlias: "fake",
    };
    const state: StackState = {
      stackName: "S",
      targetOrg: "fake",
      lastDeployedAt: null,
      resources: {
        "S/D": {
          type: "DMO",
          apiName: "D__dlm",
          salesforceId: "D__dlm",
          hash: "sha256:x",
          createdAt: "2026-05-07T00:00:00.000Z",
        },
        "S/Idx": {
          type: "SearchIndex",
          apiName: "Idx",
          salesforceId: "18l-existing",
          hash: "sha256:y",
          createdAt: "2026-05-07T00:00:00.000Z",
        },
      },
    };
    await adoptOrphans({ ctx, state, resourcesByUid, forwardOrder });
    // No lookup attempted because state already had the entry.
    expect(get).not.toHaveBeenCalled();
    expect(state.resources["S/Idx"]?.salesforceId).toBe("18l-existing");
  });
});
