import { describe, it, expect, vi, beforeEach } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";
import { Mapping } from "../../src/resources/mapping.js";
import { CalculatedInsight } from "../../src/resources/calculated-insight.js";
import type { ResourceContext } from "../../src/core/construct.js";

// connectRequest is the raw-REST seam; mock it so resource CRUD tests assert
// the wire calls without touching an org. Hoisted so the vi.mock factory can
// reference it.
const { connectRequest } = vi.hoisted(() => ({ connectRequest: vi.fn() }));
vi.mock("../../src/client/rest.js", () => ({ connectRequest }));

// Import AFTER the mock is registered.
const { SemanticModel, SemanticModelResource } = await import(
  "../../src/resources/semantic-model.js"
);
const { RESOURCE_REGISTRY, PRUNE_TYPE_PRIORITY, pruneTypeRank } = await import(
  "../../src/resources/registry.js"
);

function stackWith(): { stack: Stack; dmo: DMO } {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "x" });
  const dmo = new DMO(stack, "Fact", {
    fields: [
      { name: "Id", dataType: "Text", isPrimaryKey: true },
      { name: "Amount", dataType: "Currency" },
    ],
  });
  return { stack, dmo };
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

describe("SemanticModel construct — source resolution", () => {
  it("infers dataObjectName + Dmo type from a DMO construct and wires the dep", () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        {
          apiName: "Fact",
          source: dmo,
          dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text", isPrimaryKey: true }],
        },
      ],
    });
    const dob = sm.props.dataObjects[0]!;
    expect(dob.dataObjectName).toBe("Fact__dlm");
    expect(dob.dataObjectType).toBe("Dmo");
    expect(sm.dependsOn).toContain(dmo);
  });

  it("infers dataObjectName + Cio type from a CalculatedInsight construct", () => {
    const { stack } = stackWith();
    const ci = new CalculatedInsight(stack, "MyCI", { expression: "SELECT 1" });
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        {
          apiName: "Metric",
          source: ci,
          dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
        },
      ],
    });
    const dob = sm.props.dataObjects[0]!;
    expect(dob.dataObjectName).toBe("MyCI__cio");
    expect(dob.dataObjectType).toBe("Cio");
    expect(sm.dependsOn).toContain(ci);
  });

  it("requires dataObjectType when source is a raw string", () => {
    const { stack } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Std",
              source: "ssot__Account__dlm",
              dimensions: [{ apiName: "Id", dataObjectFieldName: "ssot__Id__c", dataType: "Text" }],
            },
          ],
        }),
    ).toThrow(/dataObjectType is required when source is a string/);
  });

  it("accepts a string source when dataObjectType is given", () => {
    const { stack } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        {
          apiName: "Std",
          source: "ssot__Account__dlm",
          dataObjectType: "Dmo",
          dimensions: [{ apiName: "Id", dataObjectFieldName: "ssot__Id__c", dataType: "Text" }],
        },
      ],
    });
    expect(sm.props.dataObjects[0]!.dataObjectName).toBe("ssot__Account__dlm");
  });
});

describe("SemanticModel construct — defaults", () => {
  it("applies shell + dimension + measure defaults", () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        {
          apiName: "Fact",
          source: dmo,
          dimensions: [
            { apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text", isPrimaryKey: true },
            {
              apiName: "Cur",
              dataObjectFieldName: "cdp_sys_record_currency__c",
              dataType: "Text",
              semanticDataType: "RecordCurrency",
            },
          ],
          measures: [{ apiName: "Amt", dataObjectFieldName: "Amount__c", dataType: "Currency" }],
        },
      ],
    });
    expect(sm.apiName).toBe("Model");
    expect(sm.props.dataSpace).toBe("default");
    expect(sm.props.sourceCreation).toBe("DataCloud");
    expect(sm.props.currency).toEqual({ useOrgDefault: true });
    expect(sm.props.queryUnrelatedDataObjects).toBe("Union");
    expect(sm.props.agentEnabled).toBe(false);

    const dim = sm.props.dataObjects[0]!.dimensions[0]!;
    expect(dim.displayCategory).toBe("Discrete");
    expect(dim.isVisible).toBe(true);
    expect(dim.sortOrder).toBe("Ascending");
    expect(dim.storageDataType).toBe("Text");

    const m = sm.props.dataObjects[0]!.measures[0]!;
    expect(m.aggregationType).toBe("UserAgg");
    expect(m.displayCategory).toBe("Continuous");
    expect(m.decimalPlace).toBe(2);
    expect(m.sentiment).toBe("SentimentTypeUpIsGood");
    expect(m.storageDataType).toBe("Currency");
  });

  it("fills relationship criterion defaults (Equals / TableField / Auto)", () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
      relationships: [
        {
          apiName: "R",
          cardinality: "OneToMany",
          leftSemanticDefinitionApiName: "Spine",
          rightSemanticDefinitionApiName: "Fact",
          criteria: [{ leftSemanticFieldApiName: "Id", rightSemanticFieldApiName: "AccountId" }],
        },
      ],
    });
    const rel = sm.props.relationships[0]!;
    expect(rel.joinType).toBe("Auto");
    expect(rel.isEnabled).toBe(true);
    expect(rel.criteria[0]).toEqual({
      joinOperator: "Equals",
      leftFieldType: "TableField",
      leftSemanticFieldApiName: "Id",
      rightFieldType: "TableField",
      rightSemanticFieldApiName: "AccountId",
    });
  });
});

