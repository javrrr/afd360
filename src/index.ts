// Public SDK exports. Populated per milestone.

declare const __PKG_VERSION__: string;
export const VERSION: string = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "0.0.0";

export { App, Stack } from "./core/app.js";
export type { Plan, PlanResource, StackProps } from "./core/app.js";
export { Construct, protect, isProtected } from "./core/construct.js";
export type { Resource, ResourceContext, Scope } from "./core/construct.js";
export type { MovedEntry } from "./core/moves.js";

export { Connection } from "./resources/connection.js";
export type { ConnectionProps, ConnectionOutput } from "./resources/connection.js";
export { ConnectionSchema } from "./resources/connection-schema.js";
export type {
  ConnectionSchemaProps,
  ConnectionSchemaOutput,
} from "./resources/connection-schema.js";
export { DataStream } from "./resources/data-stream.js";
export type {
  DataStreamProps,
  DataStreamOutput,
  DataStreamPrimaryKey,
  DataStreamConnectorType,
  AwsS3StreamAttributes,
  SnowflakeStreamAttributes,
  BigQueryStreamAttributes,
  DloCategory,
} from "./resources/data-stream.js";
export { DMO } from "./resources/dmo.js";
export type {
  DmoProps,
  DmoOutput,
  DmoField,
  DmoCategory,
} from "./resources/dmo.js";
export { Mapping } from "./resources/mapping.js";
export type {
  MappingProps,
  MappingOutput,
  FieldMapping,
} from "./resources/mapping.js";
export { Relationship } from "./resources/relationship.js";
export type {
  RelationshipProps,
  RelationshipOutput,
  RelationshipCardinality,
  RelationshipOwner,
} from "./resources/relationship.js";
export { CalculatedInsight } from "./resources/calculated-insight.js";
export type {
  CalculatedInsightProps,
  CalculatedInsightOutput,
  CalculatedInsightDefinitionType,
  PublishScheduleInterval,
} from "./resources/calculated-insight.js";
export { SearchIndex } from "./resources/search-index.js";
export type {
  SearchIndexProps,
  SearchIndexOutput,
  SearchIndexSearchType,
  SearchIndexProcessingType,
  ChunkingFieldConfig,
  ChunkingDecorator,
  VectorRelatedField,
  VectorEmbeddingConfig,
  ConfigBlock,
} from "./resources/search-index.js";
export { SemanticModel } from "./resources/semantic-model.js";
export type {
  SemanticModelProps,
  SemanticModelOutput,
  SemanticDataObjectProps,
  SemanticDataObjectType,
  SemanticDimension,
  SemanticMeasure,
  SemanticRelationshipProps,
  SemanticRelationshipCriterion,
  SemanticCalculatedMeasurementProps,
  SemanticCardinality,
} from "./resources/semantic-model.js";
export { Visualization } from "./resources/visualization.js";
export type {
  VisualizationProps,
  VisualizationOutput,
  VisualizationWorkspace,
  VizField,
  VizRole,
  VizAxis,
} from "./resources/visualization.js";
