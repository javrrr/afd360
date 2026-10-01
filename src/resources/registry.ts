import type { Resource } from "../core/construct.js";
import { ConnectionResource } from "./connection.js";
import { ConnectionSchemaResource } from "./connection-schema.js";
import { DataStreamResource } from "./data-stream.js";
import { DmoResource } from "./dmo.js";
import { MappingResource } from "./mapping.js";
import { RelationshipResource } from "./relationship.js";
import { CalculatedInsightResource } from "./calculated-insight.js";
import { SearchIndexResource } from "./search-index.js";
import { SemanticModelResource } from "./semantic-model.js";
import { VisualizationResource } from "./visualization.js";
import { DashboardResource } from "./dashboard.js";

/**
 * Static `resource.type` → `Resource` map.
 *
 * Orphan prune (`deploy --prune`) deletes state entries whose manifest construct
 * was removed — so there is no `construct.resource` to dispatch through. This
 * registry recovers the right `Resource` from the `type` string persisted in
 * state, reusing every per-resource delete quirk already implemented (DMO
 * 500-on-gone, DataStream DLO cascade, Connection transient 500 /
 * DEPENDENCY_EXISTS, SearchIndex delete-by-id, CI slow async delete, Mapping /
 * ConnectionSchema no-op deletes).
 *
 * Keyed by the SAME string each Resource sets as its `.type` (and that
 * `stateEntry` writes to `StateResource.type`). The `fromExisting` variants
 * (ExistingConnectionResource / ExistingDataStreamResource) are intentionally
 * NOT registered: they share the `type` string but their deletes are no-ops,
 * and prune only ever acts on OWNED orphans — a `fromExisting` / adopted
 * resource is `owned:false`, classified `forget`, never pruned.
 */
export const RESOURCE_REGISTRY: Record<string, Resource<never, never>> = {
  Connection: ConnectionResource as Resource<never, never>,
  ConnectionSchema: ConnectionSchemaResource as Resource<never, never>,
  DataStream: DataStreamResource as Resource<never, never>,
  DMO: DmoResource as Resource<never, never>,
  Mapping: MappingResource as Resource<never, never>,
  Relationship: RelationshipResource as Resource<never, never>,
  CalculatedInsight: CalculatedInsightResource as Resource<never, never>,
  SearchIndex: SearchIndexResource as Resource<never, never>,
  SemanticModel: SemanticModelResource as Resource<never, never>,
  Visualization: VisualizationResource as Resource<never, never>,
  Dashboard: DashboardResource as Resource<never, never>,
};

/**
 * Fixed dependency-respecting delete order, used when a state entry has no
 * recorded `dependsOn` edges (legacy state written before that field existed).
 * Lower index = delete earlier. Mirrors destroy's reverse-topo intent:
 * dependents (Mapping/Relationship, then the DMO consumers) before the DMO,
 * then the stream and its schema, then the Connection last. Types absent here
 * sort after all listed ones (stable), which is safe for leaf resources.
 */
export const PRUNE_TYPE_PRIORITY: readonly string[] = [
  "Mapping",
  "Relationship",
  "SearchIndex",
  // Dashboard before Visualization: a dashboard widget references (binds) a viz
  // by name, so the referencing dashboard tears down before the viz it points at.
  // (Analytics teardown order: Dashboard → Viz → SemanticModel → CI → DMO.)
  "Dashboard",
  // Visualization before SemanticModel: a viz binds to (references) a model, and
  // the model can't be torn down while a viz still points at it — so the viz
  // deletes first. (Analytics teardown order: Viz → SemanticModel → CI → DMO.)
  "Visualization",
  // SemanticModel before CalculatedInsight + DMO: a model HARD-BLOCKS deletion
  // of the CIs/DMOs it references (platform 400 DELETE_FAILED), so it must be
  // torn down first.
  "SemanticModel",
  "CalculatedInsight",
  "DMO",
  "DataStream",
  "ConnectionSchema",
  "Connection",
];

/** Priority index for a type; unknown types sort last (after all known). */
export function pruneTypeRank(type: string): number {
  const i = PRUNE_TYPE_PRIORITY.indexOf(type);
  return i === -1 ? PRUNE_TYPE_PRIORITY.length : i;
}
