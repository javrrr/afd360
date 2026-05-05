/**
 * Substitution layer for manifest strings at deploy time:
 *
 *   `${env.NAME}`   → process.env.NAME
 *   `${file:PATH}`  → file contents read from PATH (utf8)
 *   `${pem:PATH}`   → PEM body only: BEGIN/END headers stripped, all
 *                     whitespace removed, base64 characters only.
 *
 * Nesting: env first, then file/pem. A path itself can contain
 * `${env.X}` references.
 *
 * Typical Snowflake usage — the connector's `privateKey` field rejects raw
 * PEM and only accepts the base64 body:
 *
 *   privateKey: "${pem:${env.SNOWFLAKE_PRIVATE_KEY_PATH}}"
 *
 * Deep-walks objects/arrays; non-string primitives pass through untouched.
 * Unresolved env tokens and unreadable files are aggregated and thrown as a
 * single error listing every problem.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export class UnresolvedEnvError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `Unresolved env tokens: ${missing.join(", ")}. ` +
        `Set these in your shell or a .env file before running deploy.`,
    );
    this.name = "UnresolvedEnvError";
  }
}

export class FileReadError extends Error {
  constructor(readonly paths: readonly { path: string; reason: string }[]) {
    super(
      `Could not read file(s) referenced by \${file:...}:\n` +
        paths.map((p) => `  - ${p.path}: ${p.reason}`).join("\n"),
    );
    this.name = "FileReadError";
  }
}

const ENV_TOKEN = /\$\{env\.([A-Z0-9_]+)\}/g;
// File paths can contain roughly anything except `}`. We deliberately allow
// leading `~` (expanded to $HOME), absolute, and relative paths.
const FILE_TOKEN = /\$\{file:([^}]+)\}/g;
const PEM_TOKEN = /\$\{pem:([^}]+)\}/g;

export function substituteEnv<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const missingEnv = new Set<string>();
  const badFiles: { path: string; reason: string }[] = [];
  const out = walk(value, env, missingEnv, badFiles) as T;
  // Throw env errors first — a path that references a missing env var will
  // also show up as a file-not-found, and reporting both is confusing.
  if (missingEnv.size > 0) {
    throw new UnresolvedEnvError([...missingEnv].sort());
  }
  if (badFiles.length > 0) {
    throw new FileReadError(badFiles);
  }
  return out;
}

function walk(
  value: unknown,
  env: NodeJS.ProcessEnv,
  missingEnv: Set<string>,
  badFiles: { path: string; reason: string }[],
): unknown {
  if (typeof value === "string") {
    return substituteString(value, env, missingEnv, badFiles);
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, env, missingEnv, badFiles));
  }
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      out[k] = walk(src[k], env, missingEnv, badFiles);
    }
    return out;
  }
  return value;
}

function substituteString(
  str: string,
  env: NodeJS.ProcessEnv,
  missingEnv: Set<string>,
  badFiles: { path: string; reason: string }[],
): string {
  // 1. env first, so file paths can reference env vars.
  const envResolved = str.replace(ENV_TOKEN, (_full, name: string) => {
    const val = env[name];
    if (val === undefined) {
      missingEnv.add(name);
      return "";
    }
    return val;
  });
  // 2. file / pem after. If env errors accumulated above we still try files
  // so the error message is complete, but the caller will throw the env
  // error first (file errors are skipped when paths resolved to the empty
  // string because an env var was missing).
  const fileResolved = envResolved.replace(FILE_TOKEN, (_full, rawPath: string) => {
    return readPath(rawPath, badFiles, (content) => content);
  });
  return fileResolved.replace(PEM_TOKEN, (_full, rawPath: string) => {
    return readPath(rawPath, badFiles, toBase64Body);
  });
}

function readPath(
  rawPath: string,
  badFiles: { path: string; reason: string }[],
  transform: (content: string) => string,
): string {
  const path = expandUser(rawPath.trim());
  if (path === "") {
    // Came from a resolved-but-missing env var. Don't add a file error
    // for it; the env error already explains the underlying cause.
    return "";
  }
  try {
    return transform(readFileSync(path, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    badFiles.push({ path, reason });
    return "";
  }
}

/**
 * Strip PEM armor and whitespace, leaving only the base64 body.
 *
 * Data 360's SNOWFLAKE connector `privateKey` field requires this form —
 * raw PEM (with `-----BEGIN...-----` headers and line breaks) creates a
 * connection that looks fine structurally but fails the auth handshake.
 * Evidence: jaygentforce 2026-05-05, captured in
 * `feedback_snowflake-privatekey-base64-only.md`.
 *
 * Throws if the input doesn't contain a PEM block, so we don't silently
 * return an empty string for the wrong file type.
 */
function toBase64Body(content: string): string {
  const match = content.match(/-----BEGIN [^-]+-----([\s\S]+?)-----END [^-]+-----/);
  if (!match) {
    throw new Error(
      "No PEM block found. The ${pem:...} token expects a file whose contents " +
        "contain -----BEGIN ...----- / -----END ...----- markers.",
    );
  }
  return match[1]!.replace(/\s+/g, "");
}

function expandUser(path: string): string {
  if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
  if (path === "~") return homedir();
  return path;
}
