import type {
  Data360Client,
  DataObjectInputRepresentation,
  RefreshConfigInputRepresentation,
} from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack, DeployedRef } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn, retryOn5xx, errBodyIncludes, is5xx, isNotFound } from "../client/retry.js";
import { Connection } from "./connection.js";
import { ConnectionSchema } from "./connection-schema.js";

/**
 * DLO category. Engagement vs Profile vs Other is a core Data Cloud distinction;
 * it drives downstream DMO mapping semantics. Default "Other" mirrors tdc.
 *
 * Sourced from the SDK so afd360 stays aligned with upstream regenerates.
 * Defined as a non-optional narrowing of the SDK's `category?` enum — afd360
 * always supplies a value (default "Other"), so the optionality drops out.
 */
export type DloCategory = NonNullable<DataObjectInputRepresentation["category"]>;

/**
 * Supported connector types. Each maps to a different Connect API payload
 * shape (`datastreamType`, `connectorInfo.connectorDetails`, and sometimes
 * `advancedAttributes`). M4 wired up IngestApi; M5 adds AwsS3; M11.1 adds
 * SNOWFLAKE (federated — platform introspects the source table schema);
 * M11.2 adds BIGQUERY (also federated, same Direct_Access BYOL family).
 */
export type DataStreamConnectorType = "IngestApi" | "AwsS3" | "SNOWFLAKE" | "BIGQUERY";

export interface DataStreamPrimaryKey {
  readonly name: string;
  readonly label?: string;
  /** API type (Text, Number, DateTime, ...). Defaults to Text. */
  readonly dataType?: string;
}

/**
 * A single column in the source file or feed. For AwsS3 CSV, `name` is the
 * **literal CSV header** (case-sensitive, may contain spaces). `dloName` is
 * how the column will be stored in the DLO — spaces aren't allowed, so
 * underscore-substitute. The platform auto-prefixes __c on the DLO side.
 */
export interface SourceFieldMapping {
  /** CSV column header as it appears in the file (may contain spaces). */
  readonly name: string;
  /** DLO field name — no spaces, no __c suffix (platform appends). Defaults to name with spaces→underscores. */
  readonly dloName?: string;
  /** Text | Number | DateTime | Date | Url | Email | Boolean. */
  readonly dataType: string;
  /** DateTime-only: format string e.g. `yyyy/MM/dd HH:mm:ss`. */
  readonly format?: string;
  /** True for the DLO primary-key column. Exactly one per stream. */
  readonly isPrimaryKey?: boolean;
}

/**
 * AwsS3-specific advanced attributes. Required when the parent connection is
 * AwsS3; ignored for other connectors.
 */
export interface AwsS3StreamAttributes {
  /** "CSV" | "PARQUET". Case-sensitive as returned by the connector metadata. */
  readonly fileType: "CSV" | "PARQUET";
  /** Bucket-relative directory. Empty string or omitted = root (`/`). */
  readonly importDirectory?: string;
  /** File name or glob. For CSV: a specific file or a prefix pattern. */
  readonly fileName: string;
  /** CSV only — "true"/"false" string (platform uses stringy booleans here). */
  readonly areHeadersIncludedInFile?: "true" | "false";
  /** Optional delimiter override — default is auto-detect. */
  readonly delimiter?: string;
  /**
   * Source columns and their mapping into the DLO. REQUIRED for AwsS3: the
   * platform does not auto-discover columns on create (it reads the CSV and
   * rejects with "CSV doesn't have source field X" for any unexpected name,
   * and "Mappings list cannot be empty" if mappings are missing).
   *
   * For the DLO side (after __c suffix), the platform will normalize spaces
   * to underscores and append __c. Authored `dloName` must not contain
   * spaces or __c.
   */
  readonly fields: ReadonlyArray<SourceFieldMapping>;
}

/**
 * SNOWFLAKE-specific advanced attributes. `database`, `schema`, and `object`
 * identify the source table inside Snowflake (NOT on the connection — the
 * connection only carries warehouse + auth, so the same Snowflake connection
 * can feed many streams against different tables). Platform introspects the
 * column schema server-side; the user doesn't declare columns — only the PK.
 *
 * Observed shape on aporg (dataStreams.list.json, SnowOrderV2 / TV_Viewing_Snow):
 *   advancedAttributes: { database, schema, object, incrementalColumn? }
 *   refreshConfig.refreshMode: "INCREMENTAL" | "TOTAL_REPLACE" | "UPSERT"
 */
