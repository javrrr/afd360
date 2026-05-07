/**
 * Full RAG pipeline over a CSV file in S3.
 *
 *   S3 CSV → DataStream (CSV ingest) → DLO → DMO → Mapping → SearchIndex
 *
 * Three field lists need to be kept in sync:
 *   1. s3.fields              — literal CSV column headers (spaces OK)
 *   2. dmo.fields             — DMO field names (CamelCase, no __c)
 *   3. mapping.fieldMappings  — DLO column (underscore form + __c) → DMO field (__c)
 */
import { App, Stack, Connection, DataStream, DMO, Mapping, SearchIndex } from "afd360";

const TARGET_ORG = "my-org";
const BUCKET_NAME = "my-bucket";
const SOURCE_DIR = "knowledge";
const SOURCE_FILE = "articles.csv";

const app = new App();
const stack = new Stack(app, "Rag", { targetOrg: TARGET_ORG });

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
    bucketName: BUCKET_NAME,
    parentDirectory: "/",
  },
});

const stream = new DataStream(stack, "ArticlesStream", {
  connection: conn,
  sourceObject: "articles",
  label: "Articles",
  category: "Other",
  refreshMode: "UPSERT",
  primaryKey: { name: "Id", dataType: "Text" },
  s3: {
    fileType: "CSV",
    importDirectory: SOURCE_DIR,
    fileName: SOURCE_FILE,
    areHeadersIncludedInFile: "true",
    fields: [
      { name: "Id",    dataType: "Text", isPrimaryKey: true },
      { name: "Title", dataType: "Text" },
      { name: "Body",  dataType: "Text" },
    ],
  },
});

const dmo = new DMO(stack, "Article", {
  name: "Article",
  label: "Article",
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
        // Prepend the article Title onto each chunk for retrieval context.
        {
          decoratorId: "prepend",
          dmoDeveloperName: dmo.fullName,
          dmoFieldDeveloperName: "Title__c",
        },
      ],
    },
  ],
});

export default app;
