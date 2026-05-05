import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack, DeployedRef } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn, retryOn5xx, errBodyIncludes, is5xx } from "../client/retry.js";
import { Connection } from "./connection.js";
import { ConnectionSchema } from "./connection-schema.js";

/**
 * DLO category. Engagement vs Profile vs Other is a core Data Cloud distinction;
 * it drives downstream DMO mapping semantics. Default "Other" mirrors tdc.
 */
export type DloCategory = "Engagement" | "Profile" | "Other";

/** IngestApi is the only connector type wired up in M4; more land in M5+. */
export type DataStreamConnectorType = "IngestApi";

export interface DataStreamPrimaryKey {
  readonly name: string;
  readonly label?: string;
  /** API type (Text, Number, DateTime, ...). Defaults to Text. */
  readonly dataType?: string;
}

export interface DataStreamProps {
  readonly connection: Connection;
  /** Schema object name the stream ingests. For IngestApi, this is the
   *  ConnectionSchema's name; for other connectors it's e.g. an S3 prefix. */
  readonly sourceObject: string;
  /** Developer name; falls back to the construct logical id. */
  readonly name?: string;
  readonly label?: string;
  readonly category?: DloCategory;
  readonly refreshMode?: "UPSERT" | "REPLACE" | "APPEND";
  /** Data space for the resulting DLO. "default" unless multi-tenant. */
  readonly dataSpace?: string;
  readonly primaryKey: DataStreamPrimaryKey;
}

export interface DataStreamOutput {
  /** recordId = Salesforce id. Preferred for get/patch/delete path params. */
  readonly recordId: string;
  /** API dev name. */
  readonly name: string;
  readonly label?: string;
  readonly status?: string;
  /** Terminal DLO name — downstream Mapping (M5) will target this. */
  readonly dloName?: string;
}

export interface DataStreamResourceProps {
  readonly connectionName: string;
  readonly sourceObject: string;
  readonly name: string;
  readonly label: string;
  readonly category: DloCategory;
  readonly refreshMode: "UPSERT" | "REPLACE" | "APPEND";
  readonly dataSpace: string;
  readonly primaryKey: DataStreamPrimaryKey;
}

function buildIngestApiPayload(p: DataStreamResourceProps): unknown {
  const pk = p.primaryKey;
  return {
    name: p.name,
    label: p.label,
    datasource: p.connectionName,
    datastreamType: "INGESTAPI",
    connectorInfo: {
      connectorType: "IngestApi",
      connectorDetails: {
        name: p.connectionName,
        events: [p.sourceObject],
      },
    },
    dataLakeObjectInfo: {
      label: p.sourceObject,
      // Convention: DLO dev name = <schemaObject>__dll, matching tdc.
      name: `${p.sourceObject}__dll`,
      category: p.category,
      dataspaceInfo: [{ name: p.dataSpace }],
      // Only the PK goes in dataLakeFieldInputRepresentations — the API
      // derives the rest from the ConnectionSchema.
      dataLakeFieldInputRepresentations: [
        {
          name: pk.name,
          label: pk.label ?? pk.name,
          dataType: pk.dataType ?? "Text",
          isPrimaryKey: true,
        },
      ],
    },
    refreshConfig: { refreshMode: p.refreshMode },
  };
}

