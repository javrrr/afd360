import { describe, it, expect } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { protect, isProtected } from "../../src/core/construct.js";
import { Connection } from "../../src/resources/connection.js";

function mkConnection() {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "org" });
  return new Connection(stack, "Conn", {
    connectorType: "IngestApi",
    label: "Conn",
    schema: { label: "Sch", fields: [{ name: "Id", dataType: "Text" }] },
  });
}

describe("protect / isProtected", () => {
  it("flags a construct and returns it for inline use", () => {
    const conn = mkConnection();
    const returned = protect(conn);
    expect(returned).toBe(conn);
    expect(isProtected(conn)).toBe(true);
  });

  it("reports false for an un-flagged construct", () => {
    expect(isProtected(mkConnection())).toBe(false);
  });

  it("is idempotent — protecting twice stays protected", () => {
    const conn = protect(protect(mkConnection()));
    expect(isProtected(conn)).toBe(true);
  });
});
