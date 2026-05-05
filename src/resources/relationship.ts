import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, isNotFound } from "../client/retry.js";
import type { DMO } from "./dmo.js";
import type { Mapping } from "./mapping.js";

/**
 * Cardinality of the foreign-key relationship. ManyToOne is the common case
 * (e.g. many transaction DMO rows → one account DMO row). OneToOne enforces
 * a unique constraint on the source field.
 */
export type RelationshipCardinality = "ManyToOne" | "OneToOne";

/**
 * Who owns the relationship record. DataCloud is the normal case for custom
 * DMOs. Sobject indicates the relationship originates from a CRM object's
 * lookup/master-detail field and is synced in from Salesforce Core.
 */
export type RelationshipOwner = "DataCloud" | "Sobject";

export interface RelationshipProps {
  /** Source DMO construct. */
  readonly source: DMO;
  /** FK field name on the source DMO (with or without __c; platform uses __c). */
  readonly sourceField: string;
  /**
   * Target DMO. Either an afd360-managed DMO construct or a standard
   * platform DMO referenced by dev name (e.g. `"ssot__Account__dlm"`).
   * Both work via the Connect API so long as both DMOs have at least one
   * DLO→DMO mapping (see feedback_createrelationships-requires-mappings.md).
   */
  readonly target: DMO | string;
  /** FK field name on the target DMO (typically `Id__c` or `ssot__Id__c`). */
  readonly targetField: string;
  readonly cardinality?: RelationshipCardinality;
  readonly relationshipOwner?: RelationshipOwner;
  readonly dataSpace?: string;
  /** Optional: afd360 wires dependsOn from both ends' Mappings; this is for extras. */
  readonly dependsOn?: readonly Construct[];
}

export interface RelationshipOutput {
  /** Platform-assigned id (used for delete). */
  readonly id: string;
  /** Platform-assigned dev name. */
  readonly name: string;
  readonly sourceObjectName: string;
  readonly targetObjectName: string;
  readonly sourceFieldName: string;
  readonly targetFieldName: string;
  readonly cardinality: RelationshipCardinality;
  readonly owner?: string;
}

