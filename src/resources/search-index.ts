import type {
  Data360Client,
  SemanticSearchInputRepresentation,
} from "data-360-sdk";
import { Construct, type Resource } from "../core/construct.js";
import type { Stack } from "../core/app.js";
import { hashProps } from "../core/hash.js";
import { retryOn, retryOn5xx, is5xx, errBodyIncludes, isNotFound as baseIsNotFound } from "../client/retry.js";
import type { DMO } from "./dmo.js";

/**
 * Search index type. HYBRID combines vector similarity with lexical ranking
 * (the Agentforce-RAG default). VECTOR is pure semantic similarity.
 *
 * Sourced from the SDK (narrowed in v0.2.9 via the SCHEMA_OVERRIDES
 * fieldTypes mechanism); afd360 always supplies a value so the field is
 * required at our layer.
 */
export type SearchIndexSearchType = SemanticSearchInputRepresentation["searchType"];

/**
 * Processing cadence. `NEAR_REALTIME` is the aporg KA_Knowledge default and
 * the only value the platform currently accepts through the Connect API.
 * `REALTIME` is reserved for future use.
 *
 * SDK currently types this as a bare `string` (no spec narrowing); afd360
 * keeps a stricter literal union for the user-facing surface. Tracked
 * upstream in the SemanticSearchInputRepresentation override note.
 */
export type SearchIndexProcessingType = "NEAR_REALTIME" | "REALTIME";

/**
 * Named chunking/embedding/index config block. Mirrors the platform's
 * `ConfigInputRepresentation`: `{ id, userValues: [{id,value}] }`. The id is a
 * platform-known constant (e.g. `passage_extraction`, `e5_large_v2`, `HNSW`).
 */
