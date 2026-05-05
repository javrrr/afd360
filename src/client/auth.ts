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

  const session: Session = {
    alias,
    username: r.username,
    orgId: r.id,
    instanceUrl: r.instanceUrl,
    apiVersion: r.apiVersion,
    accessToken: r.accessToken,
  };
  cache.set(alias, session);
  return session;
}

export function clearSessionCache(): void {
  cache.clear();
}
