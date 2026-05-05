/**
 * afd360 starter — a minimal RAG pipeline.
 *
 *   S3 Connection → DataStream → DMO → Mapping → SearchIndex
 *
 * What this deploys:
 *   1. An AwsS3 Connection to a bucket holding your source CSVs.
 *   2. A DataStream that ingests a CSV into a new DLO (data lake object).
 *   3. A DMO (data model object) that gives the DLO a structured schema.
 *   4. A Mapping wiring the DLO fields to the DMO fields.
 *   5. A SearchIndex over the DMO so an Agentforce agent can retrieve docs.
 *
 * Before deploying:
 *   1. `cp .env.example .env` and fill in your S3 credentials + bucket.
 *   2. Update the SOURCE_* constants below to point at your data.
 *   3. `afd360 whoami --org <alias>` to verify auth.
 *   4. `afd360 diff --org <alias>` to preview, then `afd360 deploy --org <alias>`.
 *
 * See docs/resources.md for full prop reference.
 */
import { App, Stack, Connection, DataStream, DMO, Mapping, SearchIndex } from "afd360";

// ── Configure these ─────────────────────────────────────────────────────────

/** sf CLI org alias. Run `sf org list` to see yours. */
const TARGET_ORG = "my-scratch-org";

/** S3 bucket + directory where your source CSVs live. */
const SOURCE_BUCKET = "my-rag-docs";
const SOURCE_DIR = "docs";
const SOURCE_FILE = "articles.csv";

// ── Stack ───────────────────────────────────────────────────────────────────

const app = new App();
const stack = new Stack(app, "RagStarter", { targetOrg: TARGET_ORG });

const conn = new Connection(stack, "DocsS3", {
  connectorType: "AwsS3",
  label: "Docs S3",
  method: "Ingress",
  credentials: {
    authenticationOption: "accessKeyAndSecret",
    accessKey: "${env.AWS_ACCESS_KEY}",
    accessSecret: "${env.AWS_ACCESS_SECRET}",
  },
  parameters: {
    bucketName: SOURCE_BUCKET,
    parentDirectory: "/",
  },
});

const stream = new DataStream(stack, "DocsStream", {
  connection: conn,
  sourceObject: "articles",
  label: "Articles",
  primaryKey: { name: "Id", dataType: "Text" },
  category: "Other",
  refreshMode: "UPSERT",
  s3: {
    fileType: "CSV",
    importDirectory: SOURCE_DIR,
    fileName: SOURCE_FILE,
    areHeadersIncludedInFile: "true",
    // CSV headers, preserved verbatim (spaces allowed — platform normalizes
    // to underscores on the DLO side).
    fields: [
      { name: "Id",    dataType: "Text", isPrimaryKey: true },
      { name: "Title", dataType: "Text" },
      { name: "Body",  dataType: "Text" },
    ],
  },
});

const dmo = new DMO(stack, "Articles", {
  label: "Articles",
  category: "Other",
  fields: [
    { name: "Id",    label: "Id",    dataType: "Text", isPrimaryKey: true },
    { name: "Title", label: "Title", dataType: "Text" },
    { name: "Body",  label: "Body",  dataType: "Text" },
  ],
});

new Mapping(stack, "ArticlesMapping", {
  source: stream,
  target: dmo,
  fieldMappings: [
    { source: "Id__c",    target: "Id__c" },
    { source: "Title__c", target: "Title__c" },
    { source: "Body__c",  target: "Body__c" },
  ],
});

new SearchIndex(stack, "ArticlesIdx", {
  label: "Articles Search",
  sourceDmo: dmo,
  searchType: "HYBRID",
  processingType: "NEAR_REALTIME",
  fields: [
    {
      fieldDeveloperName: "Body__c",
      decorators: [
        // Prepend the article title onto every chunk so vector matches
        // return contextually grounded snippets.
        {
          decoratorId: "prepend",
          dmoDeveloperName: dmo.fullName,
          dmoFieldDeveloperName: "Title__c",
        },
      ],
    },
  ],
  // vectorRelatedFields defaults to the source DMO's PK; override if you
  // want to index extra filterable fields alongside the embedding.
});

export default app;
