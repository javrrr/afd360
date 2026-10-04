import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import {
  retryOn,
  retryOn5xx,
  is5xx,
  isSemanticSourceNotReady,
  isNotFound as baseIsNotFound,
} from "../client/retry.js";
import type { SemanticModelInputRepresentation } from "tableau-semantics-sdk";
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
 * Transport is `tableau-semantics-sdk` (`ctx.semanticsClient.semanticModels`),
 * a generated client over the v65 `/ssot/semantic/models` spec. This replaced
 * the hand-rolled `connectRequest` seam that talked v64. The sub-collection
 * ELEMENT shapes are open objects the SDK does NOT type, so afd360 still owns
 * the exact leaf field names/values below — captured firsthand against a live
 * Data 360 org at v64 (2026-10-01) and re-confirmed live at v65 (2026-10-04;
 * see feedback_semantic-model-viz-api-surface.md).
 *
 * v64→v65 MIGRATION: create collapses the old FIVE ordered sub-resource POSTs
 * (shell → data-objects → relationships → calculated-measurements →
 * calculated-dimensions) into ONE nested body. The five v64 path segments
 * become camelCase array properties on the body: `semanticDataObjects`,
 * `semanticRelationships`, `semanticCalculatedMeasurements`,
 * `semanticCalculatedDimensions`. DELETE tears the whole thing down.
 *
 * CREATE VERB (live-verified v65, 2026-10-04): the create is the COLLECTION POST
 * `semanticModels.create(body)` → POST /ssot/semantic/models → 201 — NOT `put`.
 * `put(apiName, body)` is REPLACE-ONLY: a PUT to a not-yet-existing apiName 404s
 * (SEMANTIC_ENTITY_NOT_EXIST). The collection POST is absent from the published
 * spec, so the SDK hand-authors it. Two shell enums keep their v64 spellings —
 * `sourceCreation: "DataCloud"` and `queryUnrelatedDataObjects: "Union"` — which
 * the live org ACCEPTS; the spec's modeled values (`Manual|Import`,
 * `Allow|Disallow`) are REJECTED (the published spec was inverted; the SDK's
 * exported enum types are live-corrected to match). `dataspace` is a MANDATORY
 * top-level shell field. A semantic-data-object field `apiName` must be
 * space-free (alphanumeric + underscore); a space surfaces as an opaque 500
 * SERVER_INTERNAL_ERROR, so afd360 fast-fails it below (assertApiNameSpaceFree).
 */

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
 * `dataType` is the display enum: `Number`, `Currency`, or `Percentage`. The
 * bare string `Percent` is REJECTED — a natively-Percent column is a valid
 * measure, but its display (and storage) type is spelled `Percentage`, not
 * `Percent`/`Number` (the platform 400s "This Data Type can't be converted …"
 * on `Number` over a Percent column). Live-verified on the v64 rig. For a Cio
 * data object `storageDataType` must equal the field's native type.
 */
