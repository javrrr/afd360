import type { VisualizationInputRepresentation } from "tableau-next-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, isNotFound as baseIsNotFound } from "../client/retry.js";
import { connectRequest } from "../client/rest.js";
import type { SemanticModel } from "./semantic-model.js";

/**
 * Tableau-Next **visualization** construct — the chart/table a workbook or an
 * Agentforce surface renders over a {@link SemanticModel}.
 *
 * Transport: the `/tableau/visualizations` CRUD runs through the
 * **tableau-next-sdk** client (`ctx.tableauClient.visualizations`), the generated
 * wrapper over the Tableau Next OpenAPI spec. Only the model-id resolve hits a
 * different surface — `/ssot/semantic/models` (v64) is in neither published spec,
 * so it stays on the raw-REST `connectRequest` seam (see src/client/rest.ts),
 * same seam SemanticModel keeps. The wire contract was captured firsthand against
 * a live org (v67.0, `/tableau/visualizations`, round-trip POST 201 → GET 200 →
 * DELETE 204, 2026-09-30) — see feedback_semantic-model-viz-api-surface.md.
 *
 * Create is a SINGLE POST. We build the body fresh (never round-tripping a GET),
 * so the read-only fields the platform rejects on input — `id`, `createdBy`,
 * `createdDate`, `lastModifiedBy`, `lastModifiedDate`, `permissions`,
 * `sourceVersion`, `url`, `dataSource.url`, `workspace.{label,url}`,
 * `fields.*.id`, `view.{id,name,isOriginal}` — are simply never emitted.
 *
 * Binding: a viz binds to its model via a TOP-LEVEL `dataSource`
 * (`{ type:"SemanticModel", id, name }`), NOT via the workspace (which is a
 * durable container referenced by `{ id?, name }`). `fields` is an OBJECT keyed
 * by slot id (`F2`, `F3`, …), and `objectName`/`fieldName` take the SEMANTIC
 * apiNames (e.g. `WinRatePct`), NOT the DMO/CIO dev names (`WinRatePct__c`).
 *
 * All three originally-guessed shapes are now CONFIRMED against a live v67.0
 * capture (2026-10-01): `dataSource.id` is the model GET's `.id`
 * (2SM record id — resolved + sent; name-only binding remains unverified so we
 * always resolve the id), `visualSpecification.marks.panes` is a SINGLE object
 * (not an array) with a parallel `marks.headers`, and `view` carries a populated
 * viewSpecification scaffold (not `{}`). All remain overridable via
 * `visualSpecification` / `view` raw props so a power user can supply an exact
 * captured body if a future version drifts (the viz surface is v67; we GET the
 * model at v64, so shapes can diverge across versions).
 */

// The `/tableau/visualizations` surface (v67) is handled by the tableau-next-sdk
// client (ctx.tableauClient.visualizations); only the model-id resolve below
// hits the raw-REST seam.
/** Semantic-models surface (v64) — queried once at create to resolve the model's record id. */
const SEMANTIC_API_VERSION = "64.0";
const MODELS_PATH = "/ssot/semantic/models";

export type VizRole = "Dimension" | "Measure";
export type VizAxis = "column" | "row";

/**
 * One field placed on the viz. `objectName`/`fieldName` are the model's SEMANTIC
 * apiNames (not the underlying `__c` columns). The construct assigns the slot id
 * (`F2`, `F3`, …) and routes it to the `column`/`row` axis.
 */
export interface VizField {
  /** Semantic data-object apiName (e.g. `Competitor_Win_Rate`). */
  readonly objectName: string;
  /** Semantic field apiName (e.g. `WinRatePct`) — NOT the `__c` column. */
  readonly fieldName: string;
  readonly role: VizRole;
  readonly axis: VizAxis;
  /** Slot `type` discriminator — the literal `"Field"` (a slot that references a
   * model field). Defaults to `"Field"`; there is no reason to override it today.
   * This is NOT a display dataType — the live v67 body carries no per-field
   * dataType; dimension/measure is expressed via `role` + `displayCategory`. */
  readonly type?: string;
  /** `Discrete` for a dimension (default), `Continuous` for a measure. */
  readonly displayCategory?: string;
  /** Aggregation for a MEASURE slot, e.g. `UserAgg` (default on measures; omitted on dimensions). */
  readonly function?: string;
}

