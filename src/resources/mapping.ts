import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource, type ResourceContext } from "../core/construct.js";
import type { Stack, DeployedRef } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, errBodyIncludes, isNotFound } from "../client/retry.js";
import { pollUntil } from "../core/poll.js";
import { DataStream } from "./data-stream.js";
import { DMO } from "./dmo.js";
import { attachMappingToSearchIndexes } from "./search-index.js";
import { attachMappingToRelationships } from "./relationship.js";

/**
 * A DLO-field → DMO-field pair. Platform uses `__c` suffix on both sides.
 *
 * Convention from tdc/provision/dmo-mapping.ts:
 *   - Source DLO field names end in `__c` (platform appends on DLO creation).
 *   - Target DMO field names end in `__c` too (ditto for DMOs).
 * So an "auto-mapping" from a DLO with fields [Id__c, Title__c, …] onto a DMO
 * whose authored field names were [Id, Title, …] lands on [Id__c, Title__c, …]
 * for the target side.
 */
export interface FieldMapping {
  readonly source: string;
  readonly target: string;
}

export interface MappingProps {
  readonly source: DataStream;
  readonly target: DMO;
  readonly fieldMappings: ReadonlyArray<FieldMapping>;
  /** Data space — must match the target DMO's. Defaults to "default". */
  readonly dataSpace?: string;
}

export interface MappingOutput {
  readonly developerName: string;
  readonly sourceEntityDeveloperName: string;
  readonly targetEntityDeveloperName: string;
  readonly dataSpace: string;
}