export interface RelationshipResourceProps {
  readonly sourceObjectName: string;
  readonly targetObjectName: string;
  readonly sourceFieldName: string;
  readonly targetFieldName: string;
  readonly cardinality: RelationshipCardinality;
  readonly relationshipOwner: RelationshipOwner;
  readonly dataSpace: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function ensureFieldSuffix(fieldName: string): string {
  return fieldName.endsWith("__c") ? fieldName : `${fieldName}__c`;
}

function toOutput(
  raw: {
    id?: string;
    name?: string;
    cardinality?: RelationshipCardinality;
    owner?: string;
    sourceField?: { name?: string };
    sourceObject?: { name?: string };
    targetField?: { name?: string };
    targetObject?: { name?: string };
  },
  props: RelationshipResourceProps,
): RelationshipOutput {
  const out: Mutable<RelationshipOutput> = {
    id: raw.id ?? "",
    name: raw.name ?? "",
    sourceObjectName: raw.sourceObject?.name ?? props.sourceObjectName,
    targetObjectName: raw.targetObject?.name ?? props.targetObjectName,
    sourceFieldName: raw.sourceField?.name ?? props.sourceFieldName,
    targetFieldName: raw.targetField?.name ?? props.targetFieldName,
    cardinality: raw.cardinality ?? props.cardinality,
  };
  if (raw.owner !== undefined) out.owner = raw.owner;
  return out;
}


export const RelationshipResource: Resource<
  RelationshipResourceProps,
  RelationshipOutput
> = {
  type: "Relationship",
  surface: "connect",

  idOf(out): string {
    // Composite id — read() uses it to locate the relationship via a list.
    return `${out.sourceObjectName}::${out.name}`;
  },

  async read(ctx, compositeId): Promise<RelationshipOutput | null> {
    const sep = compositeId.indexOf("::");
    if (sep < 0) return null;
    const sourceObject = compositeId.slice(0, sep);
    const devName = compositeId.slice(sep + 2);
    try {
      const result = await ctx.client.dataModelObjects.listRelationships(
        sourceObject,
      );
      const rels =
        (result as { relationships?: Array<{ name?: string }> }).relationships ??
        [];
      const match = rels.find((r) => r.name === devName);
      if (!match) return null;
      return toOutput(match as never, {
        sourceObjectName: sourceObject,
        targetObjectName: "",
        sourceFieldName: "",
        targetFieldName: "",
        cardinality: "ManyToOne",
        relationshipOwner: "DataCloud",
        dataSpace: "default",
      });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<RelationshipOutput | null> {
    // Match on (source object, source field, target object, target field)
    // within the source DMO's relationship list.
    try {
      const result = await ctx.client.dataModelObjects.listRelationships(
        props.sourceObjectName,
      );
      const rels =
        (result as {
          relationships?: Array<{
            id?: string;
            name?: string;
            cardinality?: RelationshipCardinality;
            owner?: string;
            sourceField?: { name?: string };
            sourceObject?: { name?: string };
            targetField?: { name?: string };
            targetObject?: { name?: string };
          }>;
        }).relationships ?? [];
      const match = rels.find(
        (r) =>
          r.sourceField?.name === props.sourceFieldName &&
          r.targetField?.name === props.targetFieldName &&
          r.targetObject?.name === props.targetObjectName,
      );
      if (!match) return null;
      return toOutput(match, props);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async create(ctx, props): Promise<RelationshipOutput> {
    // Payload shape from jaygentforce 2026-05-05 probe — see memory note
    // feedback_createrelationships-requires-mappings.md.
    // Quirks:
    //   - docs show `owner` / `creationType`; actual API accepts only
    //     `relationshipOwner` and rejects the other two as unrecognized.
    //   - Both DMOs must have DLO→DMO mappings; otherwise 400
    //     INVALID_INPUT "No ObjectSourceTargetMaps were found". Construct
    //     wires dependsOn to the source DMO's Mapping to cover our side;
    //     target-side mapping is the user's responsibility (and is always
    //     the case for `ssot__*` standard DMOs with Sales bundle streams).
    const body = {
      relationships: [
        {
          sourceObjectName: props.sourceObjectName,
          targetObjectName: props.targetObjectName,
          cardinality: props.cardinality,
          sourceFieldName: props.sourceFieldName,
          targetFieldName: props.targetFieldName,
          relationshipOwner: props.relationshipOwner,
          dataSpaceName: props.dataSpace,
        },
      ],
    } as Parameters<Data360Client["dataModelObjects"]["createRelationships"]>[1];
    const result = await retryOn5xx(() =>
      ctx.client.dataModelObjects.createRelationships(
        props.sourceObjectName,
        body,
        { dataspace: props.dataSpace },
      ),
    );
    // Defensive: the SDK returns `undefined` for 204 responses, and the
    // Connect API occasionally returns 201 with a body but with the SDK's
    // JSON path returning an unexpected shape. Either way, fall back to a
    // listRelationships lookup — the relationship is already created.
    const rels =
      (result as { relationships?: Array<unknown> } | undefined)?.relationships ?? [];
    if (rels.length > 0) {
      return toOutput(rels[0] as never, props);
    }
    const hydrated = await RelationshipResource.lookupByProps!(ctx, props);
    if (hydrated) return hydrated;
    throw new Error(
      `createRelationships for ${props.sourceObjectName} succeeded but the ` +
        `response was empty and lookup could not find the created relationship.`,
    );
  },

  async update(_ctx, _id, _props): Promise<RelationshipOutput> {
    // v1 policy — delete-and-recreate on drift (PLAN §9).
    throw new Error(
      "RelationshipResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, compositeId): Promise<void> {
    const sep = compositeId.indexOf("::");
    if (sep < 0) return;
    const devName = compositeId.slice(sep + 2);
    if (!devName) return;
    try {
      await retryOn5xx(() =>
        ctx.client.dataModelObjects.deleteRelationships(devName),
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  hash(props): string {
    return hashProps(props);
  },
};

/**
 * Construct. dependsOn auto-wires to the source DMO (and, when the target is
 * an afd360-managed DMO, to it as well). For targets that are standard DMOs
 * referenced by name (e.g. `"ssot__Account__dlm"`), afd360 can't know what
 * created them — the user must ensure those are mapped before deploy.
 *
 * afd360 does NOT auto-dependsOn the Mapping resources. The PLAN quirk says
 * both DMOs need ObjectSourceTargetMaps; within a single stack the Mapping
 * constructs typically depend on the DMOs, so a Relationship that depends on
 * the DMO transitively depends on its Mapping via the topo sort.
 */
export class Relationship extends Construct {
  readonly resource = RelationshipResource;
  readonly props: RelationshipResourceProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Stack, id: string, props: RelationshipProps) {
    super(scope, id);
    const targetName =
      typeof props.target === "string" ? props.target : props.target.fullName;
    const sourceName = props.source.fullName;
    this.props = {
      sourceObjectName: sourceName,
      targetObjectName: targetName,
      sourceFieldName: ensureFieldSuffix(props.sourceField),
      targetFieldName: ensureFieldSuffix(props.targetField),
      cardinality: props.cardinality ?? "ManyToOne",
      relationshipOwner: props.relationshipOwner ?? "DataCloud",
      dataSpace: props.dataSpace ?? props.source.props.dataSpace,
    };
    const autoDeps: Construct[] = [props.source];
    if (typeof props.target !== "string") autoDeps.push(props.target);
    this.dependsOn = [...autoDeps, ...(props.dependsOn ?? [])];
  }

  /**
   * Consumer-facing helper: pin a Mapping dependency explicitly. Use this
   * when the target DMO is also afd360-managed and you want the Relationship
   * to wait for its Mapping to be created (defensive; normally the DMO→
   * Mapping edge plus Mapping→Relationship transitively handles this).
   */
  addDependency(dep: Mapping | Construct): this {
    (this.dependsOn as Construct[]).push(dep);
    return this;
  }
}
