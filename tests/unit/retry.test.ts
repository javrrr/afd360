import { describe, it, expect, vi } from "vitest";
import { retryOn, retryOn5xx, is5xx } from "../../src/client/retry.js";

const fastOpts = { intervalMs: 1, jitter: 0 };

describe("is5xx", () => {
  it("matches errors with status 500-599", () => {
    expect(is5xx({ status: 500 })).toBe(true);
    expect(is5xx({ status: 503 })).toBe(true);
    expect(is5xx({ status: 599 })).toBe(true);
  });
  it("rejects non-5xx", () => {
    expect(is5xx({ status: 404 })).toBe(false);
    expect(is5xx({ status: 200 })).toBe(false);
    expect(is5xx(null)).toBe(false);
    expect(is5xx("oops")).toBe(false);
  });
});

describe("retryOn", () => {
  it("returns the first successful result", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const out = await retryOn(fn, () => true, fastOpts);
    expect(out).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    const out = await retryOn5xx(fn, { ...fastOpts, attempts: 5, onRetry });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-matching errors", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 404, message: "nope" });
    await expect(retryOn5xx(fn, fastOpts)).rejects.toMatchObject({ status: 404 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws last error after exhausting attempts", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 500, attempt: "all" });
    await expect(retryOn5xx(fn, { ...fastOpts, attempts: 3 })).rejects.toMatchObject({
      status: 500,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