export interface SnowflakeStreamAttributes {
  /** Snowflake database name (Snowflake uppercases unquoted identifiers). */
  readonly database: string;
  /** Snowflake schema name. */
  readonly schema: string;
  /** Snowflake table or view name. */
  readonly object: string;
  /**
   * Column name to use for incremental loads (refreshMode=INCREMENTAL).
   * Typically a monotonically-increasing DateTime or Number column. Omit
   * for TOTAL_REPLACE / UPSERT refresh modes.
   */
  readonly incrementalColumn?: string;
  /**
   * Source columns and their mapping into the DLO. REQUIRED: despite being
   * federated, the platform rejects the create with "source fields are
   * required" if omitted. Probed on awt 2026-05-06. Matches the AwsS3
   * requirement.
   *
   * The Snowflake wire shape uses LOWERCASE `datatype` (not `dataType`) and
   * `sourceFieldName` on mappings (not `sourceFieldLabel` like AwsS3). afd360
   * handles both translations internally — users author the same
   * `SourceFieldMapping` shape they use for AwsS3.
   */
  readonly fields: ReadonlyArray<SourceFieldMapping>;
}

/**
 * BIGQUERY-specific advanced attributes. `project`, `dataset`, and `table`
 * identify the source table inside BigQuery (NOT on the connection — the
 * connection only carries auth + project, so the same BigQuery connection
 * can feed many streams against different tables).
 *
 * BigQuery rides the same Direct_Access BYOL pipeline as Snowflake (see
 * data-360-sdk DataStreamInputRepresentation override comment). Wire shape
 * mirrors Snowflake almost exactly — only the advancedAttributes keys
 * differ (project/dataset/table vs database/schema/object).
 *
 * The `fields` list is required despite federation, same as Snowflake.
 */
export interface BigQueryStreamAttributes {
  /** GCP project ID hosting the BigQuery dataset. */
  readonly project: string;
  /** BigQuery dataset (the equivalent of Snowflake's "schema"). */
  readonly dataset: string;
  /** BigQuery table or view name. */
  readonly table: string;
  /**
   * Column name to use for incremental loads (refreshMode=INCREMENTAL).
   * Typically a monotonically-increasing TIMESTAMP or DATETIME column. Omit
   * for TOTAL_REPLACE refresh modes.
   */
  readonly incrementalColumn?: string;
  /**
   * Source columns and their mapping into the DLO. REQUIRED — even though
   * BigQuery is federated, the platform's Direct_Access path expects
   * `sourceFields[]` and `mappings[]` on create (consistent with Snowflake's
   * behavior on awt 2026-05-06). Declare the BigQuery columns to pull.
   */
  readonly fields: ReadonlyArray<SourceFieldMapping>;
}

export interface DataStreamProps {
  readonly connection: Connection;
  /** Logical name of the source object:
   *  - IngestApi: schema object name (matches ConnectionSchema.schemaName).
   *  - AwsS3: a stable identifier for the stream; used for the DLO name.
   *  - SNOWFLAKE: user-facing identifier; separate from `snowflake.object`
   *    (the Snowflake table name). Used to name the DLO.
   *  - BIGQUERY: user-facing identifier; separate from `bigquery.table`
   *    (the BigQuery table name). Used to name the DLO. */
  readonly sourceObject: string;
  /** Developer name; falls back to the construct logical id. */
  readonly name?: string;
  readonly label?: string;
  readonly category?: DloCategory;
  /**
   * How the DLO is refreshed. Connector-dependent defaults:
   *   IngestApi / AwsS3: UPSERT
   *   SNOWFLAKE: INCREMENTAL (requires `snowflake.incrementalColumn`) or
   *     TOTAL_REPLACE. UPSERT is not supported on federated Snowflake.
   *   BIGQUERY: INCREMENTAL (requires `bigquery.incrementalColumn`) or
   *     TOTAL_REPLACE. UPSERT is not supported on federated BigQuery.
   */
  readonly refreshMode?: NonNullable<RefreshConfigInputRepresentation["refreshMode"]>;
  /** Data space for the resulting DLO. "default" unless multi-tenant. */
  readonly dataSpace?: string;
  readonly primaryKey: DataStreamPrimaryKey;
  /**
   * REQUIRED when category = "Engagement". DLO field name (underscore form,
   * no __c) that carries the event time. Not used for Profile / Other.
   */
  readonly eventDateTimeFieldName?: string;
  /**
   * AwsS3-only: where to find the data + column definitions. Required when
   * the parent connection's connectorType is AwsS3; validated at construct time.
   */
  readonly s3?: AwsS3StreamAttributes;
  /**
   * SNOWFLAKE-only: which table to pull from. Required when the parent
   * connection's connectorType is SNOWFLAKE.
   */
  readonly snowflake?: SnowflakeStreamAttributes;
  /**
   * BIGQUERY-only: which table to pull from. Required when the parent
   * connection's connectorType is BigQuery.
   */
  readonly bigquery?: BigQueryStreamAttributes;
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
  readonly connectorType: DataStreamConnectorType;
  readonly connectionName: string;
  readonly sourceObject: string;
  readonly name: string;
  readonly label: string;
  readonly category: DloCategory;
  readonly refreshMode: NonNullable<RefreshConfigInputRepresentation["refreshMode"]>;
  readonly dataSpace: string;
  readonly primaryKey: DataStreamPrimaryKey;
  readonly eventDateTimeFieldName?: string;
  readonly s3?: AwsS3StreamAttributes;
  readonly snowflake?: SnowflakeStreamAttributes;
  readonly bigquery?: BigQueryStreamAttributes;
}

