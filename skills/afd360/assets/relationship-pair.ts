/**
 * Two related DMOs with a foreign key.
 *
 *   accounts.csv → AccountDMO ←─┐
 *                                │ Relationship (orders.AccountId → accounts.Id, ManyToOne)
 *   orders.csv   → OrderDMO   ──┘
 */
import {
  App,
  Stack,
  Connection,
  DataStream,
  DMO,
  Mapping,
  Relationship,
} from "afd360";

const TARGET_ORG = "my-org";
const BUCKET_NAME = "my-bucket";

const app = new App();
const stack = new Stack(app, "Rel", { targetOrg: TARGET_ORG });

const conn = new Connection(stack, "DataS3", {
  connectorType: "AwsS3",
  label: "Data S3",
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

// ── Accounts ────────────────────────────────────────────────────────────────

const accountsStream = new DataStream(stack, "AccountsStream", {
  connection: conn,
  sourceObject: "accounts",
  label: "Accounts",
  category: "Other",
  refreshMode: "UPSERT",
  primaryKey: { name: "Id", dataType: "Text" },
  s3: {
    fileType: "CSV",
    fileName: "accounts.csv",
    areHeadersIncludedInFile: "true",
    fields: [
      { name: "Id",   dataType: "Text", isPrimaryKey: true },
      { name: "Name", dataType: "Text" },
    ],
  },
});

const accountDmo = new DMO(stack, "Account", {
  name: "Account",
  label: "Account",
  category: "Other",
  fields: [
    { name: "Id",   label: "Id",   dataType: "Text", isPrimaryKey: true },
    { name: "Name", label: "Name", dataType: "Text" },
  ],
});

new Mapping(stack, "AccountsMapping", {
  source: accountsStream,
  target: accountDmo,
  fieldMappings: [
    { source: "Id__c",   target: "Id__c" },
    { source: "Name__c", target: "Name__c" },
  ],
});

// ── Orders ──────────────────────────────────────────────────────────────────

const ordersStream = new DataStream(stack, "OrdersStream", {
  connection: conn,
  sourceObject: "orders",
  label: "Orders",
  category: "Other",
  refreshMode: "UPSERT",
  primaryKey: { name: "Id", dataType: "Text" },
  s3: {
    fileType: "CSV",
    fileName: "orders.csv",
    areHeadersIncludedInFile: "true",
    fields: [
      { name: "Id",        dataType: "Text",   isPrimaryKey: true },
      { name: "AccountId", dataType: "Text"   },
      { name: "Total",     dataType: "Number" },
    ],
  },
});

const orderDmo = new DMO(stack, "Order", {
  name: "Order",
  label: "Order",
  category: "Other",
  fields: [
    { name: "Id",        label: "Id",         dataType: "Text",   isPrimaryKey: true },
    { name: "AccountId", label: "Account Id", dataType: "Text"   },
    { name: "Total",     label: "Total",      dataType: "Number" },
  ],
});

new Mapping(stack, "OrdersMapping", {
  source: ordersStream,
  target: orderDmo,
  fieldMappings: [
    { source: "Id__c",        target: "Id__c" },
    { source: "AccountId__c", target: "AccountId__c" },
    { source: "Total__c",     target: "Total__c" },
  ],
});

// ── Foreign-key relationship: orders.AccountId → accounts.Id ────────────────

new Relationship(stack, "OrderAccount", {
  source: orderDmo,
  sourceField: "AccountId",
  target: accountDmo,
  targetField: "Id",
  cardinality: "ManyToOne",
  relationshipOwner: "DataCloud",
});

export default app;
