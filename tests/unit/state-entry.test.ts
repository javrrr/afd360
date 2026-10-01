import { describe, it, expect } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { stateEntry, reconcileProtected } from "../../src/cli/deploy.js";
import { protect } from "../../src/core/construct.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";
import type { StateResource } from "../../src/core/state.js";

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

describe("reconcileProtected (noop-path RETAIN reconciliation)", () => {
  function existing(over: Partial<StateResource> = {}): StateResource {
    return {
      type: "Connection",
      apiName: "Conn_api",
      salesforceId: "0sH",
      hash: "h",
      createdAt: "t",
      owned: true,
      ...over,
    };
  }

  it("CLEARS a stale protected flag when the construct is no longer protect()ed", () => {
    // The Phase-3 live-validation bug: drop protect(), redeploy = noop, flag
    // must clear so the resource becomes deletable again.
    const entry = existing({ protected: true });
    reconcileProtected(entry, mkConnection(mkStack()));
    expect(entry.protected).toBeUndefined();
  });

  it("SETS the flag when protect() is added to a previously-unprotected noop resource", () => {
    const entry = existing();
    reconcileProtected(entry, protect(mkConnection(mkStack())));
    expect(entry.protected).toBe(true);
  });

  it("is a no-op when protection state already matches (protected stays protected)", () => {
    const entry = existing({ protected: true });
    reconcileProtected(entry, protect(mkConnection(mkStack())));
    expect(entry.protected).toBe(true);
  });

  it("leaves an unprotected entry unprotected (no spurious key)", () => {
    const entry = existing();
    reconcileProtected(entry, mkConnection(mkStack()));
    expect("protected" in entry).toBe(false);
  });
});