/**
 * The durable workspace container the viz lives in. Pre-existing (afd360 does
 * NOT create or delete it) — reference it by `name` (and optionally `id`).
 */
export interface VisualizationWorkspace {
  readonly id?: string;
  readonly name: string;
}

export interface VisualizationProps {
  /** Viz developer name. Defaults to the construct id. */
  readonly name?: string;
  readonly label?: string;
  /** The model to bind to — a {@link SemanticModel} construct (preferred; wires
   * dependsOn + supplies the apiName) or a raw model apiName string. */
  readonly model: SemanticModel | string;
  readonly workspace: VisualizationWorkspace;
  /** Chart type → `visualSpecification.marks.panes.type`. Default `Bar`. */
  readonly chartType?: string;
  /** Fields placed on the viz; the construct assigns slot ids in array order. */
  readonly fields: ReadonlyArray<VizField>;
  /** Escape hatch: a full `visualSpecification` to emit verbatim instead of the
   * generated one. Use when a captured body is needed. */
  readonly visualSpecification?: Record<string, unknown>;
  /** Escape hatch: a `view` block to emit (minus the read-only id/name/isOriginal). */
  readonly view?: Record<string, unknown>;
  readonly dependsOn?: readonly Construct[];
}

export interface VisualizationOutput {
  /** Server-assigned record id (key prefix `1AK`). */
  readonly id: string;
  readonly name?: string;
  readonly label?: string;
}

// ---- Resolved (defaults applied) shape used for create + hash ----

interface ResolvedField {
  readonly slot: string;
  readonly objectName: string;
  readonly fieldName: string;
  readonly role: VizRole;
  readonly axis: VizAxis;
  readonly type: string;
  readonly displayCategory: string;
  readonly function?: string;
}

export interface VisualizationResourceProps {
  readonly name: string;
  readonly label: string;
  readonly modelApiName: string;
  readonly workspace: VisualizationWorkspace;
  readonly chartType: string;
  readonly fields: ReadonlyArray<ResolvedField>;
  readonly visualSpecification?: Record<string, unknown>;
  readonly view?: Record<string, unknown>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `/tableau/{devName}` GET returns 400 INVALID_INPUT "was not found" on some
 * paths rather than 404 — widen the not-found predicate as SearchIndex does. */
function isNotFound(err: unknown): boolean {
  return (
    baseIsNotFound(err, { extra400Body: "was not found" }) ||
    baseIsNotFound(err, { extra400Body: "does not exist" })
  );
}

function toOutput(raw: { id?: string; name?: string; label?: string }): VisualizationOutput {
  const out: Mutable<VisualizationOutput> = { id: raw.id ?? "" };
  if (raw.name !== undefined) out.name = raw.name;
  if (raw.label !== undefined) out.label = raw.label;
  return out;
}

/** Build the `fields` OBJECT keyed by slot id (`{ F2: {...}, F3: {...} }`). */
function buildFieldsObject(fields: ReadonlyArray<ResolvedField>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const f of fields) {
    const slot: Record<string, unknown> = {
      objectName: f.objectName,
      fieldName: f.fieldName,
      role: f.role,
      type: f.type,
      displayCategory: f.displayCategory,
    };
    if (f.function !== undefined) slot["function"] = f.function;
    obj[f.slot] = slot;
  }
  return obj;
}

/** `marks` scaffold — chart type is `marks.panes.type` (panes is a SINGLE OBJECT,
 * NOT an array), with a parallel `marks.headers` object and an (empty) `fields`.
 * Shape confirmed live (v67.0). */
function buildMarks(chartType: string): Record<string, unknown> {
  return {
    fields: {},
    headers: {
      encodings: [],
      isAutomatic: true,
      stack: { isAutomatic: true, isStacked: false },
      type: "Text",
    },
    panes: {
      encodings: [],
      isAutomatic: false,
      stack: { isAutomatic: true, isStacked: true },
      type: chartType,
    },
  };
}

/** Static (chart-type-agnostic) members of `visualSpecification.style`, captured
 * verbatim from a known-good v67 viz GET. The slot-keyed members
 * (`axis`/`encodings`/`headers.fields`) are layered on in {@link buildStyle}. */
