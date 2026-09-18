import type { JsonObject, JsonValue, Sha256Digest } from './json.js';

export type RunBrief = JsonObject;

export interface GraphValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class GraphValidationError extends Error {
  readonly issues: readonly GraphValidationIssue[];

  constructor(message: string, issues: readonly GraphValidationIssue[]) {
    super(message);
    this.name = 'GraphValidationError';
    this.issues = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue })),
    );
  }
}

export type GraphId = string;
export type NodeId = string;
export type EdgeId = string;

export interface GraphNode<Data extends JsonValue = JsonValue>
  extends JsonObject {
  readonly id: NodeId;
  readonly data: Data;
}

export interface GraphEdge<Data extends JsonValue = JsonValue>
  extends JsonObject {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly data: Data;
}

export interface GraphDefinition<
  NodeData extends JsonValue = JsonValue,
  EdgeData extends JsonValue = JsonValue,
  GraphData extends JsonValue = JsonValue,
> extends JsonObject {
  readonly id: GraphId;
  readonly definitionVersion: number;
  readonly data: GraphData;
  readonly nodes: readonly GraphNode<NodeData>[];
  readonly edges: readonly GraphEdge<EdgeData>[];
}

export interface CompiledGraphDefinition<
  Definition extends GraphDefinition = GraphDefinition,
> extends JsonObject {
  readonly value: Definition;
  readonly canonicalJson: string;
  readonly digest: Sha256Digest;
}

type DefinitionNode<Definition extends GraphDefinition> =
  Definition['nodes'][number];
type DefinitionEdge<Definition extends GraphDefinition> =
  Definition['edges'][number];

export interface GraphKernel<
  Definition extends GraphDefinition = GraphDefinition,
> {
  readonly definition: CompiledGraphDefinition<Definition>;
  node(id: NodeId): DefinitionNode<Definition> | undefined;
  edge(id: EdgeId): DefinitionEdge<Definition> | undefined;
  predecessors(id: NodeId): readonly NodeId[];
  successors(id: NodeId): readonly NodeId[];
  inboundEdges(id: NodeId): readonly DefinitionEdge<Definition>[];
  outboundEdges(id: NodeId): readonly DefinitionEdge<Definition>[];
}
