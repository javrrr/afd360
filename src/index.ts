// Public SDK exports. Populated per milestone.

export const VERSION = "0.0.1";

export { App, Stack } from "./core/app.js";
export type { Plan, PlanResource, StackProps } from "./core/app.js";
export { Construct } from "./core/construct.js";
export type { Resource, ResourceContext, Scope } from "./core/construct.js";

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