function buildCreatePayload(p: DataStreamResourceProps): unknown {
  if (p.connectorType === "IngestApi") return buildIngestApiPayload(p);
  if (p.connectorType === "AwsS3") return buildAwsS3Payload(p);
  if (p.connectorType === "SNOWFLAKE") return buildSnowflakePayload(p);
  if (p.connectorType === "BIGQUERY") return buildBigQueryPayload(p);
  // Exhaustive check — future connector types land here.
  const _exhaustive: never = p.connectorType;
  throw new Error(`DataStream connectorType "${String(_exhaustive)}" is not supported yet.`);
}

function buildIngestApiPayload(p: DataStreamResourceProps): unknown {
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
      dataLakeFieldInputRepresentations: [pkFieldRep(p.primaryKey)],
    },
    refreshConfig: { refreshMode: p.refreshMode },
  };
}

function buildAwsS3Payload(p: DataStreamResourceProps): unknown {
  if (!p.s3) {
    throw new Error(
      `DataStream "${p.name}" has connectorType=AwsS3 but no s3 attributes. ` +
        `Provide { fileType, fileName, fields, ... }.`,
    );
  }
  const s3 = p.s3;
  if (!s3.fields.length) {
    throw new Error(
      `DataStream "${p.name}": s3.fields cannot be empty — the Connect API ` +
        `will reject the create with "Mappings list cannot be empty".`,
    );
  }
  const pkFields = s3.fields.filter((f) => f.isPrimaryKey);
  if (pkFields.length !== 1) {
    throw new Error(
      `DataStream "${p.name}": s3.fields must contain exactly one isPrimaryKey field (got ${pkFields.length}).`,
    );
  }
  const dloNameFor = (f: SourceFieldMapping): string =>
    f.dloName ?? f.name.replace(/\s+/g, "_");

  // Evidence from jaygentforce probes 2026-05-05 (see feedback notes on
  // DataStream AwsS3 shape): the Connect API for S3 streams requires:
  //   - connectorInfo.connectorType: "DataConnector" (not "AwsS3" — that's
  //     a GET-response echo, rejected on POST).
  //   - connectorInfo.connectorDetails: { name } ONLY — no `type` field.
  //   - datasource: `AwsS3_${connectionName}` (platform prepends AwsS3_).
  //   - sourceFields[]: literal CSV header names (spaces preserved).
  //   - mappings[]: per-column CSV → DLO mapping (sourceFieldLabel is the
  //     CSV name, targetFieldName is the DLO column, targetFieldReturntype
  //     mirrors the source datatype).
  //   - dataLakeObjectInfo.dataLakeFieldInputRepresentations[]: every
  //     target DLO column pre-declared, or the API rejects with
  //     "targetField X in mapping is not present in DataLakeObject".
  //   - refreshConfig.frequency: { frequencyType: "None" } for on-demand streams.
  //   - Engagement category needs eventDateTimeFieldName; Profile/Other don't.
  const dlo: Record<string, unknown> = {
    label: p.sourceObject,
    name: `${p.sourceObject}__dll`,
    category: p.category,
    dataspaceInfo: [{ name: p.dataSpace }],
    dataLakeFieldInputRepresentations: s3.fields.map((f) => ({
      name: dloNameFor(f),
      label: f.name,
      dataType: f.dataType,
      isPrimaryKey: !!f.isPrimaryKey,
    })),
  };
  if (p.category === "Engagement") {
    if (!p.eventDateTimeFieldName) {
      throw new Error(
        `DataStream "${p.name}": category=Engagement requires eventDateTimeFieldName.`,
      );
    }
    dlo["eventDateTimeFieldName"] = p.eventDateTimeFieldName;
  }

  return {
    name: p.name,
    label: p.label,
    datasource: `AwsS3_${p.connectionName}`,
    datastreamType: "CONNECTORSFRAMEWORK",
    connectorInfo: {
      connectorType: "DataConnector",
      connectorDetails: { name: p.connectionName },
    },
    advancedAttributes: {
      fileType: s3.fileType,
      fileName: s3.fileName,
      importDirectory: s3.importDirectory ?? "",
      areHeadersIncludedInFile: s3.areHeadersIncludedInFile ?? "true",
      ...(s3.delimiter ? { delimiter: s3.delimiter } : {}),
    },
    sourceFields: s3.fields.map((f) => {
      const sf: Record<string, unknown> = { name: f.name, dataType: f.dataType };
      if (f.format) sf["format"] = f.format;
      return sf;
    }),
    mappings: s3.fields.map((f) => ({
      sourceFieldLabel: f.name,
      targetFieldName: dloNameFor(f),
      targetFieldReturntype: f.dataType,
    })),
    dataLakeObjectInfo: dlo,
    refreshConfig: {
      refreshMode: p.refreshMode,
      frequency: { frequencyType: "None" },
    },
  };
}

