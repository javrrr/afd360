import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, isNotFound as baseIsNotFound } from "../client/retry.js";
import { connectRequest } from "../client/rest.js";
import type { DMO } from "./dmo.js";
import type { CalculatedInsight } from "./calculated-insight.js";

/**
 * Tableau-Next / Data 360 **semantic model** construct.
 *
 * A semantic model sits on top of already-provisioned DMOs and
 * CalculatedInsights — it gives their columns business-facing dimensions and
 * measures, wires foreign-key relationships between them, and adds derived
 * calculated measurements. A Tableau viz later binds to the model.
 *
 * There is NO data-360-sdk service for semantic models, so this resource talks
 * raw Connect REST through `connectRequest` (see src/client/rest.ts). The wire
 * contract below was captured firsthand by a live org against a live Data 360
 * org (v64.0, `/ssot/semantic/models`, 2026-10-01) — see
 * feedback_semantic-model-viz-api-surface.md.
 *
 * Create is a FOUR-STEP ordered sequence, each sub-resource referencing the
 * prior by **apiName** (no server-id remap):
 *   1. POST /ssot/semantic/models                        — the shell
 *   2. POST .../{model}/data-objects                     — one per DMO/CI
 *   3. POST .../{model}/relationships                    — FK joins
 *   4. POST .../{model}/calculated-measurements          — derived metrics
 * DELETE /ssot/semantic/models/{apiName} tears the whole thing down (204/404).
 */

/** API version the semantic-model endpoints were verified against. Pinned
 * because `/ssot/semantic/` is version-sensitive; the Tableau viz layer sits
 * on a DIFFERENT version (v67) — see the viz construct. */
const SEMANTIC_API_VERSION = "64.0";
const MODELS_PATH = "/ssot/semantic/models";

/** `Cio` = CalculatedInsight output; `Dmo` = a DLO/DMO. (NOT "Dlm".) */
export type SemanticDataObjectType = "Cio" | "Dmo";
export type SemanticCardinality = "OneToOne" | "OneToMany";

/**
 * A row-level filter on a semantic data object, or a filter on a calculated
 * measurement. This is the native semantic-layer equivalent of a CI's
 * `WHERE …` clause (e.g. `Status IN ('Won','Lost')`): it restricts the rows a
 * data object contributes before measures aggregate.
 *
 * The exact `/ssot/semantic/models` filter grammar is NOT carried by
 * data-360-sdk (there is no first-class semantic-model service) and is being
 * confirmed firsthand against a live Data 360 org. Until it is pinned from a
 * live capture, afd360 forwards each filter object **verbatim** to the wire —
 * the same pass-through contract as a calculated-measurement `expression`
 * string: afd360 does not validate the grammar, the platform does. Author the
 * shape the live endpoint accepts; this type will be tightened to a named
 * shape once a live response confirms it.
 */
export type SemanticFilter = Readonly<Record<string, unknown>>;

/**
 * One business dimension on a data object. `apiName` is the semantic name a
 * viz/relationship references (e.g. `AccountId`); `dataObjectFieldName` is the
 * underlying `__c` column it projects.
 */
export interface SemanticDimension {
  readonly apiName: string;
  /** Underlying column dev name (`__c`). */
  readonly dataObjectFieldName: string;
  /** Display enum: `Text` | `Number` | `Currency` | `Date` | `DateTime` | … */
  readonly dataType: string;
  readonly label?: string;
  /** `Discrete` (default) | `Continuous`. */
  readonly displayCategory?: string;
  readonly isPrimaryKey?: boolean;
  readonly isVisible?: boolean;
  /**
   * `None` (default). Set to `RecordCurrency` on the dimension that projects
   * `cdp_sys_record_currency__c` — REQUIRED alongside any Currency measure on
   * the same data object (the platform 400s "missing a record currency field"
   * otherwise). See [[currency-type-breaks-semantic-layer]].
   */
  readonly semanticDataType?: string;
  /** `Ascending` (default) | `Descending`. */
  readonly sortOrder?: string;
  /** Native storage type. Defaults to `dataType`. For a Cio data object it
   * MUST equal the field's native type — the platform rejects any coercion. */
  readonly storageDataType?: string;
}

