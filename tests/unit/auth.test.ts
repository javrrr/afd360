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

  // Recent sf CLI versions (mid-2026 onward) redact the access token in
  // `sf org display --json`, returning the literal string "[REDACTED]". afd360
  // detects this and falls back to `sf org auth show-access-token --json`.
  it("falls back to 'sf org auth show-access-token' when display redacts the token", async () => {
    // 1st call: sf org display returns redacted token. The actual sf CLI
    // value is the string "[REDACTED]" followed by human-readable
    // instruction text — match the real shape.
    respond(
      JSON.stringify({
        status: 0,
        result: {
          id: "00DWt00000KqAfsMAF",
          apiVersion: "67.0",
          accessToken:
            "[REDACTED] Use 'sf org auth show-access-token' to view",
          instanceUrl: "https://x.my.salesforce.com",
          username: "u@example.com",
          alias: "redacted-org",
          connectedStatus: "Connected",
        },
      }),
    );
    // 2nd call: sf org auth show-access-token returns the real token.
    respond(
      JSON.stringify({
        status: 0,
        result: { accessToken: "00DWt00000KqAfs!RealToken_abc123" },
      }),
    );

    const session = await getSession("redacted-org");
    expect(session.accessToken).toBe("00DWt00000KqAfs!RealToken_abc123");
    expect(session.orgId).toBe("00DWt00000KqAfsMAF");

    // Verify the second exec call was the auth fallback with the right args.
    expect(execFileImpl).toHaveBeenCalledTimes(2);
    const secondCall = execFileImpl.mock.calls[1]!;
    expect(secondCall[0]).toBe("sf");
    expect(secondCall[1]).toEqual([
      "org", "auth", "show-access-token", "--target-org", "redacted-org", "--json",
    ]);
  });

  it("propagates AuthError if the show-access-token fallback also fails", async () => {
    // 1st call: redacted (full real-CLI string shape).
    respond(
      JSON.stringify({
        status: 0,
        result: {
          id: "00D", apiVersion: "67.0",
          accessToken: "[REDACTED] Use 'sf org auth show-access-token' to view",
          instanceUrl: "https://x", username: "u",
        },
      }),
    );
    // 2nd call: fallback fails (e.g. session expired).
    respondError(Object.assign(new Error("exit 1"), { stderr: "auth failed" }));

    await expect(getSession("dead-org")).rejects.toBeInstanceOf(AuthError);
  });
});
