import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { connectRequest } from "../client/rest.js";
import { retryOn, is5xx, isFactTableNotReady, isNotFound } from "../client/retry.js";
import type { DMO } from "./dmo.js";
import type { DataActionTarget } from "./data-action-target.js";

/**
 * What the action listens to. `DataModelEntity` is a DMO (the common case —
 * new/changed rows on a `__dlm`); `DataGraph` sources from a data graph (which
 * additionally needs `actionsSourceObject`/`Type`/`Path`, not modeled in v1).
 */
export type DataActionSourceType = "DataModelEntity" | "DataGraph";

/** CDC subscription modes the action fires on. */
export type CdcSubscription = "Create" | "Update" | "Delete";

/**
 * One field carried from the source object onto the published event. The
 * platform calls this a "projected field": `fieldApiName` is the source DMO
 * field, `fieldAliasName` is the destination (Platform Event) field name.
 */
export interface DataActionProjectedField {
  /** Source DMO field dev name (e.g. `AccountId__c`). */
  readonly fieldApiName: string;
  /** Destination (Platform Event) field name. Defaults to `fieldApiName`. */
  readonly fieldAliasName?: string;
  /** Source object api name. Defaults to the action's source DMO name. */
  readonly objectApiName?: string;
}

export interface DataActionProps {
  /** Dev name. Defaults to the construct id. */
  readonly name?: string;
  /** UI label (dataActionName). Defaults to the dev name. */
  readonly label?: string;
  /** Data space. Default `default`. */
  readonly dataspace?: string;
  /**
   * Source — either an afd360-managed `DMO` construct (preferred; auto-wires
   * dependsOn + its Mapping) or a DMO referenced by dev name with the `__dlm`
   * suffix (e.g. `AccountInsight__dlm`).
   */
  readonly source: DMO | string;
  /** Source kind. Default `DataModelEntity` (a DMO). */
  readonly sourceType?: DataActionSourceType;
  /** CDC events to fire on. Default `["Create", "Update"]`. */
  readonly subscriptions?: ReadonlyArray<CdcSubscription>;
  /** At least one field to carry onto the event. */
  readonly projectedFields: ReadonlyArray<DataActionProjectedField>;
  /** Optional filter, e.g. `AccountId__c != null`. */
  readonly condition?: string;
  /**
   * Target — either an afd360-managed `DataActionTarget` construct (preferred;
   * auto-wires dependsOn so the target provisions to Active first) or a target
   * referenced by apiName.
   */
  readonly target: DataActionTarget | string;
  readonly dependsOn?: ReadonlyArray<Construct>;
}

export interface DataActionResourceProps {
  readonly developerName: string;
  readonly dataActionName: string;
  readonly dataspace: string;
  readonly sourceName: string;
  readonly sourceType: DataActionSourceType;
  readonly subscriptions: ReadonlyArray<CdcSubscription>;
  readonly projectedFields: ReadonlyArray<Required<DataActionProjectedField>>;
  readonly targetNames: ReadonlyArray<string>;
  readonly actionConditionExpression?: string;
}