/**
 * One business measure. Extends a dimension with aggregation metadata.
 *
 * `dataType` is the display enum and is NARROWER than storage: it accepts
 * `Number`/`Currency` but REJECTS `Percent` — a natively-Percent column can't
 * be a measure (model it as a dimension). For a Cio data object `storageDataType`
 * must equal the field's native type.
 */
export interface SemanticMeasure {
  readonly apiName: string;
  readonly dataObjectFieldName: string;
  readonly dataType: string;
  readonly label?: string;
  readonly storageDataType?: string;
  /** `UserAgg` (default), `Sum`, `Avg`, … */
  readonly aggregationType?: string;
  readonly decimalPlace?: number;
  /** `Up` (default) | `Down` | `None`. */
  readonly directionality?: string;
  readonly displayCategory?: string;
  readonly isAggregatable?: boolean;
  readonly isPrimaryKey?: boolean;
  readonly isVisible?: boolean;
  readonly semanticDataType?: string;
  /** Only `SentimentTypeUpIsGood` is accepted today (`…DownIsGood` is rejected). */
  readonly sentiment?: string;
  readonly shouldTreatNullsAsZeros?: boolean;
  readonly sortOrder?: string;
}

/**
 * A data object — a DMO or CI surfaced into the model. `source` may be an
 * afd360-managed `DMO`/`CalculatedInsight` construct (preferred — auto-wires
 * dependsOn + infers `dataObjectType`) or a raw `dataObjectName` string (then
 * `dataObjectType` is required).
 */
export interface SemanticDataObjectProps {
  /** Semantic apiName (e.g. `My_Fact`). Referenced by relationships + viz. */
  readonly apiName: string;
  readonly label?: string;
  readonly source: DMO | CalculatedInsight | string;
  /** Required when `source` is a string; inferred from a construct otherwise. */
  readonly dataObjectType?: SemanticDataObjectType;
  /** `Standard` (default) — NOT "Full". */
  readonly tableType?: string;
  readonly shouldIncludeAllFields?: boolean;
  readonly dimensions: ReadonlyArray<SemanticDimension>;
  readonly measures?: ReadonlyArray<SemanticMeasure>;
  /**
   * Row-level filters restricting the rows this data object contributes (the
   * native equivalent of a CI's `WHERE`). Forwarded verbatim; see
   * {@link SemanticFilter}. Omit (or `[]`) for no filter — the wire default.
   */
  readonly filters?: ReadonlyArray<SemanticFilter>;
}

export interface SemanticRelationshipCriterion {
  /** Dimension apiName on the left data object (NOT the raw column). */
  readonly leftSemanticFieldApiName: string;
  readonly rightSemanticFieldApiName: string;
  /** `Equals` (default). */
  readonly joinOperator?: string;
  /** `TableField` (default). */
  readonly leftFieldType?: string;
  readonly rightFieldType?: string;
}

export interface SemanticRelationshipProps {
  readonly apiName: string;
  readonly label?: string;
  readonly cardinality: SemanticCardinality;
  /** Data-object apiName on each end. */
  readonly leftSemanticDefinitionApiName: string;
  readonly rightSemanticDefinitionApiName: string;
  readonly criteria: ReadonlyArray<SemanticRelationshipCriterion>;
  readonly isEnabled?: boolean;
  /** `Auto` (default). */
  readonly joinType?: string;
}

/**
 * A derived measurement. Two flavors, discriminated by `aggregationType`:
 *  - **Aggregate** — supply `aggregationType` (e.g. `UserAgg`); afd360 fills
 *    `level: "AggregateFunction"` + `totalAggregationType: "Sum"` unless set.
 *    Expression form: `count([My_Fact])`.
 *  - **Row-level** — OMIT `aggregationType` (and level/total). Reference member
 *    measures dotted in single brackets: `[My_Fact.ScoreA] + [My_Fact.ScoreB]`.
 *    Setting `aggregationType` on a row-level field is rejected ("does not
 *    support userAgg").
 */