/**
 * SNOWFLAKE is federated — the platform queries Snowflake live to introspect
 * table columns. The create payload only identifies the source table and PK;
 * no sourceFields/mappings/DLO-field-reps needed (platform derives them).
 *
 * Shape derived from aporg 2026-05-06 dataStreams.list.json (SnowOrderV2,
 * TV_Viewing_Snow), which captured the live GET response. Keys confirmed
 * against data-360-sdk's ConnectorFrameworkPayload type.
 */
function buildSnowflakePayload(p: DataStreamResourceProps): unknown {
  if (!p.snowflake) {
    throw new Error(
      `DataStream "${p.name}": connectorType=SNOWFLAKE requires snowflake attributes ` +
        `({ database, schema, object, incrementalColumn?, fields }).`,
    );
  }
  const snowflakeFields = p.snowflake.fields;
  if (!snowflakeFields || snowflakeFields.length === 0) {
    throw new Error(
      `DataStream "${p.name}": snowflake.fields is required. Despite being ` +
        `federated, the platform rejects creates without sourceFields. ` +
        `Declare the Snowflake columns you want to pull.`,
    );
  }
  const pkFields = snowflakeFields.filter((f) => f.isPrimaryKey);
  if (pkFields.length !== 1) {
    throw new Error(
      `DataStream "${p.name}": snowflake.fields must contain exactly one isPrimaryKey field (got ${pkFields.length}).`,
    );
  }
  const dloNameFor = (f: SourceFieldMapping): string =>
    f.dloName ?? f.name.replace(/\s+/g, "_");
  // Snowflake's BYOL (Direct_Access) path uses lowercase `database`/`schema`/
  // `object` keys — not the UPPERCASE `DATABASE`/`SCHEMA`/`objectName` that
  // appear in the connector's `advancedAttributes` metadata. The metadata
  // form-keys aren't the same as the create-payload keys. Observed on awt
  // 2026-05-06.
  const advancedAttributes: Record<string, unknown> = {
    database: p.snowflake.database,
    schema: p.snowflake.schema,
    object: p.snowflake.object,
  };
  if (p.snowflake.incrementalColumn) {
    advancedAttributes["incrementalColumn"] = p.snowflake.incrementalColumn;
  }
  const dlo: Record<string, unknown> = {
    label: p.sourceObject,
    name: `${p.sourceObject}__dll`,
    category: p.category,
    dataspaceInfo: [{ name: p.dataSpace }],
    dataLakeFieldInputRepresentations: snowflakeFields.map((f) => ({
      name: dloNameFor(f),
      label: f.name,
      dataType: f.dataType,
      isPrimaryKey: !!f.isPrimaryKey,
    })),
  };
  if (p.category === "Engagement") {
    if (!p.eventDateTimeFieldName) {
      throw new Error(
        `DataStream "${p.name}": category=Engagement requires eventDateTimeFieldName.`,
      );
    }
    dlo["eventDateTimeFieldName"] = p.eventDateTimeFieldName;
  }
  return {
    name: p.name,
    label: p.label,
    // CRITICAL — Snowflake stream creation routes through the BYOL/zero-copy
    // path, NOT the ingest path. The Connect API has two separate creation
    // pipelines and the discriminator is `dataAccessMode`:
    //   - Ingest:        copies data to Data Cloud's lake (AwsS3 / IngestApi)
    //   - Direct_Access: federated query against the source (Snowflake / BigQuery / Databricks)
    //
    // Without `dataAccessMode: "Direct_Access"`, the server tries the ingest
    // path and returns the misleading error
    //   `Unable to post Data Stream: DATA_CONNECTORS is not supported`
    // even though the connector itself is GA. With Direct_Access, the
    // BYOL path takes over and the create succeeds. Observed on awt
    // 2026-05-06; see feedback_snowflake-stream-direct-access.md.
    //
    // Also note: `datasource` MUST be omitted for Direct_Access streams —
    // the server returns `DataSource name should be empty for External data
    // streams` if present.
    dataAccessMode: "Direct_Access",
    datastreamType: "DATA_CONNECTORS",
    connectorInfo: {
      connectorType: "DataConnector",
      connectorDetails: { name: p.connectionName },
    },
    advancedAttributes,
    // POST wants `dataType` (camelCase); GET echoes `datatype` (lowercase).
    sourceFields: snowflakeFields.map((f) => {
      const sf: Record<string, unknown> = { name: f.name, dataType: f.dataType };
      if (f.format) sf["format"] = f.format;
      return sf;
    }),
    mappings: snowflakeFields.map((f) => ({
      sourceFieldLabel: f.name,
      targetFieldName: dloNameFor(f),
      targetFieldReturntype: f.dataType,
    })),
    dataLakeObjectInfo: dlo,
    refreshConfig: { refreshMode: p.refreshMode },
  };
}

