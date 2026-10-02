import type { Data360Client } from "data-360-sdk";
import type { Session } from "../client/auth.js";

/**
 * Ambient info handed to every Resource method. Contains the live SDK client,
 * the resolved session (for per-org knobs), and the org alias so resources can
 * key state-file entries.
 */
export interface ResourceContext {
  readonly client: Data360Client;
  readonly session: Session;
  readonly orgAlias: string;
  /**
   * Set by `destroy` ONLY. When present, a resource whose owned data-lake
   * object can't be torn down until a sibling that has no `dependsOn` edge is
   * gone should register that DLO's live name here and SKIP its own inline
   * cleanup — `destroy` sweeps the registered names in a post-loop pass once
   * every dependent is deleted (so the delete finally lands). Undefined on the
   * deploy/recreate path, where resources clean up inline. Today only
   * DataStream uses it, for its source DLO vs. a mapped DMO (torn down later in
   * the same reverse-topo pass; see cli/destroy.ts).
   */
  readonly deferDloCleanup?: (dloName: string) => void;
}

/**
 * A resource type's create/read/update/delete/poll contract. Each v1 resource
 * lives in src/resources/<name>.ts and implements this interface against
 * data-360-sdk directly — no re-wrapping of the SDK.
 *
 * - `read` returns null when the resource is absent in the org (used for
 *   idempotency checks). It must swallow "404 / 500 with 'not found' body"
 *   from the Connect API and return null — see PLAN Appendix A quirks B1 + D1.
 * - `hash(props)` drives drift detection. State file stores the last deployed
 *   hash; redeploy skips when current hash matches.
 * - `isReady` is only needed for async resources (DataStream, DMO, SearchIndex).
 */
export interface Resource<Props, Output> {
  readonly type: string;
  readonly surface: "connect" | "metadata";
  /** Fetch current state given an id previously returned from create/update. */
  read(ctx: ResourceContext, id: string): Promise<Output | null>;
  /**
   * First-time lookup by authored props — used when the state file has no id
   * for this resource. For resources whose API has a GET-by-name, this is
   * typically a thin wrapper around it.
   */
  lookupByProps?(ctx: ResourceContext, props: Props): Promise<Output | null>;
  /** Stable id extracted from an output; stored in state and fed back to read/delete. */
  idOf(output: Output): string;
  create(ctx: ResourceContext, props: Props): Promise<Output>;
  update(ctx: ResourceContext, id: string, props: Props): Promise<Output>;
  delete(ctx: ResourceContext, id: string): Promise<void>;
  isReady?(ctx: ResourceContext, output: Output): Promise<boolean>;
  /**
   * Optional — return true if the live output is in a terminal failed state
   * that cannot be recovered via the API (e.g. DataStream `status = ERROR`).
   * computeOp treats this as a signal to recreate rather than adopt/noop.
   */
  isFailed?(output: Output): boolean;
  /**
   * Optional drift check used during adoption. If `lookupByProps` returns
   * a match, computeOp calls `matchesAuthored(live, resolvedProps)` before
   * deciding to adopt. Returning false forces a recreate — useful when the
   * live resource has the same key/name but drifts on a material field
   * (e.g. a DMO's category). Default (when undefined): trust the match.
   */
  matchesAuthored?(live: Output, props: Props): boolean;
  hash(props: Props): string;
}

/**
 * Minimal scope contract — a parent that owns an id namespace. Stack and App
 * both implement this; inner Constructs use it to compose uniqueIds.
 */
export interface Scope {
  readonly id: string;
  readonly path: readonly string[];
  addChild(child: Construct): void;
}

/**
 * Base class for every declarative node in a manifest — Stacks, resource
 * constructs (Connection, DMO, …), and user-defined composites.
 */
export class Construct {
  readonly id: string;
  readonly scope: Scope;
  readonly path: readonly string[];
  readonly uniqueId: string;
  readonly children: Construct[] = [];

  constructor(scope: Scope, id: string) {
    if (!id || id.includes("/")) {
      throw new Error(`Construct id must be non-empty and cannot contain "/" (got: ${JSON.stringify(id)})`);
    }
    this.id = id;
    this.scope = scope;
    this.path = [...scope.path, id];
    this.uniqueId = this.path.join("/");
    scope.addChild(this);
  }

  addChild(child: Construct): void {
    this.children.push(child);
  }
}

/**
 * Mark a resource construct as RETAINed — afd360 will never auto-delete it.
 * Both `deploy --prune` and `destroy` SKIP a protected resource (reported as
 * `skip (protected)`) and leave it on the org; the flag is persisted to state
 * so orphan prune still honors it after the construct is removed from the
 * manifest. To actually delete a protected resource, drop the `protect()` call
 * (and redeploy, so state clears the flag) first.
 *
 * Sets the duck-typed `isProtected` marker on the instance — the same pattern
 * `fromExisting` uses for `isExisting` — so it works across the src/dist
 * module-graph boundary. Returns the construct for inline use:
 * `const conn = protect(new Connection(stack, "Conn", { ... }));`
 *
 * Analog: CDK `RemovalPolicy.RETAIN`, Pulumi `retainOnDelete`, Terraform
 * `prevent_destroy`.
 */
export function protect<T extends Construct>(construct: T): T {
  (construct as { isProtected?: boolean }).isProtected = true;
  return construct;
}

/** Read the `protect()` marker off a construct (duck-typed, cross-realm safe). */
export function isProtected(construct: Construct): boolean {
  return (construct as { isProtected?: boolean }).isProtected === true;
}
