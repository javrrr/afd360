/**
 * C4 — 4-resource topological deploy against jaygentforce.
 *
 *   Connection (AwsS3) → DataStream → DMO → Mapping
 *
 * Validates:
 *   - AwsS3 DataStream path (datastreamType=CONNECTORSFRAMEWORK + advancedAttributes)
 *   - DMO create + readiness (dataSpaceName populated, quirk B2)
 *   - Mapping create (sourceDloName → targetDmoName, fieldMapping[])
 *   - Topological ordering: Conn → Stream → DMO in parallel → Mapping
 *   - Idempotent redeploy → 0 writes
 *   - Clean destroy (DMO cascade removes the Mapping — quirk B3)
 *
 * Points at demo/engine_data.csv in the cdp-data-javier bucket. That file
 * has the sensor-telemetry schema: Id (PK, Text), Engine_rpm (Number),
 * Coolant_pressure (Number), etc. An existing `enginedatacsv_cdp_data_javier`
 * stream in the org already proves the file is readable; this C4 stack
 * just stands up a parallel one with its own DLO, DMO, and mapping.
 */
import { App, Stack, Connection, DataStream, DMO, Mapping } from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360C4", { targetOrg: "jaygentforce" });

const conn = new Connection(stack, "C4S3Conn", {
  connectorType: "AwsS3",
  label: "afd360 c4 s3",
  method: "Ingress",
  credentials: {
    authenticationOption: "accessKeyAndSecret",
    accessKey: "${env.AWS_ACCESS_KEY}",
    accessSecret: "${env.AWS_ACCESS_SECRET}",
  },
  parameters: {
    bucketName: "cdp-data-javier",
    parentDirectory: "/",
  },
});

const stream = new DataStream(stack, "C4Stream", {
  connection: conn,
  sourceObject: "engineData",
  label: "C4 engine data",
  primaryKey: { name: "Id", dataType: "Text" },
  category: "Engagement",
  refreshMode: "UPSERT",
  s3: {
    fileType: "CSV",
    importDirectory: "demo",
    fileName: "engine_data.csv",
    areHeadersIncludedInFile: "true",
  },
});

const dmo = new DMO(stack, "C4EngineTelemetry", {
  label: "C4 Engine Telemetry",
  category: "Engagement",
  fields: [
    { name: "Id",               label: "Id",               dataType: "Text",     isPrimaryKey: true },
    { name: "EngineRpm",        label: "Engine RPM",       dataType: "Number" },
    { name: "CoolantPressure",  label: "Coolant Pressure", dataType: "Number" },
    { name: "CoolantTemp",      label: "Coolant Temp",     dataType: "Number" },
    { name: "FuelPressure",     label: "Fuel Pressure",    dataType: "Number" },
    { name: "LubOilPressure",   label: "Lub Oil Pressure", dataType: "Number" },
    { name: "LubOilTemp",       label: "Lub Oil Temp",     dataType: "Number" },
    { name: "EngineCondition",  label: "Engine Condition", dataType: "Number" },
    { name: "TimeStamp",        label: "Time Stamp",       dataType: "DateTime" },
  ],
});

// Field mappings: DLO field names (from sourceFields, snake_case + __c) →
// DMO field names (CamelCase + __c). Platform auto-suffixes both sides.
new Mapping(stack, "C4EngineMapping", {
  source: stream,
  target: dmo,
  fieldMappings: [
    { source: "Id__c",               target: "Id__c" },
    { source: "Engine_rpm__c",       target: "EngineRpm__c" },
    { source: "Coolant_pressure__c", target: "CoolantPressure__c" },
    { source: "Coolant_temp__c",     target: "CoolantTemp__c" },
    { source: "Fuel_pressure__c",    target: "FuelPressure__c" },
    { source: "Lub_oil_pressure__c", target: "LubOilPressure__c" },
    { source: "lub_oil_temp__c",     target: "LubOilTemp__c" },
    { source: "Engine_Condition__c", target: "EngineCondition__c" },
    { source: "Time_Stamp__c",       target: "TimeStamp__c" },
  ],
});

export default app;
