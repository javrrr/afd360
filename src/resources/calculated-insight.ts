import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, isNotFound } from "../client/retry.js";
import type { DMO } from "./dmo.js";

/**
 * Calculated Insight definition type. The only value afd360 v1 wires up is
 * `CALCULATED_METRIC` — the common case for a scheduled SQL computation over
 * one or more DMOs. Streaming and external insights land later.
 */
export type CalculatedInsightDefinitionType =
  | "CALCULATED_METRIC"
  | "EXTERNAL_METRIC"
  | "STREAMING_METRIC";

/**
 * How often the CI is recomputed. `NotScheduled` + `SystemManaged` require
 * no start date. Everything else expects `publishScheduleStartDateTime`.
 */
export type PublishScheduleInterval =
  | "NotScheduled"
  | "SystemManaged"
  | "One"
  | "Six"
  | "Twelve"
  | "TwentyFour"
  | "ExternallyManaged"
  | "Streaming";

export interface CalculatedInsightProps {
  /** Dev name without `__cio`; platform appends on create. Defaults to construct logical id. */
  readonly name?: string;
  /** Display name shown in the UI. Defaults to the dev name. */
  readonly displayName?: string;
  readonly description?: string;
  /** ANSI SQL expression. The only expression-family field on the input contract. */
  readonly expression: string;
  readonly definitionType?: CalculatedInsightDefinitionType;
  readonly dataSpace?: string;
  /**
   * How often to run the CI. Default `Six` (every 6h). For a one-shot CI
   * use `NotScheduled`.
   */
  readonly publishScheduleInterval?: PublishScheduleInterval;
  /**
   * ISO-8601 date-time; must be in the future per the input schema's
   * constraint. Required unless `publishScheduleInterval` is `NotScheduled`
   * or `SystemManaged`. afd360 defaults to now + 1 hour when unspecified.
   */
  readonly publishScheduleStartDateTime?: string;
  /**
   * Explicit dependency list. CIs typically depend on the DMOs referenced in
   * their expression — afd360 can't statically parse SQL to derive them, so
   * the user either lists the DMO constructs here or trusts the ordering
   * within a single `afd360 deploy` run (all DMOs finish before any CI).
   */
  readonly dependsOn?: ReadonlyArray<DMO | Construct>;
}

export interface CalculatedInsightOutput {
  /** Full dev name including __cio (e.g. `my_ci__cio`). */
  readonly apiName: string;
  readonly displayName?: string;
  readonly definitionType?: string;
  readonly dataSpace?: string;
  readonly status?: string;
}

