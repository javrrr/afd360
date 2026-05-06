import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource, type ResourceContext } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn5xx, isNotFound } from "../client/retry.js";
import {
  ConnectionSchema,
  type ConnectionSchemaProps,
} from "./connection-schema.js";

/**
 * Authoring shape. `connectorType` is passed through to the API verbatim — we
 * do not maintain a casing registry. If the user gets casing wrong the API
 * returns `400 ILLEGAL_QUERY_PARAMETER_VALUE` with a helpful message (per
 * data-360-sdk's ConnectionsService.list JSDoc).
 *
 * `name` is the developer name; if omitted, the construct's logical id is used.
 *
 * `schema` is only meaningful for `IngestApi` connectors. Supplying it
 * materializes a child ConnectionSchema with a dependency edge.
 */
/**
 * Friendly key-value map for connection credentials / parameters.
 * afd360 converts this into the API's `[{paramName, value}, ...]` shape.
 *
 * Example (AwsS3):
 *   credentials: {
 *     authenticationOption: "accessKeyAndSecret",
 *     accessKey:  "${env.AWS_ACCESS_KEY}",
 *     accessSecret: "${env.AWS_ACCESS_SECRET}",
 *   },
 *   parameters: { bucketName: "cdp-data-javier", parentDirectory: "/" },
 */
export type ConnectionParams = Readonly<Record<string, string>>;

export interface ConnectionProps {
  readonly connectorType: string;
  readonly label: string;
  readonly name?: string;
  /**
   * Data connector credentials. Required for "Data Connection" family
   * connectors (AwsS3, Snowflake, Sftp, AzureBlob, Databricks, Gcs, etc.).
   * Not applicable for IngestApi (no credentials), SalesforceDotCom (uses
   * OAuth), SalesforceMarketingCloud (separate flow), or StreamingApp.
   */
  readonly credentials?: ConnectionParams;
  /** Connection parameters (bucketName, parentDirectory, host, etc.). */
  readonly parameters?: ConnectionParams;
  /**
   * Data connection direction. Required for Data Connection family, ignored
   * otherwise. Defaults to "Ingress" — read-into-Data-Cloud. Egress is for
   * activation targets.
   */
  readonly method?: "Ingress" | "Egress";
  /** IngestApi schema registration — ignored for other connector types. */
  readonly schema?: ConnectionSchemaProps;
}

export interface ConnectionOutput {
  /** Salesforce id — used as the path parameter for get/patch/delete. */
  readonly id: string;
  /** Developer name echoed back from the API. */
  readonly name: string;
  readonly label?: string;
  readonly connectorType: string;
  /**
   * Runtime status. Observed values (case-insensitive):
   *   Processing — provisioning / auth handshake running
   *   Active     — healthy
   *   Error      — auth failed or other unrecoverable state
   * Title-case from the Connect API, unlike DataStream which is UPPERCASE.
   */
  readonly status?: string;
}

/**
 * Build the Connect API body. `schema` is stripped (separate resource).
 * Credentials/parameters are converted from the authoring-friendly object
 * shape to the API's `[{paramName, value}, ...]` arrays.
 *
 * IngestApi: body = { connectorType, label, name } only.
 * Data Connection family (AwsS3, Snowflake, Sftp, AzureBlob, …):
 *   body = { connectorType, label, name, method, credentials[], parameters[] }.
 */
function apiPayload(props: ConnectionProps, devName: string): unknown {
  const base: Record<string, unknown> = {
    connectorType: props.connectorType,
    label: props.label,
    name: devName,
  };
  if (props.connectorType === "IngestApi") {
    return base;
  }
  // Data Connection family. `parameters` is omitted entirely when empty
  // (Snowflake's connection create has no connection-level parameters — those
  // live on the DataStream's advancedAttributes — so an empty `[]` may be
  // rejected). `credentials` also omitted-when-empty for symmetry.
  const body: Record<string, unknown> = {
    ...base,
    method: props.method ?? "Ingress",
  };
  const credentials = toParamArray(props.credentials);
  if (credentials.length > 0) body["credentials"] = credentials;
  const parameters = toParamArray(props.parameters);
  if (parameters.length > 0) body["parameters"] = parameters;
  return body;
}