const STYLE_STATIC = {
  fieldLabels: {
    columns: { showDividerLine: false, showLabels: true },
    rows: { showDividerLine: false, showLabels: true },
  },
  fit: "Standard",
  fonts: {
    actionableHeaders: { color: "#0250d9", size: 13 },
    axisTickLabels: { color: "#2e2e2e", size: 13 },
    fieldLabels: { color: "#2e2e2e", size: 13 },
    headers: { color: "#2e2e2e", size: 13 },
    legendLabels: { color: "#2e2e2e", size: 13 },
    markLabels: { color: "#2e2e2e", size: 13 },
    marks: { color: "#2e2e2e", size: 13 },
  },
  lines: {
    axisLine: { color: "#c9c9c9" },
    fieldLabelDividerLine: { color: "#c9c9c9" },
    separatorLine: { color: "#c9c9c9" },
    zeroLine: { color: "#c9c9c9" },
  },
  // `style.marks` — distinct from `visualSpecification.marks`; static, not slot-keyed.
  marks: {
    fields: {},
    headers: {
      color: { color: "" },
      isAutomaticSize: true,
      label: { canOverlapLabels: false, marksToLabel: { type: "All" }, showMarkLabels: false },
      range: { reverse: true },
      size: { isAutomatic: true, type: "Pixel", value: 13 },
    },
    panes: {
      color: { color: "" },
      isAutomaticSize: true,
      isStackingAxisCentered: false,
      label: { canOverlapLabels: false, marksToLabel: { type: "All" }, showMarkLabels: false },
      range: { reverse: true },
      size: { isAutomatic: true, type: "Percentage", value: 75 },
    },
  },
  referenceLines: {},
  shading: { backgroundColor: "#ffffff", banding: { rows: { color: "#e5e5e5" } } },
  showDataPlaceholder: false,
  title: { isVisible: true },
} as const;

/** Static `headers.columns`/`headers.rows` siblings of the slot-keyed `headers.fields`. */
const STYLE_HEADERS_STATIC = {
  columns: { mergeRepeatedCells: true, showIndex: false, sizing: { fieldHeight: {} } },
  rows: { mergeRepeatedCells: true, showIndex: false, sizing: { fieldWidth: {} } },
} as const;

/**
 * `visualSpecification.style` — the member the platform requires a REAL
 * (fully-populated) value for; an empty `style: {}` drew the misleading
 * `"Value required for [...]"` 400 chain (value-gated, not a writability gate).
 * Twelve members total, captured verbatim from a known-good v67 viz
 * (/tmp capture, live-verified 2026-10-03). Three are SLOT-KEYED under a
 * `.fields` map and keyed by SLOT ROLE:
 *   - `axis.fields`      — MEASURE slots (number-format axis, `type:"NumberShort"`)
 *   - `encodings.fields` — MEASURE slots (default number format, `type:"Number"` —
 *                          intentionally different from axis's "NumberShort")
 *   - `headers.fields`   — DIMENSION slots (visibility toggles)
 * The remaining nine members are chart-type-agnostic constants
 * ({@link STYLE_STATIC} + {@link STYLE_HEADERS_STATIC}).
 */
function buildStyle(fields: ReadonlyArray<ResolvedField>): Record<string, unknown> {
  const axisFields: Record<string, unknown> = {};
  const encodingFields: Record<string, unknown> = {};
  const headerFields: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.role === "Measure") {
      axisFields[f.slot] = {
        isVisible: true,
        isZeroLineVisible: true,
        range: { includeZero: true, type: "Auto" },
        scale: {
          format: {
            numberFormatInfo: {
              decimalPlaces: 2,
              displayUnits: "Auto",
              includeThousandSeparator: true,
              negativeValuesFormat: "Auto",
              prefix: "",
              suffix: "",
              type: "NumberShort",
            },
          },
        },
        ticks: { majorTicks: { type: "Auto" }, minorTicks: { type: "Auto" } },
      };
      encodingFields[f.slot] = {
        defaults: {
          format: {
            numberFormatInfo: {
              decimalPlaces: 2,
              displayUnits: "Auto",
              includeThousandSeparator: true,
              negativeValuesFormat: "Auto",
              prefix: "",
              suffix: "",
              type: "Number",
            },
          },
        },
      };
    } else {
      headerFields[f.slot] = { hiddenValues: [], isVisible: true, showMissingValues: false };
    }
  }
  return {
    axis: { fields: axisFields },
    encodings: { fields: encodingFields },
    headers: { ...STYLE_HEADERS_STATIC, fields: headerFields },
    ...STYLE_STATIC,
  };
}

