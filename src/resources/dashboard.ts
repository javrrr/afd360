import { createHash } from "node:crypto";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, isNotFound as baseIsNotFound } from "../client/retry.js";
import { connectRequest } from "../client/rest.js";
import type { Visualization } from "./visualization.js";

/**
 * Tableau-Next **dashboard** construct — a laid-out page of one or more
 * {@link Visualization} tiles, rendered in a workspace and queried by a Tableau
 * Next workbook or an Agentforce surface.
 *
 * Like SemanticModel and Visualization there is NO data-360-sdk service for this
 * surface, so the resource talks raw Connect REST through `connectRequest` (see
 * src/client/rest.ts). The wire contract was captured firsthand
 * against a live org (v67.0, `/tableau/dashboards`, POST accepted, 2026-10-01).
 *
 * Create is a SINGLE POST. We build the body fresh (never round-tripping a GET),
 * so the read-only fields the platform rejects/ignores on input are simply never
 * emitted: top-level `id`/`createdBy`/`createdDate`/`lastModifiedBy`/
 * `lastModifiedDate`/`url`/`permissions`/`cacheKey`/`sourceVersion`/`status`/
 * `actions`/`customViews`, and the nested server ids (layout id, page id).
 *
 * Binding: each dashboard widget binds a visualization BY NAME ONLY —
 * `widgets.<key>.source = { name: "<vizDevName>" }`. Unlike a viz→model binding
 * there is no id to resolve, and a `source.type` is REJECTED (strip it). The
 * widget-level `type: "visualization"` is a REQUIRED polymorphic discriminator
 * and is kept.
 *
 * Layout: a 48-column grid. A widget is placed twice — once in
 * `layouts[].pages[].widgets[]` (position: column/row/colspan/rowspan, keyed by
 * `name`) and once in the top-level `widgets` OBJECT (binding + parameters, keyed
 * by the same `name`). The page `name` must be a uuid; we derive it
 * DETERMINISTICALLY from the dashboard name so re-synth yields a stable body (and
 * therefore a stable hash → noop idempotency). A random uuid per synth would
 * defeat idempotency; the server accepted a client-supplied uuid in b8's capture.
 */

/** API version the `/tableau/` surface is gated to. v64/v65 → DOWNGRADE_VERSION_ERROR. */
const DASH_API_VERSION = "67.0";
const DASH_PATH = "/tableau/dashboards";

/** Grid defaults from b8's live-accepted capture. */
const DEFAULT_COLUMN_COUNT = 48;
const DEFAULT_MAX_WIDTH = 1200;
const DEFAULT_ROW_HEIGHT = 20;
/** A single full-width tile spans the whole grid, 23 rows tall (captured value). */
const DEFAULT_ROWSPAN = 23;
const DEFAULT_LEGEND_POSITION = "Right";

const DEFAULT_CUSTOM_CONFIG: Record<string, unknown> = {
  queryCacheEnabled: true,
  queryCacheStaleness: "30min",
};
const DEFAULT_LAYOUT_STYLE: Record<string, unknown> = {
  backgroundColor: "#ffffff",
  cellSpacingX: 4,
  cellSpacingY: 4,
  gutterColor: "#f3f3f3",
};
const DEFAULT_WIDGET_STYLE: Record<string, unknown> = {
  backgroundColor: "#ffffff",
  borderColor: "#5c5c5c",
  borderEdges: [],
  borderRadius: 0,
  borderWidth: 1,
};

/**
 * One tile on the dashboard. Binds a visualization (by construct — preferred,
 * wires dependsOn + supplies the dev name — or by raw dev-name string) and places
 * it on the 48-column grid. Position fields default to a vertically-stacked
 * full-width tile, matching the single-widget capture (`0,0,48,23`).
 */
export interface DashboardWidget {
  /** The visualization to render — a {@link Visualization} construct (preferred)
   * or a raw viz dev-name string. Bound by NAME only. */
  readonly visualization: Visualization | string;
  /** Grid column of the tile's top-left corner. Default `0`. */
  readonly column?: number;
  /** Grid row of the tile's top-left corner. Default: stacked below prior tiles. */
  readonly row?: number;
  /** Width in grid columns. Default: the full `columnCount`. */
  readonly colspan?: number;
  /** Height in grid rows. Default `23`. */
  readonly rowspan?: number;
  /** Legend placement, e.g. `Right` (default) | `Bottom` | `None`. */
  readonly legendPosition?: string;
}