function toParamArray(kv: ConnectionParams | undefined): Array<{ paramName: string; value: string }> {
  if (!kv) return [];
  return Object.entries(kv).map(([paramName, value]) => ({ paramName, value }));
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function toOutput(raw: {
  id: string;
  name: string;
  label?: string;
  connectorType: string;
  status?: string;
}): ConnectionOutput {
  const out: Mutable<ConnectionOutput> = {
    id: raw.id,
    name: raw.name,
    connectorType: raw.connectorType,
  };
  if (raw.label !== undefined) out.label = raw.label;
  if (raw.status !== undefined) out.status = raw.status;
  return out;
}

export const ConnectionResource: Resource<ConnectionProps, ConnectionOutput> = {
  type: "Connection",
  surface: "connect",

  idOf(output): string {
    return output.id;
  },

  async read(ctx, salesforceId): Promise<ConnectionOutput | null> {
    try {
      const result = await ctx.client.connections.get(salesforceId);
      return toOutput(result);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<ConnectionOutput | null> {
    // No by-name GET; list + match on the authored devName.
    const result = await ctx.client.connections.list({
      connectorType: props.connectorType,
      batchSize: 200,
    });
    const devName = props.name;
    const connections = result.connections ?? [];
    // Exact name match first. Handles AwsS3 / Snowflake / Databricks where
    // the platform preserves the authored name verbatim.
    let match = devName
      ? connections.find((c) => c.name === devName)
      : connections.find((c) => c.label === props.label);
    // IngestApi quirk: the platform rewrites the Connection's `name` to
    // `<label-underscored>_<uuid>` on create (see memory note
    // feedback_ingestapi-name-auto-suffix.md). So an exact-name lookup never
    // finds a freshly created IngestApi Connection on second deploy. Fall
    // back to matching on `label` — stable across the rewrite.
    if (!match && props.connectorType === "IngestApi" && props.label) {
      match = connections.find((c) => c.label === props.label);
    }
    if (!match) return null;
    return toOutput(match);
  },

  isFailed(output): boolean {
    // Case-insensitive to match the title-case observed for Connection
    // (vs UPPERCASE for DataStream). "Error" means auth failed or the
    // platform gave up — no API-side recovery exists, so force a recreate.
    return (output.status ?? "").toLowerCase() === "error";
  },

  matchesAuthored(live, props): boolean {
    // Only compare connectorType — changing a connection's connectorType is
    // a fundamentally different resource. Credentials and parameters are
    // masked on GET so we can't compare them; drift there can only be
    // caught via state-hash on subsequent deploys.
    return live.connectorType === props.connectorType;
  },

  async create(ctx, props): Promise<ConnectionOutput> {
    if (!props.name) {
      throw new Error(
        "ConnectionResource.create requires props.name — the Connection construct " +
          "normalizes this to the logical id if absent, so a missing value indicates " +
          "the resource was invoked outside the normal construct path.",
      );
    }
    const body = apiPayload(props, props.name) as Parameters<
      Data360Client["connections"]["create"]
    >[0];
    const result = await retryOn5xx(() => ctx.client.connections.create(body));
    return {
      id: result.id,
      name: result.name,
      label: result.label,
      connectorType: result.connectorType,
    };
  },

  async update(_ctx, _id, _props): Promise<ConnectionOutput> {
    // v1 policy: delete-and-recreate on hash drift. PATCH only supports
    // SalesforceMarketingCloud and StreamingApp per the OpenAPI spec, and
    // neither matches the RAG pipeline we need for C6. (PLAN §9 —
    // "v1 update policy = delete-and-recreate".)
    throw new Error(
      "Connection.update is not implemented in v1 — hash drift triggers " +
        "delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, salesforceId): Promise<void> {
    try {
      await retryOn5xx(() => ctx.client.connections.delete(salesforceId));
    } catch (err) {
      // Quirks B1 / D1 — treat "already gone" as success during destroy.
      if (isNotFound(err)) return;
      throw err;
    }
  },

  hash(props): string {
    // Schema is a separate resource, so exclude it from the Connection's hash.
    // Otherwise changing schema fields would also re-create the Connection.
    const { schema: _schema, ...rest } = props;
    void _schema;
    return hashProps(rest);
  },
};


interface ConnectionOpts {
  readonly dependsOn?: readonly Construct[];
}

export class Connection extends Construct {
  readonly resource = ConnectionResource;
  readonly props: ConnectionProps;
  readonly dependsOn: readonly Construct[];
  /** API dev name = authored `name` OR the construct's logical id. */
  readonly devName: string;
  /** Child ConnectionSchema construct, if the connector is IngestApi + schema is supplied. */
  readonly schema?: ConnectionSchema;

  constructor(scope: Stack, id: string, props: ConnectionProps, opts: ConnectionOpts = {}) {
    super(scope, id);
    this.devName = props.name ?? id;
    // Normalize — store the resolved devName in props so downstream consumers
    // (ConnectionResource.create, hashing, synth output) never see an undefined
    // `name`. Evidence: early C3-S3 deploys sent `name: ""` to the Connect API
    // and got `ILLEGAL_QUERY_PARAMETER_VALUE dataConnection.developerName cannot
    // be empty` because the authored name fell back to an empty string.
    this.props = { ...props, name: this.devName };
    this.dependsOn = opts.dependsOn ?? [];

    if (props.schema) {
      if (props.connectorType !== "IngestApi") {
        throw new Error(
          `Connection "${id}": schema is only supported for connectorType "IngestApi" (got "${props.connectorType}").`,
        );
      }
      this.schema = new ConnectionSchema(this, `${id}Schema`, props.schema);
    }
  }
}
