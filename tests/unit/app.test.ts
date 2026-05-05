import { describe, it, expect } from "vitest";
import { App, Stack, isResourceConstruct } from "../../src/core/app.js";
import { Construct, type Resource } from "../../src/core/construct.js";
import { hashProps } from "../../src/core/hash.js";

interface FakeProps {
  readonly name: string;
}

interface FakeOpts {
  readonly dependsOn?: readonly Construct[];
}

class FakeResource extends Construct {
  readonly resource: Resource<FakeProps, { id: string }>;
  readonly props: FakeProps;
  readonly dependsOn: readonly Construct[];

  constructor(scope: Stack, id: string, props: FakeProps, opts: FakeOpts = {}) {
    super(scope, id);
    this.props = props;
    this.dependsOn = opts.dependsOn ?? [];
    this.resource = {
      type: "Fake",
      surface: "connect",
      read: async () => null,
      create: async () => ({ id: "fake" }),
      update: async () => ({ id: "fake" }),
      delete: async () => {},
      hash: (p) => hashProps(p),
    };
  }
}

describe("App / Stack / Construct", () => {
  it("composes uniqueIds as stack/id", () => {
    const app = new App();
    const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });
    const c = new FakeResource(stack, "DocsS3", { name: "docs" });
    expect(c.uniqueId).toBe("RagDemo/DocsS3");
    expect(c.path).toEqual(["RagDemo", "DocsS3"]);
  });

  it("synth emits a plan with deps, hash, and stack metadata", () => {
    const app = new App();
    const stack = new Stack(app, "RagDemo", { targetOrg: "jaygentforce" });
    const conn = new FakeResource(stack, "DocsS3", { name: "docs" });
    const stream = new FakeResource(
      stack,
      "DocsStream",
      { name: "stream" },
      { dependsOn: [conn] },
    );

    const plan = app.synth("0.0.1");
    expect(plan.stacks).toEqual([
      { id: "RagDemo", targetOrg: "jaygentforce" },
    ]);
    expect(plan.resources).toHaveLength(2);

    const streamEntry = plan.resources.find((r) => r.uniqueId.endsWith("/DocsStream"));
    expect(streamEntry?.dependsOn).toEqual(["RagDemo/DocsS3"]);
    expect(streamEntry?.type).toBe("Fake");
    expect(streamEntry?.surface).toBe("connect");
    expect(streamEntry?.hash).toMatch(/^sha256:/);

    // Avoid unused-variable warnings while still asserting registration.
    expect(conn.uniqueId).toBe("RagDemo/DocsS3");
    expect(stream.uniqueId).toBe("RagDemo/DocsStream");
  });

  it("rejects ids containing '/'", () => {
    const app = new App();
    expect(() => new Stack(app, "bad/name", { targetOrg: "x" })).toThrow();
  });

  it("isResourceConstruct narrows correctly", () => {
    const app = new App();
    const stack = new Stack(app, "S", { targetOrg: "x" });
    const c = new FakeResource(stack, "C", { name: "c" });
    expect(isResourceConstruct(c)).toBe(true);
    expect(isResourceConstruct(stack)).toBe(false);
  });
});