export interface DashboardProps {
  /** Dashboard developer name. Defaults to the construct id. */
  readonly name?: string;
  readonly label?: string;
  /** The durable workspace the dashboard lives in — referenced by id or apiName
   * (a plain string, `workspaceIdOrApiName`). Pre-existing; afd360 does NOT
   * create or delete it. */
  readonly workspace: string;
  /** The tiles. At least one is required. */
  readonly widgets: ReadonlyArray<DashboardWidget>;
  /** Grid columns. Default `48`. */
  readonly columnCount?: number;
  /** Max rendered width in px. Default `1200`. */
  readonly maxWidth?: number;
  /** Grid row height in px. Default `20`. */
  readonly rowHeight?: number;
  /** Escape hatch: full `customConfig` block (query cache). Defaults applied if omitted. */
  readonly customConfig?: Record<string, unknown>;
  /** Escape hatch: the layout `style` block. Defaults applied if omitted. */
  readonly layoutStyle?: Record<string, unknown>;
  /** Escape hatch: the top-level `style.widgetStyle` block. Defaults applied if omitted. */
  readonly widgetStyle?: Record<string, unknown>;
  readonly dependsOn?: readonly Construct[];
}

export interface DashboardOutput {
  /** Server-assigned record id. */
  readonly id: string;
  readonly name?: string;
  readonly label?: string;
}

// ---- Resolved (defaults applied) shape used for create + hash ----

interface ResolvedWidget {
  /** Grid+binding key, e.g. `visualization_1`. */
  readonly key: string;
  /** The bound viz dev name. */
  readonly vizName: string;
  readonly column: number;
  readonly row: number;
  readonly colspan: number;
  readonly rowspan: number;
  readonly legendPosition: string;
}