export const DataStreamResource: Resource<DataStreamResourceProps, DataStreamOutput> = {
  type: "DataStream",
  surface: "connect",

  idOf(out): string {
    return out.recordId;
  },

  async read(ctx, recordIdOrDevName): Promise<DataStreamOutput | null> {
    try {
      const detail = await ctx.client.dataStreams.get(recordIdOrDevName);
      const out: Mutable<DataStreamOutput> = {
        recordId: (detail as { recordId?: string }).recordId ?? recordIdOrDevName,
        name: detail.name ?? recordIdOrDevName,
      };
      if (detail.label !== undefined) out.label = detail.label;
      const status = (detail as { status?: string }).status;
      if (status !== undefined) out.status = status;
      const dloName = detail.dataLakeObjectInfo?.name;
      if (dloName !== undefined) out.dloName = dloName;
      return out;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<DataStreamOutput | null> {
    // Scope by connectionName to keep the list small.
    const result = await ctx.client.dataStreams.list({
      connectionName: props.connectionName,
      batchSize: 200,
    });
    // IngestApi rewrites both name and label on create (authored "C3Stream"
    // becomes "C3Stream_afd360_c3_kb_F6DAB3FB" / "C3Stream-afd360_c3_kb").
    // The stable identifier is the (connection, sourceObject) pair — each
    // source object has exactly one stream per connection. Match on the
    // DLO name derived from sourceObject, since the live list surfaces that.
    const streams = (result as {
      dataStreams?: Array<{
        name?: string;
        recordId?: string;
        label?: string;
        dataLakeObjectInfo?: { name?: string };
      }>;
    }).dataStreams;
    const wantedDlo = `${props.sourceObject}__dll`;
    const match = streams?.find((s) => {
      if (s.dataLakeObjectInfo?.name === wantedDlo) return true;
      // Fallback: exact name match (handles manifests that provide explicit `name`).
      if (s.name === props.name) return true;
      // And label-startsWith handles the auto-suffix pattern for IngestApi.
      if (s.label && s.label.startsWith(props.label)) return true;
      return false;
    });
    if (!match?.recordId || !match.name) return null;
    return DataStreamResource.read(ctx, match.recordId);
  },

  async create(ctx, props): Promise<DataStreamOutput> {
    const body = buildIngestApiPayload(props) as Parameters<
      Data360Client["dataStreams"]["create"]
    >[0];
    // Quirk A1: "Illegal argument" on create is transient — schema
    // provisioning lag. tdc retries 6 × 15s. We preserve 5xx baseline too.
    const shouldRetry = (err: unknown): boolean =>
      errBodyIncludes(err, "Illegal argument") || is5xx(err);
    const result = await retryOn(() => ctx.client.dataStreams.create(body), shouldRetry, {
      attempts: 6,
      intervalMs: 15_000,
      backoff: 1,
      jitter: 0,
    });
    const name = result.name;
    if (!name) {
      throw new Error(
        `dataStreams.create returned a DataStreamRepresentation with no name — cannot key state.`,
      );
    }
    const recordId = (result as { recordId?: string }).recordId ?? name;
    const out: Mutable<DataStreamOutput> = { recordId, name };
    if (result.label !== undefined) out.label = result.label;
    const status = (result as { status?: string }).status;
    if (status !== undefined) out.status = status;
    const dloName = result.dataLakeObjectInfo?.name;
    if (dloName !== undefined) out.dloName = dloName;
    return out;
  },

  async update(_ctx, _id, _props): Promise<DataStreamOutput> {
    // v1 policy — delete-and-recreate on drift (PLAN §9). PATCH is theoretically
    // possible for refreshMode, but not enough of the contract is mutable to
    // be worth wiring up before we have more real manifests to test against.
    throw new Error(
      "DataStream.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, recordId): Promise<void> {
    try {
      // PLAN §9 D2 — prefer cascading the DLO delete; fallback to leaving
      // the DLO behind if the platform rejects it (DLO may be referenced).
      // Real orphan-DLO cleanup lands in M9.
      await retryOn5xx(() =>
        ctx.client.dataStreams.delete(recordId, { shouldDeleteDataLakeObject: true }),
      );
    } catch (err) {
      if (isNotFound(err)) return;
      // If shouldDeleteDataLakeObject=true fails, retry without the cascade.
      await retryOn5xx(() =>
        ctx.client.dataStreams.delete(recordId, { shouldDeleteDataLakeObject: false }),
      );
    }
  },

  async isReady(ctx, output): Promise<boolean> {
    // Quirk A2 revisited (see memory note on DataStream status casing + IngestApi PROCESSING):
    //   - Live API returns UPPERCASE status values ("PROCESSING", "ACTIVE", ...).
    //     SDK types lie (title-case) and tdc's `=== "Active"` check silently never matches.
    //   - For IngestApi streams, `status` sits at PROCESSING until data ingests —
    //     which is out of afd360 v1 scope. The real "provisioned" signal is the
    //     DLO reaching status === ACTIVE. Once the DLO is ACTIVE, downstream
    //     Mapping/SearchIndex can build on top of it.
    //   - ERROR/DELETING are terminal failures — surface immediately.
    const fresh = await ctx.client.dataStreams.get(output.recordId);
    const streamStatus = ((fresh as { status?: string }).status ?? "").toUpperCase();
    const dloStatus = (
      (fresh.dataLakeObjectInfo as { status?: string } | undefined)?.status ?? ""
    ).toUpperCase();
    if (streamStatus === "ERROR" || streamStatus === "DELETING") {
      throw new Error(
        `DataStream "${output.name}" entered terminal state ${streamStatus} during provisioning.`,
      );
    }
    if (streamStatus === "ACTIVE") return true;
    if (streamStatus === "PROCESSING" && dloStatus === "ACTIVE") return true;
    return false;
  },

  hash(props): string {
    // connectionName is resolved at deploy time; exclude it from the hash so a
    // rename of the parent Connection doesn't force a stream recreate (same
    // pattern as ConnectionSchema).
    const { connectionName: _c, ...rest } = props;
    void _c;
    return hashProps(rest);
  },
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (status === 404) return true;
  if (status === 500 && errBodyIncludes(err, "not found")) return true;
  return false;
}

interface DataStreamOpts {
  readonly dependsOn?: readonly Construct[];
  /**
   * Per-resource poll tuning for create-time isReady. Defaults match tdc:
   * 2s interval, 60s total (waitForActive in tdc uses 2s × 30 = 60s).
   */
  readonly readyIntervalMs?: number;
  readonly readyTimeoutMs?: number;
}

export class DataStream extends Construct {
  readonly resource = DataStreamResource;
  readonly devName: string;
  readonly props: DataStreamResourceProps;
  readonly dependsOn: readonly Construct[];
  /**
   * DLO reference for M5 Mapping. The DLO dev name is known at synth time —
   * the platform appends __dll per tdc convention — so downstream Mapping can
   * reference `stream.dlo.name` without needing deploy state.
   */
  readonly dlo: { readonly name: string };
  /** Read by the deploy runner when polling isReady. */
  readonly readyIntervalMs: number;
  readonly readyTimeoutMs: number;

  constructor(scope: Stack, id: string, props: DataStreamProps, opts: DataStreamOpts = {}) {
    super(scope, id);
    this.devName = props.name ?? id;
    const category: DloCategory = props.category ?? "Other";
    const refreshMode = props.refreshMode ?? "UPSERT";
    const dataSpace = props.dataSpace ?? "default";
    this.props = {
      // connectionName gets resolved from state at deploy time; placeholder here.
      connectionName: "",
      sourceObject: props.sourceObject,
      name: this.devName,
      label: props.label ?? this.devName,
      category,
      refreshMode,
      dataSpace,
      primaryKey: props.primaryKey,
    };
    // Auto-wire dependency on the parent Connection (and ConnectionSchema if
    // present) so the deploy runner orders us after both.
    const autoDeps: Construct[] = [props.connection];
    if (props.connection.schema) autoDeps.push(props.connection.schema);
    this.dependsOn = [...autoDeps, ...(opts.dependsOn ?? [])];

    this.dlo = { name: `${props.sourceObject}__dll` };
    this.readyIntervalMs = opts.readyIntervalMs ?? 2_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
  }

  resolveProps(deployed: ReadonlyMap<string, DeployedRef>): DataStreamResourceProps | null {
    // We need the parent Connection's API *name* (datasource). The platform
    // rewrites this on create (IngestApi gets `<label>_<uuid>`), so read it
    // from deployed state — NOT from the construct's authored devName.
    const conn = this.dependsOn.find(
      (d) => (d as { resource?: { type?: string } }).resource?.type === "Connection",
    ) as Connection | undefined;
    if (!conn) {
      throw new Error(
        `DataStream "${this.uniqueId}" has no parent Connection in dependsOn — authoring bug.`,
      );
    }
    const parentRef = deployed.get(conn.uniqueId);
    if (!parentRef) return null;
    return { ...this.props, connectionName: parentRef.apiName };
  }
}
/** Re-exported so userland code can name-check schema types in tests. */
export type { ConnectionSchema };