export interface SemanticCalculatedMeasurementProps {
  readonly apiName: string;
  readonly label?: string;
  readonly expression: string;
  readonly dataType?: string;
  readonly decimalPlace?: number;
  readonly directionality?: string;
  readonly displayCategory?: string;
  readonly semanticDataType?: string;
  readonly sentiment?: string;
  readonly isVisible?: boolean;
  /** Presence selects the aggregate flavor; omit for row-level. */
  readonly aggregationType?: string;
  readonly level?: string;
  readonly totalAggregationType?: string;
  /**
   * Filters scoping this calculated measurement. Forwarded verbatim; see
   * {@link SemanticFilter}. Omit (or `[]`) for none — the wire default.
   */
  readonly filters?: ReadonlyArray<SemanticFilter>;
}

export interface SemanticModelProps {
  /** Model apiName. Defaults to the construct id. */
  readonly apiName?: string;
  readonly label?: string;
  /** Maps to the body's `dataspace`. Default `default`. */
  readonly dataSpace?: string;
  /** Default `DataCloud`. */
  readonly sourceCreation?: string;
  /** Default `{ useOrgDefault: true }`. */
  readonly currency?: { readonly useOrgDefault: boolean };
  /** Default `Union`. */
  readonly queryUnrelatedDataObjects?: string;
  readonly agentEnabled?: boolean;
  readonly dataObjects: ReadonlyArray<SemanticDataObjectProps>;
  readonly relationships?: ReadonlyArray<SemanticRelationshipProps>;
  readonly calculatedMeasurements?: ReadonlyArray<SemanticCalculatedMeasurementProps>;
  readonly dependsOn?: ReadonlyArray<Construct>;
}

export interface SemanticModelOutput {
  readonly apiName: string;
  readonly label?: string;
  /** `Queryable` when the model validated. */
  readonly isQueryable?: string;
}

// ---- Resolved (defaults applied) shapes used for create + hash ----

interface ResolvedDimension {
  readonly apiName: string;
  readonly dataObjectFieldName: string;
  readonly dataType: string;
  readonly displayCategory: string;
  readonly isPrimaryKey: boolean;
  readonly isVisible: boolean;
  readonly label: string;
  readonly semanticDataType: string;
  readonly sortOrder: string;
  readonly storageDataType: string;
}

interface ResolvedMeasure extends ResolvedDimension {
  readonly aggregationType: string;
  readonly decimalPlace: number;
  readonly directionality: string;
  readonly isAggregatable: boolean;
  readonly sentiment: string;
  readonly shouldTreatNullsAsZeros: boolean;
}

interface ResolvedDataObject {
  readonly apiName: string;
  readonly label: string;
  readonly dataObjectName: string;
  readonly dataObjectType: SemanticDataObjectType;
  readonly tableType: string;
  readonly shouldIncludeAllFields: boolean;
  readonly dimensions: ReadonlyArray<ResolvedDimension>;
  readonly measures: ReadonlyArray<ResolvedMeasure>;
  /** Undefined when the author supplied none — keeps the hash + wire bytes
   * identical to pre-filters manifests (hashProps drops undefined keys). */
  readonly filters?: ReadonlyArray<SemanticFilter>;
}

interface ResolvedCriterion {
  readonly joinOperator: string;
  readonly leftFieldType: string;
  readonly leftSemanticFieldApiName: string;
  readonly rightFieldType: string;
  readonly rightSemanticFieldApiName: string;
}

interface ResolvedRelationship {
  readonly apiName: string;
  readonly label: string;
  readonly cardinality: SemanticCardinality;
  readonly isEnabled: boolean;
  readonly joinType: string;
  readonly leftSemanticDefinitionApiName: string;
  readonly rightSemanticDefinitionApiName: string;
  readonly criteria: ReadonlyArray<ResolvedCriterion>;
}

interface ResolvedCalcMeasurement {
  readonly apiName: string;
  readonly label: string;
  readonly expression: string;
  readonly dataType: string;
  readonly decimalPlace: number;
  readonly directionality: string;
  readonly displayCategory: string;
  readonly semanticDataType: string;
  readonly sentiment: string;
  readonly isVisible: boolean;
  readonly aggregationType?: string;
  readonly level?: string;
  readonly totalAggregationType?: string;
  /** Undefined when none supplied — hash/wire-identical to pre-filters manifests. */
  readonly filters?: ReadonlyArray<SemanticFilter>;
}