export interface DashboardResourceProps {
  readonly name: string;
  readonly label: string;
  readonly workspace: string;
  readonly widgets: ReadonlyArray<ResolvedWidget>;
  readonly columnCount: number;
  readonly maxWidth: number;
  readonly rowHeight: number;
  readonly customConfig: Record<string, unknown>;
  readonly layoutStyle: Record<string, unknown>;
  readonly widgetStyle: Record<string, unknown>;
  /** Deterministic uuid for the single page `name` (stable across synths). */
  readonly pageName: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** `/tableau/{name}` GET returns 400 INVALID_INPUT "was not found"/"does not
 * exist" on some paths rather than 404 — widen the not-found predicate as
 * Visualization and SearchIndex do. */
function isNotFound(err: unknown): boolean {
  return (
    baseIsNotFound(err, { extra400Body: "was not found" }) ||
    baseIsNotFound(err, { extra400Body: "does not exist" })
  );
}

function toOutput(raw: { id?: string; name?: string; label?: string }): DashboardOutput {
  const out: Mutable<DashboardOutput> = { id: raw.id ?? "" };
  if (raw.name !== undefined) out.name = raw.name;
  if (raw.label !== undefined) out.label = raw.label;
  return out;
}

/**
 * Derive a stable, well-formed uuid from a seed (the dashboard name). sha256 →
 * 8-4-4-4-12 with the version (5) + RFC-4122 variant nibbles set, so the page
 * `name` is a valid uuid AND identical on every synth (idempotent hash). The
 * server accepted a client-supplied uuid in b8's capture.
 */
export function deterministicPageUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; // version 5 (name-based)
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/** Build the POST body fresh from resolved props — read-only server fields never
 * emitted. Exported for unit tests + pre-commit live-body validation. */
export function buildCreateBody(p: DashboardResourceProps): unknown {
  // Each widget is placed twice: a positioned entry in the page's widget list,
  // and a bound entry in the top-level widgets object, linked by `key`.
  const layoutWidgets = p.widgets.map((w) => ({
    name: w.key,
    column: w.column,
    row: w.row,
    colspan: w.colspan,
    rowspan: w.rowspan,
  }));

  const widgetsMap: Record<string, unknown> = {};
  for (const w of p.widgets) {
    widgetsMap[w.key] = {
      name: w.key,
      parameters: {
        legendPosition: w.legendPosition,
        // Accept filters from any widget (none wired yet). Shape from capture.
        receiveFilterSource: { filterMode: "all", widgetIds: [] },
      },
      // Bind the visualization BY NAME ONLY — `source.type` is rejected.
      source: { name: w.vizName },
      // REQUIRED polymorphic discriminator — keep it.
      type: "visualization",
    };
  }

  return {
    name: p.name,
    label: p.label,
    workspaceIdOrApiName: p.workspace,
    customConfig: p.customConfig,
    layouts: [
      {
        columnCount: p.columnCount,
        maxWidth: p.maxWidth,
        name: "default",
        rowHeight: p.rowHeight,
        style: p.layoutStyle,
        pages: [
          {
            label: "Page 1",
            name: p.pageName,
            widgets: layoutWidgets,
          },
        ],
      },
    ],
    style: { widgetStyle: p.widgetStyle },
    widgets: widgetsMap,
  };
}

export const DashboardResource: Resource<DashboardResourceProps, DashboardOutput> = {
  type: "Dashboard",
  surface: "connect",

  idOf(out): string {
    // Prefer the server id; fall back to the dev name (DELETE/GET-by-name work).
    return out.id || out.name || "";
  },

  async read(ctx, id): Promise<DashboardOutput | null> {
    try {
      const raw = await connectRequest<Record<string, unknown>>(ctx.session, {
        method: "GET",
        path: `${DASH_PATH}/${id}`,
        apiVersion: DASH_API_VERSION,
      });
      return toOutput(raw as never);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<DashboardOutput | null> {
    // No GET-by-name filter on the list; list and match on developer name.
    try {
      const raw = await connectRequest<unknown>(ctx.session, {
        method: "GET",
        path: DASH_PATH,
        apiVersion: DASH_API_VERSION,
      });
      // Tolerate both the wrapped shape (`{ dashboards: [...] }`, analog of the
      // viz surface's `visualizations`) and a bare array.
      const list: Array<Record<string, unknown>> = Array.isArray(raw)
        ? (raw as Array<Record<string, unknown>>)
        : ((raw as { dashboards?: Array<Record<string, unknown>> })?.dashboards ?? []);
      const match = list.find((d) => d["name"] === props.name);
      return match ? toOutput(match as never) : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async create(ctx, props): Promise<DashboardOutput> {
    const created = await retryOn5xx(() =>
      connectRequest<Record<string, unknown>>(ctx.session, {
        method: "POST",
        path: DASH_PATH,
        body: buildCreateBody(props),
        apiVersion: DASH_API_VERSION,
      }),
    );
    return toOutput(created as never);
  },

  async update(_ctx, _id, _props): Promise<DashboardOutput> {
    // v1 policy (PLAN §9): hash drift → delete-and-recreate. No partial PATCH.
    throw new Error(
      "DashboardResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, id): Promise<void> {
    try {
      await retryOn5xx(() =>
        connectRequest(ctx.session, {
          method: "DELETE",
          path: `${DASH_PATH}/${id}`,
          apiVersion: DASH_API_VERSION,
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

interface DashboardOpts {
  readonly dependsOn?: readonly Construct[];
}

export class Dashboard extends Construct {
  readonly resource = DashboardResource;
  readonly name: string;
  readonly props: DashboardResourceProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Stack, id: string, props: DashboardProps, opts: DashboardOpts = {}) {
    super(scope, id);
    this.name = props.name ?? id;
    const label = props.label ?? this.name;

    if (!props.workspace) {
      throw new Error(
        `Dashboard "${this.name}": workspace (workspaceIdOrApiName) is required — it is a pre-existing container, not created by afd360.`,
      );
    }
    if (props.widgets.length === 0) {
      throw new Error(`Dashboard "${this.name}": at least one widget is required.`);
    }

    const columnCount = props.columnCount ?? DEFAULT_COLUMN_COUNT;
    const deps: Construct[] = [];

    // Assign widget keys in author order (`visualization_1`, …) and lay tiles
    // out top-to-bottom: a tile with no explicit `row` stacks below the prior
    // one, so N default tiles don't overlap (a single tile → 0,0,48,23).
    let autoRow = 0;
    const widgets: ResolvedWidget[] = props.widgets.map((w, i) => {
      const vizName = resolveViz(this.name, w.visualization, deps);
      const colspan = w.colspan ?? columnCount;
      const rowspan = w.rowspan ?? DEFAULT_ROWSPAN;
      const column = w.column ?? 0;
      const row = w.row ?? autoRow;
      autoRow = row + rowspan;
      return {
        key: `visualization_${i + 1}`,
        vizName,
        column,
        row,
        colspan,
        rowspan,
        legendPosition: w.legendPosition ?? DEFAULT_LEGEND_POSITION,
      };
    });

    this.props = {
      name: this.name,
      label,
      workspace: props.workspace,
      widgets,
      columnCount,
      maxWidth: props.maxWidth ?? DEFAULT_MAX_WIDTH,
      rowHeight: props.rowHeight ?? DEFAULT_ROW_HEIGHT,
      customConfig: props.customConfig ?? DEFAULT_CUSTOM_CONFIG,
      layoutStyle: props.layoutStyle ?? DEFAULT_LAYOUT_STYLE,
      widgetStyle: props.widgetStyle ?? DEFAULT_WIDGET_STYLE,
      pageName: deterministicPageUuid(this.name),
    };

    this.dependsOn = [...deps, ...(props.dependsOn ?? []), ...(opts.dependsOn ?? [])];
  }
}

/**
 * Resolve a widget's `visualization` into the viz dev name, wiring the
 * dependency when a Visualization construct is passed. Duck-typed on
 * `resource.type` + `name` so cross-realm instances (user's `src/` vs the CLI's
 * `dist/`) are recognized — same approach as Visualization's `resolveModel`.
 */
function resolveViz(
  dashName: string,
  viz: Visualization | string,
  deps: Construct[],
): string {
  if (typeof viz === "string") return viz;
  const type = (viz as { resource?: { type?: unknown } }).resource?.type;
  if (type === "Visualization") {
    deps.push(viz as unknown as Construct);
    return (viz as unknown as { name?: string }).name ?? "";
  }
  throw new Error(
    `Dashboard "${dashName}": widget.visualization must be a Visualization construct or a viz dev-name string.`,
  );
}
