import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, isNotFound } from "../client/retry.js";

/**
 * Data Action Target type. A `Core` target publishes to a Salesforce
 * **Platform Event** in a CRM org (the ingest-notify use case); the WebHook /
 * MarketingCloud variants publish to external endpoints. afd360 v1 is built and
 * live-exercised against `Core`; the others pass through the generic `config`
 * escape hatch but are unvalidated.
 *
 * NB: the create payload spells it `Core`, but the platform READ-BACK
 * normalizes it to `CORE` — compare case-insensitively (see `matchesAuthored`).
 */
export type DataActionTargetType =
  | "Core"
  | "WebHook"
  | "Internal_WebHook"
  | "MarketingCloud";

/**
 * Resolved target config block posted under `config`. For a `Core` target this
 * carries `orgId` + `orgLabel` (the CRM org coordinates) and `targetEndpoint`
 * (the Platform Event API name). Open-ended for the non-Core types.
 */
export interface DataActionTargetConfig {
  /** Salesforce org id the Platform Event lives in. */
  readonly orgId?: string;
  /** Admin username / org label for the CRM org connection. */
  readonly orgLabel?: string;
  /**
   * Platform Event API name, e.g. `AccountInsightIngested__e`.
   *
   * GOTCHA (live-verified): the platform SILENTLY DROPS `targetEndpoint` from a
   * Core target's STORED config — a Core target provisions a Salesforce-CRM org
   * connection, and the PE binding is established elsewhere. So it is kept here
   * as authored intent (and IS part of the drift hash), but is NEVER diffed
   * against read-back during adoption — the read-back would always look
   * "drifted". Same create-vs-read asymmetry family as DataStream.connectorType.
   */
  readonly targetEndpoint?: string;
  readonly [key: string]: string | undefined;
}

export interface DataActionTargetProps {
  /** Dev name (apiName). Defaults to the construct id. */
  readonly name?: string;
  /** UI label. Defaults to the dev name. */
  readonly label?: string;
  /** Target type. Default `Core`. */
  readonly type?: DataActionTargetType;
  /** Core target: the CRM org id the Platform Event lives in (`${env.X}` ok). */
  readonly orgId?: string;
  /** Core target: admin username / org label (`${env.X}` ok). */
  readonly orgLabel?: string;
  /** Core target: the Platform Event API name (e.g. `AccountInsightIngested__e`). */
  readonly targetEndpoint?: string;
  /** Extra raw config passthrough for non-Core target types (WebHook etc.). */
  readonly config?: Record<string, string>;
  readonly dependsOn?: ReadonlyArray<Construct>;
}

export interface DataActionTargetResourceProps {
  readonly apiName: string;
  readonly label: string;
  readonly type: DataActionTargetType;
  readonly config: DataActionTargetConfig;
}

export interface DataActionTargetOutput {
  readonly apiName: string;
  readonly label?: string;
  readonly type?: string;
  /** Provisioning status: `Active` | `Processing` | `Error` | `InActive`. */
  readonly status?: string;
  /** `CreateFailed` | `DeleteFailed` | `ProcessingFailed` when status is Error. */
  readonly statusErrorCode?: string;
  readonly config?: Record<string, unknown>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function toTargetOutput(raw: {
  apiName?: string;
  label?: string;
  type?: string;
  status?: string;
  statusErrorCode?: string;
  config?: Record<string, unknown>;
}): DataActionTargetOutput {
  const out: Mutable<DataActionTargetOutput> = { apiName: raw.apiName ?? "" };
  if (raw.label !== undefined) out.label = raw.label;
  if (raw.type !== undefined) out.type = raw.type;
  if (raw.status !== undefined) out.status = raw.status;
  if (raw.statusErrorCode !== undefined) out.statusErrorCode = raw.statusErrorCode;
  if (raw.config !== undefined) out.config = raw.config;
  return out;
}

function buildTargetBody(p: DataActionTargetResourceProps): unknown {
  // Live-proven shape (v68.0, CORE token):
  //   { apiName, label, type:"Core", config:{ orgId, orgLabel, targetEndpoint } }
  // `config` carries only the defined keys — an undefined value posted into
  // config confuses the connector-metadata validator.
  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.config)) {
    if (v !== undefined) config[k] = v;
  }
  return { apiName: p.apiName, label: p.label, type: p.type, config };
}

export const DataActionTargetResource: Resource<
  DataActionTargetResourceProps,
  DataActionTargetOutput
