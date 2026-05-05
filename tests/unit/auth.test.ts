import { describe, it, expect, beforeEach, vi } from "vitest";
import { promisify } from "node:util";

// The real execFile has a [util.promisify.custom] symbol that makes
// `promisify(execFile)` resolve to { stdout, stderr } instead of just stdout.
// Our mock needs the same symbol so auth.ts's destructuring works.
interface MockExecFn {
  (cmd: string, args: string[], opts: unknown): Promise<{
    stdout: string;
    stderr: string;
  }>;
  [key: symbol]: unknown;
}

const execFileImpl = vi.fn<MockExecFn>();
const execFileMock = Object.assign(
  // Plain callback form — unused by auth.ts (it uses promisify) but kept so
  // the shape still matches Node's execFile.
  (() => {}) as unknown as MockExecFn,
  { [promisify.custom]: execFileImpl },
);

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

// Import after the mock so promisify(execFile) captures the mocked version.
const { getSession, clearSessionCache, AuthError } = await import(
  "../../src/client/auth.js"
);

function respond(stdout: string, stderr = ""): void {
  execFileImpl.mockResolvedValueOnce({ stdout, stderr });
}

function respondError(err: Error & { stderr?: string }): void {
  execFileImpl.mockRejectedValueOnce(err);
}

beforeEach(() => {
  clearSessionCache();
  execFileImpl.mockReset();
});

describe("getSession", () => {
  it("parses sf org display JSON and returns a Session", async () => {
    respond(
      JSON.stringify({
        status: 0,
        result: {
          id: "00DWt00000G96PxMAJ",
          apiVersion: "66.0",
          accessToken: "tok",
          instanceUrl: "https://x.my.salesforce.com",
          username: "u@example.com",
          alias: "myorg",
          connectedStatus: "Connected",
        },
      }),
    );

    const session = await getSession("myorg");
    expect(session).toEqual({
      alias: "myorg",
      username: "u@example.com",
      orgId: "00DWt00000G96PxMAJ",
      instanceUrl: "https://x.my.salesforce.com",
      apiVersion: "66.0",
      accessToken: "tok",
    });
  });

  it("caches sessions per alias", async () => {
    respond(
      JSON.stringify({
        status: 0,
        result: {
          id: "00D",
          apiVersion: "66.0",
          accessToken: "t",
          instanceUrl: "https://x",
          username: "u",
        },
      }),
    );
    await getSession("alpha");
    await getSession("alpha");
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });

  it("throws AuthError when sf CLI exits non-zero", async () => {
    const err = Object.assign(new Error("exit 1"), {
      stderr: "No AuthInfo found for name unknown",
    });
    respondError(err);
    await expect(getSession("unknown")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError when JSON is unparseable", async () => {
    respond("not json");
    await expect(getSession("bad")).rejects.toBeInstanceOf(AuthError);
  });

  it("throws AuthError when required fields are missing", async () => {
    respond(
      JSON.stringify({
        status: 0,
        result: { id: "00D", apiVersion: "66.0" /* missing token */ },
      }),
    );
    await expect(getSession("partial")).rejects.toBeInstanceOf(AuthError);
  });
});
