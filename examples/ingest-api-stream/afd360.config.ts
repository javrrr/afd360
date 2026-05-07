/**
 * IngestApi Connection + Schema + DataStream.
 *
 * No external credentials needed — IngestApi auth is the user's
 * `sf` CLI session. Replace TARGET_ORG, the schema label, and the
 * field set with the user's data shape.
 */
import { App, Stack, Connection, DataStream } from "afd360";

const TARGET_ORG = "my-org";

const app = new App();
const stack = new Stack(app, "Ingest", { targetOrg: TARGET_ORG });

const conn = new Connection(stack, "DocsIngest", {
  connectorType: "IngestApi",
  label: "Docs Ingest",
  schema: {
    label: "KnowledgeBase",
    fields: [
      { name: "Id", dataType: "Text" },
      { name: "Title", dataType: "Text" },
      { name: "Body", dataType: "Text" },
    ],
  },
});

new DataStream(stack, "DocsStream", {
  connection: conn,
  sourceObject: "KnowledgeBase", // matches schema.label
  label: "Docs Stream",
  category: "Other",
  refreshMode: "UPSERT",
  primaryKey: { name: "Id", dataType: "Text" },
});

export default app;