export interface CalculatedInsightResourceProps {
  readonly apiName: string;
  readonly displayName: string;
  readonly description?: string;
  readonly expression: string;
  readonly definitionType: CalculatedInsightDefinitionType;
  readonly dataSpace: string;
  readonly publishScheduleInterval: PublishScheduleInterval;
  readonly publishScheduleStartDateTime?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function fullApiName(base: string): string {
  return base.endsWith("__cio") ? base : `${base}__cio`;
}

function toOutput(raw: {
  apiName?: string;
  displayName?: string;
  definitionType?: string;
  dataSpace?: string;
  calculatedInsightStatus?: string;
}): CalculatedInsightOutput {
  const out: Mutable<CalculatedInsightOutput> = {
    apiName: raw.apiName ?? "",
  };
  if (raw.displayName !== undefined) out.displayName = raw.displayName;
  if (raw.definitionType !== undefined) out.definitionType = raw.definitionType;
  if (raw.dataSpace !== undefined) out.dataSpace = raw.dataSpace;
  if (raw.calculatedInsightStatus !== undefined) out.status = raw.calculatedInsightStatus;
  return out;
}

export const CalculatedInsightResource: Resource<
  CalculatedInsightResourceProps,
  CalculatedInsightOutput
> = {
  type: "CalculatedInsight",
  surface: "connect",

  idOf(out): string {
    return out.apiName;
  },

  async read(ctx, apiName): Promise<CalculatedInsightOutput | null> {
    try {
      const result = await ctx.client.calculatedInsights.get(apiName, { timeout: 60_000 });
      return toOutput(result as never);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<CalculatedInsightOutput | null> {
    const existing = await CalculatedInsightResource.read(ctx, props.apiName);
    if (!existing) return null;
    // Platform CI delete is async — the DELETE returns 204 immediately but
    // the CI sits at status=DELETING for a while. Don't adopt a CI that's
    // on its way out; treat it as gone so the next deploy creates fresh.
    if ((existing.status ?? "").toUpperCase() === "DELETING") return null;
    return existing;
  },

  async create(ctx, props): Promise<CalculatedInsightOutput> {
    const body: Record<string, unknown> = {
      apiName: props.apiName,
      displayName: props.displayName,
      definitionType: props.definitionType,
      dataSpaceName: props.dataSpace,
      expression: props.expression,
      publishScheduleInterval: props.publishScheduleInterval,
    };
    if (props.description !== undefined) body["description"] = props.description;
    if (
      props.publishScheduleStartDateTime !== undefined &&
      props.publishScheduleInterval !== "NotScheduled" &&
      props.publishScheduleInterval !== "SystemManaged"
    ) {
      body["publishScheduleStartDateTime"] = props.publishScheduleStartDateTime;
    }
    // CI create can take >30s server-side (SQL validation + schedule setup).
    // SDK's default 30s timeout aborts mid-flight; the baseline retry then
    // hits the partially-created CI. Bump to 120s per-call.
    const result = await retryOn5xx(() =>
      ctx.client.calculatedInsights.create(
        body as Parameters<Data360Client["calculatedInsights"]["create"]>[0],
        { timeout: 120_000 },
      ),
    );
    return toOutput(result as never);
  },

  async update(_ctx, _id, _props): Promise<CalculatedInsightOutput> {
    // v1 policy — delete-and-recreate on drift (PLAN §9). PATCH is defined
    // in the SDK but we don't wire it up in v1: the schema makes every field
    // optional on PATCH, but the expression + definitionType coupling means
    // partial updates are risky without a richer drift model.
    throw new Error(
      "CalculatedInsightResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, apiName): Promise<void> {
    try {
      await retryOn5xx(() => ctx.client.calculatedInsights.delete(apiName, { timeout: 60_000 }));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async isReady(ctx, output): Promise<boolean> {
    // Platform takes a few seconds (~5-10s typical) to transition from
    // PROCESSING → ACTIVE / FAILED. ACTIVE means the definition is valid
    // and scheduled. FAILED means the SQL couldn't be compiled against the
    // DMO schema. Treat FAILED as a terminal error.
    const fresh = await ctx.client.calculatedInsights.get(output.apiName, { timeout: 60_000 });
    const status = ((fresh as { calculatedInsightStatus?: string }).calculatedInsightStatus ?? "").toUpperCase();
    if (status === "FAILED") {
      const reason = (fresh as { lastCalcInsightStatusErrorCode?: string }).lastCalcInsightStatusErrorCode ?? "";
      throw new Error(
        `CalculatedInsight "${output.apiName}" entered terminal state FAILED` +
          (reason ? ` (${reason})` : "") +
          `. Check the expression against the referenced DMO schema.`,
      );
    }
    return status === "ACTIVE";
  },

  isFailed(output): boolean {
    return (output.status ?? "").toUpperCase() === "FAILED";
  },

  hash(props): string {
    // Include publishScheduleStartDateTime ONLY when it's user-supplied
    // (not defaulted to "an hour from now") — otherwise every synth produces
    // a new hash and idempotency breaks. Construct handles the defaulting;
    // if we see the default sentinel, strip it here.
    // Practical implementation: we hash whatever the construct passes. Users
    // who want idempotent deploys should pin publishScheduleStartDateTime.
    return hashProps(props);
  },
};

interface CalculatedInsightOpts {
  readonly dependsOn?: readonly Construct[];
}

export class CalculatedInsight extends Construct {
  readonly resource = CalculatedInsightResource;
  readonly apiName: string;
  readonly props: CalculatedInsightResourceProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Stack, id: string, props: CalculatedInsightProps, opts: CalculatedInsightOpts = {}) {
    super(scope, id);
    const devName = props.name ?? id;
    this.apiName = fullApiName(devName);
    const interval = props.publishScheduleInterval ?? "Six";
    const needsStart = interval !== "NotScheduled" && interval !== "SystemManaged";
    const resolved: Mutable<CalculatedInsightResourceProps> = {
      apiName: this.apiName,
      displayName: props.displayName ?? devName,
      expression: props.expression,
      definitionType: props.definitionType ?? "CALCULATED_METRIC",
      dataSpace: props.dataSpace ?? "default",
      publishScheduleInterval: interval,
    };
    if (props.description !== undefined) resolved.description = props.description;
    if (needsStart) {
      // User-supplied wins. Otherwise default to +1h (future-dated per schema
      // constraint). Users should pin this for idempotent redeploys — the
      // default drifts every synth and will force recreate on every run.
      resolved.publishScheduleStartDateTime =
        props.publishScheduleStartDateTime ??
        new Date(Date.now() + 60 * 60 * 1000).toISOString();
    }
    this.props = resolved;
    this.dependsOn = [
      ...(props.dependsOn ?? []),
      ...(opts.dependsOn ?? []),
    ];
  }
}
