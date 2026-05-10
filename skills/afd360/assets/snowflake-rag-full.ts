/**
 * Full RAG pipeline over a Snowflake table.
 *
 *   Snowflake (DB.SCHEMA.TABLE) → DataStream → DLO → DMO → Mapping → SearchIndex
 *
 * Three field lists need to be kept in sync:
 *   1. snowflake.fields  — Snowflake column names (typically UPPERCASE)
 *   2. dmo.fields        — DMO field names (CamelCase, no __c — platform adds it)
 *   3. mapping.fieldMappings — DLO column (__c) → DMO field (__c)
 *
 * The example uses an NTO Products schema. Replace with the user's
 * actual columns.
 */
import { App, Stack, Connection, DataStream, DMO, Mapping, SearchIndex } from "afd360";

const TARGET_ORG = "my-org";

// Snowflake table coordinates.
const SF_DATABASE = "MY_DB";
const SF_SCHEMA = "PUBLIC";
const SF_OBJECT = "PRODUCTS";

const app = new App();
const stack = new Stack(app, "Rag", { targetOrg: TARGET_ORG });

const conn = new Connection(stack, "MySnowflake", {
  connectorType: "SNOWFLAKE",
  label: "Snowflake",
  method: "Ingress",
  credentials: {
    authenticationOption: "KeyPair",
    user: "${env.SNOWFLAKE_USER}",
    privateKey: "${pem:${env.SNOWFLAKE_PRIVATE_KEY_PATH}}",
  },
  parameters: {
    accountUrl: "${env.SNOWFLAKE_ACCOUNT_URL}",
    warehouse: "${env.SNOWFLAKE_WAREHOUSE}",
    region: "${env.SNOWFLAKE_REGION}",
    unloadData: "true",
    hasPrivateNetworkRoute: "false",
  },
});

const stream = new DataStream(stack, "ProductsStream", {
  connection: conn,
  sourceObject: "Products",
  label: "Products (Snowflake)",
  category: "Other",
  refreshMode: "TOTAL_REPLACE",
  primaryKey: { name: "ID", dataType: "Text" },
  snowflake: {
    database: SF_DATABASE,
    schema: SF_SCHEMA,
    object: SF_OBJECT,
    fields: [
      { name: "ID",              dataType: "Text", isPrimaryKey: true },
      { name: "NAME",            dataType: "Text" },
      { name: "DESCRIPTION",     dataType: "Text" },
      { name: "LONGDESCRIPTION", dataType: "Text" },
      { name: "CATEGORY1",       dataType: "Text" },
      { name: "PRODUCTSKU",      dataType: "Text" },
    ],
  },
});

const dmo = new DMO(stack, "Product", {
  name: "Product",
  label: "Product",
  category: "Other",
  fields: [
    { name: "Id",              label: "Id",               dataType: "Text", isPrimaryKey: true },
    { name: "Name",             label: "Name",             dataType: "Text" },
    { name: "Description",      label: "Description",      dataType: "Text" },
    { name: "LongDescription",  label: "Long Description", dataType: "Text" },
    { name: "Category1",        label: "Category 1",       dataType: "Text" },
    { name: "ProductSKU",       label: "Product SKU",      dataType: "Text" },
  ],
});

new Mapping(stack, "ProductsMapping", {
  source: stream,
  target: dmo,
  fieldMappings: [
    { source: "ID__c",              target: "Id__c" },
    { source: "NAME__c",            target: "Name__c" },
    { source: "DESCRIPTION__c",     target: "Description__c" },
    { source: "LONGDESCRIPTION__c", target: "LongDescription__c" },
    { source: "CATEGORY1__c",       target: "Category1__c" },
    { source: "PRODUCTSKU__c",      target: "ProductSKU__c" },
  ],
});

new SearchIndex(stack, "ProductsIdx", {
  label: "Products Search",
  sourceDmo: dmo,
  searchType: "HYBRID",
  processingType: "NEAR_REALTIME",
  fields: [
    {
      fieldDeveloperName: "LongDescription__c",
      decorators: [
        // Prepend the product Name onto each chunk so vector matches
        // return contextually grounded snippets.
        {
          decoratorId: "prepend",
          dmoDeveloperName: dmo.fullName,
          dmoFieldDeveloperName: "Name__c",
        },
      ],
    },
    {
      fieldDeveloperName: "Description__c",
      decorators: [
        {
          decoratorId: "prepend",
          dmoDeveloperName: dmo.fullName,
          dmoFieldDeveloperName: "Name__c",
        },
      ],
    },
  ],
  vectorRelatedFields: [
    { dmoDeveloperName: dmo.fullName, fieldDeveloperName: "Id__c" },
    { dmoDeveloperName: dmo.fullName, fieldDeveloperName: "Category1__c" },
    { dmoDeveloperName: dmo.fullName, fieldDeveloperName: "ProductSKU__c" },
  ],
});

export default app;
