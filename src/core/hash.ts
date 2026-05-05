import { createHash } from "node:crypto";

/**
 * Deterministic JSON stringify — sorts object keys recursively so
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same string.
 *
 * Used as the input to resource hashing so idempotency isn't defeated by
 * key-order differences in authored props.
 *
 * Unsupported values (functions, symbols, BigInt) throw — they should never
 * appear in a manifest's props.
 */
export function canonicalStringify(value: unknown): string {
  return stringify(value);
}

/** sha256(canonicalStringify(value)), hex-encoded and prefixed with "sha256:". */
export function hashProps(value: unknown): string {
  const h = createHash("sha256");
  h.update(canonicalStringify(value));
  return `sha256:${h.digest("hex")}`;
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`cannot hash non-finite number: ${value as number}`);
    }
    return JSON.stringify(value);
  }
  if (t === "boolean") return (value as boolean) ? "true" : "false";
  if (t === "undefined") return "null";
  if (t === "bigint" || t === "function" || t === "symbol") {
    throw new TypeError(`cannot hash value of type ${t}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringify).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys
      .map((k) => {
        const v = obj[k];
        // Drop undefined values so `{ a: 1, b: undefined }` hashes the same as `{ a: 1 }`.
        if (v === undefined) return null;
        return `${JSON.stringify(k)}:${stringify(v)}`;
      })
      .filter((p): p is string => p !== null);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`cannot hash value of unknown type: ${t}`);
}