describe("SemanticModel construct — calculated measurements", () => {
  function buildWith(cm: Record<string, unknown>) {
    const { stack, dmo } = stackWith();
    return new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
      calculatedMeasurements: [cm as never],
    });
  }

  it("aggregate flavor fills level + totalAggregationType", () => {
    const sm = buildWith({ apiName: "Cnt", expression: "count([Fact])", aggregationType: "UserAgg" });
    const cm = sm.props.calculatedMeasurements[0]!;
    expect(cm.aggregationType).toBe("UserAgg");
    expect(cm.level).toBe("AggregateFunction");
    expect(cm.totalAggregationType).toBe("Sum");
  });

  it("row-level flavor omits aggregationType / level / totalAggregationType", () => {
    const sm = buildWith({ apiName: "Derived", expression: "[Fact.A] + [Fact.B]" });
    const cm = sm.props.calculatedMeasurements[0]!;
    expect(cm.aggregationType).toBeUndefined();
    expect(cm.level).toBeUndefined();
    expect(cm.totalAggregationType).toBeUndefined();
  });
});

describe("SemanticModel construct — measure guards", () => {
  it("rejects a Percent measure", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
              measures: [{ apiName: "Pct", dataObjectFieldName: "Pct__c", dataType: "Percent" }],
            },
          ],
        }),
    ).toThrow(/dataType "Percent", which the semantic layer rejects/);
  });

  it("rejects a Currency measure without a RecordCurrency sibling dimension", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
              measures: [{ apiName: "Amt", dataObjectFieldName: "Amount__c", dataType: "Currency" }],
            },
          ],
        }),
    ).toThrow(/requires a sibling dimension flagged semanticDataType: "RecordCurrency"/);
  });

  it("accepts a Currency measure when a RecordCurrency dimension is present", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [
                { apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" },
                {
                  apiName: "Cur",
                  dataObjectFieldName: "cdp_sys_record_currency__c",
                  dataType: "Text",
                  semanticDataType: "RecordCurrency",
                },
              ],
              measures: [{ apiName: "Amt", dataObjectFieldName: "Amount__c", dataType: "Currency" }],
            },
          ],
        }),
    ).not.toThrow();
  });
});

describe("SemanticModel construct — aggregationType guard", () => {
  it("rejects a measure aggregationType of 'Avg' and points to 'Average'", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
              measures: [
                { apiName: "AvgAmt", dataObjectFieldName: "Amount__c", dataType: "Number", aggregationType: "Avg" },
              ],
            },
          ],
        }),
    ).toThrow(/aggregationType "Avg" is invalid.*Use "Average"/s);
  });

  it("rejects 'Avg' on a calculated-measurement aggregationType", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
          ],
          calculatedMeasurements: [{ apiName: "A", expression: "avg([Fact.X])", aggregationType: "Avg" }],
        }),
    ).toThrow(/aggregationType "Avg" is invalid/);
  });

  it("accepts 'Average' (the correct spelling)", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
              measures: [
                { apiName: "AvgAmt", dataObjectFieldName: "Amount__c", dataType: "Number", aggregationType: "Average" },
              ],
            },
          ],
        }),
    ).not.toThrow();
  });

  it("accepts a Percentage measure (native-Percent column modeled correctly)", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
              measures: [
                {
                  apiName: "Share",
                  dataObjectFieldName: "MW_Percent__c",
                  dataType: "Percentage",
                  storageDataType: "Percentage",
                  aggregationType: "Average",
                },
              ],
            },
          ],
        }),
    ).not.toThrow();
  });

  it("the Percent rejection now points to 'Percentage', not 'model as a dimension'", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
              measures: [{ apiName: "Pct", dataObjectFieldName: "Pct__c", dataType: "Percent" }],
            },
          ],
        }),
    ).toThrow(/spell its dataType.*"Percentage"/s);
  });
});

