import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectRequest, RestError } from "../../src/client/rest.js";
import { is5xx, isNotFound, errBodyIncludes } from "../../src/client/retry.js";
import type { Session } from "../../src/client/auth.js";

const session: Session = {
  alias: "my-org",
  username: "u@example.com",
  orgId: "00D000000000000",
  instanceUrl: "https://example.my.salesforce.com",
  apiVersion: "66.0",
  accessToken: "tok-abc",
};

function mockFetch(status: number, bodyText: string, statusText = ""): typeof fetch {
  return vi.fn(async () =>
    new Response(bodyText, {
      status,
      statusText,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("connectRequest", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("builds the URL from the session base + path and sends the bearer token", async () => {
    const spy = mockFetch(200, JSON.stringify({ apiName: "MyModel" }));
    globalThis.fetch = spy;
    const out = await connectRequest<{ apiName: string }>(session, {
      method: "GET",
      path: "/ssot/semantic/models/MyModel",
    });
    expect(out).toEqual({ apiName: "MyModel" });
    const [url, init] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(
      "https://example.my.salesforce.com/services/data/v66.0/ssot/semantic/models/MyModel",
    );
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok-abc",
    });
  });

  it("honors an apiVersion override for version-gated endpoints", async () => {
    const spy = mockFetch(200, JSON.stringify({ ok: true }));
    globalThis.fetch = spy;
    await connectRequest(session, {
      method: "POST",
      path: "ssot/semantic/models",
      body: { apiName: "MyModel" },
      apiVersion: "64.0",
    });
    const [url, init] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(
      "https://example.my.salesforce.com/services/data/v64.0/ssot/semantic/models",
    );
    expect((init as RequestInit).body).toBe(JSON.stringify({ apiName: "MyModel" }));
    expect((init as RequestInit).headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });

  it("returns undefined on an empty 204 body (DELETE)", async () => {
    const spy = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    globalThis.fetch = spy;
    const out = await connectRequest(session, { method: "DELETE", path: "/ssot/semantic/models/MyModel" });
    expect(out).toBeUndefined();
  });

  it("throws a RestError carrying status + parsed body on non-2xx", async () => {
    globalThis.fetch = mockFetch(
      500,
      JSON.stringify([{ errorCode: "UNKNOWN_EXCEPTION", message: "Internal Server Error" }]),
      "Server Error",
    );
    const err = await connectRequest(session, { method: "POST", path: "/ssot/semantic/models", body: {} }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RestError);
    // Compatible with the shared retry predicates.
    expect(is5xx(err)).toBe(true);
    expect(errBodyIncludes(err, "UNKNOWN_EXCEPTION")).toBe(true);
  });

  it("RestError is recognized as not-found by isNotFound (404)", async () => {
    globalThis.fetch = mockFetch(404, JSON.stringify([{ errorCode: "NOT_FOUND" }]), "Not Found");
    const err = await connectRequest(session, { method: "GET", path: "/ssot/semantic/models/Missing" }).catch(
      (e) => e,
    );
    expect(isNotFound(err)).toBe(true);
  });
});