export interface DataActionOutput {
  readonly developerName: string;
  readonly dataspace?: string;
  readonly dataActionName?: string;
  /** `Active` | `Processing` | `Error` | `InActive`. */
  readonly status?: string;
  /** `CreateFailed` | `DeleteFailed` | `ProcessingFailed` when status is Error. */
  readonly statusErrorCode?: string;
  readonly targetNames?: ReadonlyArray<string>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * State id for a data action. The read + delete REST surfaces are
 * data-space-scoped (`?dataspace=…`), so the id carries both coordinates:
 * `<dataspace>::<developerName>`.
 */
function makeId(dataspace: string, developerName: string): string {
  return `${dataspace || "default"}::${developerName}`;
}

function parseId(id: string): { dataspace: string; developerName: string } {
  const i = id.indexOf("::");
  if (i === -1) return { dataspace: "default", developerName: id };
  return { dataspace: id.slice(0, i), developerName: id.slice(i + 2) };
}

function toActionOutput(raw: {
  developerName?: string;
  dataSpaceDevName?: string;
  dataActionName?: string;
  masterLabel?: string;
  dataActionStatus?: string;
  lastActionStatusErrorCode?: string;
  dataActionTargets?: string[];
}): DataActionOutput {
  const out: Mutable<DataActionOutput> = { developerName: raw.developerName ?? "" };
  if (raw.dataSpaceDevName !== undefined) out.dataspace = raw.dataSpaceDevName;
  if (raw.dataActionName !== undefined) out.dataActionName = raw.dataActionName;
  else if (raw.masterLabel !== undefined) out.dataActionName = raw.masterLabel;
  if (raw.dataActionStatus !== undefined) out.status = raw.dataActionStatus;
  if (raw.lastActionStatusErrorCode !== undefined) out.statusErrorCode = raw.lastActionStatusErrorCode;
  if (raw.dataActionTargets !== undefined) out.targetNames = raw.dataActionTargets;
  return out;
}

function buildActionBody(p: DataActionResourceProps): unknown {
  // Live-proven shape (v68.0, CORE token). Create needs BOTH the
  // `?dataspace=` query param AND `dataspace` in the body. `sourceType` is
  // "DataModelEntity" for a DMO (NOT "DataModelObject"); `actionsSourceObject`
  // /Type/Path are omitted (they are DataGraph-only). Field mapping lives in
  // `dataActionProjectedFields` on the ACTION (fieldAliasName = the PE field),
  // NOT an ActivationPlatform*AttributeMapping (a different mechanism).
  return {
    dataActionName: p.dataActionName,
    developerName: p.developerName,
    dataspace: p.dataspace,
    ...(p.actionConditionExpression !== undefined
      ? { actionConditionExpression: p.actionConditionExpression }
      : {}),
    dataActionSources: [
      {
        sourceName: p.sourceName,
        sourceType: p.sourceType,
        sourceCdcSubscriptions: p.subscriptions,
      },
    ],
    dataActionProjectedFields: p.projectedFields.map((f) => ({
      objectApiName: f.objectApiName,
      fieldApiName: f.fieldApiName,
      fieldAliasName: f.fieldAliasName,
    })),
    dataActionTargetNames: p.targetNames,
  };
}

async function findByName(
  ctx: Parameters<Resource<DataActionResourceProps, DataActionOutput>["read"]>[0],
  dataspace: string,
  developerName: string,
): Promise<DataActionOutput | null> {
  // The data-actions SDK service exposes list/create but no get-by-name, so
  // read + adopt page the data-space-scoped list and match on developerName.
  for await (const a of ctx.client.dataActions.listAll({ dataspace })) {
    if ((a as { developerName?: string }).developerName === developerName) {
      return toActionOutput(a as never);
    }
  }
  return null;
}

export const DataActionResource: Resource<DataActionResourceProps, DataActionOutput> = {
  type: "DataAction",
  surface: "connect",

  idOf(out): string {
    return makeId(out.dataspace ?? "default", out.developerName);
  },

  async read(ctx, id): Promise<DataActionOutput | null> {
    const { dataspace, developerName } = parseId(id);
    return findByName(ctx, dataspace, developerName);
  },

  async lookupByProps(ctx, props): Promise<DataActionOutput | null> {
    return findByName(ctx, props.dataspace, props.developerName);
  },

  async create(ctx, props): Promise<DataActionOutput> {
    const body = buildActionBody(props) as Parameters<
      Data360Client["dataActions"]["create"]
    >[0];
    // The action references its source DMO's fields — which only exist once the
    // DMO's fact table has materialized (dependsOn orders the Mapping first, but
    // materialization lags the mapping create by up to ~90s). Retry the same
    // fact-table-not-ready / 5xx window SearchIndex + CI retry.
    const created = await retryOn(
      () => ctx.client.dataActions.create(body, { dataspace: props.dataspace }, { timeout: 120_000 }),
      (err) => is5xx(err) || isFactTableNotReady(err),
      { attempts: 6, intervalMs: 15_000, backoff: 1, jitter: 0 },
    );
    const out = toActionOutput(created as never);
    if (out.developerName) {
      // The create receipt may omit dataSpaceDevName — ensure idOf keys the
      // right data space by stamping the authored one when absent.
      return out.dataspace ? out : { ...out, dataspace: props.dataspace };
    }
    const hydrated = await findByName(ctx, props.dataspace, props.developerName);
    if (hydrated) return hydrated;
    return { developerName: props.developerName, dataspace: props.dataspace };
  },

  async update(_ctx, _id, _props): Promise<DataActionOutput> {
    // v1 policy — hash drift triggers delete-and-recreate (PLAN §9).
    throw new Error(
      "DataActionResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, id): Promise<void> {
    const { dataspace, developerName } = parseId(id);
    // The data-actions SDK service has no delete verb, so go through the raw
    // Connect-API seam: DELETE /ssot/data-actions/{developerName}?dataspace=…
    // (same session + api version the SDK create used).
    try {
      await connectRequest(ctx.session, {
        method: "DELETE",
        path: `/ssot/data-actions/${encodeURIComponent(developerName)}?dataspace=${encodeURIComponent(dataspace)}`,
      });
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async isReady(_ctx, output): Promise<boolean> {
    // Active = live. Error is terminal (surface it, don't spin) — on a
    // Data-Cloud-only org the backing Core target fails provisioning async and
    // the action follows it to Error/CreateFailed. Processing/InActive → wait.
    const status = (output.status ?? "").toUpperCase();
    if (status === "ERROR") {
      throw new Error(
        `DataAction "${output.developerName}" entered terminal state ERROR` +
          `${output.statusErrorCode ? ` (${output.statusErrorCode})` : ""}. ` +
          `This usually follows a Core target that could not provision — ` +
          `check the DataActionTarget deployed against a CRM-connected org.`,
      );
    }
    return status === "ACTIVE";
  },

  isFailed(output): boolean {
    return (output.status ?? "").toUpperCase() === "ERROR";
  },

  hash(props): string {
    return hashProps(props);
  },
};

interface DataActionOpts {
  readonly dependsOn?: readonly Construct[];
  readonly readyIntervalMs?: number;
  readonly readyTimeoutMs?: number;
}

export class DataAction extends Construct {
  readonly resource = DataActionResource;
  readonly devName: string;
  readonly props: DataActionResourceProps;
  /** Mutable so a Mapping sibling constructed later can reciprocate (see below). */
  readonly dependsOn: Construct[];
  readonly readyIntervalMs: number;
  readonly readyTimeoutMs: number;

  constructor(scope: Stack, id: string, props: DataActionProps, opts: DataActionOpts = {}) {
    super(scope, id);
    this.devName = props.name ?? id;
    const dataspace = props.dataspace ?? "default";
    const sourceType = props.sourceType ?? "DataModelEntity";
    const sourceName =
      typeof props.source === "string" ? props.source : props.source.fullName;
    if (sourceType === "DataModelEntity" && !sourceName.endsWith("__dlm")) {
      throw new Error(
        `DataAction "${id}": a DataModelEntity source "${sourceName}" must be a ` +
          `full DMO name ending in __dlm.`,
      );
    }
    if (props.projectedFields.length === 0) {
      throw new Error(
        `DataAction "${id}": at least one projected field is required (the ` +
          `field carried onto the published event).`,
      );
    }

    const projectedFields = props.projectedFields.map((f) => ({
      objectApiName: f.objectApiName ?? sourceName,
      fieldApiName: f.fieldApiName,
      fieldAliasName: f.fieldAliasName ?? f.fieldApiName,
    }));
    const targetName =
      typeof props.target === "string" ? props.target : props.target.apiName;

    const resolved: Mutable<DataActionResourceProps> = {
      developerName: this.devName,
      dataActionName: props.label ?? this.devName,
      dataspace,
      sourceName,
      sourceType,
      subscriptions: props.subscriptions ?? ["Create", "Update"],
      projectedFields,
      targetNames: [targetName],
    };
    if (props.condition !== undefined) resolved.actionConditionExpression = props.condition;
    this.props = resolved;

    // Auto-wire dependencies: the target (so it provisions to Active before the
    // action is created — the proven create order is target-first) and the
    // source DMO. Plus any sibling Mapping whose target DMO is our source — the
    // action's projected fields only exist once the DMO is mapped + its fact
    // table materializes. Two-way: this scans already-built Mappings; the
    // Mapping constructor reciprocates via attachMappingToDataActions.
    const autoDeps: Construct[] = [];
    if (typeof props.target !== "string") autoDeps.push(props.target);
    if (typeof props.source !== "string") autoDeps.push(props.source);
    const stackScope = findStack(scope);
    if (stackScope) {
      for (const sibling of stackScope.children) {
        if (
          isMappingForDmo(sibling, sourceName) &&
          !autoDeps.includes(sibling) &&
          !(props.dependsOn ?? []).includes(sibling) &&
          !(opts.dependsOn ?? []).includes(sibling)
        ) {
          autoDeps.push(sibling);
        }
      }
    }
    this.dependsOn = [...autoDeps, ...(props.dependsOn ?? []), ...(opts.dependsOn ?? [])];

    this.readyIntervalMs = opts.readyIntervalMs ?? 10_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 600_000;
  }
}

/**
 * Walk up the scope chain to the owning Stack (identified by `targetOrg`).
 * Duck-typed so it works across the src/dist module-graph boundary.
 */
function findStack(scope: Construct | { children: Construct[] }): { children: Construct[] } | null {
  let cur: unknown = scope;
  while (cur && typeof cur === "object") {
    if ("targetOrg" in cur) return cur as unknown as { children: Construct[] };
    cur = (cur as { scope?: unknown }).scope;
  }
  return null;
}

/** Is `c` a Mapping construct whose target DMO matches `dmoFullName`? */
function isMappingForDmo(c: Construct, dmoFullName: string): boolean {
  const r = (c as { resource?: { type?: unknown } }).resource;
  if (!r || (r as { type?: string }).type !== "Mapping") return false;
  const props = (c as { props?: { targetDmoName?: unknown } }).props;
  return (props?.targetDmoName as string | undefined) === dmoFullName;
}

/**
 * Internal API for the Mapping construct: append `mapping` to any DataAction
 * sibling whose source DMO matches the mapping's target. Called from Mapping's
 * constructor so manifest order between Mapping and DataAction doesn't matter.
 */
export function attachMappingToDataActions(
  stack: { children: Construct[] },
  mapping: Construct & { props: { targetDmoName: string } },
): void {
  for (const sibling of stack.children) {
    const r = (sibling as { resource?: { type?: unknown } }).resource;
    if (!r || (r as { type?: string }).type !== "DataAction") continue;
    const da = sibling as unknown as { props: { sourceName: string }; dependsOn: Construct[] };
    if (da.props.sourceName !== mapping.props.targetDmoName) continue;
    if (da.dependsOn.includes(mapping)) continue;
    (da.dependsOn as Construct[]).push(mapping);
  }
}
