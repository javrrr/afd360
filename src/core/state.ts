import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per-resource state file record. See PRD §8.
 *
 * `salesforceId` is set only when the Connect API returns an id (e.g. Connection,
 * SearchIndex). Name-keyed resources (DMO, Mapping) leave it undefined.
 */
export interface StateResource {
  type: string;
  apiName: string;
  salesforceId?: string;
  hash: string;
  createdAt: string;
  updatedAt?: string;
}

export interface StackState {
  stackName: string;
  targetOrg: string;
  lastDeployedAt: string | null;
  resources: Record<string, StateResource>;
}

export const DEFAULT_STATE_DIR = ".afd360/state";

function defaultState(stackName: string, targetOrg: string): StackState {
  return {
    stackName,
    targetOrg,
    lastDeployedAt: null,
    resources: {},
  };
}

export function stateFilePath(
  orgAlias: string,
  stateDir: string = DEFAULT_STATE_DIR,
): string {
  return join(stateDir, `${orgAlias}.json`);
}

/**
 * Read the state file for an org alias. Returns a default empty state when
 * the file doesn't exist — first deploy of a new stack shouldn't error.
 */
export async function readState(
  orgAlias: string,
  stackName: string,
  stateDir: string = DEFAULT_STATE_DIR,
): Promise<StackState> {
  const path = stateFilePath(orgAlias, stateDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultState(stackName, orgAlias);
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as StackState;
  // Tolerate older/missing fields — we may evolve the schema.
  return {
    stackName: parsed.stackName ?? stackName,
    targetOrg: parsed.targetOrg ?? orgAlias,
    lastDeployedAt: parsed.lastDeployedAt ?? null,
    resources: parsed.resources ?? {},
  };
}

export async function writeState(
  orgAlias: string,
  state: StackState,
  stateDir: string = DEFAULT_STATE_DIR,
): Promise<void> {
  const path = stateFilePath(orgAlias, stateDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
