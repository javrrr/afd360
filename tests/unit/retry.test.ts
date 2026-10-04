import { describe, it, expect, vi } from "vitest";
import {
  retryOn,
  retryOn5xx,
  is5xx,
  isNotFound,
  isFactTableNotReady,
  isReferencedPreconditionFailure,
} from "../../src/client/retry.js";

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

describe("isNotFound", () => {
  it("matches plain 404", () => {
    expect(isNotFound({ status: 404 })).toBe(true);
  });

  it("matches 500 with 'not found' in the body (quirk B1)", () => {
    expect(isNotFound({ status: 500, body: '[{"message":"DMO not found"}]' })).toBe(true);
    expect(isNotFound({ status: 500, message: "The DMO was not found." })).toBe(true);
  });

  it("ignores 500 without 'not found' body", () => {
    expect(isNotFound({ status: 500, body: '[{"message":"UNKNOWN_EXCEPTION"}]' })).toBe(false);
  });

  it("matches 400 with extra400Body opt-in (SearchIndex quirk)", () => {
    const err = {
      status: 400,
      body: '[{"errorCode":"INVALID_INPUT","message":"The resource with ID or api name = X was not found."}]',
    };
    expect(isNotFound(err)).toBe(false); // default: no 400 matching
    expect(isNotFound(err, { extra400Body: "was not found" })).toBe(true);
  });

  it("accepts regex for extra400Body / body500", () => {
    const err = { status: 400, message: "api name = X was NOT FOUND." };
    expect(isNotFound(err, { extra400Body: /was not found/i })).toBe(true);
  });

  it("rejects non-object errors and non-matching statuses", () => {
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound("nope")).toBe(false);
    expect(isNotFound({ status: 200 })).toBe(false);
    expect(isNotFound({ status: 400 })).toBe(false);
  });
});

describe("isFactTableNotReady", () => {
  it("matches the ENTITY_SAVE_ERROR fact-table 400 bodies (either phrasing)", () => {
    expect(
      isFactTableNotReady({
        status: 400,
        body: '[{"errorCode":"ENTITY_SAVE_ERROR","message":"Error getting FactTable ValLeadDmo__dlm"}]',
      }),
    ).toBe(true);
    expect(
      isFactTableNotReady({
        status: 400,
        message: "Cannot find type for node ValLeadDmo__dlm.Id__c",
      }),
    ).toBe(true);
  });

  it("does not match unrelated errors (so a genuinely bad CI definition still fails fast)", () => {
    expect(isFactTableNotReady({ status: 400, message: "Invalid SQL expression" })).toBe(false);
    expect(isFactTableNotReady({ status: 500, body: "INTERNAL_ERROR" })).toBe(false);
    expect(isFactTableNotReady(null)).toBe(false);
    expect(isFactTableNotReady("oops")).toBe(false);
  });

  it("drives retryOn to wait out the materialization lag then succeed", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 400, message: "Error getting FactTable X__dlm" })
      .mockResolvedValue("created");
    const out = await retryOn(
      fn,
      (err) => is5xx(err) || isFactTableNotReady(err),
      { ...fastOpts, attempts: 5 },
    );
    expect(out).toBe("created");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("isReferencedPreconditionFailure", () => {
  it("matches a 412 by status alone", () => {
    expect(isReferencedPreconditionFailure({ status: 412 })).toBe(true);
  });

  it("matches the MATCH_PRECONDITION_FAILED / 'referenced in other features' body", () => {
    expect(
      isReferencedPreconditionFailure({
        status: 400,
        body: '[{"errorCode":"MATCH_PRECONDITION_FAILED"}]',
      }),
    ).toBe(true);
    expect(
      isReferencedPreconditionFailure({
        message: "DMO is referenced in other features and cannot be deleted",
      }),
    ).toBe(true);
  });

  it("matches the CalculatedInsight delete-block (DELETE_FAILED / 'dependencies') body", () => {
    expect(
      isReferencedPreconditionFailure({
        status: 400,
        body: '[{"errorCode":"DELETE_FAILED","message":"can\'t delete this calculated insight"}]',
      }),
    ).toBe(true);
    expect(
      isReferencedPreconditionFailure({
        message: "can't delete this calculated insight because of these dependencies",
      }),
    ).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isReferencedPreconditionFailure({ status: 404 })).toBe(false);
    expect(isReferencedPreconditionFailure({ status: 400, message: "bad request" })).toBe(false);
    expect(isReferencedPreconditionFailure(null)).toBe(false);
    expect(isReferencedPreconditionFailure("nope")).toBe(false);
  });

  it("drives retryOn to wait for the reference to clear then delete", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 412, message: "referenced in other features" })
      .mockRejectedValueOnce({ status: 412 })
      .mockResolvedValue(undefined);
    await retryOn(
      fn,
      (err) => is5xx(err) || isReferencedPreconditionFailure(err),
      { ...fastOpts, attempts: 6 },
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
