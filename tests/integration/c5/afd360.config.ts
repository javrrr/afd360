/**
 * C5 — Relationship deploy + destroy on jaygentforce.
 *
 *   Connection (S3) → DataStream → DLO
 *                                    ├─ Mapping → DMO A (Readings)
 *                                    └─ Mapping → DMO B (Engine)
 *                                                   ▲
 *                                    Relationship ──┘
 *                                    (Readings.EngineId → Engine.Id)
 *
 * Two DMOs sharing one DLO (same engine_data.csv): `Readings` carries the
 * per-row data; `Engine` holds a coarser aggregation keyed by Id. The
 * Relationship establishes a ManyToOne from Readings → Engine on Id.
 *
 * Why share the DLO: Relationship requires both source and target DMOs to
 * have DLO→DMO mappings. Using one stream means C5 validates the
 * Relationship resource without having to provision a second file in S3.
 *
 * All resources survive an idempotent redeploy with zero writes. Destroy
 * reverses cleanly. Teardown of the stranded Connection (C4-style 500 on
 * healthy-looking connection deletes) may need a manual UI step — that's a
 * separate issue from M6.
 */
import {
  App,
  Stack,
  Connection,
  DataStream,
  DMO,
  Mapping,
  Relationship,
} from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360C5", { targetOrg: "jaygentforce" });

const conn = new Connection(stack, "C5S3Conn", {
  connectorType: "AwsS3",
  label: "afd360 c5 s3",
  method: "Ingress",
  credentials: {
    authenticationOption: "accessKeyAndSecret",
    accessKey: "${env.AWS_ACCESS_KEY}",
    accessSecret: "${env.AWS_ACCESS_SECRET}",
  },
  parameters: { bucketName: "cdp-data-javier", parentDirectory: "/" },
});

const stream = new DataStream(stack, "C5Stream", {
  connection: conn,
  sourceObject: "c5EngineReadings",
  label: "C5 engine readings",
  primaryKey: { name: "Id", dataType: "Text" },
  category: "Other",
  refreshMode: "UPSERT",
  s3: {
    fileType: "CSV",
    importDirectory: "demo",
    fileName: "engine_data.csv",
    areHeadersIncludedInFile: "true",
    fields: [
      { name: "Id",               dataType: "Text",   isPrimaryKey: true },
      { name: "Engine rpm",       dataType: "Number" },
      { name: "Lub oil pressure", dataType: "Number" },
      { name: "Fuel pressure",    dataType: "Number" },
      { name: "Coolant pressure", dataType: "Number" },
      { name: "lub oil temp",     dataType: "Number" },
      { name: "Coolant temp",     dataType: "Number" },
      { name: "Engine Condition", dataType: "Number" },
    ],
  },
});

// Parent DMO (Engine) — keyed by the same Id; the FK target.
const engine = new DMO(stack, "C5Engine", {
  label: "C5 Engine",
  category: "Other",
  fields: [
    { name: "Id", label: "Id", dataType: "Text", isPrimaryKey: true },
  ],
});

// Child DMO (Readings) — carries per-reading details + a reference to Engine.
const readings = new DMO(stack, "C5Readings", {
  label: "C5 Readings",
  category: "Other",
  fields: [
    { name: "Id",              label: "Id",              dataType: "Text",   isPrimaryKey: true },
    { name: "EngineId",        label: "Engine Id",       dataType: "Text" },
    { name: "EngineRpm",       label: "Engine RPM",      dataType: "Number" },
    { name: "CoolantPressure", label: "Coolant Pressure", dataType: "Number" },
  ],
});

// Map the shared DLO into Engine (just Id → Id).
const engineMapping = new Mapping(stack, "C5EngineMapping", {
  source: stream,
  target: engine,
  fieldMappings: [{ source: "Id__c", target: "Id__c" }],
});

// Map the shared DLO into Readings (Id + FK + a couple of sensor values).
const readingsMapping = new Mapping(stack, "C5ReadingsMapping", {
  source: stream,
  target: readings,
  fieldMappings: [
    { source: "Id__c",               target: "Id__c" },
    { source: "Id__c",               target: "EngineId__c" }, // self-key as FK; simplest
    { source: "Engine_rpm__c",       target: "EngineRpm__c" },
    { source: "Coolant_pressure__c", target: "CoolantPressure__c" },
  ],
});

// The relationship — ManyToOne Readings.EngineId → Engine.Id.
// Explicit Mapping deps because `createRelationships` requires both DMOs
// to have ObjectSourceTargetMaps at relationship-create time (see memory
// note feedback_createrelationships-requires-mappings.md).
new Relationship(stack, "C5ReadingsToEngine", {
  source: readings,
  sourceField: "EngineId",
  target: engine,
  targetField: "Id",
  cardinality: "ManyToOne",
  dependsOn: [engineMapping, readingsMapping],
});

export default app;
