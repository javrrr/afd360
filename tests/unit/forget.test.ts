import { describe, it, expect } from "vitest";
import { App, Stack } from "../../src/core/app.js";
import { Connection } from "../../src/resources/connection.js";
import { DataStream } from "../../src/resources/data-stream.js";
import { findForgetBlockers } from "../../src/cli/forget.js";
import type { ResourceConstruct } from "../../src/core/app.js";
import type { Construct } from "../../src/core/construct.js";

/**
 * Build a Connection → DataStream pair so the stream genuinely depends on the
 * connection (auto-wired dependsOn), giving us a real edge to test the guard.
 */
function buildPair(): {
  conn: Connection;
  stream: DataStream;
  resources: Array<Construct & ResourceConstruct>;
} {
  const app = new App();
  const stack = new Stack(app, "S", { targetOrg: "dev-org" });
  const conn = new Connection(stack, "DocsIngest", {
    connectorType: "IngestApi",
    label: "Docs",
    schema: { name: "KB", label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
  });
  const stream = new DataStream(stack, "DocsStream", {
    connection: conn,
    sourceObject: "KB",
    primaryKey: { name: "Id" },
  });
  return {
    conn,
    stream,
    resources: [conn, stream] as unknown as Array<Construct & ResourceConstruct>,
  };
}

describe("findForgetBlockers (forget dependency guard)", () => {
  it("blocks forgetting a resource a still-present manifest resource depends on", () => {
    const { conn, stream, resources } = buildPair();
    // Forgetting the Connection while the DataStream still references it.
    const blockers = findForgetBlockers(resources, new Set([conn.uniqueId]));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toBe(`${stream.uniqueId} → ${conn.uniqueId}`);
  });

  it("allows forgetting a leaf resource nothing depends on", () => {
    const { stream, resources } = buildPair();
    // Nothing depends on the DataStream, so forgetting it strands no deploy.
    expect(findForgetBlockers(resources, new Set([stream.uniqueId]))).toEqual([]);
  });

  it("returns no blockers for a target that isn't a dependency of anything", () => {
    const { resources } = buildPair();
    expect(findForgetBlockers(resources, new Set(["S/SomethingElse"]))).toEqual([]);
  });

  it("reports every dependent when multiple resources depend on the target", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "dev-org" });
    const conn = new Connection(stack, "DocsIngest", {
      connectorType: "IngestApi",
      label: "Docs",
      schema: { name: "KB", label: "KB", fields: [{ name: "Id", dataType: "Text" }] },
    });
    const s1 = new DataStream(stack, "StreamOne", {
      connection: conn,
      sourceObject: "KB",
      primaryKey: { name: "Id" },
    });
    const s2 = new DataStream(stack, "StreamTwo", {
      connection: conn,
      sourceObject: "KB",
      primaryKey: { name: "Id" },
    });
    const resources = [conn, s1, s2] as unknown as Array<Construct & ResourceConstruct>;
    const blockers = findForgetBlockers(resources, new Set([conn.uniqueId]));
    expect(blockers).toHaveLength(2);
    expect(blockers).toEqual(
      expect.arrayContaining([
        `${s1.uniqueId} → ${conn.uniqueId}`,
        `${s2.uniqueId} → ${conn.uniqueId}`,
      ]),
    );
  });
});