describe("SemanticModel construct — model joinType guard", () => {
  function modelWithJoin(joinType?: string) {
    const { stack, dmo } = stackWith();
    return () =>
      new SemanticModel(stack, "Model", {
        dataObjects: [
          { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
        ],
        relationships: [
          {
            apiName: "R",
            cardinality: "OneToMany",
            leftSemanticDefinitionApiName: "Spine",
            rightSemanticDefinitionApiName: "Fact",
            criteria: [{ leftSemanticFieldApiName: "Id", rightSemanticFieldApiName: "AccountId" }],
            ...(joinType !== undefined ? { joinType } : {}),
          },
        ],
      });
  }

  it("rejects an explicit 'Left' join on a base-model relationship", () => {
    expect(modelWithJoin("Left")).toThrow(/must be "Auto".*logical views/s);
  });

  it("rejects 'Inner' too", () => {
    expect(modelWithJoin("Inner")).toThrow(/joinType "Inner" is invalid/);
  });

  it("accepts 'Auto' and the omitted default", () => {
    expect(modelWithJoin("Auto")).not.toThrow();
    expect(modelWithJoin(undefined)).not.toThrow();
  });
});

describe("SemanticModelResource.create — atomic rollback", () => {
  beforeEach(() => {
    connectRequest.mockReset();
  });

  it("rolls back the shell (DELETE) when a child POST fails, and rethrows the original error", async () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
    });
    // shell POST ok; first data-objects POST 400s; DELETE (rollback) ok.
    connectRequest.mockImplementation(async (_s: unknown, o: { method: string; path: string }) => {
      if (o.method === "POST" && o.path.endsWith("/data-objects")) {
        throw { status: 400, body: { message: "SemanticAuthoringError: bad field" } };
      }
      return {};
    });

    await expect(SemanticModelResource.create(ctx(), sm.props)).rejects.toMatchObject({ status: 400 });

    const deletes = connectRequest.mock.calls.filter((c) => (c[1] as { method: string }).method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect((deletes[0]![1] as { path: string }).path).toBe("/ssot/semantic/models/Model");
  });

  it("surfaces the original create error even if rollback DELETE also fails", async () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
    });
    connectRequest.mockImplementation(async (_s: unknown, o: { method: string; path: string }) => {
      if (o.method === "POST" && o.path.endsWith("/data-objects")) {
        throw { status: 400, body: { message: "original" } };
      }
      // 403 (not 5xx, not 404): delete() rethrows immediately — no retry/backoff.
      if (o.method === "DELETE") throw { status: 403, body: { message: "cleanup failed" } };
      return {};
    });
    await expect(SemanticModelResource.create(ctx(), sm.props)).rejects.toMatchObject({
      status: 400,
      body: { message: "original" },
    });
  });
});