/** Generated `visualSpecification` — all NINE members, required + value-gated at
 * v67 (NOT read-only: omitting it → `"Value required for [visualSpecification]"`,
 * `{}` → `"Value required for [layout]"`, and so on member by member). `columns`
 * are the measure slot ids, `rows` the dimension slot ids (derived from each
 * field's `axis`); `chartType` flows into `marks.panes.type`; `style` carries the
 * real per-measure axis-format value (an empty `{}` is rejected). The remaining
 * members (`layout`/`legends`/`forecasts`/`referenceLines`/`measureValues`) are
 * structural scaffolds. Full 9-member body proven live (201 → dashboard create →
 * re-diff noop → destroy → delete-404, 2026-10-03). Overridden wholesale by
 * `props.visualSpecification`. */
function buildVisualSpecification(p: VisualizationResourceProps): Record<string, unknown> {
  if (p.visualSpecification) return p.visualSpecification;
  const columns = p.fields.filter((f) => f.axis === "column").map((f) => f.slot);
  const rows = p.fields.filter((f) => f.axis === "row").map((f) => f.slot);
  return {
    columns,
    rows,
    marks: buildMarks(p.chartType),
    layout: "Vizql",
    legends: {},
    forecasts: {},
    referenceLines: {},
    measureValues: [],
    style: buildStyle(p.fields),
  };
}

/** Default `view` scaffold — a populated viewSpecification (NOT `{}`); the
 * server-managed `id`/`isOriginal` are never emitted and `name`/`label` are
 * freshly set. Shape confirmed live (v67.0 capture, 2026-10-01).
 * Overridden wholesale by `props.view`. */
function buildView(p: VisualizationResourceProps): Record<string, unknown> {
  if (p.view) return p.view;
  return {
    label: "default",
    name: `${p.name}_default`,
    viewSpecification: {
      filter: { filters: [] },
      sortOrders: { columns: [], fields: {}, rows: [] },
      style: {
        headers: {
          columns: { sizing: { fieldHeight: {} } },
          rows: { sizing: { fieldWidth: {} } },
        },
      },
    },
  };
}

function buildCreateBody(p: VisualizationResourceProps, modelId: string | undefined): unknown {
  const dataSource: Record<string, unknown> = {
    type: "SemanticModel",
    name: p.modelApiName,
  };
  // dataSource.id (the model's record id, key prefix `2SM`) resolved at create.
  // If the model GET didn't surface an id, fall through with name-only — a
  // LIVE-VERIFY branch (the platform may require the id).
  if (modelId) dataSource["id"] = modelId;

  const workspace: Record<string, unknown> = { name: p.workspace.name };
  if (p.workspace.id) workspace["id"] = p.workspace.id;

  return {
    name: p.name,
    label: p.label,
    dataSource,
    workspace,
    fields: buildFieldsObject(p.fields),
    visualSpecification: buildVisualSpecification(p),
    view: buildView(p),
    interactions: [], // required ARRAY, may be empty
  };
}

/** GET the model to resolve its record id for the viz `dataSource.id` binding. */
async function resolveModelId(ctx: ResourceContextShim, modelApiName: string): Promise<string | undefined> {
  try {
    const raw = await connectRequest<{ id?: string }>(ctx.session, {
      method: "GET",
      path: `${MODELS_PATH}/${modelApiName}`,
      apiVersion: SEMANTIC_API_VERSION,
    });
    return raw?.id;
  } catch {
    // Non-fatal: fall back to name-only binding (flagged live-verify).
    return undefined;
  }
}

// Local alias so the helper signature reads clearly without re-importing.
type ResourceContextShim = Parameters<Resource<VisualizationResourceProps, VisualizationOutput>["create"]>[0];

