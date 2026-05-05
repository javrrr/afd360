import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, errBodyIncludes } from "../client/retry.js";
import { pollUntil } from "../core/poll.js";

/**
 * DMO category. `Other` is the default. The Connect API accepts title-case
 * on create (matches `DataModelObjectInputRepresentation`) but returns
 * UPPERCASE on read ("OTHER"). afd360 normalizes comparisons, not input.
 */
export type DmoCategory = "Other" | "Engagement" | "Profile";

export interface DmoField {
  /** Field dev name without `__c` — platform adds it. */
  readonly name: string;
  readonly label?: string;
  /** Text | Number | DateTime | Date | Url | Email | Boolean. */
  readonly dataType: string;
  readonly isPrimaryKey?: boolean;
}

export interface DmoProps {
  /** DMO dev name WITHOUT `__dlm` suffix — platform appends it on create. */
  readonly name?: string;
  readonly label?: string;
  readonly category?: DmoCategory;
  readonly dataSpace?: string;
  readonly fields: ReadonlyArray<DmoField>;
}

export interface DmoOutput {
  /** Full dev name including __dlm (e.g. NTOProduct__dlm). */
  readonly name: string;
  readonly label?: string;
  readonly category?: string;
  readonly dataSpaceName?: string;
  readonly creationType?: string;
  /**
   * Optional runtime status. Not always populated; DMO readiness is keyed
   * on dataSpaceName being present (quirk B2).
   */
  readonly status?: string;
}

export interface DmoResourceProps {
  readonly name: string;
  readonly label: string;
  readonly category: DmoCategory;
  readonly dataSpace: string;
  readonly fields: ReadonlyArray<DmoField>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function toOutput(raw: {
  name: string;
  label?: string;
  category?: string;
  dataSpaceName?: string;
  creationType?: string;
  status?: string;
}): DmoOutput {
  const out: Mutable<DmoOutput> = { name: raw.name };
  if (raw.label !== undefined) out.label = raw.label;
  if (raw.category !== undefined) out.category = raw.category;
  if (raw.dataSpaceName !== undefined) out.dataSpaceName = raw.dataSpaceName;
  if (raw.creationType !== undefined) out.creationType = raw.creationType;
  if (raw.status !== undefined) out.status = raw.status;
  return out;
}

function isNotFound(err: unknown): boolean {
  // Quirk B1 — PLAN documented a 500 with body "DMO not found"; the live API
  // on jaygentforce (2026-05-05) now returns a clean 404 ITEM_NOT_FOUND.
  // Check both, so we're resilient if the quirk regresses.
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (status === 404) return true;
  if (status === 500 && errBodyIncludes(err, "not found")) return true;
  return false;
}

/** DMO dev-name convention: the platform appends __dlm if the user doesn't. */
function fullDmoName(baseName: string): string {
  return baseName.endsWith("__dlm") ? baseName : `${baseName}__dlm`;
}

export const DmoResource: Resource<DmoResourceProps, DmoOutput> = {
  type: "DMO",
  surface: "connect",

  idOf(out): string {
    // DMOs don't have a Salesforce record id in the output we care about;
    // the dev name IS the key for get/delete. Use it as the idOf return.
    return out.name;
  },

  async read(ctx, fullName): Promise<DmoOutput | null> {
    try {
      const result = await ctx.client.dataModelObjects.get(fullName);
      return toOutput(result as never);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<DmoOutput | null> {
    // DMO has a direct get-by-name endpoint; no need to list-and-filter.
    return DmoResource.read(ctx, fullDmoName(props.name));
  },

  async create(ctx, props): Promise<DmoOutput> {
    // Payload matches tdc/provision/dmo-mapping.ts line 71-82: names without __c
    // on fields, without __dlm on the DMO itself; platform appends both.
    const body = {
      name: props.name,
      label: props.label,
      category: props.category,
      dataSpaceName: props.dataSpace,
      fields: props.fields.map((f) => ({
        name: f.name,
        label: f.label ?? f.name,
        dataType: f.dataType,
        isPrimaryKey: f.isPrimaryKey ?? false,
      })),
    } as Parameters<Data360Client["dataModelObjects"]["create"]>[0];
    const result = await retryOn5xx(() => ctx.client.dataModelObjects.create(body));
    // Response lists the DMO with __dlm suffix; normalize for consistency.
    return toOutput({
      ...(result as object),
      name: fullDmoName((result as { name?: string }).name ?? props.name),
    } as never);
  },

  async update(_ctx, _id, _props): Promise<DmoOutput> {
    // v1 policy (PLAN §9): hash drift → delete-and-recreate. PATCH of DMO
    // field-add has an undocumented shape (quirk B5) we'll tackle in M9.
    throw new Error(
      "DmoResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, fullName): Promise<void> {
    try {
      // Quirk B3: DMO delete cascades to mappings on the platform side.
      // We do NOT delete mappings first — Mapping.delete is a no-op.
      await retryOn5xx(() => ctx.client.dataModelObjects.delete(fullName));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async isReady(ctx, output): Promise<boolean> {
    // Quirk B2 — after create, `get()` may return with incomplete fields.
    // The signal that the DMO is fully materialized (and safe for downstream
    // SearchIndex / Mapping) is `dataSpaceName` being populated.
    const fresh = await DmoResource.read(ctx, output.name);
    return Boolean(fresh?.dataSpaceName);
  },

  matchesAuthored(live, props): boolean {
    // Detect drift when the platform's live DMO category differs from what
    // the manifest authors (e.g. an old Engagement DMO adopted into an Other
    // manifest). Without this, adopt silently stamps the wrong DMO in state
    // and the next Mapping create fails with "Cannot map DLO to DMO" type
    // mismatch.
    //
    // Live category returns UPPERCASE ("ENGAGEMENT") but authored is title-
    // case ("Engagement"). Compare case-insensitively.
    const liveCat = (live.category ?? "").toLowerCase();
    const wantCat = (props.category ?? "").toLowerCase();
    if (liveCat && wantCat && liveCat !== wantCat) return false;
    if (live.dataSpaceName && live.dataSpaceName !== props.dataSpace) return false;
    return true;
  },

  hash(props): string {
    return hashProps(props);
  },
};

interface DmoOpts {
  readonly dependsOn?: readonly Construct[];
  readonly readyIntervalMs?: number;
  readonly readyTimeoutMs?: number;
}

export class DMO extends Construct {
  readonly resource = DmoResource;
  /** Dev name without __dlm suffix (authored value). */
  readonly devName: string;
  /** Full dev name WITH __dlm suffix — downstream Mapping references this. */
  readonly fullName: string;
  readonly props: DmoResourceProps;
  readonly dependsOn: readonly Construct[];
  // tdc polls 12 × 5 s = 60 s; give headroom.
  readonly readyIntervalMs: number;
  readonly readyTimeoutMs: number;

  constructor(scope: Stack, id: string, props: DmoProps, opts: DmoOpts = {}) {
    super(scope, id);
    this.devName = props.name ?? id;
    this.fullName = fullDmoName(this.devName);
    this.props = {
      name: this.devName,
      label: props.label ?? this.devName,
      category: props.category ?? "Other",
      dataSpace: props.dataSpace ?? "default",
      fields: props.fields,
    };
    this.dependsOn = opts.dependsOn ?? [];
    this.readyIntervalMs = opts.readyIntervalMs ?? 5_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 90_000;
  }
}
