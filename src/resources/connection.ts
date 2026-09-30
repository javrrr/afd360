import type { Data360Client } from "data-360-sdk";
import { Construct, type Resource, type ResourceContext } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn, retryOn5xx, is5xx, isNotFound, errBodyIncludes } from "../client/retry.js";
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
    // DELETE→CREATE race: after a successful delete, the name is locked for
    // ~seconds server-side even though the list endpoint already reports
    // the connection as gone. An immediate recreate hits a
    // `400 DUPLICATES_DETECTED: "A data connector with the provided name: X
    // already exists"`. Observed on awt 2026-05-06 during a SNOWFLAKE
    // hash-drift recreate. Retry alongside the baseline 5xx retry so a
    // single `afd360 deploy` survives the lock window instead of making
    // the user re-run.
    const shouldRetry = (err: unknown): boolean =>
      errBodyIncludes(err, "DUPLICATES_DETECTED") || is5xx(err);
    const result = await retryOn(
      () => ctx.client.connections.create(body),
      shouldRetry,
      { attempts: 6, intervalMs: 10_000, backoff: 1, jitter: 0 },
    );
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
      // Connection delete can transiently 500 even when the connection is
      // deletable and has no live dependents — observed on awt 2026-05-06
      // for SNOWFLAKE: first attempt 500'd with UNKNOWN_EXCEPTION, retry
      // ~10s later succeeded with 204. The platform-side cleanup (account
      // binding teardown, OAuth token revocation, etc.) can briefly conflict
      // with the delete handler. Use a longer retry window than the baseline
      // 3 × 500ms — 6 × 5s gives the cleanup time to settle.
      //
      // We also retry on DEPENDENCY_EXISTS (a 4xx, not a 5xx, so is5xx alone
      // misses it). During `destroy` the children (DataStream + its DLO) are
      // deleted before the Connection, but the platform lags releasing the
      // dependency edge for a few seconds after the DLO delete returns 204 —
      // so a Connection delete issued immediately behind it sees a stale
      // DEPENDENCY_EXISTS. It's the same propagation race the DELETE→CREATE
      // DUPLICATES_DETECTED retry handles on create: transient, clears on
      // retry. (If children genuinely failed to delete, destroy's orphan
      // adoption pre-pass handles that earlier; a DEPENDENCY_EXISTS that
      // survives all 6 attempts still surfaces so a real leak isn't masked.)
      const isTransientDelete = (err: unknown): boolean =>
        is5xx(err) || errBodyIncludes(err, "DEPENDENCY_EXISTS");
      await retryOn(
        () => ctx.client.connections.delete(salesforceId),
        isTransientDelete,
        { attempts: 6, intervalMs: 5_000, backoff: 1, jitter: 0 },
      );
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

/**
 * Resource ops for a connection afd360 REFERENCES but does not own — created
 * via {@link Connection.fromExisting}. The canonical case is the built-in
 * `Salesforce_Home` connector used by same-org CRM (Home) data streams: it is
 * provisioned by the platform, has no credentials, and must survive `destroy`.
 *
 * Contract vs the owned {@link ConnectionResource}:
 *  - create: never POSTs. Adopts the pre-existing connection by name (so its
 *    id/apiName land in state for dependent DataStreams). Errors loudly if the
 *    connection isn't already on the org — fromExisting is a reference, not a
 *    create.
 *  - delete: NO-OP. Deleting a built-in/shared connection would break every
 *    other stream that references it. This is the whole reason the reference
 *    lifecycle exists.
 *  - update / isFailed / matchesAuthored: never trigger a recreate — a
 *    referenced connection has no authored body to drift against, and a
 *    recreate would delete-then-recreate a resource we don't own.
 */
export const ExistingConnectionResource: Resource<ConnectionProps, ConnectionOutput> = {
  type: "Connection",
  surface: "connect",
  idOf: (output) => output.id,
  read: ConnectionResource.read,
  lookupByProps: ConnectionResource.lookupByProps!,
  isFailed: () => false,
  matchesAuthored: () => true,

  async create(ctx, props): Promise<ConnectionOutput> {
    const existing = await ConnectionResource.lookupByProps!(ctx, props);
    if (!existing) {
      throw new Error(
        `Connection.fromExisting("${props.name}"): no connection named "${props.name}" ` +
          `(connectorType "${props.connectorType}") exists on the org. fromExisting ` +
          `REFERENCES a pre-existing connection (e.g. the built-in "Salesforce_Home") — ` +
          `it does not create one. Verify the name/connectorType, or create it first.`,
      );
    }
    return existing;
  },

  async update(ctx, salesforceId): Promise<ConnectionOutput> {
    // Nothing to update — return the live view so the runner has an output.
    const live = await ConnectionResource.read(ctx, salesforceId);
    if (!live) {
      throw new Error(
        `Connection.fromExisting: referenced connection ${salesforceId} vanished from the org.`,
      );
    }
    return live;
  },

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async delete(): Promise<void> {
    // Intentionally a no-op — see the resource doc comment. afd360 must never
    // delete a connection it only references.
  },

  hash: ConnectionResource.hash,
};