export interface MappingResourceProps {
  readonly sourceDloName: string;
  readonly targetDmoName: string;
  readonly dataSpace: string;
  readonly fieldMappings: ReadonlyArray<FieldMapping>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function toOutput(
  raw: { developerName?: string; sourceEntityDeveloperName?: string; targetEntityDeveloperName?: string },
  props: MappingResourceProps,
): MappingOutput {
  const out: Mutable<MappingOutput> = {
    developerName: raw.developerName ?? "",
    sourceEntityDeveloperName: raw.sourceEntityDeveloperName ?? props.sourceDloName,
    targetEntityDeveloperName: raw.targetEntityDeveloperName ?? props.targetDmoName,
    dataSpace: props.dataSpace,
  };
  return out;
}

export const MappingResource: Resource<MappingResourceProps, MappingOutput> = {
  type: "Mapping",
  surface: "connect",

  idOf(out): string {
    // Composite id: <dataSpace>::<dmo>::<dlo>::<developerName>. The
    // developerName is platform-assigned on create. The prefix lets read()
    // reconstruct lookup params without hitting a separate get-by-name.
    return `${out.dataSpace}::${out.targetEntityDeveloperName}::${out.sourceEntityDeveloperName}::${out.developerName}`;
  },

  async read(ctx, compositeId): Promise<MappingOutput | null> {
    const parts = compositeId.split("::");
    if (parts.length !== 4) return null;
    const [dataSpace, dmo, dlo, developerName] = parts;
    return lookup(ctx, dmo!, dlo!, dataSpace!, developerName ?? undefined);
  },

  async lookupByProps(ctx, props): Promise<MappingOutput | null> {
    return lookup(ctx, props.targetDmoName, props.sourceDloName, props.dataSpace);
  },

  async create(ctx, props): Promise<MappingOutput> {
    // tdc lesson #4: after a stream creates, its DLO can take 5-60s before
    // it's queryable for mapping. createMappings without this wait yields
    // a 400 with a confusing "source object not found" / similar error.
    // Gate on dataLakeObjects.get() returning fields.
    await waitForDloDiscoverable(ctx, props.sourceDloName);

    const body = {
      sourceEntityDeveloperName: props.sourceDloName,
      targetEntityDeveloperName: props.targetDmoName,
      fieldMapping: props.fieldMappings.map((f) => ({
        sourceFieldDeveloperName: f.source,
        targetFieldDeveloperName: f.target,
      })),
    } as Parameters<Data360Client["dataModelObjects"]["createMappings"]>[0];
    try {
      const result = await retryOn5xx(() =>
        ctx.client.dataModelObjects.createMappings(body, { dataspace: props.dataSpace }),
      );
      return toOutput(result as never, props);
    } catch (err) {
      // Quirk B4 — createMappings throws DUPLICATE_DLO_TO_DMO_MAPPING when a
      // mapping already exists with the same (dlo, dmo, dataSpace). Treat as
      // an idempotent success: look up the existing one and return it.
      if (errBodyIncludes(err, "DUPLICATE_DLO_TO_DMO_MAPPING")) {
        const existing = await lookup(ctx, props.targetDmoName, props.sourceDloName, props.dataSpace);
        if (existing) return existing;
        // If we somehow can't find it after the duplicate error, surface the
        // original error — something genuinely strange is going on.
      }
      throw err;
    }
  },

  async update(_ctx, _id, _props): Promise<MappingOutput> {
    // v1 policy: hash drift → delete-and-recreate (PLAN §9). Field-level
    // PATCH (patchMappingsFieldMappings) is a possible future path.
    throw new Error(
      "MappingResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(_ctx, _compositeId): Promise<void> {
    // Quirk B3 — Mapping cannot be deleted directly; delete the target DMO
    // and let the platform cascade. This resource's delete is a no-op so
    // reverse-topological destroy doesn't fire a redundant API call.
    // The DMO's delete runs after ours in reverse-topo order and handles it.
  },

  hash(props): string {
    // Exclude dataSpace from the hash input? Keep it — changing dataSpace
    // means a genuinely different mapping. But normalize fieldMappings order
    // by source so reordering the array doesn't force a recreate.
    const normalizedFields = [...props.fieldMappings].sort((a, b) =>
      a.source.localeCompare(b.source),
    );
    return hashProps({ ...props, fieldMappings: normalizedFields });
  },
};

/**
 * Poll until `dataLakeObjects.get(name)` returns a DLO with at least one
 * non-system field populated — that's the signal from the platform that
 * the DLO has materialized enough for Mapping to reference it.
 *
 * tdc's lesson: an S3 stream create returns 201 + status=PROCESSING, and
 * the DLO appears in listings quickly, but getting its fields is subject
 * to a lag of 5-60s. Mapping create will fail during that window.
 *
 * Defaults: 5s × 36 = 3 min budget — covers the long tail tdc observed.
 */
async function waitForDloDiscoverable(
  ctx: ResourceContext,
  dloName: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  await pollUntil<true>(
    async () => {
      try {
        const raw = await ctx.client.dataLakeObjects.get(dloName);
        // The SDK sometimes wraps the response in { dataLakeObjects: [...] }
        // (tdc-observed behavior); handle both shapes defensively.
        const dlo =
          (raw as { dataLakeObjects?: Array<unknown> }).dataLakeObjects?.[0] ??
          raw;
        const fields =
          (dlo as { fields?: unknown[]; dataLakeFieldInfoRepresentation?: unknown[] })
            .fields ??
          (dlo as { dataLakeFieldInfoRepresentation?: unknown[] })
            .dataLakeFieldInfoRepresentation ??
          [];
        return fields.length > 0 ? true : null;
      } catch {
        return null;
      }
    },
    { intervalMs: opts.intervalMs ?? 5_000, timeoutMs: opts.timeoutMs ?? 180_000 },
  );
}

async function lookup(
  ctx: { client: Data360Client },
  dmoName: string,
  dloName: string,
  dataSpace: string,
  preferredDeveloperName?: string,
): Promise<MappingOutput | null> {
  try {
    const result = await ctx.client.dataModelObjects.listMappings({
      dmoDeveloperName: dmoName,
      dloDeveloperName: dloName,
      dataspace: dataSpace,
    });
    const mappings = (result as { objectSourceTargetMaps?: Array<{
      developerName?: string;
      sourceEntityDeveloperName?: string;
      targetEntityDeveloperName?: string;
    }> }).objectSourceTargetMaps ?? [];
    const match =
      (preferredDeveloperName &&
        mappings.find((m) => m.developerName === preferredDeveloperName)) ||
      mappings.find(
        (m) =>
          m.sourceEntityDeveloperName === dloName &&
          m.targetEntityDeveloperName === dmoName,
      );
    if (!match) return null;
    return {
      developerName: match.developerName ?? "",
      sourceEntityDeveloperName: match.sourceEntityDeveloperName ?? dloName,
      targetEntityDeveloperName: match.targetEntityDeveloperName ?? dmoName,
      dataSpace,
    };
  } catch (err) {
    // The SDK's ConnectionsService.listMappings override normalizes the
    // "no mappings" 404 into an empty collection, so we shouldn't normally
    // see errors. If we do, treat missing as a clean null and rethrow others.
    if (isNotFound(err)) return null;
    throw err;
  }
}

interface MappingOpts {
  readonly dependsOn?: readonly Construct[];
}

export class Mapping extends Construct {
  readonly resource = MappingResource;
  readonly props: MappingResourceProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Stack, id: string, props: MappingProps, opts: MappingOpts = {}) {
    super(scope, id);
    this.props = {
      sourceDloName: props.source.dlo.name,
      targetDmoName: props.target.fullName,
      dataSpace: props.dataSpace ?? props.target.props.dataSpace,
      fieldMappings: props.fieldMappings,
    };
    // Auto-wire dependencies on both the source DataStream (so the DLO exists)
    // and the target DMO (so its dataSpaceName has materialized per B2).
    this.dependsOn = [
      props.source,
      props.target,
      ...(opts.dependsOn ?? []),
    ];
    // Reciprocal wiring: tell any SearchIndex sibling that targets the same
    // DMO to depend on this Mapping. Without this, SearchIndex can run in
    // parallel with Mapping under topo sort and time out waiting for source
    // data that hasn't been mapped yet. Order-independent: SearchIndex's
    // own constructor scans for already-built Mappings; this scans for
    // already-built SearchIndexes.
    attachMappingToSearchIndexes(scope, this);
    // Same reciprocal wiring for Relationships. The Connect API rejects
    // a `createRelationships` call until both DMOs have at least one
    // ObjectSourceTargetMap (i.e. mapping). Without this hook a Relationship
    // construct that only auto-wires to the DMOs can deploy in parallel
    // with the Mapping, and the platform errors out:
    //   INVALID_INPUT: No ObjectSourceTargetMaps were found for the DMOs in
    //   the relationships. Make sure that the DMOs are mapped.
    // Probed against awt 2026-06-11.
    attachMappingToRelationships(scope, this);
  }

  /**
   * Helper: build field mappings where source and target share the same name
   * (with __c suffix on source). Handy when DLO and DMO fields are aligned.
   */
  static oneToOne(names: readonly string[]): FieldMapping[] {
    return names.map((n) => {
      const src = n.endsWith("__c") ? n : `${n}__c`;
      const tgt = n.endsWith("__c") ? n : `${n}__c`;
      return { source: src, target: tgt };
    });
  }
}

export type { DeployedRef };
