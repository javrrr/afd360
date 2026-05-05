import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource, type ResourceContext } from "../core/construct.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx } from "../client/retry.js";
import { pollUntil } from "../core/poll.js";

/**
 * Authored shape for an IngestApi schema object. Matches
 * ConnectionSchemaInputRepresentation (schemaType: "IngestApi"). We keep it
 * loose — the SDK's generated type unions are complex and users may want to
 * supply additional shape fields.
 */
export interface ConnectionSchemaProps {
  /** Schema object dev name — if omitted, the construct logical id is used. */
  readonly name?: string;
  readonly label: string;
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly label?: string;
    readonly dataType: string;
  }>;
  /** Escape hatch for any additional fields the API expects. */
  readonly [extra: string]: unknown;
}

export interface ConnectionSchemaOutput {
  readonly connectionId: string;
  readonly schemaName: string;
  readonly availabilityStatus?: string;
}

export interface ConnectionSchemaResourceProps {
  readonly connectionId: string;
  readonly schema: ConnectionSchemaProps;
  readonly schemaName: string;
}

export const ConnectionSchemaResource: Resource<
  ConnectionSchemaResourceProps,
  ConnectionSchemaOutput
> = {
  type: "ConnectionSchema",
  surface: "connect",

  idOf(output): string {
    // Composite id: <connectionId>::<schemaName>. Schema has no standalone id.
    return `${output.connectionId}::${output.schemaName}`;
  },

  async read(ctx, compositeId): Promise<ConnectionSchemaOutput | null> {
    const sep = compositeId.indexOf("::");
    if (sep < 0) return null;
    const connectionId = compositeId.slice(0, sep);
    const schemaName = compositeId.slice(sep + 2);
    return readSchemaByName(ctx, connectionId, schemaName);
  },

  async lookupByProps(ctx, props): Promise<ConnectionSchemaOutput | null> {
    if (!props.connectionId) return null;
    return readSchemaByName(ctx, props.connectionId, props.schemaName);
  },

  async create(ctx, props): Promise<ConnectionSchemaOutput> {
    const { schema, schemaName } = props;
    const body = {
      schemas: [{ ...schema, schemaType: "IngestApi", name: schemaName, label: schema.label }],
    } as Parameters<Data360Client["connections"]["putSchema"]>[1];
    await retryOn5xx(() => ctx.client.connections.putSchema(props.connectionId, body));
    return { connectionId: props.connectionId, schemaName };
  },

  async update(_ctx, _id, _props): Promise<ConnectionSchemaOutput> {
    // Schema is effectively immutable — field additions must go through a new
    // schema object, a re-created DataStream, a re-created Mapping, and any
    // SearchIndex referencing the resulting DMO. `diff` treats hash drift
    // here as a delete-and-recreate with high blast-radius warning (PLAN §9).
    throw new Error(
      "ConnectionSchema.update is not implemented — schema changes are delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, key): Promise<void> {
    // Schema delete isn't exposed by the Connect API directly — the schema
    // goes away when the parent Connection is deleted. No-op here mirrors the
    // Mapping pattern (B3). The composite key is `<connectionId>::<schemaName>`.
    void ctx;
    void key;
  },

  async isReady(ctx, output): Promise<boolean> {
    // Poll listSchema until availabilityStatus === "Available" (tdc pattern).
    const result = await ctx.client.connections.listSchema(output.connectionId);
    const match = result.schemas?.find((s) => s.name === output.schemaName);
    return match?.availabilityStatus === "Available";
  },

  hash(props): string {
    // Don't hash the transient connectionId — it's resolved from state at deploy
    // time and changes between orgs. Hash the schema shape + name only.
    return hashProps({ schema: props.schema, schemaName: props.schemaName });
  },
};

/**
 * Check whether the schema is already registered on the given connection.
 * Used by the deploy runner for idempotency — listSchema always succeeds for
 * IngestApi connections.
 */
export async function readSchemaByName(
  ctx: ResourceContext,
  connectionId: string,
  schemaName: string,
): Promise<ConnectionSchemaOutput | null> {
  const result = await ctx.client.connections.listSchema(connectionId);
  const match = result.schemas?.find((s) => s.name === schemaName);
  if (!match) return null;
  return {
    connectionId,
    schemaName,
    availabilityStatus: match.availabilityStatus,
  };
}

/** Wait until a schema object reaches availabilityStatus === "Available". */
export async function waitForSchemaReady(
  ctx: ResourceContext,
  connectionId: string,
  schemaName: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  await pollUntil<true>(
    async () => {
      const out = await readSchemaByName(ctx, connectionId, schemaName);
      return out?.availabilityStatus === "Available" ? true : null;
    },
    { intervalMs: opts.intervalMs ?? 10_000, timeoutMs: opts.timeoutMs ?? 120_000 },
  );
}

/**
 * Construct. Parented to its owning Connection so its uniqueId reads as
 * `<stack>/<conn-id>/<schema-id>`. Deploy runner treats it as a regular
 * resource; the explicit dependsOn on the Connection ensures correct order.
 */
export class ConnectionSchema extends Construct {
  readonly resource = ConnectionSchemaResource;
  /** Schema dev name — authored `name` or construct logical id. */
  readonly schemaName: string;
  /** Props for the ConnectionSchema resource. `connectionId` is filled in by
   *  the deploy runner from the parent Connection's state entry; the authored
   *  placeholder is an empty string. */
  readonly props: ConnectionSchemaResourceProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Construct, id: string, schemaProps: ConnectionSchemaProps) {
    super(scope, id);
    this.schemaName = schemaProps.name ?? id;
    this.props = { connectionId: "", schema: schemaProps, schemaName: this.schemaName };
    // Depend on the parent Connection so topo sort orders us after it.
    this.dependsOn = [scope];
  }

  resolveProps(deployedIds: ReadonlyMap<string, string>): ConnectionSchemaResourceProps {
    const parentId = deployedIds.get(this.scope.path.join("/"));
    if (!parentId) {
      throw new Error(
        `ConnectionSchema "${this.uniqueId}" cannot resolve parent Connection id — ` +
          `the parent must be deployed first.`,
      );
    }
    return { ...this.props, connectionId: parentId };
  }
}
