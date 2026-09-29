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
    // `name` is the schema object's dev name. The DataStream below matches its
    // `sourceObject` (the ingest event) against THIS name — not the label — so
    // they must be equal. Omitting `name` defaults it to the construct id
    // ("DocsIngestSchema"), which would NOT match sourceObject and fails with
    // an opaque "400 INTERNAL_ERROR: Unable to create a data-stream".
    name: "KnowledgeBase",
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
  sourceObject: "KnowledgeBase", // must equal the schema object name above
  label: "Docs Stream",
  category: "Other",
  refreshMode: "UPSERT",
  primaryKey: { name: "Id", dataType: "Text" },
});

export default app;
