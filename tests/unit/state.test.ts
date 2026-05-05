import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  stateFilePath,
  type StackState,
} from "../../src/core/state.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "afd360-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("state round-trip", () => {
  it("returns empty default when file absent", async () => {
    const s = await readState("myorg", "RagDemo", dir);
    expect(s).toEqual({
      stackName: "RagDemo",
      targetOrg: "myorg",
      lastDeployedAt: null,
      resources: {},
    });
  });

  it("writes then reads", async () => {
    const s: StackState = {
      stackName: "RagDemo",
      targetOrg: "myorg",
      lastDeployedAt: "2026-05-05T00:00:00Z",
      resources: {
        DocsS3: {
          type: "Connection",
          apiName: "DocsS3",
          salesforceId: "0sH...",
          hash: "sha256:abc",
          createdAt: "2026-05-05T00:00:00Z",
        },
      },
    };
    await writeState("myorg", s, dir);
    const back = await readState("myorg", "RagDemo", dir);
    expect(back).toEqual(s);
  });

  it("stateFilePath uses alias-based filename", () => {
    expect(stateFilePath("jaygentforce", ".afd360/state")).toBe(
      ".afd360/state/jaygentforce.json",
    );
  });
});
