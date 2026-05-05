import { describe, it, expect, vi } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { DMO } from "../../src/resources/dmo.js";
import { Relationship, RelationshipResource } from "../../src/resources/relationship.js";
import type { ResourceContext } from "../../src/core/construct.js";

function fixture() {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "x" });
  const a = new DMO(stack, "A", {
    fields: [
      { name: "Id", dataType: "Text", isPrimaryKey: true },
      { name: "B_fk", dataType: "Text" },
    ],
  });
  const b = new DMO(stack, "B", {
    fields: [{ name: "Id", dataType: "Text", isPrimaryKey: true }],
  });
  return { app, stack, a, b };
}

function mockCtx(): ResourceContext {
  return {
    client: {
      dataModelObjects: {
        createRelationships: vi.fn(),
        deleteRelationships: vi.fn(),
        listRelationships: vi.fn(),
      },
    } as unknown as ResourceContext["client"],
    session: {
      alias: "jaygentforce", username: "u", orgId: "00D",
      instanceUrl: "https://x", apiVersion: "66.0", accessToken: "tok",
    },
    orgAlias: "jaygentforce",
  };
}

describe("Relationship construct", () => {
  it("resolves source/target DMO full names", () => {
    const { stack, a, b } = fixture();
    const r = new Relationship(stack, "R", {
      source: a, sourceField: "B_fk", target: b, targetField: "Id",
    });
    expect(r.props.sourceObjectName).toBe("A__dlm");
    expect(r.props.targetObjectName).toBe("B__dlm");
    expect(r.props.sourceFieldName).toBe("B_fk__c");
    expect(r.props.targetFieldName).toBe("Id__c");
    expect(r.props.cardinality).toBe("ManyToOne");
    expect(r.props.relationshipOwner).toBe("DataCloud");
    expect(r.dependsOn).toContain(a);
    expect(r.dependsOn).toContain(b);
  });

  it("accepts a standard DMO target by name string", () => {
    const { stack, a } = fixture();
    const r = new Relationship(stack, "R", {
      source: a, sourceField: "Acc_fk", target: "ssot__Account__dlm", targetField: "ssot__Id__c",
    });
    expect(r.props.targetObjectName).toBe("ssot__Account__dlm");
    // Standard DMO targets don't add a construct dep (afd360 doesn't own them).
    expect(r.dependsOn.some((d) => d.id === "ssot__Account__dlm")).toBe(false);
  });

  it("ensureFieldSuffix appends __c only when missing", () => {
    const { stack, a, b } = fixture();
    const r = new Relationship(stack, "R", {
      source: a, sourceField: "X__c", target: b, targetField: "Y",
    });
    expect(r.props.sourceFieldName).toBe("X__c");
    expect(r.props.targetFieldName).toBe("Y__c");
  });
});

describe("RelationshipResource.create", () => {
  it("sends the correct body shape (relationshipOwner, no owner/creationType)", async () => {
    const ctx = mockCtx();
    const create = ctx.client.dataModelObjects.createRelationships as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({
      relationships: [{
        id: "rel1",
        name: "B_fk_c_rel_B_dlm_123",
        sourceField: { name: "B_fk__c" },
        sourceObject: { name: "A__dlm" },
        targetField: { name: "Id__c" },
        targetObject: { name: "B__dlm" },
        cardinality: "ManyToOne",
      }],
    });
    const props = {
      sourceObjectName: "A__dlm",
      targetObjectName: "B__dlm",
      sourceFieldName: "B_fk__c",
      targetFieldName: "Id__c",
      cardinality: "ManyToOne" as const,
      relationshipOwner: "DataCloud" as const,
      dataSpace: "default",
    };
    const out = await RelationshipResource.create(ctx, props);
    expect(out.id).toBe("rel1");
    expect(out.name).toBe("B_fk_c_rel_B_dlm_123");
    // Verify payload
    const [dmoName, body, params] = create.mock.calls[0]!;
    expect(dmoName).toBe("A__dlm");
    expect(params).toEqual({ dataspace: "default" });
    const rel = (body as { relationships: Array<Record<string, unknown>> }).relationships[0]!;
    expect(rel["relationshipOwner"]).toBe("DataCloud");
    expect(rel).not.toHaveProperty("owner");
    expect(rel).not.toHaveProperty("creationType");
    expect(rel["cardinality"]).toBe("ManyToOne");
    expect(rel["dataSpaceName"]).toBe("default");
  });
});

describe("RelationshipResource.delete", () => {
  it("extracts devName from composite id", async () => {
    const ctx = mockCtx();
    const del = ctx.client.dataModelObjects.deleteRelationships as ReturnType<typeof vi.fn>;
    del.mockResolvedValue(undefined);
    await RelationshipResource.delete(ctx, "A__dlm::MyRel_dev");
    expect(del).toHaveBeenCalledWith("MyRel_dev");
  });

  it("swallows 404 as idempotent success", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.deleteRelationships as ReturnType<typeof vi.fn>).mockRejectedValue({
      status: 404,
    });
    await expect(RelationshipResource.delete(ctx, "A__dlm::X")).resolves.toBeUndefined();
  });

  it("is a no-op if composite id has no ::", async () => {
    const ctx = mockCtx();
    const del = ctx.client.dataModelObjects.deleteRelationships as ReturnType<typeof vi.fn>;
    await RelationshipResource.delete(ctx, "garbage");
    expect(del).not.toHaveBeenCalled();
  });
});

describe("RelationshipResource.lookupByProps", () => {
  it("returns existing relationship matching (source, sourceField, target, targetField)", async () => {
    const ctx = mockCtx();
    (ctx.client.dataModelObjects.listRelationships as ReturnType<typeof vi.fn>).mockResolvedValue({
      relationships: [
        {
          id: "rel1",
          name: "B_fk_c_rel_B_dlm_123",
          sourceField: { name: "B_fk__c" },
          sourceObject: { name: "A__dlm" },
          targetField: { name: "Id__c" },
          targetObject: { name: "B__dlm" },
          cardinality: "ManyToOne",
        },
        {
          id: "rel2",
          name: "other",
          sourceField: { name: "Other__c" },
          sourceObject: { name: "A__dlm" },
          targetField: { name: "Id__c" },
          targetObject: { name: "C__dlm" },
          cardinality: "ManyToOne",
        },
      ],
    });
    const out = await RelationshipResource.lookupByProps!(ctx, {
      sourceObjectName: "A__dlm",
      targetObjectName: "B__dlm",
      sourceFieldName: "B_fk__c",
      targetFieldName: "Id__c",
      cardinality: "ManyToOne",
      relationshipOwner: "DataCloud",
      dataSpace: "default",
    });
    expect(out?.id).toBe("rel1");
  });
});