> = {
  type: "DataActionTarget",
  surface: "connect",

  idOf(out): string {
    return out.apiName;
  },

  async read(ctx, apiName): Promise<DataActionTargetOutput | null> {
    try {
      return toTargetOutput(
        (await ctx.client.dataActionTargets.get(apiName)) as never,
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<DataActionTargetOutput | null> {
    try {
      return toTargetOutput(
        (await ctx.client.dataActionTargets.get(props.apiName)) as never,
      );
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async create(ctx, props): Promise<DataActionTargetOutput> {
    const body = buildTargetBody(props) as Parameters<
      Data360Client["dataActionTargets"]["create"]
    >[0];
    // The POST returns 200 immediately but the CORE target then provisions
    // ASYNC (status Processing → Active, or → Error/CreateFailed on an org
    // lacking the Salesforce-CRM / External Client App connection). Readiness
    // is polled via isReady; here we just land the record. Retry transient 5xx.
    const created = await retryOn5xx(() =>
      ctx.client.dataActionTargets.create(body, { timeout: 120_000 }),
    );
    const out = toTargetOutput(created as never);
    if (out.apiName) return out;
    // Thin receipt — hydrate from GET so callers get status for readiness.
    const hydrated = await DataActionTargetResource.read(ctx, props.apiName);
    return hydrated ?? toTargetOutput({ apiName: props.apiName, label: props.label });
  },

  async update(_ctx, _apiName, _props): Promise<DataActionTargetOutput> {
    // v1 policy — hash drift triggers delete-and-recreate (PLAN §9). The
    // connector-metadata config is validated at create; an in-place PATCH of a
    // target an action already references risks a half-rebound endpoint.
    throw new Error(
      "DataActionTargetResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, apiName): Promise<void> {
    try {
      await retryOn5xx(() =>
        ctx.client.dataActionTargets.delete(apiName, { timeout: 120_000 }),
      );
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async isReady(_ctx, output): Promise<boolean> {
    // Status transitions:
    //   null → Processing → Active   (happy path)
    //   null → Processing → Error    (terminal; statusErrorCode=CreateFailed)
    //
    // Compared case-insensitively — the live API has returned both PascalCase
    // ("Active"/"Error", the SDK-typed spelling) and UPPERCASE at different
    // points. Error is TERMINAL and must throw, not spin: a CORE/Platform-Event
    // target can take ~4-5 min to fail provisioning on an org that lacks the
    // Salesforce-CRM / External Client App connection (e.g. a Data-Cloud-only
    // org), and the POST never surfaces that synchronously.
    const status = (output.status ?? "").toUpperCase();
    if (status === "ERROR") {
      throw new Error(
        `DataActionTarget "${output.apiName}" entered terminal state ERROR` +
          `${output.statusErrorCode ? ` (${output.statusErrorCode})` : ""}. ` +
          `A Core / Platform-Event target requires a Salesforce-CRM / External ` +
          `Client App connection in the org — a Data-Cloud-only org cannot ` +
          `provision one. Deploy against a CRM-connected org.`,
      );
    }
    return status === "ACTIVE";
  },

  isFailed(output): boolean {
    return (output.status ?? "").toUpperCase() === "ERROR";
  },

  matchesAuthored(live, props): boolean {
    // Adoption drift check. The target `type` round-trips Core→CORE, so compare
    // case-insensitively. Do NOT diff `targetEndpoint` — the platform silently
    // drops it from stored config, so it would always look drifted. Compare
    // orgId when the live config exposes it; otherwise trust the name match.
    if ((live.type ?? "").toUpperCase() !== props.type.toUpperCase()) return false;
    const liveCfg = (live.config ?? {}) as Record<string, unknown>;
    if (
      props.config.orgId &&
      typeof liveCfg.orgId === "string" &&
      liveCfg.orgId !== props.config.orgId
    ) {
      return false;
    }
    return true;
  },

  hash(props): string {
    return hashProps(props);
  },
};

interface DataActionTargetOpts {
  readonly dependsOn?: readonly Construct[];
  readonly readyIntervalMs?: number;
  readonly readyTimeoutMs?: number;
}

export class DataActionTarget extends Construct {
  readonly resource = DataActionTargetResource;
  readonly devName: string;
  /** apiName the DataAction references via `dataActionTargetNames`. */
  readonly apiName: string;
  readonly props: DataActionTargetResourceProps;
  readonly dependsOn: readonly Construct[];
  readonly readyIntervalMs: number;
  readonly readyTimeoutMs: number;

  constructor(
    scope: Stack,
    id: string,
    props: DataActionTargetProps,
    opts: DataActionTargetOpts = {},
  ) {
    super(scope, id);
    this.devName = props.name ?? id;
    this.apiName = this.devName;
    const type = props.type ?? "Core";

    const config: Mutable<DataActionTargetConfig> = {};
    if (props.orgId !== undefined) config.orgId = props.orgId;
    if (props.orgLabel !== undefined) config.orgLabel = props.orgLabel;
    if (props.targetEndpoint !== undefined) config.targetEndpoint = props.targetEndpoint;
    if (props.config) {
      for (const [k, v] of Object.entries(props.config)) config[k] = v;
    }

    if (type === "Core" && (!config.orgId || !config.orgLabel)) {
      throw new Error(
        `DataActionTarget "${id}": a Core target requires both orgId and orgLabel ` +
          `(the CRM org id + admin username the Platform Event lives in).`,
      );
    }

    this.props = {
      apiName: this.apiName,
      label: props.label ?? this.devName,
      type,
      config,
    };

    this.dependsOn = [...(props.dependsOn ?? []), ...(opts.dependsOn ?? [])];
    // Provisioning is async (~4-5 min to Active, or to Error on a non-CRM org).
    this.readyIntervalMs = opts.readyIntervalMs ?? 10_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 600_000;
  }
}
