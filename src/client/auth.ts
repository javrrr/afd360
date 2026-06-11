import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Session {
  readonly alias: string;
  readonly username: string;
  readonly orgId: string;
  readonly instanceUrl: string;
  readonly apiVersion: string;
  readonly accessToken: string;
}

interface SfOrgDisplayResult {
  status: number;
  result?: {
    id?: string;
    apiVersion?: string;
    accessToken?: string;
    instanceUrl?: string;
    username?: string;
    alias?: string;
    connectedStatus?: string;
  };
  message?: string;
}

const cache = new Map<string, Session>();

export class AuthError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AuthError";
  }
}

export async function getSession(alias: string): Promise<Session> {
  const cached = cache.get(alias);
  if (cached) return cached;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "sf",
      ["org", "display", "--target-org", alias, "--json"],
      { maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new AuthError(
      `sf CLI failed for org "${alias}". Is it authenticated? Try: sf org login web --alias ${alias}\n${stderr}`,
      err,
    );
  }

  let parsed: SfOrgDisplayResult;
  try {
    parsed = JSON.parse(stdout) as SfOrgDisplayResult;
  } catch (err) {
    throw new AuthError(
      `Could not parse 'sf org display' JSON for "${alias}".`,
      err,
    );
  }

  if (parsed.status !== 0 || !parsed.result) {
    throw new AuthError(
      `sf CLI reported an error for "${alias}": ${parsed.message ?? "unknown"}`,
    );
  }

  const r = parsed.result;
  if (!r.accessToken || !r.instanceUrl || !r.username || !r.id || !r.apiVersion) {
    throw new AuthError(
      `sf CLI response for "${alias}" is missing required fields (accessToken, instanceUrl, username, id, apiVersion).`,
    );
  }

  // Recent sf CLI versions (mid-2026 onward) redact the access token from
  // `sf org display --json` output. The redacted value isn't a clean
  // sentinel — it's a string that STARTS WITH "[REDACTED]" followed by
  // additional human-readable instruction text (e.g.
  // "[REDACTED] Use 'sf org auth show-access-token' to view"). The
  // dedicated `sf org auth show-access-token --json` command returns
  // the real token. Fall back to it when we see the redaction marker.
  // The user can also bypass by setting SF_TEMP_SHOW_SECRETS=true, but
  // that's a temporary CLI escape hatch and we shouldn't depend on it.
  let accessToken = r.accessToken;
  if (accessToken.startsWith("[REDACTED]")) {
    accessToken = await fetchAccessTokenViaAuthCommand(alias);
  }

  const session: Session = {
    alias,
    username: r.username,
    orgId: r.id,
    instanceUrl: r.instanceUrl,
    apiVersion: r.apiVersion,
    accessToken,
  };
  cache.set(alias, session);
  return session;
}

interface SfAuthShowTokenResult {
  status: number;
  result?: { accessToken?: string };
  message?: string;
}

async function fetchAccessTokenViaAuthCommand(alias: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "sf",
      ["org", "auth", "show-access-token", "--target-org", alias, "--json"],
      { maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    throw new AuthError(
      `sf CLI redacted the access token in 'sf org display'. Falling back to ` +
        `'sf org auth show-access-token --target-org ${alias} --json' also failed. ` +
        `Re-authenticate with: sf org login web --alias ${alias}\n${stderr}`,
      err,
    );
  }

  let parsed: SfAuthShowTokenResult;
  try {
    parsed = JSON.parse(stdout) as SfAuthShowTokenResult;
  } catch (err) {
    throw new AuthError(
      `Could not parse 'sf org auth show-access-token' JSON for "${alias}".`,
      err,
    );
  }

  const token = parsed.result?.accessToken;
  if (parsed.status !== 0 || !token) {
    throw new AuthError(
      `sf CLI 'sf org auth show-access-token' returned no token for "${alias}": ${parsed.message ?? "unknown"}`,
    );
  }
  return token;
}

export function clearSessionCache(): void {
  cache.clear();
}