export const VisualizationResource: Resource<VisualizationResourceProps, VisualizationOutput> = {
  type: "Visualization",
  surface: "connect",

  idOf(out): string {
    return out.id;
  },

  async read(ctx, id): Promise<VisualizationOutput | null> {
    try {
      const raw = await ctx.tableauClient.visualizations.get(id);
      return toOutput(raw as never);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<VisualizationOutput | null> {
    // No GET-by-name on this surface; list (paginated) and match on dev name.
    try {
      for await (const v of ctx.tableauClient.visualizations.listAll()) {
        if (v.name === props.name) return toOutput(v as never);
      }
      return null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async create(ctx, props): Promise<VisualizationOutput> {
    const modelId = await resolveModelId(ctx, props.modelApiName);
    // Body is hand-built to the live-verified contract (buildCreateBody); cast
    // through unknown to the generated input type for the typed SDK call.
    const body = buildCreateBody(props, modelId) as unknown as VisualizationInputRepresentation;
    const created = await retryOn5xx(() => ctx.tableauClient.visualizations.create(body));
    return toOutput(created as never);
  },

  async update(_ctx, _id, _props): Promise<VisualizationOutput> {
    // v1 policy (PLAN §9): hash drift → delete-and-recreate. No partial PATCH.
    throw new Error(
      "VisualizationResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, id): Promise<void> {
    try {
      await retryOn5xx(() => ctx.tableauClient.visualizations.delete(id));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  hash(props): string {
    return hashProps(props);
  },
};

interface VisualizationOpts {
  readonly dependsOn?: readonly Construct[];
}

export class Visualization extends Construct {
  readonly resource = VisualizationResource;
  readonly name: string;
  readonly props: VisualizationResourceProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Stack, id: string, props: VisualizationProps, opts: VisualizationOpts = {}) {
    super(scope, id);
    this.name = props.name ?? id;
    const label = props.label ?? this.name;

    const deps: Construct[] = [];
    const modelApiName = resolveModel(this.name, props.model, deps);

    if (props.fields.length === 0) {
      throw new Error(
        `Visualization "${this.name}": at least one field is required (place dimensions/measures on an axis).`,
      );
    }

    // Assign slot ids in author order, starting at F2 (F1 is reserved by the
    // platform — matches the captured body's F2/F3 numbering).
    const fields: ResolvedField[] = props.fields.map((f, i) => ({
      slot: `F${i + 2}`,
      objectName: f.objectName,
      fieldName: f.fieldName,
      role: f.role,
      axis: f.axis,
      // Slot `type` is the structural discriminator "this slot is a field
      // reference" — the literal "Field". (The platform 400s with
      // POST_BODY_PARSE_ERROR on a display dataType like "Text"/"Number"; the
      // live v67 body has no per-field dataType — role + displayCategory carry
      // the dim/measure distinction. Live-verified 2026-10-03.)
      type: f.type ?? "Field",
      displayCategory: f.displayCategory ?? (f.role === "Measure" ? "Continuous" : "Discrete"),
      // A function applies to measures only; default UserAgg, omit for dimensions.
      ...(f.role === "Measure" ? { function: f.function ?? "UserAgg" } : {}),
    }));

    const resolved: Mutable<VisualizationResourceProps> = {
      name: this.name,
      label,
      modelApiName,
      workspace: props.workspace,
      chartType: props.chartType ?? "Bar",
      fields,
    };
    if (props.visualSpecification) resolved.visualSpecification = props.visualSpecification;
    if (props.view) resolved.view = props.view;
    this.props = resolved;

    this.dependsOn = [...deps, ...(props.dependsOn ?? []), ...(opts.dependsOn ?? [])];
  }
}

/**
 * Resolve `model` into the model apiName, wiring the dependency when a
 * SemanticModel construct is passed. Duck-typed on `resource.type` + `apiName`
 * so cross-realm instances (user's `src/` vs the CLI's `dist/`) are recognized
 * — same approach as SemanticModel's `resolveSource`.
 */
function resolveModel(vizName: string, model: SemanticModel | string, deps: Construct[]): string {
  if (typeof model === "string") return model;
  const type = (model as { resource?: { type?: unknown } }).resource?.type;
  if (type === "SemanticModel") {
    deps.push(model as unknown as Construct);
    return (model as unknown as { apiName?: string }).apiName ?? "";
  }
  throw new Error(
    `Visualization "${vizName}": model must be a SemanticModel construct or a model apiName string.`,
  );
}