describe("SemanticModel construct — reciprocal Mapping wiring", () => {
  function ragStack(order: "mapping-first" | "model-first") {
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
    const dmo = new DMO(stack, "Fact", {
      fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
    });
    const makeModel = () =>
      new SemanticModel(stack, "Model", {
        dataObjects: [
          { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
        ],
      });
    const makeMapping = () =>
      new Mapping(stack, "Map", {
        source: stream,
        target: dmo,
        fieldMappings: [{ source: "Id__c", target: "Id__c" }],
      });
    if (order === "mapping-first") {
      const mapping = makeMapping();
      const model = makeModel();
      return { mapping, model };
    }
    const model = makeModel();
    const mapping = makeMapping();
    return { mapping, model };
  }

  it("wires Mapping → SemanticModel when the Mapping is authored first", () => {
    const { mapping, model } = ragStack("mapping-first");
    expect(model.dependsOn).toContain(mapping);
  });

  it("wires Mapping → SemanticModel when the model is authored first (reciprocal)", () => {
    const { mapping, model } = ragStack("model-first");
    expect(model.dependsOn).toContain(mapping);
  });
});

describe("SemanticModelResource — CRUD wire calls", () => {
  // NB block body — `mockReset()` returns the mock (a function); an arrow that
  // returned it would make vitest treat the mock as a teardown cleanup hook and
  // invoke `connectRequest()` with no args during callCleanupHooks.
  beforeEach(() => {
    connectRequest.mockReset();
  });

  function resolvedProps() {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        {
          apiName: "Fact",
          source: dmo,
          dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text", isPrimaryKey: true }],
        },
      ],
      relationships: [
        {
          apiName: "R",
          cardinality: "OneToMany",
          leftSemanticDefinitionApiName: "Spine",
          rightSemanticDefinitionApiName: "Fact",
          criteria: [{ leftSemanticFieldApiName: "Id", rightSemanticFieldApiName: "AccountId" }],
        },
      ],
      calculatedMeasurements: [{ apiName: "Cnt", expression: "count([Fact])", aggregationType: "UserAgg" }],
    });
    return sm.props;
  }

  it("issues shell → data-objects → relationships → calculated-measurements in order, then reads", async () => {
    connectRequest.mockImplementation(async (_session: unknown, opts: { method: string }) =>
      opts.method === "GET" ? { apiName: "Model", label: "Model", isQueryable: "Queryable" } : {},
    );
    const out = await SemanticModelResource.create(ctx(), resolvedProps());
    expect(out.apiName).toBe("Model");

    const calls = connectRequest.mock.calls.map((c) => ({
      method: (c[1] as { method: string }).method,
      path: (c[1] as { path: string }).path,
      apiVersion: (c[1] as { apiVersion?: string }).apiVersion,
    }));
    expect(calls).toEqual([
      { method: "POST", path: "/ssot/semantic/models", apiVersion: "64.0" },
      { method: "POST", path: "/ssot/semantic/models/Model/data-objects", apiVersion: "64.0" },
      { method: "POST", path: "/ssot/semantic/models/Model/relationships", apiVersion: "64.0" },
      { method: "POST", path: "/ssot/semantic/models/Model/calculated-measurements", apiVersion: "64.0" },
      { method: "GET", path: "/ssot/semantic/models/Model", apiVersion: "64.0" },
    ]);
  });

  it("sends the shell body with sourceCreation + currency + agentEnabled", async () => {
    connectRequest.mockImplementation(async (_s: unknown, opts: { method: string }) =>
      opts.method === "GET" ? { apiName: "Model" } : {},
    );
    await SemanticModelResource.create(ctx(), resolvedProps());
    const shell = connectRequest.mock.calls[0]![1] as { body: Record<string, unknown> };
    expect(shell.body).toMatchObject({
      apiName: "Model",
      dataspace: "default",
      sourceCreation: "DataCloud",
      currency: { useOrgDefault: true },
      queryUnrelatedDataObjects: "Union",
      agentEnabled: false,
    });
  });

  it("delete swallows a 404 as idempotent success", async () => {
    connectRequest.mockRejectedValue({ status: 404, body: { message: "not found" } });
    await expect(SemanticModelResource.delete(ctx(), "Gone")).resolves.toBeUndefined();
  });

  it("read returns null when the model does not exist", async () => {
    connectRequest.mockRejectedValue({ status: 404, body: {} });
    await expect(SemanticModelResource.read(ctx(), "Missing")).resolves.toBeNull();
  });
});

