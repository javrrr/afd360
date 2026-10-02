import type {
  Data360Client,
  DataObjectInputRepresentation,
  RefreshConfigInputRepresentation,
} from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack, DeployedRef } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn, retryOn5xx, errBodyIncludes, is5xx, isNotFound } from "../client/retry.js";
import { pollUntil, PollTimeoutError } from "../core/poll.js";
import { Connection } from "./connection.js";
import { ConnectionSchema } from "./connection-schema.js";

/**
 * DLO category. Engagement vs Profile vs Other is a core Data Cloud distinction;
 * it drives downstream DMO mapping semantics. Default "Other" mirrors prior tooling.
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
export type DataStreamConnectorType =
  | "IngestApi"
  | "AwsS3"
  | "SNOWFLAKE"
  | "BIGQUERY"
  | "SalesforceHome";

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
   *  - IngestApi: MUST equal the connection's schema object name
   *    (ConnectionSchema.schemaName / schema.name — the dev name, not the
   *    label). Enforced at construct time; a mismatch fails the platform create
   *    with an opaque 400 INTERNAL_ERROR.
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
   * SalesforceHome-only: the source-record audit field used for incremental
   * change detection. Defaults to "SystemModstamp" (present on every standard
   * and custom sObject). Override only if the object uses a different field.
   */
  readonly recordModifiedFieldName?: string;
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
  /**
   * The parent connection's `dataSource` field, used as the stream's
   * `datasource` when it differs from the connection dev name (SalesforceHome:
   * name="SalesforceDotCom_Home" but datasource="Salesforce_Home"). Falls back
   * to `connectionName` when absent. Resolved from the Connection construct's
   * `dataSourceName` at deploy time.
   */
  readonly datasourceName?: string;
  readonly sourceObject: string;
  readonly name: string;
  readonly label: string;
  readonly category: DloCategory;
  readonly refreshMode: NonNullable<RefreshConfigInputRepresentation["refreshMode"]>;
  readonly dataSpace: string;
  readonly primaryKey: DataStreamPrimaryKey;
  readonly eventDateTimeFieldName?: string;
  readonly recordModifiedFieldName?: string;
  readonly s3?: AwsS3StreamAttributes;
  readonly snowflake?: SnowflakeStreamAttributes;
  readonly bigquery?: BigQueryStreamAttributes;
}

