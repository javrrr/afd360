/**
 * ${env.X} substitution. Used at deploy time to pull secrets and per-env
 * values out of process.env without committing them.
 *
 * - Scans strings for `${env.NAME}` (NAME = [A-Z0-9_]+).
 * - Deep-walks objects and arrays.
 * - Unresolved tokens are aggregated and thrown as a single error listing all
 *   missing vars — matches sfdk's pattern (one error beats N round-trips for
 *   users with a ~/.env file to populate).
 *
 * NOT sensitive to type: non-string primitives pass through untouched.
 */

export class UnresolvedEnvError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `Unresolved env tokens: ${missing.join(", ")}. ` +
        `Set these in your shell or a .env file before running deploy.`,
    );
    this.name = "UnresolvedEnvError";
  }
}

const TOKEN = /\$\{env\.([A-Z0-9_]+)\}/g;

export function substituteEnv<T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const missing = new Set<string>();
  const out = walk(value, env, missing) as T;
  if (missing.size > 0) {
    throw new UnresolvedEnvError([...missing].sort());
  }
  return out;
}

function walk(
  value: unknown,
  env: NodeJS.ProcessEnv,
  missing: Set<string>,
): unknown {
  if (typeof value === "string") return replaceString(value, env, missing);
  if (Array.isArray(value)) return value.map((v) => walk(v, env, missing));
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      out[k] = walk(src[k], env, missing);
    }
    return out;
  }
  return value;
}

function replaceString(
  str: string,
  env: NodeJS.ProcessEnv,
  missing: Set<string>,
): string {
  return str.replace(TOKEN, (_full, name: string) => {
    const val = env[name];
    if (val === undefined) {
      missing.add(name);
      return "";
    }
    return val;
  });
}