interface ConnectionOpts {
  readonly dependsOn?: readonly Construct[];
  /** Internal: set by {@link Connection.fromExisting} to swap in the reference lifecycle. */
  readonly existing?: boolean;
  /**
   * Internal: the connection's `dataSource` field, which a same-org CRM (Home)
   * DataStream uses as its `datasource` — distinct from the connection's dev
   * `name`. For the built-in Home connector the platform reports
   * name="SalesforceDotCom_Home" but dataSource="Salesforce_Home" (confirmed
   * live on a live org, ). Set by {@link Connection.salesforceHome}.
   */
  readonly dataSourceName?: string;
}

/** Platform constants for the built-in same-org CRM (Home) connector. */
const SALESFORCE_HOME_CONNECTION_NAME = "SalesforceDotCom_Home";
const SALESFORCE_HOME_DATASOURCE = "Salesforce_Home";

export class Connection extends Construct {
  readonly resource: Resource<ConnectionProps, ConnectionOutput>;
  readonly props: ConnectionProps;
  readonly dependsOn: readonly Construct[];
  /** API dev name = authored `name` OR the construct's logical id. */
  readonly devName: string;
  /** Child ConnectionSchema construct, if the connector is IngestApi + schema is supplied. */
  readonly schema?: ConnectionSchema;
  /**
   * True when this construct only REFERENCES a pre-existing connection (built
   * via {@link Connection.fromExisting}) rather than owning it. Referenced
   * connections are adopted on deploy and skipped on destroy. Consumers
   * (DataStream connector inference, destroy) branch on this.
   */
  readonly isExisting: boolean;
  /**
   * The connection's `dataSource` field, when it differs from the dev `name`.
   * A same-org CRM (Home) DataStream's `datasource` is this value, not the
   * connection name. Undefined for connections where they coincide.
   */
  readonly dataSourceName?: string;

  /**
   * Reference a connection the platform (or a human) already provisioned,
   * instead of creating one. The canonical case is the built-in
   * `Salesforce_Home` connector that same-org CRM (Home) data streams read
   * from — it has no credentials and must never be deleted. For that connector
   * prefer the {@link Connection.salesforceHome} preset, which fills in the
   * platform's name/dataSource constants for you.
   *
   * afd360 adopts the connection by name on deploy (recording its id/apiName
   * so dependent DataStreams resolve) and NEVER deletes it on destroy.
   *
   * `dataSourceName` is the connection's `dataSource` field — supply it only
   * when it differs from `name` (as it does for the Home connector).
   */
  static fromExisting(
    scope: Stack,
    id: string,
    props: { name: string; connectorType: string; label?: string; dataSourceName?: string },
  ): Connection {
    const opts: ConnectionOpts = { existing: true };
    return new Connection(
      scope,
      id,
      {
        connectorType: props.connectorType,
        label: props.label ?? props.name,
        name: props.name,
      },
      props.dataSourceName !== undefined
        ? { ...opts, dataSourceName: props.dataSourceName }
        : opts,
    );
  }

  /**
   * Reference the built-in same-org CRM (Home) connector — the one afd360 uses
   * to stream this org's own Salesforce objects (Account, Lead, custom
   * objects, …) into Data Cloud. No credentials; provisioned by the platform;
   * never deleted on destroy.
   *
   * Encodes the platform constants (connection name "SalesforceDotCom_Home",
   * dataSource "Salesforce_Home", connectorType "SalesforceDotCom") so authors
   * don't have to memorize them. If a given org reports different internal
   * names, fall back to {@link Connection.fromExisting} with explicit values.
   */
  static salesforceHome(scope: Stack, id = "SalesforceHome"): Connection {
    return Connection.fromExisting(scope, id, {
      name: SALESFORCE_HOME_CONNECTION_NAME,
      connectorType: "SalesforceDotCom",
      dataSourceName: SALESFORCE_HOME_DATASOURCE,
    });
  }

  constructor(scope: Stack, id: string, props: ConnectionProps, opts: ConnectionOpts = {}) {
    super(scope, id);
    this.isExisting = opts.existing ?? false;
    this.resource = this.isExisting ? ExistingConnectionResource : ConnectionResource;
    if (opts.dataSourceName !== undefined) this.dataSourceName = opts.dataSourceName;
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