export interface ConfigBlock {
  readonly id: string;
  readonly userValues: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

/**
 * One field on the source DMO to be chunked. The platform expects developer
 * names (e.g. `ssot__ArticleContentText__c`). Display names (`sourceDmoName`,
 * `sourceDmoFieldName`) on input cause the POST to 500 — they're output-only.
 */
export interface ChunkingFieldConfig {
  /** Developer name (__c). Must exist verbatim on the source DMO. */
  readonly fieldDeveloperName: string;
  /** Chunking strategy. Default: `passage_extraction` with strip_html + 512 tokens. */
  readonly config?: ConfigBlock;
  /**
   * Prepend/append decorators — extra DMO fields whose values get prefixed
   * onto each chunk. Common for Knowledge: prepend Description, Question.
   */
  readonly decorators?: ReadonlyArray<ChunkingDecorator>;
}

export interface ChunkingDecorator {
  /** `prepend` or `append`. */
  readonly decoratorId: "prepend" | "append";
  /** DMO dev name WITH __dlm (prepended from a related DMO, typically the same source). */
  readonly dmoDeveloperName: string;
  /** Field dev name (__c). */
  readonly dmoFieldDeveloperName: string;
}

/**
 * Extra fields pulled onto the vector embedding row — searchable alongside
 * the embedding. Quirk C3: this array must be non-empty, or the server NPEs.
 * Include at least the source DMO's PK.
 */
export interface VectorRelatedField {
  /** DMO dev name WITH __dlm. */
  readonly dmoDeveloperName: string;
  /** Field dev name (__c). */
  readonly fieldDeveloperName: string;
}

/**
 * Vector embedding config. Defaults to `e5_large_v2` (1024 dim / 512 max
 * tokens) + HNSW COSINE — the platform's /search-index/config values.
 */
export interface VectorEmbeddingConfig {
  readonly embeddingModel?: ConfigBlock;
  readonly index?: ConfigBlock;
  /** `COSINE` | `DOT_PRODUCT` | `EUCLIDEAN`. Default COSINE. */
  readonly similarityMetric?: string;
}

export interface SearchIndexProps {
  /** Dev name for the index. Defaults to construct id. Must be unique per org. */
  readonly name?: string;
  /** UI label. Defaults to the dev name. */
  readonly label?: string;
  readonly description?: string;
  /**
   * Source DMO — either an afd360-managed DMO construct (preferred; auto-wires
   * dependsOn and readiness) or a standard DMO referenced by dev name with
   * `__dlm` suffix (e.g. `ssot__KnowledgeArticleVersion__dlm`).
   */
  readonly sourceDmo: DMO | string;
  /**
   * Chunk DMO dev name — platform creates it behind the scenes. Must NOT
   * carry `__dlm` (quirk C2). Defaults to `<name>_chunk`.
   */
  readonly chunkDmoName?: string;
  /** Chunk DMO display name. Defaults to `<label> chunk`. */
  readonly chunkDmoLabel?: string;
  /** Vector DMO dev name. Must NOT carry `__dlm`. Defaults to `<name>_index`. */
  readonly vectorDmoName?: string;
  readonly vectorDmoLabel?: string;
  readonly searchType?: SearchIndexSearchType;
  readonly processingType?: SearchIndexProcessingType;
  /** At least one field to chunk. The first field's DMO PK is added to vectorEmbeddingRelatedFields. */
  readonly fields: ReadonlyArray<ChunkingFieldConfig>;
  /** Extra fields on the embedding row. C3: must include at least one entry; defaults to the source DMO PK. */
  readonly vectorRelatedFields?: ReadonlyArray<VectorRelatedField>;
  readonly vectorEmbedding?: VectorEmbeddingConfig;
  readonly dataSpace?: string;
  readonly dependsOn?: ReadonlyArray<Construct>;
}

export interface SearchIndexOutput {
  /** Platform-assigned id (used for delete per quirk C6). */
  readonly id: string;
  readonly developerName: string;
  readonly label?: string;
  readonly searchType?: string;
  readonly processingType?: string;
  readonly runtimeStatus?: string;
  readonly sourceDmoDeveloperName?: string;
  readonly chunkDmoDeveloperName?: string;
  readonly vectorDmoDeveloperName?: string;
}

export interface SearchIndexResourceProps {
  readonly developerName: string;
  readonly label: string;
  readonly description?: string;
  readonly sourceDmoDeveloperName: string;
  readonly chunkDmoDeveloperName: string;
  readonly chunkDmoLabel: string;
  readonly vectorDmoDeveloperName: string;
  readonly vectorDmoLabel: string;
  readonly searchType: SearchIndexSearchType;
  readonly processingType: SearchIndexProcessingType;
  readonly fields: ReadonlyArray<ChunkingFieldConfig>;
  readonly vectorRelatedFields: ReadonlyArray<VectorRelatedField>;
  readonly vectorEmbedding: Required<VectorEmbeddingConfig>;
  readonly dataSpace: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DEFAULT_EMBEDDING_MODEL: ConfigBlock = {
  id: "e5_large_v2",
  userValues: [
    { id: "dimension", value: "1024" },
    { id: "max_token_limit", value: "512" },
  ],
};

const DEFAULT_INDEX: ConfigBlock = {
  id: "HNSW",
  userValues: [
    { id: "hnswEfConstruction", value: "2000" },
    { id: "M", value: "64" },
  ],
};

const DEFAULT_CHUNKING: ConfigBlock = {
  id: "passage_extraction",
  userValues: [
    { id: "strip_html", value: "true" },
    { id: "max_tokens", value: "512" },
  ],
};

// SearchIndex's GET /ssot/search-index/{developerName} returns `400
// INVALID_INPUT` with "...was not found" in the body when the name doesn't
// exist — not the clean 404 the other endpoints use. Widen the base helper
// with a 400-body matcher so lookupByProps can return null instead of
// throwing on a first-deploy miss. See feedback_search-index-create-shape.md.
function isNotFound(err: unknown): boolean {
  return baseIsNotFound(err, { extra400Body: "was not found" });
}

function rejectDlmSuffix(kind: string, name: string): void {
  if (name.endsWith("__dlm")) {
    // Quirk C2: double-suffixing NPEs server-side. Better to fail fast at
    // construct time with a clear message than to inflict a 500 on deploy.
    throw new Error(
      `SearchIndex ${kind} "${name}" must not end with "__dlm" — the platform appends it. Use "${name.replace(/__dlm$/, "")}".`,
    );
  }
}

function toOutput(raw: {
  id?: string;
  developerName?: string;
  label?: string;
  searchType?: string;
  processingType?: string;
  runtimeStatus?: string;
  sourceDmoDeveloperName?: string;
  chunkDmoDeveloperName?: string;
  vectorDmoDeveloperName?: string;
}): SearchIndexOutput {
  const out: Mutable<SearchIndexOutput> = {
    id: raw.id ?? "",
    developerName: raw.developerName ?? "",
  };
  if (raw.label !== undefined) out.label = raw.label;
  if (raw.searchType !== undefined) out.searchType = raw.searchType;
  if (raw.processingType !== undefined) out.processingType = raw.processingType;
  if (raw.runtimeStatus !== undefined) out.runtimeStatus = raw.runtimeStatus;
  if (raw.sourceDmoDeveloperName !== undefined) out.sourceDmoDeveloperName = raw.sourceDmoDeveloperName;
  if (raw.chunkDmoDeveloperName !== undefined) out.chunkDmoDeveloperName = raw.chunkDmoDeveloperName;
  if (raw.vectorDmoDeveloperName !== undefined) out.vectorDmoDeveloperName = raw.vectorDmoDeveloperName;
  return out;
}

function buildCreatePayload(p: SearchIndexResourceProps): unknown {
  // Evidence: six probes on jaygentforce 2026-05-05; see memory note
  // feedback_search-index-create-shape.md. The platform 500s if the input
  // echoes the output-only name fields (`sourceDmoName`, `sourceDmoFieldName`,
  // `relatedDmoName`, `relatedDmoFieldName`). We deliberately pass developer
  // names only. Matches tdc/scripts/data-cloud/provision/search-index.ts.
  return {
    developerName: p.developerName,
    label: p.label,
    ...(p.description !== undefined ? { description: p.description } : {}),
    searchType: p.searchType,
    processingType: p.processingType,
    sourceDmoDeveloperName: p.sourceDmoDeveloperName,
    chunkDmoDeveloperName: p.chunkDmoDeveloperName,
    chunkDmoName: p.chunkDmoLabel,
    vectorDmoDeveloperName: p.vectorDmoDeveloperName,
    vectorDmoName: p.vectorDmoLabel,
    chunkingConfiguration: {
      fieldLevelConfigurations: p.fields.map((f) => ({
        config: f.config ?? DEFAULT_CHUNKING,
        decorators: (f.decorators ?? []).map((d) => ({
          decoratorId: d.decoratorId,
          dmoDeveloperName: d.dmoDeveloperName,
          dmoFieldDeveloperName: d.dmoFieldDeveloperName,
          relationships: [],
        })),
        sourceDmoDeveloperName: p.sourceDmoDeveloperName,
        sourceDmoFieldDeveloperName: f.fieldDeveloperName,
      })),
    },
    vectorEmbedding: {
      vectorEmbeddingRelatedFields: p.vectorRelatedFields.map((v) => ({
        relatedDmoDeveloperName: v.dmoDeveloperName,
        relatedDmoFieldDeveloperName: v.fieldDeveloperName,
        relationships: [],
      })),
    },
    vectorEmbeddingConfiguration: {
      similarityMetric: p.vectorEmbedding.similarityMetric,
      embeddingModel: p.vectorEmbedding.embeddingModel,
      index: p.vectorEmbedding.index,
    },
  };
}

export const SearchIndexResource: Resource<SearchIndexResourceProps, SearchIndexOutput> = {
  type: "SearchIndex",
  surface: "connect",

  idOf(out): string {
    // Platform-assigned id — feeding this back to delete is the ONLY path
    // that works (quirk C6: DELETE /search-index/{developerName} 404s).
    return out.id;
  },

  async read(ctx, id): Promise<SearchIndexOutput | null> {
    try {
      const result = await ctx.client.searchIndex.get(id);
      return toOutput(result as never);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async lookupByProps(ctx, props): Promise<SearchIndexOutput | null> {
    // Try GET by developerName first — the list endpoint paginates and we'd
    // prefer a direct hit. The GET endpoint accepts either id or dev name.
    try {
      const result = await ctx.client.searchIndex.get(props.developerName);
      return toOutput(result as never);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async create(ctx, props): Promise<SearchIndexOutput> {
    const body = buildCreatePayload(props) as Parameters<
      Data360Client["searchIndex"]["create"]
    >[0];
    // Quirk C1 — "DMO not fully materialized" surfaces as a 400 (sometimes
    // a 500) for up to ~90s after the DMO's own isReady check passes. Retry
    // 6 × 15s. Match tdc's pattern.
    const shouldRetry = (err: unknown): boolean =>
      errBodyIncludes(err, "not fully materialized") ||
      errBodyIncludes(err, "not materialized") ||
      is5xx(err);
    const created = await retryOn(
      () => ctx.client.searchIndex.create(body, { timeout: 120_000 }),
      shouldRetry,
      { attempts: 6, intervalMs: 15_000, backoff: 1, jitter: 0 },
    );
    const id = (created as { id?: string }).id;
    if (!id) {
      throw new Error(`SearchIndex create returned no id — cannot key state.`);
    }
    // The create response is a thin "receipt" (id + vector embedding sub-id
    // + chunking strategy ids). developerName isn't echoed back — hydrate
    // from GET so callers get a full output.
    const hydrated = await SearchIndexResource.read(ctx, id);
    if (hydrated) return hydrated;
    return toOutput({ id, developerName: props.developerName, label: props.label });
  },

  async update(_ctx, _id, _props): Promise<SearchIndexOutput> {
    // v1 policy (PLAN §9) — hash drift triggers delete-and-recreate. PATCH
    // exists in the SDK but the payload is effectively the full input shape;
    // for a resource this central to downstream agent config we prefer an
    // explicit destroy + redeploy to surface blast-radius in diff.
    throw new Error(
      "SearchIndexResource.update is not implemented in v1 — hash drift triggers delete-and-recreate (PLAN §9).",
    );
  },

  async delete(ctx, id): Promise<void> {
    // Quirk C6 — DELETE by id, not developerName. The name-keyed path 404s.
    // The id is stored in state by `idOf`, so this path is safe.
    try {
      await retryOn5xx(() => ctx.client.searchIndex.delete(id));
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
  },

  async isReady(_ctx, output): Promise<boolean> {
    // runtimeStatus transitions null → PROCESSING → READY (happy path) or
    // FAILED. The platform also briefly reports `null` before `PROCESSING`
    // starts. Treat null and PROCESSING as "keep polling".
    const status = (output.runtimeStatus ?? "").toUpperCase();
    if (status === "FAILED") {
      throw new Error(
        `SearchIndex "${output.developerName}" entered terminal state FAILED. ` +
          `Check the source DMO's schema and that the chunked fields exist.`,
      );
    }
    return status === "READY";
  },

  isFailed(output): boolean {
    return (output.runtimeStatus ?? "").toUpperCase() === "FAILED";
  },

  hash(props): string {
    return hashProps(props);
  },
};

interface SearchIndexOpts {
  readonly dependsOn?: readonly Construct[];
  readonly readyIntervalMs?: number;
  readonly readyTimeoutMs?: number;
}

export class SearchIndex extends Construct {
  readonly resource = SearchIndexResource;
  readonly devName: string;
  readonly props: SearchIndexResourceProps;
  readonly dependsOn: readonly Construct[];
  readonly readyIntervalMs: number;
  readonly readyTimeoutMs: number;

  constructor(scope: Stack, id: string, props: SearchIndexProps, opts: SearchIndexOpts = {}) {
    super(scope, id);
    this.devName = props.name ?? id;
    const label = props.label ?? this.devName;
    const chunkDmoName = props.chunkDmoName ?? `${this.devName}_chunk`;
    const vectorDmoName = props.vectorDmoName ?? `${this.devName}_index`;
    rejectDlmSuffix("chunkDmoName", chunkDmoName);
    rejectDlmSuffix("vectorDmoName", vectorDmoName);

    // Quirk C5 — PK must appear in the embedding-related fields. When the
    // source is an afd360-managed DMO we know the PK statically; otherwise
    // the caller must pass vectorRelatedFields explicitly (or we default to
    // a Salesforce-standard `ssot__Id__c` / `Id__c` guess).
    const sourceDmoDeveloperName =
      typeof props.sourceDmo === "string" ? props.sourceDmo : props.sourceDmo.fullName;
    if (!sourceDmoDeveloperName.endsWith("__dlm")) {
      throw new Error(
        `SearchIndex "${id}": sourceDmo "${sourceDmoDeveloperName}" must be a full DMO name ending in __dlm.`,
      );
    }

    if (props.fields.length === 0) {
      throw new Error(
        `SearchIndex "${id}": at least one chunking field is required.`,
      );
    }

    // Default vectorRelatedFields — quirk C3 says this must be non-empty or
    // the server NPEs. Prefer the authored DMO's PK if we can see it; else
    // fall back to a standard-DMO guess.
    let vectorRelatedFields: ReadonlyArray<VectorRelatedField>;
    if (props.vectorRelatedFields && props.vectorRelatedFields.length > 0) {
      vectorRelatedFields = props.vectorRelatedFields;
    } else {
      const pkField = inferPkField(props.sourceDmo, sourceDmoDeveloperName);
      vectorRelatedFields = [
        { dmoDeveloperName: sourceDmoDeveloperName, fieldDeveloperName: pkField },
      ];
    }

    const vectorEmbedding: Required<VectorEmbeddingConfig> = {
      embeddingModel: props.vectorEmbedding?.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
      index: props.vectorEmbedding?.index ?? DEFAULT_INDEX,
      similarityMetric: props.vectorEmbedding?.similarityMetric ?? "COSINE",
    };

    const resolved: Mutable<SearchIndexResourceProps> = {
      developerName: this.devName,
      label,
      sourceDmoDeveloperName,
      chunkDmoDeveloperName: chunkDmoName,
      chunkDmoLabel: props.chunkDmoLabel ?? `${label} chunk`,
      vectorDmoDeveloperName: vectorDmoName,
      vectorDmoLabel: props.vectorDmoLabel ?? `${label} index`,
      searchType: props.searchType ?? "HYBRID",
      processingType: props.processingType ?? "NEAR_REALTIME",
      fields: props.fields,
      vectorRelatedFields,
      vectorEmbedding,
      dataSpace: props.dataSpace ?? "default",
    };
    if (props.description !== undefined) resolved.description = props.description;
    this.props = resolved;

    const autoDeps: Construct[] = [];
    if (typeof props.sourceDmo !== "string") autoDeps.push(props.sourceDmo);
    // Auto-wire any Mapping in the same stack whose target DMO matches our
    // source DMO. Without this, topo sort can run SearchIndex in parallel
    // with Mapping — and the index's chunk/vector DMOs may sit at
    // runtimeStatus=null indefinitely waiting for source data that hasn't
    // been mapped yet (causing the 10-min poll to time out).
    //
    // Two-way wiring: at construct time we scan existing siblings; the
    // Mapping constructor reciprocates by appending itself to any already-
    // constructed SearchIndex whose sourceDmo matches its target. Order-
    // independent.
    const stackScope = findStack(scope);
    if (stackScope) {
      for (const sibling of stackScope.children) {
        if (
          isMappingForDmo(sibling, sourceDmoDeveloperName) &&
          !autoDeps.includes(sibling) &&
          !(props.dependsOn ?? []).includes(sibling) &&
          !(opts.dependsOn ?? []).includes(sibling)
        ) {
          autoDeps.push(sibling);
        }
      }
    }
    // Mutable internal list so Mapping.constructor can append to it later
    // (when Mapping is constructed AFTER this SearchIndex).
    this.dependsOn = [...autoDeps, ...(props.dependsOn ?? []), ...(opts.dependsOn ?? [])];

    // SearchIndex readiness is slow — provisioning a chunk+vector DMO plus
    // the embedding job takes 10-12 min on a freshly-mapped Snowflake DMO
    // (observed on awt 2026-05-07: indexRefreshedOn ~12 min after create).
    // 15 min default covers the observed tail; users can override per-stack.
    this.readyIntervalMs = opts.readyIntervalMs ?? 10_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 900_000;
  }
}

function inferPkField(sourceDmo: DMO | string, fullName: string): string {
  if (typeof sourceDmo !== "string") {
    const pk = sourceDmo.props.fields.find((f) => f.isPrimaryKey);
    if (pk) return pk.name.endsWith("__c") ? pk.name : `${pk.name}__c`;
  }
  // Standard-DMO convention: ssot__Id__c on ssot__* DMOs, Id__c otherwise.
  return fullName.startsWith("ssot__") ? "ssot__Id__c" : "Id__c";
}

/**
 * Walk up the scope chain to find the owning Stack. Used by SearchIndex's
 * sibling-Mapping discovery — Mapping siblings live as direct children of
 * the Stack, not of the SearchIndex itself.
 */
function findStack(scope: Construct | { children: Construct[] }): { children: Construct[] } | null {
  let cur: unknown = scope;
  // Walk up until we find something with `targetOrg` (Stack) or run out of parent.
  while (cur && typeof cur === "object") {
    if ("targetOrg" in cur) return cur as unknown as { children: Construct[] };
    cur = (cur as { scope?: unknown }).scope;
  }
  return null;
}

/**
 * Is `c` a Mapping construct whose target DMO matches `dmoFullName`?
 * Duck-typed so cross-realm SearchIndex (e.g. user's src/ vs CLI's dist/)
 * still recognizes Mapping instances.
 */
function isMappingForDmo(c: Construct, dmoFullName: string): boolean {
  const r = (c as { resource?: { type?: unknown } }).resource;
  if (!r || (r as { type?: string }).type !== "Mapping") return false;
  const props = (c as { props?: { targetDmoName?: unknown } }).props;
  return (props?.targetDmoName as string | undefined) === dmoFullName;
}

/**
 * Internal API for the Mapping construct: append `mapping` to this
 * SearchIndex's dependsOn IF its sourceDmo matches the mapping's target.
 * Called by `Mapping`'s constructor so that ordering between Mapping and
 * SearchIndex in the manifest doesn't matter.
 */
export function attachMappingToSearchIndexes(stack: { children: Construct[] }, mapping: Construct & { props: { targetDmoName: string } }): void {
  for (const sibling of stack.children) {
    const r = (sibling as { resource?: { type?: unknown } }).resource;
    if (!r || (r as { type?: string }).type !== "SearchIndex") continue;
    const idx = sibling as unknown as { props: { sourceDmoDeveloperName: string }; dependsOn: Construct[] };
    if (idx.props.sourceDmoDeveloperName !== mapping.props.targetDmoName) continue;
    if (idx.dependsOn.includes(mapping)) continue;
    // dependsOn is typed `readonly` for external consumers; mutate the
    // backing array directly. Same pattern as Relationship.addDependency.
    (idx.dependsOn as Construct[]).push(mapping);
  }
}