/**
 * BIGQUERY is federated — same Direct_Access BYOL pipeline as Snowflake.
 * The create payload only identifies the source table (project/dataset/table)
 * and PK; column schema is declared in `bigquery.fields` (the platform's
 * Direct_Access path requires sourceFields[]+mappings[] just like Snowflake).
 *
 * Wire shape derived from data-360-sdk DataStreamInputRepresentation
 * override comment:
 *   "dataAccessMode='Direct_Access' is required for federated/BYOL connectors
 *    (Snowflake, Databricks, BigQuery, Iceberg) — without it the server
 *    returns `400 INTERNAL_ERROR: Unable to post Data Stream:
 *    DATA_CONNECTORS is not supported` even when the connector is GA.
 *    Direct_Access streams must also OMIT the top-level `datasource` field."
 *
 * advancedAttributes keys (project/dataset/table) match the BigQuery
 * connector metadata's lowercase form. If a deploy ever fails on the
 * connector side, the keys to suspect first are these. (Snowflake
 * empirically uses lowercase database/schema/object on the create payload
 * even though the connector metadata reports UPPERCASE — same gotcha may
 * apply to BigQuery.)
 */
function buildBigQueryPayload(p: DataStreamResourceProps): unknown {
  if (!p.bigquery) {
    throw new Error(
      `DataStream "${p.name}": connectorType=BIGQUERY requires bigquery attributes ` +
        `({ project, dataset, table, incrementalColumn?, fields }).`,
    );
  }
  const bigqueryFields = p.bigquery.fields;
  if (!bigqueryFields || bigqueryFields.length === 0) {
    throw new Error(
      `DataStream "${p.name}": bigquery.fields is required. Despite being ` +
        `federated, the platform's Direct_Access path rejects creates without ` +
        `sourceFields. Declare the BigQuery columns you want to pull.`,
    );
  }
  const pkFields = bigqueryFields.filter((f) => f.isPrimaryKey);
  if (pkFields.length !== 1) {
    throw new Error(
      `DataStream "${p.name}": bigquery.fields must contain exactly one isPrimaryKey field (got ${pkFields.length}).`,
    );
  }
  const dloNameFor = (f: SourceFieldMapping): string =>
    f.dloName ?? f.name.replace(/\s+/g, "_");
  // BigQuery uses the SAME advancedAttributes keys as Snowflake — `database`,
  // `schema`, `object` — NOT BigQuery-native `project`/`dataset`/`table`.
  // The Connect API's Direct_Access path is generic and uses Snowflake-style
  // names everywhere. Probed against awt 2026-06-11; sending `project` /
  // `dataset` / `table` returns:
  //   INVALID_ARGUMENT: database cannot be empty in advanced attr
  // Mapping is intuitive: BigQuery dataset acts as Snowflake's schema,
  // BigQuery table is Snowflake's object. Project ID lives on the
  // Connection (parameters.projectId), not on the stream.
  const advancedAttributes: Record<string, unknown> = {
    database: p.bigquery.project,
    schema: p.bigquery.dataset,
    object: p.bigquery.table,
  };
  if (p.bigquery.incrementalColumn) {
    advancedAttributes["incrementalColumn"] = p.bigquery.incrementalColumn;
  }
  const dlo: Record<string, unknown> = {
    label: p.sourceObject,
    name: `${p.sourceObject}__dll`,
    category: p.category,
    dataspaceInfo: [{ name: p.dataSpace }],
    dataLakeFieldInputRepresentations: bigqueryFields.map((f) => ({
      name: dloNameFor(f),
      label: f.name,
      dataType: f.dataType,
      isPrimaryKey: !!f.isPrimaryKey,
    })),
  };
  if (p.category === "Engagement") {
    if (!p.eventDateTimeFieldName) {
      throw new Error(
        `DataStream "${p.name}": category=Engagement requires eventDateTimeFieldName.`,
      );
    }
    dlo["eventDateTimeFieldName"] = p.eventDateTimeFieldName;
  }
  return {
    name: p.name,
    label: p.label,
    // Direct_Access BYOL — same routing as Snowflake (see buildSnowflakePayload
    // for the full rationale + observed-error story).
    dataAccessMode: "Direct_Access",
    datastreamType: "DATA_CONNECTORS",
    connectorInfo: {
      connectorType: "DataConnector",
      connectorDetails: { name: p.connectionName },
    },
    advancedAttributes,
    sourceFields: bigqueryFields.map((f) => {
      const sf: Record<string, unknown> = { name: f.name, dataType: f.dataType };
      if (f.format) sf["format"] = f.format;
      return sf;
    }),
    mappings: bigqueryFields.map((f) => ({
      sourceFieldLabel: f.name,
      targetFieldName: dloNameFor(f),
      targetFieldReturntype: f.dataType,
    })),
    dataLakeObjectInfo: dlo,
    refreshConfig: { refreshMode: p.refreshMode },
  };
}

