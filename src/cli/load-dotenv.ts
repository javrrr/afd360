import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import dotenv from "dotenv";
import pc from "picocolors";

/**
 * Layered dotenv loading. Precedence, highest-first:
 *
 *   1. real `process.env`       — shell / CI / runtime
 *   2. `.env.local`             — gitignored local secrets
 *   3. `.env`                   — committed template or non-secret defaults
 *
 * Lower-precedence files do not overwrite already-set keys. This mirrors the
 * Next.js / Vite / Remix convention and keeps CI (where everything comes from
 * `process.env`) predictable.
 *
 * Loaded from the directory that contains the user's `afd360.config.ts`.
 * Library consumers importing from `afd360` programmatically never invoke this —
 * the CLI does, right before it tsImport()s the config file.
 *
 * We never log values or even key names. One summary line names the files
 * that were read; if someone wants a key count they can use `afd360 env`
 * (not yet wired).
 */
export function loadDotenvFor(configPath: string): { loaded: string[] } {
  const dir = dirname(resolve(process.cwd(), configPath));
  const files = [".env.local", ".env"];
  const loaded: string[] = [];
  for (const name of files) {
    const p = resolve(dir, name);
    if (!existsSync(p)) continue;
    // override: false — earlier files (and real env) win. dotenv's default is
    // already false; we pin it so the contract is explicit.
    const result = dotenv.config({ path: p, override: false, quiet: true });
    if (result.error) {
      throw new Error(`Failed to parse ${name}: ${result.error.message}`);
    }
    loaded.push(name);
  }
  if (loaded.length > 0) {
    process.stderr.write(
      `${pc.dim(`env: loaded ${loaded.join(", ")}`)}\n`,
    );
  }
  return { loaded };
}
