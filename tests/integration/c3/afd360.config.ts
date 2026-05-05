/**
 * C3 — Connection + ConnectionSchema + DataStream round trip.
 * Exercises async polling (ConnectionSchema availabilityStatus, DataStream status=Active)
 * and quirk A1 retry on create.
 */
import { App, Stack, Connection, DataStream } from "../../../src/index.js";

const app = new App();
const stack = new Stack(app, "AFD360C3", { targetOrg: "jaygentforce" });

const conn = new Connection(stack, "C3Ingest", {
  connectorType: "IngestApi",
  label: "afd360_c3_ingest",
  schema: {
    label: "afd360_c3_kb",
    // Primary key only — DLO fields are derived from the schema at the platform.
    fields: [
      { name: "Id", label: "Id", dataType: "Text" },
      { name: "Title", label: "Title", dataType: "Text" },
    ],
  },
});

new DataStream(stack, "C3Stream", {
  connection: conn,
  sourceObject: conn.schema!.schemaName,
  primaryKey: { name: "Id", label: "Id", dataType: "Text" },
  category: "Other",
  refreshMode: "UPSERT",
});

export default app;