export interface SemanticModelResourceProps {
  readonly apiName: string;
  readonly label: string;
  readonly dataSpace: string;
  readonly sourceCreation: string;
  readonly currency: { readonly useOrgDefault: boolean };
  readonly queryUnrelatedDataObjects: string;
  readonly agentEnabled: boolean;
  readonly dataObjects: ReadonlyArray<ResolvedDataObject>;
  readonly relationships: ReadonlyArray<ResolvedRelationship>;
  readonly calculatedMeasurements: ReadonlyArray<ResolvedCalcMeasurement>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// Semantic-model GET on a missing model returns 404; widen defensively with a
// couple of common 400-body phrasings in case the Connect endpoint uses the
// INVALID_INPUT-with-body shape some /ssot endpoints prefer.
function isNotFound(err: unknown): boolean {
  return (
    baseIsNotFound(err, { extra400Body: "does not exist" }) ||
    baseIsNotFound(err, { extra400Body: "was not found" })
  );
}

function toOutput(raw: {
  apiName?: string;
  label?: string;
  isQueryable?: string;
}): SemanticModelOutput {
  const out: Mutable<SemanticModelOutput> = { apiName: raw.apiName ?? "" };
  if (raw.label !== undefined) out.label = raw.label;
  if (raw.isQueryable !== undefined) out.isQueryable = raw.isQueryable;
  return out;
}

function buildShellBody(p: SemanticModelResourceProps): unknown {
  return {
    apiName: p.apiName,
    label: p.label,
    dataspace: p.dataSpace,
    sourceCreation: p.sourceCreation,
    currency: p.currency,
    queryUnrelatedDataObjects: p.queryUnrelatedDataObjects,
    agentEnabled: p.agentEnabled,
  };
}

function buildDataObjectBody(d: ResolvedDataObject): unknown {
  return {
    apiName: d.apiName,
    label: d.label,
    dataObjectName: d.dataObjectName,
    dataObjectType: d.dataObjectType,
    tableType: d.tableType,
    shouldIncludeAllFields: d.shouldIncludeAllFields,
    filters: d.filters ?? [],
    semanticDimensions: d.dimensions.map((dim) => ({
      apiName: dim.apiName,
      dataObjectFieldName: dim.dataObjectFieldName,
      dataType: dim.dataType,
      displayCategory: dim.displayCategory,
      isPrimaryKey: dim.isPrimaryKey,
      isVisible: dim.isVisible,
      label: dim.label,
      semanticDataType: dim.semanticDataType,
      sortOrder: dim.sortOrder,
      storageDataType: dim.storageDataType,
    })),
    semanticMeasurements: d.measures.map((m) => ({
      apiName: m.apiName,
      dataObjectFieldName: m.dataObjectFieldName,
      dataType: m.dataType,
      storageDataType: m.storageDataType,
      aggregationType: m.aggregationType,
      decimalPlace: m.decimalPlace,
      directionality: m.directionality,
      displayCategory: m.displayCategory,
      isAggregatable: m.isAggregatable,
      isPrimaryKey: m.isPrimaryKey,
      isVisible: m.isVisible,
      label: m.label,
      semanticDataType: m.semanticDataType,
      sentiment: m.sentiment,
      shouldTreatNullsAsZeros: m.shouldTreatNullsAsZeros,
      sortOrder: m.sortOrder,
    })),
  };
}

function buildRelationshipBody(r: ResolvedRelationship): unknown {
  return {
    apiName: r.apiName,
    label: r.label,
    cardinality: r.cardinality,
    isEnabled: r.isEnabled,
    joinType: r.joinType,
    leftSemanticDefinitionApiName: r.leftSemanticDefinitionApiName,
    rightSemanticDefinitionApiName: r.rightSemanticDefinitionApiName,
    criteria: r.criteria.map((c) => ({
      joinOperator: c.joinOperator,
      leftFieldType: c.leftFieldType,
      leftSemanticFieldApiName: c.leftSemanticFieldApiName,
      rightFieldType: c.rightFieldType,
      rightSemanticFieldApiName: c.rightSemanticFieldApiName,
    })),
  };
}

function buildCalcMeasurementBody(cm: ResolvedCalcMeasurement): unknown {
  const body: Record<string, unknown> = {
    apiName: cm.apiName,
    label: cm.label,
    dataType: cm.dataType,
    decimalPlace: cm.decimalPlace,
    directionality: cm.directionality,
    displayCategory: cm.displayCategory,
    semanticDataType: cm.semanticDataType,
    sentiment: cm.sentiment,
    isVisible: cm.isVisible,
    filters: cm.filters ?? [],
    expression: cm.expression,
  };
  // Aggregate flavor only — a row-level field MUST omit these three.
  if (cm.aggregationType !== undefined) {
    body["aggregationType"] = cm.aggregationType;
    body["level"] = cm.level ?? "AggregateFunction";
    body["totalAggregationType"] = cm.totalAggregationType ?? "Sum";
  }
  return body;
}

export const SemanticModelResource: Resource<SemanticModelResourceProps, SemanticModelOutput> = {
  type: "SemanticModel",
  surface: "connect",

  idOf(out): string {
    return out.apiName;
  },

  async read(ctx, apiName): Promise<SemanticModelOutput | null> {
    try {
      const raw = await connectRequest<Record<string, unknown>>(ctx.session, {
        method: "GET",
        path: `${MODELS_PATH}/${apiName}`,
        apiVersion: SEMANTIC_API_VERSION,
      });
      return toOutput(raw as never);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<SemanticModelOutput | null> {
    return SemanticModelResource.read(ctx, props.apiName);
  },

  async create(ctx, props): Promise<SemanticModelOutput> {
    // Four-step ordered create — each sub-resource references the prior by
    // apiName (no id remap). The afd360 engine handles idempotency
    // (noop/adopt/recreate) around this; create() itself always builds fresh,
    // and a recreate deletes the whole model first (DELETE cascades).
    const post = (path: string, body: unknown): Promise<unknown> =>
      retryOn5xx(() =>
        connectRequest(ctx.session, {
          method: "POST",
          path,
          body,
          apiVersion: SEMANTIC_API_VERSION,
        }),
      );

    // 1. shell
    await post(MODELS_PATH, buildShellBody(props));
    const modelPath = `${MODELS_PATH}/${props.apiName}`;
    // 2. data objects (one per DMO/CI)
    for (const dob of props.dataObjects) {
      await post(`${modelPath}/data-objects`, buildDataObjectBody(dob));
    }
    // 3. relationships
    for (const rel of props.relationships) {
      await post(`${modelPath}/relationships`, buildRelationshipBody(rel));
    }
    // 4. calculated measurements
    for (const cm of props.calculatedMeasurements) {
      await post(`${modelPath}/calculated-measurements`, buildCalcMeasurementBody(cm));
    }

    const hydrated = await SemanticModelResource.read(ctx, props.apiName);
    if (hydrated) return hydrated;
    return toOutput({ apiName: props.apiName, label: props.label });
  },

  async update(_ctx, _id, _props): Promise<SemanticModelOutput> {
    // v1 policy (PLAN §9): hash drift → delete-and-recreate. A semantic model
    // is a graph of sub-resources; a partial PATCH story is deferred.
    throw new Error(
      "SemanticModelResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, apiName): Promise<void> {
    // DELETE /ssot/semantic/models/{apiName} → 204, cascades to all
    // sub-resources. Idempotent: swallow 404 (already gone).
    //
    // Ordering note: a SemanticModel HARD-BLOCKS deletion of the CIs it
    // references (platform 400 DELETE_FAILED). So it must delete BEFORE its
    // CalculatedInsights — enforced by dependsOn (reverse-topo destroy) and by
    // its slot ahead of CalculatedInsight in PRUNE_TYPE_PRIORITY.
    try {
      await retryOn5xx(() =>
        connectRequest(ctx.session, {
          method: "DELETE",
          path: `${MODELS_PATH}/${apiName}`,
          apiVersion: SEMANTIC_API_VERSION,
        }),
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

interface SemanticModelOpts {
  readonly dependsOn?: readonly Construct[];
}

export class SemanticModel extends Construct {
  readonly resource = SemanticModelResource;
  readonly apiName: string;
  readonly props: SemanticModelResourceProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Stack, id: string, props: SemanticModelProps, opts: SemanticModelOpts = {}) {
    super(scope, id);
    this.apiName = props.apiName ?? id;
    const label = props.label ?? this.apiName;

    const deps: Construct[] = [];
    const referencedDmoNames = new Set<string>();

    const dataObjects: ResolvedDataObject[] = props.dataObjects.map((dob) => {
      const resolvedSource = resolveSource(this.apiName, dob);
      if (resolvedSource.dep && !deps.includes(resolvedSource.dep)) {
        deps.push(resolvedSource.dep);
      }
      if (resolvedSource.dmoFullName) referencedDmoNames.add(resolvedSource.dmoFullName);

      const dimensions = (dob.dimensions ?? []).map(resolveDimension);
      const measures = (dob.measures ?? []).map(resolveMeasure);
      validateMeasures(this.apiName, dob.apiName, dimensions, measures);

      // Normalize omitted/[] to undefined and omit the key entirely so it hashes
      // identically to a pre-filters manifest (no spurious recreate); the wire
      // still emits []. The key is absent (not `filters: undefined`) to satisfy
      // exactOptionalPropertyTypes.
      const filters = normalizeFilters(dob.filters);
      return {
        apiName: dob.apiName,
        label: dob.label ?? dob.apiName,
        dataObjectName: resolvedSource.dataObjectName,
        dataObjectType: resolvedSource.dataObjectType,
        tableType: dob.tableType ?? "Standard",
        shouldIncludeAllFields: dob.shouldIncludeAllFields ?? false,
        dimensions,
        measures,
        ...(filters ? { filters } : {}),
      };
    });

    const relationships: ResolvedRelationship[] = (props.relationships ?? []).map((r) => ({
      apiName: r.apiName,
      label: r.label ?? r.apiName,
      cardinality: r.cardinality,
      isEnabled: r.isEnabled ?? true,
      joinType: r.joinType ?? "Auto",
      leftSemanticDefinitionApiName: r.leftSemanticDefinitionApiName,
      rightSemanticDefinitionApiName: r.rightSemanticDefinitionApiName,
      criteria: r.criteria.map((c) => ({
        joinOperator: c.joinOperator ?? "Equals",
        leftFieldType: c.leftFieldType ?? "TableField",
        leftSemanticFieldApiName: c.leftSemanticFieldApiName,
        rightFieldType: c.rightFieldType ?? "TableField",
        rightSemanticFieldApiName: c.rightSemanticFieldApiName,
      })),
    }));

    const calculatedMeasurements: ResolvedCalcMeasurement[] = (
      props.calculatedMeasurements ?? []
    ).map((cm) => {
      const base: Mutable<ResolvedCalcMeasurement> = {
        apiName: cm.apiName,
        label: cm.label ?? cm.apiName,
        expression: cm.expression,
        dataType: cm.dataType ?? "Number",
        decimalPlace: cm.decimalPlace ?? 2,
        directionality: cm.directionality ?? "Up",
        displayCategory: cm.displayCategory ?? "Continuous",
        semanticDataType: cm.semanticDataType ?? "None",
        sentiment: cm.sentiment ?? "SentimentTypeUpIsGood",
        isVisible: cm.isVisible ?? true,
      };
      const cmFilters = normalizeFilters(cm.filters);
      if (cmFilters) base.filters = cmFilters;
      // Aggregate flavor iff aggregationType is supplied; row-level omits all three.
      if (cm.aggregationType !== undefined) {
        base.aggregationType = cm.aggregationType;
        base.level = cm.level ?? "AggregateFunction";
        base.totalAggregationType = cm.totalAggregationType ?? "Sum";
      }
      return base;
    });

    this.props = {
      apiName: this.apiName,
      label,
      dataSpace: props.dataSpace ?? "default",
      sourceCreation: props.sourceCreation ?? "DataCloud",
      currency: props.currency ?? { useOrgDefault: true },
      queryUnrelatedDataObjects: props.queryUnrelatedDataObjects ?? "Union",
      agentEnabled: props.agentEnabled ?? false,
      dataObjects,
      relationships,
      calculatedMeasurements,
    };

    this.dependsOn = [...deps, ...(props.dependsOn ?? []), ...(opts.dependsOn ?? [])];

    // Reciprocal Mapping wiring (mirrors CalculatedInsight / SearchIndex). A
    // semantic model over a DMO reads that DMO's FACT TABLE, which only
    // materializes after the DLO→DMO Mapping runs — so the model must deploy
    // after the mappings of every DMO it references, not merely after the DMOs.
    // Scan already-built Mapping siblings; the Mapping constructor reciprocates
    // (attachMappingToSemanticModels) for the Mapping-after-model case.
    if (referencedDmoNames.size > 0) {
      for (const sibling of scope.children) {
        if (isMappingForAnyDmo(sibling, referencedDmoNames) && !this.dependsOn.includes(sibling)) {
          (this.dependsOn as Construct[]).push(sibling);
        }
      }
    }
  }
}

interface ResolvedSource {
  readonly dataObjectName: string;
  readonly dataObjectType: SemanticDataObjectType;
  readonly dep?: Construct;
  readonly dmoFullName?: string;
}

/**
 * Resolve a data object's `source` into the wire `dataObjectName` +
 * `dataObjectType`, plus (for a construct source) the dependency to wire and
 * the DMO full name to fact-table-order against. Duck-typed on
 * `resource.type` + `fullName`/`apiName` so cross-realm construct instances
 * (user's `src/` vs the CLI's `dist/`) are recognized — same approach as
 * CalculatedInsight.
 */
function resolveSource(modelApiName: string, dob: SemanticDataObjectProps): ResolvedSource {
  const src = dob.source;
  if (typeof src === "string") {
    if (!dob.dataObjectType) {
      throw new Error(
        `SemanticModel "${modelApiName}" data object "${dob.apiName}": dataObjectType is ` +
          `required when source is a string (use "Cio" for a CI output or "Dmo" for a DMO).`,
      );
    }
    return { dataObjectName: src, dataObjectType: dob.dataObjectType };
  }
  const type = (src as { resource?: { type?: unknown } }).resource?.type;
  if (type === "DMO") {
    const fullName = (src as unknown as { fullName?: string }).fullName ?? "";
    return {
      dataObjectName: fullName,
      dataObjectType: dob.dataObjectType ?? "Dmo",
      dep: src as unknown as Construct,
      dmoFullName: fullName,
    };
  }
  if (type === "CalculatedInsight") {
    const apiName = (src as unknown as { apiName?: string }).apiName ?? "";
    return {
      dataObjectName: apiName,
      dataObjectType: dob.dataObjectType ?? "Cio",
      dep: src as unknown as Construct,
    };
  }
  throw new Error(
    `SemanticModel "${modelApiName}" data object "${dob.apiName}": source must be a DMO ` +
      `construct, a CalculatedInsight construct, or a dataObjectName string.`,
  );
}

/**
 * Normalize an authored filter list: an omitted or empty list resolves to
 * `undefined` so it is dropped from the hash (hashProps drops undefined keys)
 * and the resolved props hash identically to a manifest authored before the
 * `filters` prop existed. A non-empty list passes through verbatim.
 */
function normalizeFilters(
  filters: ReadonlyArray<SemanticFilter> | undefined,
): ReadonlyArray<SemanticFilter> | undefined {
  return filters && filters.length > 0 ? filters : undefined;
}

function resolveDimension(d: SemanticDimension): ResolvedDimension {
  return {
    apiName: d.apiName,
    dataObjectFieldName: d.dataObjectFieldName,
    dataType: d.dataType,
    displayCategory: d.displayCategory ?? "Discrete",
    isPrimaryKey: d.isPrimaryKey ?? false,
    isVisible: d.isVisible ?? true,
    label: d.label ?? d.apiName,
    semanticDataType: d.semanticDataType ?? "None",
    sortOrder: d.sortOrder ?? "Ascending",
    storageDataType: d.storageDataType ?? d.dataType,
  };
}

function resolveMeasure(m: SemanticMeasure): ResolvedMeasure {
  return {
    apiName: m.apiName,
    dataObjectFieldName: m.dataObjectFieldName,
    dataType: m.dataType,
    displayCategory: m.displayCategory ?? "Continuous",
    isPrimaryKey: m.isPrimaryKey ?? false,
    isVisible: m.isVisible ?? true,
    label: m.label ?? m.apiName,
    semanticDataType: m.semanticDataType ?? "None",
    sortOrder: m.sortOrder ?? "Ascending",
    storageDataType: m.storageDataType ?? m.dataType,
    aggregationType: m.aggregationType ?? "UserAgg",
    decimalPlace: m.decimalPlace ?? 2,
    directionality: m.directionality ?? "Up",
    isAggregatable: m.isAggregatable ?? true,
    sentiment: m.sentiment ?? "SentimentTypeUpIsGood",
    shouldTreatNullsAsZeros: m.shouldTreatNullsAsZeros ?? false,
  };
}

/**
 * Fast-fail on two platform constraints that otherwise surface as opaque 400s:
 *  - A measure's display `dataType` of `Percent` is REJECTED (the display enum
 *    is narrower than storage). Model a Percent column as a dimension.
 *  - A `Currency` measure REQUIRES a sibling dimension on the same data object
 *    with `semanticDataType: "RecordCurrency"` (over `cdp_sys_record_currency__c`).
 */
function validateMeasures(
  modelApiName: string,
  dataObjectApiName: string,
  dimensions: ReadonlyArray<ResolvedDimension>,
  measures: ReadonlyArray<ResolvedMeasure>,
): void {
  const where = `SemanticModel "${modelApiName}" data object "${dataObjectApiName}"`;
  for (const m of measures) {
    if (m.dataType === "Percent") {
      throw new Error(
        `${where}: measure "${m.apiName}" has dataType "Percent", which the semantic ` +
          `layer rejects for measures (the display enum is narrower than storage). ` +
          `Model it as a dimension instead, or drop it.`,
      );
    }
  }
  const hasCurrencyMeasure = measures.some((m) => m.dataType === "Currency");
  if (hasCurrencyMeasure) {
    const hasRecordCurrency = dimensions.some((d) => d.semanticDataType === "RecordCurrency");
    if (!hasRecordCurrency) {
      throw new Error(
        `${where}: a Currency measure requires a sibling dimension flagged ` +
          `semanticDataType: "RecordCurrency" over the cdp_sys_record_currency__c field ` +
          `(the platform 400s "missing a record currency field" otherwise). See the ` +
          `Currency note in docs/resources.md.`,
      );
    }
  }
}

/** Full DMO dev names (`…__dlm`) among a dependsOn list. Duck-typed cross-realm. */
function dmoFullNamesOf(deps: readonly Construct[]): Set<string> {
  const names = new Set<string>();
  for (const d of deps) {
    const r = (d as { resource?: { type?: unknown } }).resource;
    if (!r || (r as { type?: string }).type !== "DMO") continue;
    const fullName = (d as { fullName?: unknown }).fullName;
    if (typeof fullName === "string") names.add(fullName);
  }
  return names;
}

/** Is `c` a Mapping whose target DMO is in `dmoNames`? Duck-typed cross-realm. */
function isMappingForAnyDmo(c: Construct, dmoNames: Set<string>): boolean {
  const r = (c as { resource?: { type?: unknown } }).resource;
  if (!r || (r as { type?: string }).type !== "Mapping") return false;
  const targetDmoName = (c as { props?: { targetDmoName?: unknown } }).props?.targetDmoName;
  return typeof targetDmoName === "string" && dmoNames.has(targetDmoName);
}

/**
 * Internal API for the Mapping construct. When a Mapping is constructed, add it
 * as a dependency of any SemanticModel sibling that references (via its
 * dependsOn DMOs) the Mapping's target DMO — so the model deploys after the
 * fact table materializes. Mirrors `attachMappingToCalculatedInsights`.
 */
export function attachMappingToSemanticModels(
  stack: { children: Construct[] },
  mapping: Construct & { props: { targetDmoName: string } },
): void {
  for (const sibling of stack.children) {
    const r = (sibling as { resource?: { type?: unknown } }).resource;
    if (!r || (r as { type?: string }).type !== "SemanticModel") continue;
    const sm = sibling as unknown as { dependsOn: Construct[] };
    if (!dmoFullNamesOf(sm.dependsOn).has(mapping.props.targetDmoName)) continue;
    if (sm.dependsOn.includes(mapping)) continue;
    (sm.dependsOn as Construct[]).push(mapping);
  }
}
