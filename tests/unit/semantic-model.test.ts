import { describe, it, expect, vi, beforeEach } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";
import { Mapping } from "../../src/resources/mapping.js";
import { CalculatedInsight } from "../../src/resources/calculated-insight.js";
import type { ResourceContext } from "../../src/core/construct.js";

// SemanticModel talks to tableau-semantics-sdk via `ctx.semanticsClient
// .semanticModels` (create/get/delete). The client is INJECTED through ctx (not
// module-imported), so we mock the methods on a fake client rather than mocking
// a module — CRUD tests assert the single nested `create` body (the COLLECTION
// POST verb; `put` is replace-only, live-verified v65) and the get/delete
// behavior without touching an org.
const semanticModels = {
  create: vi.fn(),
  put: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

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
    tableauClient: {} as unknown as ResourceContext["tableauClient"],
    semanticsClient: { semanticModels } as unknown as ResourceContext["semanticsClient"],
    session: {
      alias: "o", username: "u", orgId: "00D",
      instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
    },
    orgAlias: "o",
  };
}

/** The single nested body from the one `create` (collection POST) call. */
function createBody(): Record<string, unknown> {
  return semanticModels.create.mock.calls[0]![0] as Record<string, unknown>;
}

/** First element of a sub-collection array on the create body. */
function createCollection(key: string): Record<string, unknown>[] {
  return (createBody()[key] as Record<string, unknown>[]) ?? [];
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

describe("SemanticModel construct — calculated dimensions", () => {
  function buildWith(cd: Record<string, unknown>) {
    const { stack, dmo } = stackWith();
    return new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
      calculatedDimensions: [cd as never],
    });
  }

  it("applies dimension defaults (Text / Discrete / None / None / visible)", () => {
    const sm = buildWith({ apiName: "Bucket", expression: "IF [Fact.Id] = '1' THEN 'a' ELSE 'b' END" });
    const cd = sm.props.calculatedDimensions[0]!;
    expect(cd).toEqual({
      apiName: "Bucket",
      label: "Bucket",
      expression: "IF [Fact.Id] = '1' THEN 'a' ELSE 'b' END",
      dataType: "Text",
      displayCategory: "Discrete",
      semanticDataType: "None",
      sortOrder: "None",
      isVisible: true,
    });
  });

  it("omits calculatedDimensions from resolved props when none are authored (hash-stable upgrade)", () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
    });
    // The key must be ABSENT (not `[]`) so hashProps yields the same hash as a
    // manifest authored before the prop existed — otherwise every pre-existing
    // SemanticModel drop+recreates on upgrade.
    expect(sm.props).not.toHaveProperty("calculatedDimensions");
  });

  it("honors author overrides", () => {
    const sm = buildWith({
      apiName: "Month",
      label: "Close Month",
      expression: "[Fact.CloseDate]",
      dataType: "Date",
      isVisible: false,
    });
    const cd = sm.props.calculatedDimensions[0]!;
    expect(cd.label).toBe("Close Month");
    expect(cd.dataType).toBe("Date");
    expect(cd.isVisible).toBe(false);
  });

  it("forwards the live-confirmed wire body — level 'Row', no agg fields, fixed scaffolding", async () => {
    semanticModels.create.mockReset().mockResolvedValue({});
    semanticModels.get.mockReset().mockResolvedValue({ apiName: "Model" });
    const sm = buildWith({ apiName: "Bucket", expression: "IF [Fact.Id] = '1' THEN 'a' ELSE 'b' END" });
    await SemanticModelResource.create(ctx(), sm.props);
    const body = createCollection("semanticCalculatedDimensions")[0]!;
    expect(body).toEqual({
      apiName: "Bucket",
      label: "Bucket",
      expression: "IF [Fact.Id] = '1' THEN 'a' ELSE 'b' END",
      dataType: "Text",
      displayCategory: "Discrete",
      level: "Row",
      semanticDataType: "None",
      sortOrder: "None",
      isVisible: true,
      filters: [],
      isOverrideBase: false,
      overriddenProperties: [],
    });
    expect(body).not.toHaveProperty("aggregationType");
    expect(body).not.toHaveProperty("totalAggregationType");
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

describe("SemanticModel construct — field apiName space guard", () => {
  it("rejects a dimension apiName containing whitespace (opaque 500 otherwise)", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Account Name", dataObjectFieldName: "Name__c", dataType: "Text" }],
            },
          ],
        }),
    ).toThrow(/dimension "Account Name" apiName.*whitespace.*Account_Name/s);
  });

  it("rejects a measure apiName containing whitespace", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }],
              measures: [{ apiName: "Total Amount", dataObjectFieldName: "Amount__c", dataType: "Number" }],
            },
          ],
        }),
    ).toThrow(/measure "Total Amount" apiName.*whitespace/s);
  });

  it("accepts space-free apiNames (display text lives in label)", () => {
    const { stack, dmo } = stackWith();
    expect(
      () =>
        new SemanticModel(stack, "Model", {
          dataObjects: [
            {
              apiName: "Fact",
              source: dmo,
              dimensions: [
                { apiName: "Account_Name", dataObjectFieldName: "Name__c", dataType: "Text", label: "Account Name" },
              ],
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

describe("SemanticModelResource.create — single-POST semantics", () => {
  beforeEach(() => {
    semanticModels.create.mockReset();
    semanticModels.put.mockReset();
    semanticModels.get.mockReset();
    semanticModels.delete.mockReset();
  });

  it("issues exactly ONE collection POST (no per-sub-resource POSTs, never put) then reads once — no rollback dance", async () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
    });
    semanticModels.create.mockResolvedValue({});
    semanticModels.get.mockResolvedValue({ apiName: "Model" });

    await SemanticModelResource.create(ctx(), sm.props);

    expect(semanticModels.create).toHaveBeenCalledTimes(1);
    // create is the collection POST, NOT the replace-only put.
    expect(semanticModels.put).not.toHaveBeenCalled();
    expect(semanticModels.get).toHaveBeenCalledTimes(1);
    // The old v64 flow rolled back by DELETE on partial failure; the single
    // POST has no partial sequence, so delete is never called.
    expect(semanticModels.delete).not.toHaveBeenCalled();
  });

  it("rethrows the original error when the POST fails, and does NOT attempt a rollback delete", async () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
    });
    semanticModels.create.mockRejectedValue({ status: 400, body: { message: "original" } });

    await expect(SemanticModelResource.create(ctx(), sm.props)).rejects.toMatchObject({
      status: 400,
      body: { message: "original" },
    });
    // A failed create leaves nothing on-org; the next deploy re-POSTs — create()
    // must not fire a cleanup delete.
    expect(semanticModels.delete).not.toHaveBeenCalled();
  });

  it("waits out the upstream-CI compute lag (SEMANTIC_ENTITY_NOT_EXIST) then creates", async () => {
    vi.useFakeTimers();
    try {
      const { stack, dmo } = stackWith();
      const sm = new SemanticModel(stack, "Model", {
        dataObjects: [
          { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
        ],
      });
      // First POST: the referenced CI is ACTIVE but its data object isn't
      // queryable yet (first compute hasn't landed) → 404 SEMANTIC_ENTITY_NOT_EXIST.
      // Second: computed, create succeeds.
      semanticModels.create
        .mockRejectedValueOnce({ status: 404, body: '[{"errorCode":"SEMANTIC_ENTITY_NOT_EXIST"}]' })
        .mockResolvedValue({});
      semanticModels.get.mockResolvedValue({ apiName: "Model" });

      const p = SemanticModelResource.create(ctx(), sm.props);
      await vi.runAllTimersAsync();
      await p;

      expect(semanticModels.create).toHaveBeenCalledTimes(2);
      expect(semanticModels.put).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retry an unrelated create 400 (a real bad-definition fails fast)", async () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
    });
    semanticModels.create.mockRejectedValue({ status: 400, body: { message: "invalid aggregation type" } });

    await expect(SemanticModelResource.create(ctx(), sm.props)).rejects.toMatchObject({ status: 400 });
    expect(semanticModels.create).toHaveBeenCalledTimes(1);
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
  beforeEach(() => {
    semanticModels.create.mockReset();
    semanticModels.put.mockReset();
    semanticModels.get.mockReset();
    semanticModels.delete.mockReset();
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
      calculatedDimensions: [{ apiName: "Bucket", expression: "IF [Fact.Id] = '1' THEN 'a' ELSE 'b' END" }],
    });
    return sm.props;
  }

  it("collapses the whole model into ONE collection POST (apiName in the body + every sub-collection), then reads", async () => {
    semanticModels.create.mockResolvedValue({});
    semanticModels.get.mockResolvedValue({ apiName: "Model", label: "Model", isQueryable: "Queryable" });
    const out = await SemanticModelResource.create(ctx(), resolvedProps());
    expect(out.apiName).toBe("Model");

    expect(semanticModels.create).toHaveBeenCalledTimes(1);
    // The collection POST takes the whole model as a single body arg (no apiName
    // path param — apiName rides INSIDE the body).
    const [body] = semanticModels.create.mock.calls[0]! as [Record<string, unknown>];
    expect(body["apiName"]).toBe("Model");
    // The five v64 POST path segments are now camelCase array properties on the
    // single body — all present for a model that has each kind.
    expect(body).toHaveProperty("semanticDataObjects");
    expect(body).toHaveProperty("semanticRelationships");
    expect(body).toHaveProperty("semanticCalculatedMeasurements");
    expect(body).toHaveProperty("semanticCalculatedDimensions");
    expect((body["semanticDataObjects"] as unknown[]).length).toBe(1);
    // hydration read follows the write
    expect(semanticModels.get).toHaveBeenCalledWith("Model");
  });

  it("sends the shell fields at the top level of the create body (sourceCreation + currency + agentEnabled)", async () => {
    semanticModels.create.mockResolvedValue({});
    semanticModels.get.mockResolvedValue({ apiName: "Model" });
    await SemanticModelResource.create(ctx(), resolvedProps());
    expect(createBody()).toMatchObject({
      apiName: "Model",
      dataspace: "default",
      sourceCreation: "DataCloud",
      currency: { useOrgDefault: true },
      queryUnrelatedDataObjects: "Union",
      agentEnabled: false,
    });
  });

  it("omits empty sub-collections from the create body (relationships/calc fields absent when none authored)", async () => {
    const { stack, dmo } = stackWith();
    const sm = new SemanticModel(stack, "Model", {
      dataObjects: [
        { apiName: "Fact", source: dmo, dimensions: [{ apiName: "Id", dataObjectFieldName: "Id__c", dataType: "Text" }] },
      ],
    });
    semanticModels.create.mockResolvedValue({});
    semanticModels.get.mockResolvedValue({ apiName: "Model" });
    await SemanticModelResource.create(ctx(), sm.props);
    const body = createBody();
    expect(body).toHaveProperty("semanticDataObjects");
    expect(body).not.toHaveProperty("semanticRelationships");
    expect(body).not.toHaveProperty("semanticCalculatedMeasurements");
    expect(body).not.toHaveProperty("semanticCalculatedDimensions");
  });

  it("delete swallows a 404 as idempotent success", async () => {
    semanticModels.delete.mockRejectedValue({ status: 404, body: { message: "not found" } });
    await expect(SemanticModelResource.delete(ctx(), "Gone")).resolves.toBeUndefined();
  });

  it("read returns null when the model does not exist", async () => {
    semanticModels.get.mockRejectedValue({ status: 404, body: {} });
    await expect(SemanticModelResource.read(ctx(), "Missing")).resolves.toBeNull();
  });

  it("read retries a transient 5xx (does NOT misread an existing model as gone)", async () => {
    // The semantic surface intermittently 500s; a 500 whose body matches
    // /not found/ would otherwise be swallowed as not-found → spurious `create`
    // on re-diff.
    semanticModels.get
      .mockRejectedValueOnce({ status: 500, body: { message: "model not found (transient)" } })
      .mockResolvedValueOnce({ apiName: "Model", isQueryable: "Queryable" });
    const out = await SemanticModelResource.read(ctx(), "Model");
    expect(out?.apiName).toBe("Model");
    expect(semanticModels.get).toHaveBeenCalledTimes(2); // retried once, then succeeded
  });

  it("read does NOT retry a clean 404 (genuinely-absent model stays fast)", async () => {
    semanticModels.get.mockRejectedValue({ status: 404, body: {} });
    await expect(SemanticModelResource.read(ctx(), "Missing")).resolves.toBeNull();
    expect(semanticModels.get).toHaveBeenCalledTimes(1); // 404 is not retried
  });
});

describe("SemanticModel construct — filters (pass-through)", () => {
  beforeEach(() => {
    semanticModels.create.mockReset();
    semanticModels.get.mockReset();
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

  /**
   * Create the model via the single collection POST and return the data-object
   * and calculated-measurement ELEMENTS of the nested create body (the native
   * home of their `filters`/`filterLogic` now that there are no per-sub-resource
   * POSTs).
   */
  async function createdBodies(
    props: unknown,
  ): Promise<{ dob: Record<string, unknown>; cm: Record<string, unknown> }> {
    semanticModels.create.mockResolvedValue({});
    semanticModels.get.mockResolvedValue({ apiName: "Model" });
    await SemanticModelResource.create(ctx(), props as never);
    return {
      dob: createCollection("semanticDataObjects")[0]!,
      cm: createCollection("semanticCalculatedMeasurements")[0]!,
    };
  }

  it("omitting filters emits the unchanged `filters: []` wire default on both element bodies", async () => {
    const { dob, cm } = await createdBodies(modelWith({}).props);
    expect(dob.filters).toEqual([]);
    expect(cm.filters).toEqual([]);
  });

  it("an explicit empty `filters: []` hashes identically to omitting it (recreate-safe)", () => {
    const omitted = SemanticModelResource.hash(modelWith({}).props);
    const empty = SemanticModelResource.hash(modelWith({ dobFilters: [], cmFilters: [] }).props);
    expect(empty).toBe(omitted);
  });

  it("a non-empty data-object filter is forwarded verbatim to the wire", async () => {
    const filter = { field: "Status", operator: "In", values: ["Won", "Lost"] };
    const { dob } = await createdBodies(modelWith({ dobFilters: [filter] }).props);
    expect(dob.filters).toEqual([filter]);
  });

  it("a non-empty calculated-measurement filter is forwarded verbatim to the wire", async () => {
    const filter = { field: "Stage", operator: "Equals", values: ["Closed"] };
    const { cm } = await createdBodies(modelWith({ cmFilters: [filter] }).props);
    expect(cm.filters).toEqual([filter]);
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
    const { dob } = await createdBodies(
      modelWith({ dobFilters: [filter], filterLogic: "1 AND 2" }).props,
    );
    expect(dob.filterLogic).toBe("1 AND 2");
    // and the filters array is untouched (logic is NOT folded into a filter)
    expect(dob.filters).toEqual([filter]);
  });

  it("omitting filterLogic leaves the key absent from the wire body", async () => {
    const { dob } = await createdBodies(modelWith({}).props);
    expect(dob).not.toHaveProperty("filterLogic");
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
