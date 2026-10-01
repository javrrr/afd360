import { describe, it, expect } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { stateEntry } from "../../src/cli/deploy.js";
import { protect } from "../../src/core/construct.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";

function mkStack() {
  const app = new App();
  return new Stack(app, "S", { targetOrg: "org" });
}

function mkConnection(stack: Stack) {
  return new Connection(stack, "Conn", {
    connectorType: "IngestApi",
    label: "Conn",
    schema: { label: "Sch", fields: [{ name: "Id", dataType: "Text" }] },
  });
}

describe("stateEntry (deploy state persistence)", () => {
  it("omits `protected` for an un-flagged construct", () => {
    const conn = mkConnection(mkStack());
    const entry = stateEntry(conn, "0sH", "Conn_api", "h", undefined, true);
    expect(entry.protected).toBeUndefined();
  });

  it("persists `protected: true` when the construct was flagged with protect()", () => {
    const conn = protect(mkConnection(mkStack()));
    const entry = stateEntry(conn, "0sH", "Conn_api", "h", undefined, true);
    expect(entry.protected).toBe(true);
  });

  it("records owned provenance and dependsOn edges alongside the protect flag", () => {
    const stack = mkStack();
    const conn = mkConnection(stack);
    const stream = protect(
      new DataStream(stack, "Stream", {
        connection: conn,
        sourceObject: "ConnSchema",
        primaryKey: { name: "Id" },
      }),
    );
    const entry = stateEntry(stream, "0ds", "Stream_api", "h", undefined, true);
    expect(entry.owned).toBe(true);
    expect(entry.protected).toBe(true);
    expect(entry.dependsOn).toContain(conn.uniqueId);
  });
});
