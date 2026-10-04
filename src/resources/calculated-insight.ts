import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import {
  retryOn,
  retryOn5xx,
  is5xx,
  isFactTableNotReady,
  isReferencedPreconditionFailure,
  isNotFound,
} from "../client/retry.js";
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
   * Explicit dependency list. CIs depend on the DMOs referenced in their
   * expression — afd360 can't statically parse SQL to derive them, so list
   * the DMO constructs here.
   *
   * IMPORTANT: a CI create validates against the DMOs' **fact tables**, which
   * only materialize after the DLO→DMO **Mapping** has processed data — the
   * DMO merely *existing* is not enough. Listing a DMO construct here therefore
   * also auto-wires a dependency on that DMO's Mapping(s) in the same stack
   * (reciprocal, declaration-order-independent — see
   * `attachMappingToCalculatedInsights`). Without this, a fresh deploy can
   * attempt the CI before any mapping exists and 500 with
   * `ENTITY_SAVE_ERROR "Error getting FactTable …__dlm"`, aborting the deploy.
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
    //
    // Retry policy: baseline 5xx PLUS the fact-table-not-ready 400
    // (isFactTableNotReady). A CI validates against its DMOs' fact tables,
    // which materialize asynchronously after the DLO→DMO Mapping is created.
    // Ordering (CI after Mapping) is already enforced via dependsOn, but the
    // mapping POST returning ≠ the fact table being queryable: there's a lag
    // (~90s live-observed) during which the create 400s with "Error getting
    // FactTable". Rather than abort the deploy, wait it out — generous budget
    // (10 attempts, 15s base, ×1.5 up to 30s ⇒ ~4 min total) covers the
    // materialization long tail. See isFactTableNotReady for the full note.
    const result = await retryOn(
      () =>
        ctx.client.calculatedInsights.create(
          body as Parameters<Data360Client["calculatedInsights"]["create"]>[0],
          { timeout: 120_000 },
        ),
      (err) => is5xx(err) || isFactTableNotReady(err),
      {
        attempts: 10,
        intervalMs: 15_000,
        backoff: 1.5,
        maxIntervalMs: 30_000,
        onRetry: (err, attempt, total) => {
          if (isFactTableNotReady(err)) {
            process.stderr.write(
              `  waiting for DMO fact table to materialize before creating ` +
                `CalculatedInsight "${props.apiName}" (attempt ${attempt}/${total})…\n`,
            );
          }
        },
      },
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
      // Two-layer retry (mirrors DMO.delete — see isReferencedPreconditionFailure).
      // INNER: baseline fast 5xx retry for the opaque transient 500. OUTER: the
      // reference-clear lag on a slower budget (6 × 5s, ×1.5 up to 30s ⇒ ~1 min).
      // On a CI RECREATE cascade the drain deletes the CI's SemanticModel
      // consumer first, but a SemanticModel HARD-BLOCKS deleting the CIs it
      // references and the platform's reference graph clears asynchronously — so
      // this CI delete can still 412 / DELETE_FAILED ("...because of these
      // dependencies") for a few seconds after the model is gone. Correct delete
      // ordering is enforced elsewhere (the recreate drain / reverse-topo
      // destroy); this closes the async gap by waiting for the reference to drop.
      await retryOn(
        () => retryOn5xx(() => ctx.client.calculatedInsights.delete(apiName, { timeout: 60_000 })),
        isReferencedPreconditionFailure,
        {
          attempts: 6,
          intervalMs: 5_000,
          backoff: 1.5,
          maxIntervalMs: 30_000,
          onRetry: (_err, attempt, total) => {
            process.stderr.write(
              `  waiting for references to CalculatedInsight "${apiName}" to clear before ` +
                `delete (attempt ${attempt}/${total})…\n`,
            );
          },
        },
      );
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

    // Reciprocal Mapping wiring (mirrors SearchIndex / Relationship). A CI
    // validates against the DMO FACT TABLES, which only exist after the
    // DLO→DMO Mapping has run — so the CI must deploy AFTER the mappings of
    // every DMO it references, not merely after the DMOs. Scan already-built
    // Mapping siblings whose target DMO is one this CI depends on and add
    // them; the Mapping constructor reciprocates for the Mapping-after-CI
    // case (attachMappingToCalculatedInsights), so declaration order is moot.
    const dmoNames = dmoFullNamesOf(this.dependsOn);
    if (dmoNames.size > 0) {
      for (const sibling of scope.children) {
        if (
          isMappingForAnyDmo(sibling, dmoNames) &&
          !this.dependsOn.includes(sibling)
        ) {
          (this.dependsOn as Construct[]).push(sibling);
        }
      }
    }
  }
}

/**
 * Collect the full DMO dev names (`…__dlm`) among a dependsOn list. Duck-typed
 * (resource.type === "DMO" + a string `fullName`) so cross-realm DMO instances
 * — user's `src/` vs the CLI's `dist/` — are still recognized.
 */
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
 * Internal API for the Mapping construct. When a Mapping is constructed, walk
 * every existing CalculatedInsight sibling and add the Mapping as a dep on any
 * CI that references (via its dependsOn DMOs) the Mapping's target DMO.
 *
 * Why this exists: a CI create validates against the DMO's fact table, which
 * only materializes after the DLO→DMO Mapping has processed data. afd360's
 * CI deps only point at the DMOs, so on a fresh deploy the CI could run in
 * parallel with — or before — its mappings and 500 with
 * `ENTITY_SAVE_ERROR "Error getting FactTable"`, aborting the deploy.
 *
 * Mirrors the SearchIndex / Relationship reciprocal-wiring pattern. See
 * `Mapping`'s constructor for the call site.
 */
export function attachMappingToCalculatedInsights(
  stack: { children: Construct[] },
  mapping: Construct & { props: { targetDmoName: string } },
): void {
  for (const sibling of stack.children) {
    const r = (sibling as { resource?: { type?: unknown } }).resource;
    if (!r || (r as { type?: string }).type !== "CalculatedInsight") continue;
    const ci = sibling as unknown as { dependsOn: Construct[] };
    if (!dmoFullNamesOf(ci.dependsOn).has(mapping.props.targetDmoName)) continue;
    if (ci.dependsOn.includes(mapping)) continue;
    (ci.dependsOn as Construct[]).push(mapping);
  }
}