function pkFieldRep(pk: DataStreamPrimaryKey): unknown {
  return {
    name: pk.name,
    label: pk.label ?? pk.name,
    dataType: pk.dataType ?? "Text",
    isPrimaryKey: true,
  };
}

function inferConnectorType(conn: Connection): DataStreamConnectorType {
  const ct = conn.props.connectorType;
  if (ct === "IngestApi") return "IngestApi";
  if (ct === "AwsS3") return "AwsS3";
  if (ct === "SNOWFLAKE") return "SNOWFLAKE";
  // BigQuery: accept the SDK-canonical TitleCase ("BigQuery") on the
  // Connection construct and normalize to UPPERCASE here, matching how
  // SNOWFLAKE is plumbed internally.
  if (ct === "BigQuery" || ct === "BIGQUERY") return "BIGQUERY";
  throw new Error(
    `DataStream does not yet support connectorType "${ct}". ` +
      `Supported: IngestApi, AwsS3, SNOWFLAKE, BigQuery.`,
  );
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
    const body = buildCreatePayload(props) as Parameters<
      Data360Client["dataStreams"]["create"]
    >[0];
    // Quirk A1: "Illegal argument" on create is transient — schema
    // provisioning lag. tdc retries 6 × 15s. We preserve 5xx baseline too.
    // Also retry "required attributes [...] are null" — Snowflake BYOL
    // connections need a brief settling window after create before the
    // first DataStream can use them. The connector's session binding
    // isn't propagated yet even though Connection.status=Active.
    const shouldRetry = (err: unknown): boolean =>
      errBodyIncludes(err, "Illegal argument") ||
      errBodyIncludes(err, "required attributes") ||
      is5xx(err);
    const result = await retryOn(() => ctx.client.dataStreams.create(body), shouldRetry, {
      attempts: 6,
      intervalMs: 15_000,
      backoff: 1,
      jitter: 0,
    });
    // Platform quirk: for AwsS3 (DataConnector family), the stream's dev
    // name is derived from `dataLakeObjectInfo.name` (minus __dll), NOT the
    // authored `name` we sent. Response body may still echo the authored
    // name, but GET /ssot/data-streams/{authoredName} then returns "not
    // found". Key state on the DLO-derived name for AwsS3/SNOWFLAKE (both
    // ride the DataConnector family), and the response name for IngestApi.
    // See memory note feedback_s3-stream-devname-from-dlo.md.
    const dloName = result.dataLakeObjectInfo?.name;
    const derivedName = dloName?.endsWith("__dll") ? dloName.slice(0, -"__dll".length) : undefined;
    const usesDerivedName =
      props.connectorType === "AwsS3" ||
      props.connectorType === "SNOWFLAKE" ||
      props.connectorType === "BIGQUERY";
    const name = usesDerivedName && derivedName ? derivedName : result.name;
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
    // We need the DLO name before issuing the delete — afterwards the stream
    // is gone and we can't find the DLO by association. Read first to capture
    // the DLO. Tolerate 404 in case the stream is already gone.
    let dloName: string | undefined;
    try {
      const detail = await ctx.client.dataStreams.get(recordId);
      dloName = detail.dataLakeObjectInfo?.name;
    } catch (err) {
      if (isNotFound(err)) return;
      // Non-404 read errors shouldn't block delete attempts.
    }

    try {
      // PLAN §9 D2 — prefer cascading the DLO delete; fallback to leaving
      // the DLO behind if the platform rejects it (DLO may be referenced by
      // mappings). In practice cascade-true returns 204 but quietly LEAVES the
      // DLO in place when it has dependent mappings (evidence: jaygentforce C5
      // 2026-05-05). We re-check and clean up explicitly below.
      await retryOn5xx(() =>
        ctx.client.dataStreams.delete(recordId, { shouldDeleteDataLakeObject: true }),
      );
    } catch (err) {
      if (isNotFound(err)) {
        // stream already gone; still try to clean up the DLO below.
      } else {
        // cascade-true failed (412 or similar). Retry without cascade so the
        // stream at least goes away; DLO cleanup happens below.
        await retryOn5xx(() =>
          ctx.client.dataStreams.delete(recordId, { shouldDeleteDataLakeObject: false }),
        );
      }
    }

    // Post-delete: verify DLO is actually gone. If not, the Connect API
    // cascade silently left an orphan — attempt an explicit DLO delete so
    // downstream Connection.delete doesn't trip on DEPENDENCY_EXISTS.
    if (dloName) {
      try {
        await ctx.client.dataLakeObjects.get(dloName);
        // Still there — try to delete it directly.
        await retryOn5xx(() =>
          ctx.client.dataLakeObjects.delete(dloName!),
        );
      } catch (err) {
        if (isNotFound(err)) return; // already gone, good.
        // If the DLO has other mapping references we can't clean, surface the
        // original error for the user — but only if a destroy path is actually
        // running. For now swallow silently; M9 (teardown hardening) can add
        // more sophisticated orphan handling.
      }
    }
  },

  isFailed(output): boolean {
    const status = (output.status ?? "").toUpperCase();
    return status === "ERROR";
  },

  async isReady(ctx, output): Promise<boolean> {
    // DataStream readiness. Live API returns UPPERCASE values — SDK types
    // lie (title-case). Terminal values observed:
    //   - ACTIVE      → ready.
    //   - PROCESSING  → not ready yet; keep polling. For IngestApi this can
    //                   take minutes (tdc saw "did not activate within 60s"
    //                   warnings regularly). Callers should budget ~5 min.
    //   - ERROR       → terminal failure. Connect API offers no "Retry Now"
    //                   (probed exhaustively — Setup UI uses a different
    //                   channel). Surface as a throw; recovery is
    //                   delete + redeploy.
    //   - DELETING    → terminal, same treatment as ERROR.
    //
    // Historical note: a prior afd360 version treated "PROCESSING + DLO
    // ACTIVE" as ready, on the theory that IngestApi streams only leave
    // PROCESSING once data ingests. That was wrong — such streams eventually
    // transition to ERROR on their own (evidence: jaygentforce C3 on
    // 2026-05-05). Wait for ACTIVE.
    const fresh = await ctx.client.dataStreams.get(output.recordId);
    const streamStatus = ((fresh as { status?: string }).status ?? "").toUpperCase();
    if (streamStatus === "ERROR" || streamStatus === "DELETING") {
      const dloStatus =
        ((fresh.dataLakeObjectInfo as { status?: string } | undefined)?.status ?? "").toUpperCase();
      const lastRun = (fresh as { lastRunStatus?: string }).lastRunStatus ?? "n/a";
      throw new Error(
        `DataStream "${output.name}" entered terminal state ${streamStatus} during provisioning ` +
          `(DLO=${dloStatus || "n/a"}, lastRunStatus=${lastRun}). ` +
          `The Connect API has no recovery action; run \`afd360 destroy && afd360 deploy\` ` +
          `or check the Data Cloud Setup UI for a reason.`,
      );
    }
    return streamStatus === "ACTIVE";
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
    // Connector-specific refresh-mode default. Federated BYOL connectors
    // (Snowflake, BigQuery) want INCREMENTAL (or TOTAL_REPLACE); IngestApi
    // and AwsS3 want UPSERT.
    const connectorType = inferConnectorType(props.connection);
    const refreshMode =
      props.refreshMode ??
      (connectorType === "SNOWFLAKE" || connectorType === "BIGQUERY"
        ? "INCREMENTAL"
        : "UPSERT");
    const dataSpace = props.dataSpace ?? "default";
    // Derive connector type from the parent Connection and validate s3 attrs.
    // Keeping this mapping in one place means the manifest author picks one
    // Connection + one set of stream props; the connector-specific payload
    // shape is afd360's problem.
    if (connectorType === "AwsS3" && !props.s3) {
      throw new Error(
        `DataStream "${id}": AwsS3 connections require s3 attributes ` +
          `({ fileType, fileName, importDirectory? }).`,
      );
    }
    if (connectorType === "IngestApi" && props.s3) {
      throw new Error(
        `DataStream "${id}": s3 attributes are only meaningful for AwsS3 connections.`,
      );
    }
    if (connectorType === "SNOWFLAKE" && !props.snowflake) {
      throw new Error(
        `DataStream "${id}": SNOWFLAKE connections require snowflake attributes ` +
          `({ database, schema, object, incrementalColumn? }).`,
      );
    }
    if (connectorType !== "SNOWFLAKE" && props.snowflake) {
      throw new Error(
        `DataStream "${id}": snowflake attributes are only meaningful for SNOWFLAKE connections.`,
      );
    }
    if (
      connectorType === "SNOWFLAKE" &&
      refreshMode === "INCREMENTAL" &&
      !props.snowflake?.incrementalColumn
    ) {
      throw new Error(
        `DataStream "${id}": refreshMode=INCREMENTAL requires snowflake.incrementalColumn. ` +
          `Use refreshMode="TOTAL_REPLACE" for a full-table refresh.`,
      );
    }
    if (connectorType === "BIGQUERY" && !props.bigquery) {
      throw new Error(
        `DataStream "${id}": BigQuery connections require bigquery attributes ` +
          `({ project, dataset, table, incrementalColumn? }).`,
      );
    }
    if (connectorType !== "BIGQUERY" && props.bigquery) {
      throw new Error(
        `DataStream "${id}": bigquery attributes are only meaningful for BigQuery connections.`,
      );
    }
    if (
      connectorType === "BIGQUERY" &&
      refreshMode === "INCREMENTAL" &&
      !props.bigquery?.incrementalColumn
    ) {
      throw new Error(
        `DataStream "${id}": refreshMode=INCREMENTAL requires bigquery.incrementalColumn. ` +
          `Use refreshMode="TOTAL_REPLACE" for a full-table refresh.`,
      );
    }
    if (category === "Engagement" && !props.eventDateTimeFieldName) {
      throw new Error(
        `DataStream "${id}": category="Engagement" requires eventDateTimeFieldName. ` +
          `Name a DLO field (underscore form, no __c) that holds the event timestamp.`,
      );
    }
    const baseProps: DataStreamResourceProps = {
      connectorType,
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
    let resolvedProps: DataStreamResourceProps = baseProps;
    if (props.eventDateTimeFieldName) {
      resolvedProps = { ...resolvedProps, eventDateTimeFieldName: props.eventDateTimeFieldName };
    }
    if (props.s3) {
      resolvedProps = { ...resolvedProps, s3: props.s3 };
    }
    if (props.snowflake) {
      resolvedProps = { ...resolvedProps, snowflake: props.snowflake };
    }
    if (props.bigquery) {
      resolvedProps = { ...resolvedProps, bigquery: props.bigquery };
    }
    this.props = resolvedProps;
    // Auto-wire dependency on the parent Connection (and ConnectionSchema if
    // present) so the deploy runner orders us after both.
    const autoDeps: Construct[] = [props.connection];
    if (props.connection.schema) autoDeps.push(props.connection.schema);
    this.dependsOn = [...autoDeps, ...(opts.dependsOn ?? [])];

    this.dlo = { name: `${props.sourceObject}__dll` };
    // Defaults: 5 s × 60 attempts = 5 minutes. tdc regularly observed
    // streams taking longer than 60 s to reach ACTIVE ("warning: did not
    // activate within 60 s"). 5 min comfortably covers the observed tail
    // without paying too much on fast-path IngestApi deploys.
    this.readyIntervalMs = opts.readyIntervalMs ?? 5_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 300_000;
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