function buildCreatePayload(p: DataStreamResourceProps): unknown {
  if (p.connectorType === "IngestApi") return buildIngestApiPayload(p);
  if (p.connectorType === "AwsS3") return buildAwsS3Payload(p);
  if (p.connectorType === "SNOWFLAKE") return buildSnowflakePayload(p);
  if (p.connectorType === "BIGQUERY") return buildBigQueryPayload(p);
  if (p.connectorType === "SalesforceHome") return buildSalesforceHomePayload(p);
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
      // Convention: DLO dev name = <schemaObject>__dll, matching prior tooling.
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

/**
 * Default DLO dev name for a same-org CRM (Home) stream: `<Object>_Home__dll`,
 * with a trailing `__c` stripped from custom objects. Confirmed live on
 * a live org: standard "Account" → "Account_Home__dll"; custom "P_Region__c" →
 * "P_Region_Home__dll" (NOT "P_Region__c_Home__dll" — the platform rejects the
 * un-stripped form's field flattening). The platform also flattens custom DLO
 * FIELD names (`ExternalId__c` → `ExternalId_c`); that matters for the Mapping
 * resolver, not the stream create (which only declares the PK).
 */
function salesforceHomeDloName(sourceObject: string): string {
  const base = sourceObject.endsWith("__c")
    ? sourceObject.slice(0, -"__c".length)
    : sourceObject;
  return `${base}_Home__dll`;
}

/**
 * Same-org CRM (Home) stream. Reads this org's own Salesforce objects
 * (standard or custom) into a DLO via the built-in Salesforce_Home connector.
 *
 * Confirmed live on a live org () via a throwaway Lead_Home create that
 * iterated the 400s to a clean success — the platform auto-introspected the
 * sObject and materialized all 61 columns from a PK-only input. Key shape
 * facts, several of which differ from the AwsS3 / GET-response intuition:
 *   - datastreamType: "SFDC" (NOT "CONNECTORSFRAMEWORK" — that's the
 *     S3/DataConnector path; SFDC keeps its own type and is NOT rewritten to
 *     DataConnector the way S3 is).
 *   - connectorInfo.connectorType: "SalesforceDotCom" (POST discriminator ==
 *     GET echo here; no rewrite).
 *   - connectorInfo.connectorDetails: { name, sourceObject } — `name` is the
 *     CONNECTION dev name ("SalesforceDotCom_Home"), and `sourceObject` lives
 *     HERE, not in advancedAttributes. Emitting connectorDetails.type (which
 *     the GET echoes) makes the POST 400 with
 *     `JSON_PARSER_ERROR: Unrecognized field "type"` — same asymmetry class as
 *     the S3 connectorType echo.
 *   - datasource: the connection's `dataSource` ("Salesforce_Home") — verbatim,
 *     NOT the connection dev name and NOT AwsS3_-prefixed.
 *   - NO advancedAttributes, NO sourceFields, NO mappings — auto-introspection
 *     is driven purely by the PK in dataLakeFieldInputRepresentations.
 *   - recordModifiedFieldName lives in dataLakeObjectInfo (default
 *     "SystemModstamp"), not advancedAttributes.
 *   - DLO name = `<Object>_Home__dll` (confirmed literally "Lead_Home__dll").
 *   - refreshConfig: UPSERT + frequency { frequencyType: "BATCH" }.
 */
function buildSalesforceHomePayload(p: DataStreamResourceProps): unknown {
  const dlo: Record<string, unknown> = {
    label: p.label,
    // Convention differs from other connectors: <Object>_Home__dll, not
    // <Object>__dll (and the trailing __c on custom objects is stripped —
    // see salesforceHomeDloName). Keep in sync with the constructor's this.dlo.
    name: salesforceHomeDloName(p.sourceObject),
    category: p.category,
    dataspaceInfo: [{ name: p.dataSpace }],
    recordModifiedFieldName: p.recordModifiedFieldName ?? "SystemModstamp",
    // PK only — the platform derives the rest by introspecting the sObject.
    dataLakeFieldInputRepresentations: [pkFieldRep(p.primaryKey)],
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
    // datasource is the connection's dataSource ("Salesforce_Home"), distinct
    // from connectorDetails.name (the connection dev name). Falls back to the
    // connection name if a dataSourceName wasn't threaded through.
    datasource: p.datasourceName ?? p.connectionName,
    datastreamType: "SFDC",
    connectorInfo: {
      connectorType: "SalesforceDotCom",
      connectorDetails: { name: p.connectionName, sourceObject: p.sourceObject },
    },
    dataLakeObjectInfo: dlo,
    refreshConfig: { refreshMode: p.refreshMode, frequency: { frequencyType: "BATCH" } },
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

  // Evidence from dev-org probes 2026-05-05 (see feedback notes on
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
  if (ct === "SalesforceDotCom") {
    // Same-org CRM (Home): only the REFERENCED built-in connector (via
    // Connection.fromExisting / Connection.salesforceHome) is supported.
    // External SalesforceDotCom connections (cross-org OAuth) use a different
    // create flow afd360 doesn't implement yet.
    if (conn.isExisting) return "SalesforceHome";
    throw new Error(
      `DataStream: connectorType "SalesforceDotCom" is only supported for the ` +
        `built-in same-org CRM (Home) connector. Reference it with ` +
        `Connection.salesforceHome(stack) (or Connection.fromExisting), not ` +
        `a freshly-created Connection. External cross-org SalesforceDotCom ` +
        `streams are not supported yet.`,
    );
  }
  throw new Error(
    `DataStream does not yet support connectorType "${ct}". ` +
      `Supported: IngestApi, AwsS3, SNOWFLAKE, BigQuery, SalesforceHome (same-org CRM).`,
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
    // DLO naming is connector-specific — SalesforceHome uses `<Object>_Home__dll`
    // (with a trailing __c stripped), NOT `<Object>__dll`. Using the wrong form
    // here makes adopt-detection miss a pre-existing Home stream (e.g. the
    // platform-provisioned Account_Home), so the op is misclassified as
    // `create` and the platform idempotently resolves it to the existing
    // stream — a diff/reality mismatch. Keep in sync with this.dlo / the builder.
    const wantedDlo =
      props.connectorType === "SalesforceHome"
        ? salesforceHomeDloName(props.sourceObject)
        : `${props.sourceObject}__dll`;
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
    // provisioning lag. prior tooling retries 6 × 15s. We preserve 5xx baseline too.
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
      // DLO in place when it has dependent mappings (evidence: dev-org C5
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

    // Post-delete: best-effort cleanup of the stream's OWN source DLO. The
    // cascade (shouldDeleteDataLakeObject:true) returns 204 but SILENTLY NO-OPs
    // the DLO delete whenever another object still references it — and a mapped
    // DMO is exactly such a dependent. In a full `destroy` that DMO is torn
    // down LATER in the same reverse-topo pass: DataStream and DMO have no
    // dependsOn edge (the real link is DLO↔DMO via the Mapping, not a construct
    // edge), so their relative order is arbitrary and the stream often goes
    // first. At THIS point the DLO delete therefore can't land no matter how
    // long we retry — live-confirmed (a live org, 2026-10-02): the DLO was still
    // present minutes after this ran, and only a FRESH delete issued AFTER the
    // DMO was gone succeeded (the earlier 204s did not land late). The proper
    // fix for that case is a destroy-only post-loop DLO sweep that runs once
    // every DMO is deleted (see the TODO in cli/destroy.ts). This loop stays as
    // cheap best-effort for streams with NO dependent DMO (or a genuine
    // transient platform settle), where re-issuing the delete a moment later
    // does make it take. We poll GET→404, re-issuing the delete each attempt;
    // if the budget elapses we WARN (not silently) and return rather than block
    // teardown — a surviving orphan is the user's to clean up, not fatal.
    if (dloName) {
      const name = dloName;
      try {
        await pollUntil<true>(
          async () => {
            // Gone yet?
            try {
              await ctx.client.dataLakeObjects.get(name);
            } catch (err) {
              if (isNotFound(err)) return true; // confirmed gone — done.
              return null; // transient read error — keep polling, don't abort.
            }
            // Still present — (re-)issue the delete; the next poll verifies.
            try {
              await retryOn5xx(() => ctx.client.dataLakeObjects.delete(name));
            } catch (err) {
              if (isNotFound(err)) return true; // raced to gone.
              // Delete deferred/failed (e.g. still referenced) — keep polling.
            }
            return null;
          },
          { intervalMs: 5_000, timeoutMs: 60_000 },
        );
      } catch (err) {
        if (err instanceof PollTimeoutError) {
          process.stderr.write(
            `  warning: DataStream teardown left its backing DLO "${name}" on-org. Its ` +
              `delete can only land once every object that references it (e.g. a mapped DMO) ` +
              `is gone, and that didn't clear within ${Math.round(err.elapsedMs / 1000)}s. The ` +
              `rest of the teardown continued. Re-running destroy will NOT retry this (state ` +
              `is already cleared and the stream record is gone) — delete it manually: ` +
              `DELETE /ssot/data-lake-objects/${name}\n`,
          );
          return;
        }
        if (isNotFound(err)) return; // already gone, good.
        // Any other error: don't block teardown.
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
    //                   take minutes (prior tooling saw "did not activate within 60s"
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
    // transition to ERROR on their own (evidence: dev-org C3 on
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

/**
 * Resource ops for a DataStream afd360 REFERENCES but does not own — built via
 * {@link DataStream.fromExisting}. The canonical case is a platform-provisioned
 * same-org CRM (Home) stream (e.g. `Account_Home`, which Data Cloud creates
 * automatically): the author wants its DLO as a {@link Mapping} source without
 * afd360 owning — and, critically, without `destroy` deleting — a stream and
 * DLO it never provisioned.
 *
 * Contract vs the owned {@link DataStreamResource}:
 *  - create: never POSTs. Adopts the pre-existing stream by its DLO name (via
 *    lookupByProps) so its id/apiName land in state for dependent Mappings.
 *    Errors loudly if no such stream exists — fromExisting references, it does
 *    not create.
 *  - delete: NO-OP. Deleting a referenced stream would also drop its DLO (the
 *    owned delete cascades the DLO), breaking every Mapping that reads it. This
 *    is the whole reason the reference lifecycle exists.
 *  - isFailed / matchesAuthored: never force a recreate — we don't own the
 *    stream, and a recreate would delete-then-fail (create throws). The
 *    computeOp ownership gate also holds referenced resources at noop.
 */
export const ExistingDataStreamResource: Resource<DataStreamResourceProps, DataStreamOutput> = {
  type: "DataStream",
  surface: "connect",
  idOf: DataStreamResource.idOf,
  read: DataStreamResource.read,
  lookupByProps: DataStreamResource.lookupByProps!,
  isFailed: () => false,
  matchesAuthored: () => true,

  async create(ctx, props): Promise<DataStreamOutput> {
    const existing = await DataStreamResource.lookupByProps!(ctx, props);
    if (!existing) {
      throw new Error(
        `DataStream.fromExisting("${props.sourceObject}"): no data stream with DLO ` +
          `"${props.connectorType === "SalesforceHome" ? salesforceHomeDloName(props.sourceObject) : `${props.sourceObject}__dll`}" ` +
          `exists under connection "${props.connectionName}". fromExisting REFERENCES a ` +
          `pre-existing stream (e.g. a platform-provisioned Home stream) — it does not ` +
          `create one. Verify the source object, or let a normal DataStream create it.`,
      );
    }
    return existing;
  },

  async update(ctx, salesforceId): Promise<DataStreamOutput> {
    const live = await DataStreamResource.read(ctx, salesforceId);
    if (!live) {
      throw new Error(
        `DataStream.fromExisting: referenced stream ${salesforceId} vanished from the org.`,
      );
    }
    return live;
  },

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async delete(): Promise<void> {
    // Intentionally a no-op — see the resource doc comment. afd360 must never
    // delete a stream (or its DLO) it only references.
  },

  hash: DataStreamResource.hash,
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface DataStreamOpts {
  readonly dependsOn?: readonly Construct[];
  /**
   * Per-resource poll tuning for create-time isReady. Defaults match prior tooling:
   * 2s interval, 60s total (waitForActive in prior tooling uses 2s × 30 = 60s).
   */
  readonly readyIntervalMs?: number;
  readonly readyTimeoutMs?: number;
  /** Internal: set by {@link DataStream.fromExisting} to swap in the reference lifecycle. */
  readonly existing?: boolean;
}

export class DataStream extends Construct {
  readonly resource: Resource<DataStreamResourceProps, DataStreamOutput>;
  /**
   * True when this construct only REFERENCES a pre-existing data stream (built
   * via {@link DataStream.fromExisting}) rather than owning it. Referenced
   * streams are adopted on deploy and skipped on destroy (their DLO survives so
   * downstream Mappings keep working). The computeOp ownership gate and destroy
   * both branch on this.
   */
  readonly isExisting: boolean;
  readonly devName: string;
  readonly props: DataStreamResourceProps;
  readonly dependsOn: readonly Construct[];
  /**
   * DLO reference for M5 Mapping. The DLO dev name is known at synth time —
   * the platform appends __dll per prior tooling convention — so downstream Mapping can
   * reference `stream.dlo.name` without needing deploy state.
   */
  readonly dlo: { readonly name: string };
  /** Read by the deploy runner when polling isReady. */
  readonly readyIntervalMs: number;
  readonly readyTimeoutMs: number;

  /**
   * Reference a data stream the platform (or a human) already provisioned,
   * instead of creating one. The canonical case is a platform-provisioned
   * same-org CRM (Home) stream (e.g. `Account_Home`, auto-created by Data
   * Cloud): reference it so its DLO can be a {@link Mapping} source, without
   * afd360 owning it or deleting it (and its DLO) on `destroy`.
   *
   * afd360 adopts the stream by its DLO name on deploy (recording id/apiName so
   * dependent Mappings resolve) and NEVER deletes it on destroy. Pass the same
   * `connection` (typically {@link Connection.salesforceHome}) and
   * `sourceObject` you would for an owned stream; the DLO name is derived
   * identically, so `stream.dlo.name` is a valid Mapping source.
   */
  static fromExisting(
    scope: Stack,
    id: string,
    props: {
      connection: Connection;
      sourceObject: string;
      primaryKey?: DataStreamPrimaryKey;
      category?: DloCategory;
      label?: string;
      recordModifiedFieldName?: string;
    },
  ): DataStream {
    const streamProps: DataStreamProps = {
      connection: props.connection,
      sourceObject: props.sourceObject,
      // PK is only used for owned creates; a referenced stream is adopted by
      // DLO name. Default to "Id" (present on every sObject) so callers
      // referencing a Home stream needn't restate it.
      primaryKey: props.primaryKey ?? { name: "Id" },
      ...(props.category ? { category: props.category } : {}),
      ...(props.label ? { label: props.label } : {}),
      ...(props.recordModifiedFieldName
        ? { recordModifiedFieldName: props.recordModifiedFieldName }
        : {}),
    };
    return new DataStream(scope, id, streamProps, { existing: true });
  }

  constructor(scope: Stack, id: string, props: DataStreamProps, opts: DataStreamOpts = {}) {
    super(scope, id);
    this.isExisting = opts.existing ?? false;
    this.resource = this.isExisting ? ExistingDataStreamResource : DataStreamResource;
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
    // IngestApi: the stream's event (sourceObject) is matched by the platform
    // against the schema object's dev NAME — not its label. The create payload
    // sends `events: [sourceObject]` (buildIngestApiPayload) while the schema
    // object is PUT with `name: schemaName` (ConnectionSchema). When these
    // disagree the platform fails with an opaque
    //   `400 INTERNAL_ERROR: Unable to create a data-stream`
    // with no field-level detail. `schema.name` defaults to the ConnectionSchema
    // construct id (`<connId>Schema`) when omitted, so authoring
    // `sourceObject` to match `schema.label` (the intuitive pairing) silently
    // mismatches. Catch it at synth with an actionable message instead.
    if (connectorType === "IngestApi" && props.connection.schema) {
      const schemaObjectName = props.connection.schema.schemaName;
      if (props.sourceObject !== schemaObjectName) {
        throw new Error(
          `DataStream "${id}": sourceObject "${props.sourceObject}" must equal the ` +
            `IngestApi schema object name "${schemaObjectName}". The platform matches ` +
            `the stream event to the schema object by name (not label); a mismatch ` +
            `fails with an opaque "400 INTERNAL_ERROR: Unable to create a data-stream". ` +
            `Fix: set the connection's schema.name to "${props.sourceObject}", or set ` +
            `sourceObject to "${schemaObjectName}". (schema.name defaults to the ` +
            `ConnectionSchema construct id when omitted — it is NOT the schema label.)`,
        );
      }
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
    if (props.recordModifiedFieldName) {
      resolvedProps = { ...resolvedProps, recordModifiedFieldName: props.recordModifiedFieldName };
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

    // DLO naming is connector-specific: same-org CRM (Home) streams get
    // `<Object>_Home__dll` with a trailing `__c` stripped (see
    // salesforceHomeDloName); everything else `<Object>__dll`.
    this.dlo = {
      name:
        connectorType === "SalesforceHome"
          ? salesforceHomeDloName(props.sourceObject)
          : `${props.sourceObject}__dll`,
    };
    // Defaults: 5 s × 60 attempts = 5 minutes. prior tooling regularly observed
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
    const resolved: DataStreamResourceProps = { ...this.props, connectionName: parentRef.apiName };
    // Same-org CRM (Home): the stream's `datasource` is the connection's
    // dataSource field ("Salesforce_Home"), not its dev name
    // ("SalesforceDotCom_Home"). The Connection construct carries it.
    if (conn.dataSourceName !== undefined) {
      return { ...resolved, datasourceName: conn.dataSourceName };
    }
    return resolved;
  }
}
/** Re-exported so userland code can name-check schema types in tests. */
export type { ConnectionSchema };