describe("SemanticModel construct — filters (pass-through)", () => {
  beforeEach(() => {
    connectRequest.mockReset();
  });

  function modelWith(opts: {
    dobFilters?: ReadonlyArray<Record<string, unknown>>;
    cmFilters?: ReadonlyArray<Record<string, unknown>>;
    filterLogic?: string;
  }) {
    const { stack, dmo } = stackWith();
    return new SemanticModel(stack, "Model", {
      dataObjects: [
        {
          apiName: "Fact",
          source: dmo,
          dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text", isPrimaryKey: true }],
          ...(opts.dobFilters ? { filters: opts.dobFilters } : {}),
          ...(opts.filterLogic !== undefined ? { filterLogic: opts.filterLogic } : {}),
        },
      ],
      calculatedMeasurements: [
        {
          apiName: "Cnt",
          expression: "count([Fact])",
          aggregationType: "UserAgg",
          ...(opts.cmFilters ? { filters: opts.cmFilters } : {}),
        },
      ],
    });
  }

  async function postBodies(props: unknown): Promise<Record<string, Record<string, unknown>>> {
    connectRequest.mockImplementation(async (_s: unknown, o: { method: string }) =>
      o.method === "GET" ? { apiName: "Model" } : {},
    );
    await SemanticModelResource.create(ctx(), props as never);
    const byPath: Record<string, Record<string, unknown>> = {};
    for (const call of connectRequest.mock.calls) {
      const o = call[1] as { method: string; path: string; body?: Record<string, unknown> };
      if (o.method === "POST" && o.body) byPath[o.path] = o.body;
    }
    return byPath;
  }

  const DOB_PATH = "/ssot/semantic/models/Model/data-objects";
  const CM_PATH = "/ssot/semantic/models/Model/calculated-measurements";

  it("omitting filters emits the unchanged `filters: []` wire default on both bodies", async () => {
    const bodies = await postBodies(modelWith({}).props);
    expect(bodies[DOB_PATH]!.filters).toEqual([]);
    expect(bodies[CM_PATH]!.filters).toEqual([]);
  });

  it("an explicit empty `filters: []` hashes identically to omitting it (recreate-safe)", () => {
    const omitted = SemanticModelResource.hash(modelWith({}).props);
    const empty = SemanticModelResource.hash(modelWith({ dobFilters: [], cmFilters: [] }).props);
    expect(empty).toBe(omitted);
  });

  it("a non-empty data-object filter is forwarded verbatim to the wire", async () => {
    const filter = { field: "Status", operator: "In", values: ["Won", "Lost"] };
    const bodies = await postBodies(modelWith({ dobFilters: [filter] }).props);
    expect(bodies[DOB_PATH]!.filters).toEqual([filter]);
  });

  it("a non-empty calculated-measurement filter is forwarded verbatim to the wire", async () => {
    const filter = { field: "Stage", operator: "Equals", values: ["Closed"] };
    const bodies = await postBodies(modelWith({ cmFilters: [filter] }).props);
    expect(bodies[CM_PATH]!.filters).toEqual([filter]);
  });

  it("a non-empty filter changes the hash (so it participates in drift detection)", () => {
    const base = SemanticModelResource.hash(modelWith({}).props);
    const filtered = SemanticModelResource.hash(
      modelWith({ dobFilters: [{ field: "Status", operator: "In", values: ["Won"] }] }).props,
    );
    expect(filtered).not.toBe(base);
  });

  it("filterLogic rides as a SIBLING of filters on the data-object body (not nested)", async () => {
    const filter = { operator: "In", values: ["Won", "Lost"] };
    const bodies = await postBodies(
      modelWith({ dobFilters: [filter], filterLogic: "1 AND 2" }).props,
    );
    expect(bodies[DOB_PATH]!.filterLogic).toBe("1 AND 2");
    // and the filters array is untouched (logic is NOT folded into a filter)
    expect(bodies[DOB_PATH]!.filters).toEqual([filter]);
  });

  it("omitting filterLogic leaves the key absent from the wire body", async () => {
    const bodies = await postBodies(modelWith({}).props);
    expect(bodies[DOB_PATH]!).not.toHaveProperty("filterLogic");
  });

  it("filterLogic participates in the hash (and omitted == absent)", () => {
    const base = SemanticModelResource.hash(modelWith({}).props);
    const withLogic = SemanticModelResource.hash(modelWith({ filterLogic: "1 OR 2" }).props);
    expect(withLogic).not.toBe(base);
  });
});

describe("SemanticModel prune registry", () => {
  it("is registered and sorts for delete before CalculatedInsight and DMO", () => {
    expect(RESOURCE_REGISTRY["SemanticModel"]).toBe(SemanticModelResource);
    expect(pruneTypeRank("SemanticModel")).toBeLessThan(pruneTypeRank("CalculatedInsight"));
    expect(pruneTypeRank("SemanticModel")).toBeLessThan(pruneTypeRank("DMO"));
    expect(PRUNE_TYPE_PRIORITY).toContain("SemanticModel");
  });
});