export interface SemanticMeasure {
  readonly apiName: string;
  readonly dataObjectFieldName: string;
  readonly dataType: string;
  readonly label?: string;
  readonly storageDataType?: string;
  /**
   * Semantic aggregation type. Default `UserAgg`. Valid values (live-verified
   * v64 / SF Tableau-semantics authoring): `Sum`, `Average`, `Min`, `Max`,
   * `Median`, `Count`, `Count Distinct`, `Stddev`, `Stddevp`, `Var`, `Varp`,
   * `First`, `Last`, `UserAgg`, `None`. NOTE it is `Average`, NOT `Avg` — the
   * server 400s (`Invalid Semantic Aggregation Type: Avg`) on the SQL spelling.
   */
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
   *
   * LIVE (v64): each filter is `{ operator: "In", values: [...] }`
   * (an `In` operator needs ≥2 values) and references a **calculated** field —
   * the server rejects a raw-dimension field ref with "Invalid calculated
   * Field". SDO filters on raw columns are a PERMANENT REST dead end, and
   * `calculatedDimensions` (now a first-class prop) does NOT unlock them: a
   * calc field references an SDO field, so it must be created AFTER its data
   * object — but a data object's `filters` are fixed at the data-object CREATE
   * (no PATCH), so the calc field can never pre-exist the filter that would
   * reference it (circular; logical views, the only other path, are UI-only).
   * Reframe a WHERE as a conditional-aggregation `calculatedMeasurement`.
   */
  readonly filters?: ReadonlyArray<SemanticFilter>;
  /**
   * Boolean combination of the `filters` by 1-based index, e.g. `"1 AND 2"`.
   * Must sit HERE as a sibling of `filters`, NOT inside a filter object — the
   * server 400s "Filter logic is empty" otherwise (live v64).
   * Omit when there are no filters.
   */
  readonly filterLogic?: string;
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
  /**
   * `Auto` (default) — and the ONLY value a base-model relationship accepts.
   * Explicit join types (`Left`/`Inner`) are rejected by the server for model
   * relationships (allowed only inside logical views, which afd360 doesn't yet
   * build), so afd360 fast-fails anything but `Auto`. For LEFT-JOIN semantics
   * (retain unmatched rows), use a conditional-aggregation calculatedMeasurement.
   */
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

/**
 * A derived DIMENSION — a row-level calculated grouping/categorical field
 * (e.g. an `IF [Fact.Amount] > 100000 THEN 'Large' ...` bucketer, or a
 * `[Fact.CloseDate]`-derived month label). Unlike a {@link
 * SemanticCalculatedMeasurementProps}, a dimension is ALWAYS row-level: it
 * carries no `aggregationType`/`level`/`totalAggregationType` (the server
 * fixes `level: "Row"`). Live-confirmed buildable + queryable (v64):
 * `POST .../{model}/calculated-dimensions` → 201, and the
 * field groups a gateway query cleanly.
 *
 * The `expression` references data-object fields in SINGLE brackets —
 * `[Opportunity.Amount]`, `[Opportunity.StageName]` — so the referenced data
 * object must be declared in `dataObjects` (afd360 posts dimensions after the
 * data objects for exactly this reason). NOTE: a calculated dimension is NOT a
 * raw-column SDO-filter enabler — see the `filters` note on
 * {@link SemanticDataObjectProps}.
 */
export interface SemanticCalculatedDimensionProps {
  readonly apiName: string;
  readonly label?: string;
  readonly expression: string;
  /** `Text` (default), `Date`, or `Boolean`. */
  readonly dataType?: string;
  /** `Discrete` (default) — dimensions are categorical. */
  readonly displayCategory?: string;
  readonly semanticDataType?: string;
  readonly sortOrder?: string;
  readonly isVisible?: boolean;
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
  /**
   * Default `false`. Sets `agentEnabled` on the model so an Agentforce agent
   * (Concierge) may query it. NECESSARY BUT NOT SUFFICIENT: enabling the model
   * for agents also requires a manual **Analytics Agent Readiness** step in the
   * Tableau Next / Data Cloud UI that afd360 cannot perform via REST. Treat this
   * flag as "declare the intent"; the UI gate is a deploy-time prerequisite the
   * org admin must satisfy, same shape as the Multiple-Currencies org setting.
   */
  readonly agentEnabled?: boolean;
  readonly dataObjects: ReadonlyArray<SemanticDataObjectProps>;
  readonly relationships?: ReadonlyArray<SemanticRelationshipProps>;
  readonly calculatedMeasurements?: ReadonlyArray<SemanticCalculatedMeasurementProps>;
  readonly calculatedDimensions?: ReadonlyArray<SemanticCalculatedDimensionProps>;
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
  /** Sibling of `filters` (see props). Undefined when none — hash/wire-stable. */
  readonly filterLogic?: string;
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

interface ResolvedCalcDimension {
  readonly apiName: string;
  readonly label: string;
  readonly expression: string;
  readonly dataType: string;
  readonly displayCategory: string;
  readonly semanticDataType: string;
  readonly sortOrder: string;
  readonly isVisible: boolean;
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
  /**
   * Undefined (key absent) when the author supplied none — NOT `[]`. A model
   * with no calculated dimensions must hash IDENTICALLY to one authored before
   * this prop existed (hashProps drops undefined keys), or every pre-existing
   * SemanticModel would drop+recreate on the upgrade deploy (no PATCH for TN
   * constructs → destructive). Same hash-stability contract as `filters`.
   */
  readonly calculatedDimensions?: ReadonlyArray<ResolvedCalcDimension>;
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

function buildShellBody(p: SemanticModelResourceProps): Record<string, unknown> {
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

function buildDataObjectBody(d: ResolvedDataObject): Record<string, unknown> {
  return {
    apiName: d.apiName,
    label: d.label,
    dataObjectName: d.dataObjectName,
    dataObjectType: d.dataObjectType,
    tableType: d.tableType,
    shouldIncludeAllFields: d.shouldIncludeAllFields,
    filters: d.filters ?? [],
    // filterLogic is a SIBLING of filters (server requires it here, not nested).
    // Emitted only when supplied — an empty-filters data object omits it.
    ...(d.filterLogic !== undefined ? { filterLogic: d.filterLogic } : {}),
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

function buildRelationshipBody(r: ResolvedRelationship): Record<string, unknown> {
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

// Live-confirmed shape (v64). A dimension is always
// row-level: `level: "Row"` is fixed and the measurement-only agg fields are
// absent. `filters`/`isOverrideBase`/`overriddenProperties` are platform-fixed
// scaffolding (empty/false), not author-settable — SDO filtering is a dead end
// (see SemanticDataObjectProps.filters), so they are emitted as constants.
function buildCalcDimensionBody(cd: ResolvedCalcDimension): Record<string, unknown> {
  return {
    apiName: cd.apiName,
    label: cd.label,
    expression: cd.expression,
    dataType: cd.dataType,
    displayCategory: cd.displayCategory,
    level: "Row",
    semanticDataType: cd.semanticDataType,
    sortOrder: cd.sortOrder,
    isVisible: cd.isVisible,
    filters: [],
    isOverrideBase: false,
    overriddenProperties: [],
  };
}

/**
 * Assemble the single nested v65 `put` body from the resolved props. The five
 * v64 sub-resource POSTs become camelCase array properties here; the shell
 * fields sit at the top level. Empty collections are OMITTED (not sent as `[]`)
 * so the wire bytes stay minimal and a model with no relationships/calc fields
 * matches the "no sub-resources" intent of the old per-POST loops.
 *
 * The SDK types the ELEMENT shapes as open objects, so the builders return
 * `Record<string, unknown>` and the whole body is asserted to the SDK's
 * `SemanticModelInputRepresentation` — afd360 owns the leaf field truth.
 */
function buildModelBody(p: SemanticModelResourceProps): SemanticModelInputRepresentation {
  const body: Record<string, unknown> = {
    ...buildShellBody(p),
    semanticDataObjects: p.dataObjects.map(buildDataObjectBody),
  };
  if (p.relationships.length > 0) {
    body["semanticRelationships"] = p.relationships.map(buildRelationshipBody);
  }
  if (p.calculatedMeasurements.length > 0) {
    body["semanticCalculatedMeasurements"] = p.calculatedMeasurements.map(buildCalcMeasurementBody);
  }
  if (p.calculatedDimensions && p.calculatedDimensions.length > 0) {
    body["semanticCalculatedDimensions"] = p.calculatedDimensions.map(buildCalcDimensionBody);
  }
  return body as SemanticModelInputRepresentation;
}

export const SemanticModelResource: Resource<SemanticModelResourceProps, SemanticModelOutput> = {
  type: "SemanticModel",
  surface: "connect",

  idOf(out): string {
    return out.apiName;
  },

  async read(ctx, apiName): Promise<SemanticModelOutput | null> {
    try {
      // Retry transient 5xx, exactly as create()/delete() do. The semantic
      // surface intermittently 500s (platform-side races — same family as the
      // Connection-delete transient 500). A bare GET let a transient 500 fall
      // straight through to isNotFound, which treats a 500 with a "not found"-ish
      // body as gone → read() returns null → computeOp sees a state entry with
      // no live match and emits a spurious `create` on re-diff. Retrying first
      // means only a genuinely-absent model (a clean, un-retried 404) resolves
      // to null; a transient blip heals before isNotFound sees it. (The SDK's
      // HttpClient also retries 5xx, but this outer wrap preserves the exact
      // not-null-on-blip guarantee the fix relies on.)
      const raw = await retryOn5xx(() => ctx.semanticsClient.semanticModels.get(apiName));
      return toOutput(raw);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<SemanticModelOutput | null> {
    return SemanticModelResource.read(ctx, props.apiName);
  },

  async create(ctx, props): Promise<SemanticModelOutput> {
    // Single collection POST (v65). The v64 five-step ordered POST sequence
    // (shell → data-objects → relationships → calc-measurements → calc-dimensions)
    // collapses into ONE nested body. The afd360 engine handles idempotency
    // (noop/adopt/recreate) around this; create() always builds fresh, and a
    // recreate deletes the whole model first.
    //
    // create() is the COLLECTION POST (`semanticModels.create`), NOT `put`.
    // Live-verified v65 (2026-10-04): `put(apiName, body)` is REPLACE-ONLY — a
    // PUT to a not-yet-existing apiName 404s (SEMANTIC_ENTITY_NOT_EXIST), it
    // does not create. The create verb is POST /ssot/semantic/models → 201
    // (absent from the published spec; hand-authored in the SDK).
    //
    // No rollback dance: the v64 code made create atomic by hand because a
    // mid-sequence failure stranded a half-built shell that the next deploy could
    // neither re-POST (409 duplicate) nor usefully adopt. A single POST has no
    // partial-sequence to strand — a failed apply leaves nothing to overwrite and
    // the next deploy re-POSTs cleanly.
    //
    // Retry policy: baseline 5xx PLUS the compute-wait (isSemanticSourceNotReady).
    // A model whose data object is a CalculatedInsight 404s SEMANTIC_ENTITY_NOT_EXIST
    // if the CI was JUST created/recreated — the CI is ACTIVE but its output data
    // object isn't queryable until the first compute lands. This bites on a fresh
    // deploy (model after CI) AND on a recreate cascade (CI recreated, then the
    // drained model recreated right after). Ordering (model dependsOn the CI) is
    // enforced but insufficient: ACTIVE ≠ computed. Generous budget — the first CI
    // compute can take minutes (12 × 15s, ×1.5 up to 30s ⇒ ~5 min) — rather than
    // abort the deploy. See isSemanticSourceNotReady for the full note.
    await retryOn(
      () => ctx.semanticsClient.semanticModels.create(buildModelBody(props)),
      (err) => is5xx(err) || isSemanticSourceNotReady(err),
      {
        attempts: 12,
        intervalMs: 15_000,
        backoff: 1.5,
        maxIntervalMs: 30_000,
        onRetry: (err, attempt, total) => {
          if (isSemanticSourceNotReady(err)) {
            process.stderr.write(
              `  waiting for an upstream data object (e.g. a CalculatedInsight) to become ` +
                `queryable before creating SemanticModel "${props.apiName}" (attempt ${attempt}/${total})…\n`,
            );
          }
        },
      },
    );

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
    // DELETE /ssot/semantic/models/{apiName} cascades to all sub-resources
    // (v65 returns 200, not 204 — afd360 doesn't assert the code, only that the
    // call resolves). Idempotent: swallow 404 (already gone).
    //
    // Ordering note: a SemanticModel HARD-BLOCKS deletion of the CIs it
    // references (platform 400 DELETE_FAILED). So it must delete BEFORE its
    // CalculatedInsights — enforced by dependsOn (reverse-topo destroy) and by
    // its slot ahead of CalculatedInsight in PRUNE_TYPE_PRIORITY.
    try {
      await retryOn5xx(() => ctx.semanticsClient.semanticModels.delete(apiName));
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
        ...(dob.filterLogic !== undefined ? { filterLogic: dob.filterLogic } : {}),
      };
    });

    const relationships: ResolvedRelationship[] = (props.relationships ?? []).map((r) => {
      assertModelJoinType(this.apiName, r.apiName, r.joinType);
      return {
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
      };
    });

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
        const cmWhere = `SemanticModel "${this.apiName}" calculated measurement "${cm.apiName}"`;
        assertAggregationType(cmWhere, cm.aggregationType);
        assertAggregationType(cmWhere, cm.totalAggregationType);
        base.aggregationType = cm.aggregationType;
        base.level = cm.level ?? "AggregateFunction";
        base.totalAggregationType = cm.totalAggregationType ?? "Sum";
      }
      return base;
    });

    const calculatedDimensions: ResolvedCalcDimension[] = (props.calculatedDimensions ?? []).map(
      (cd) => ({
        apiName: cd.apiName,
        label: cd.label ?? cd.apiName,
        expression: cd.expression,
        dataType: cd.dataType ?? "Text",
        displayCategory: cd.displayCategory ?? "Discrete",
        semanticDataType: cd.semanticDataType ?? "None",
        sortOrder: cd.sortOrder ?? "None",
        isVisible: cd.isVisible ?? true,
      }),
    );

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
      // Omit the key entirely when empty so the hash is identical to a manifest
      // authored before this prop existed (prevents a destructive recreate of
      // every pre-existing SemanticModel on upgrade). Mirrors `filters`.
      ...(calculatedDimensions.length > 0 ? { calculatedDimensions } : {}),
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
 * A base-model relationship MUST be `joinType: "Auto"`. Explicit join types
 * (`Left`/`Inner`/…) 400 with "Relationship ... in model must have the 'AUTO'
 * join type. Explicit join types are only permitted for relationships within
 * logical views." (live-verified v64). afd360 only builds base-model
 * relationships today, so fast-fail anything else rather than let it reach the
 * server as an opaque 400. Explicit LEFT/INNER semantics need a logical view —
 * not yet an afd360 construct.
 */
function assertModelJoinType(model: string, rel: string, joinType: string | undefined): void {
  if (joinType !== undefined && joinType.toLowerCase() !== "auto") {
    throw new Error(
      `SemanticModel "${model}" relationship "${rel}": joinType "${joinType}" is invalid — a ` +
        `base-model relationship must be "Auto" (the server 400s "must have the 'AUTO' join ` +
        `type"). Explicit join types (Left/Inner) are only allowed inside logical views, which ` +
        `afd360 does not yet build. To retain unmatched rows (a LEFT JOIN), model it as a ` +
        `conditional-aggregation calculatedMeasurement instead.`,
    );
  }
}

/**
 * Catch the common `Avg` mistake before the server does. The semantic layer
 * spells the mean aggregation `Average`; the SQL-style `Avg` 400s with
 * `Invalid Semantic Aggregation Type: Avg` (live-verified v64). This is a
 * targeted alias check, NOT a full allowlist — the valid enum has more members
 * than afd360 has live-confirmed, and gatekeeping the whole space would risk
 * false-rejecting a valid-but-unverified type. `where` locates the offender.
 */
function assertAggregationType(where: string, agg: string | undefined): void {
  if (agg !== undefined && agg.toLowerCase() === "avg") {
    throw new Error(
      `${where}: aggregationType "${agg}" is invalid — the semantic layer spells ` +
        `the mean aggregation "Average" (the SQL spelling "Avg" 400s with ` +
        `"Invalid Semantic Aggregation Type: Avg"). Use "Average".`,
    );
  }
}

/**
 * A semantic field `apiName` must be space-free (alphanumeric + underscore) —
 * display text belongs in `label`. A space surfaces as an opaque 500
 * SERVER_INTERNAL_ERROR on create (a server-side validation leak, NOT a clean
 * 400), so fast-fail it with the fix spelled out. Live-verified v65 (2026-10-04).
 */
function assertApiNameSpaceFree(where: string, kind: string, apiName: string): void {
  if (/\s/.test(apiName)) {
    throw new Error(
      `${where}: ${kind} apiName "${apiName}" contains whitespace — a semantic field ` +
        `apiName must be space-free (alphanumeric + underscore); the server 500s otherwise. ` +
        `Use a space-free apiName (e.g. "${apiName.replace(/\s+/g, "_")}") and put the display ` +
        `text in \`label\`.`,
    );
  }
}

/**
 * Fast-fail on platform constraints that otherwise surface as opaque 4xx/5xx:
 *  - A field `apiName` with whitespace 500s (see assertApiNameSpaceFree).
 *  - A measure's display `dataType` of `Percent` is REJECTED. A natively-Percent
 *    column IS a valid measure — but its type is spelled `Percentage`, not
 *    `Percent`/`Number`. Live-verified v64.
 *  - A `Currency` measure REQUIRES a sibling dimension on the same data object
 *    with `semanticDataType: "RecordCurrency"` (over `cdp_sys_record_currency__c`).
 *  - `aggregationType: "Avg"` → should be `"Average"` (see assertAggregationType).
 */
function validateMeasures(
  modelApiName: string,
  dataObjectApiName: string,
  dimensions: ReadonlyArray<ResolvedDimension>,
  measures: ReadonlyArray<ResolvedMeasure>,
): void {
  const where = `SemanticModel "${modelApiName}" data object "${dataObjectApiName}"`;
  for (const d of dimensions) {
    assertApiNameSpaceFree(where, `dimension "${d.apiName}"`, d.apiName);
  }
  for (const m of measures) {
    assertApiNameSpaceFree(where, `measure "${m.apiName}"`, m.apiName);
    if (m.dataType === "Percent") {
      throw new Error(
        `${where}: measure "${m.apiName}" has dataType "Percent", which the semantic ` +
          `layer rejects. A natively-Percent column IS a valid measure — spell its ` +
          `dataType (and storageDataType) "Percentage", not "Percent" or "Number".`,
      );
    }
    assertAggregationType(`${where} measure "${m.apiName}"`, m.aggregationType);
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
