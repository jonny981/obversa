import {
  GraphValidationError,
  JsonValueError,
  canonicalJson,
  cloneFrozenJson,
  digestJson,
  type GraphValidationIssue,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
} from './value.js';

export { GraphValidationError } from './value.js';
export type { GraphValidationIssue } from './value.js';

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

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: JsonValue | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !CONTROL_CHARACTER.test(value)
  );
}

function issue(
  code: string,
  path: string,
  message: string,
): GraphValidationIssue {
  return { code, path, message };
}

function validateDefinition(value: JsonValue): asserts value is GraphDefinition {
  const issues: GraphValidationIssue[] = [];
  if (!isRecord(value)) {
    throw new GraphValidationError('Graph definition is invalid.', [
      issue('INVALID_DEFINITION', '', 'The graph definition must be an object.'),
    ]);
  }

  if (!isId(value.id)) {
    issues.push(
      issue(
        'INVALID_ID',
        '/id',
        'The graph id must be a non-empty trimmed string without control characters.',
      ),
    );
  }

  if (
    typeof value.definitionVersion !== 'number' ||
    !Number.isSafeInteger(value.definitionVersion) ||
    value.definitionVersion < 1
  ) {
    issues.push(
      issue(
        'INVALID_VERSION',
        '/definitionVersion',
        'The definition version must be a positive safe integer.',
      ),
    );
  }

  if (!Object.hasOwn(value, 'data')) {
    issues.push(
      issue('INVALID_DEFINITION', '/data', 'The graph data field is required.'),
    );
  }

  const nodeIds = new Set<string>();
  if (!Array.isArray(value.nodes)) {
    issues.push(
      issue('INVALID_DEFINITION', '/nodes', 'Graph nodes must be an array.'),
    );
  } else {
    for (const [index, node] of value.nodes.entries()) {
      const path = `/nodes/${index}`;
      if (!isRecord(node)) {
        issues.push(
          issue('INVALID_DEFINITION', path, 'Each graph node must be an object.'),
        );
        continue;
      }

      if (!isId(node.id)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/id`,
            'A node id must be a non-empty trimmed string without control characters.',
          ),
        );
      } else if (nodeIds.has(node.id)) {
        issues.push(
          issue(
            'DUPLICATE_NODE_ID',
            `${path}/id`,
            `Node id "${node.id}" is already declared.`,
          ),
        );
      } else {
        nodeIds.add(node.id);
      }

      if (!Object.hasOwn(node, 'data')) {
        issues.push(
          issue('INVALID_DEFINITION', `${path}/data`, 'Node data is required.'),
        );
      }
    }
  }

  const edgeIds = new Set<string>();
  if (!Array.isArray(value.edges)) {
    issues.push(
      issue('INVALID_DEFINITION', '/edges', 'Graph edges must be an array.'),
    );
  } else {
    for (const [index, edge] of value.edges.entries()) {
      const path = `/edges/${index}`;
      if (!isRecord(edge)) {
        issues.push(
          issue('INVALID_DEFINITION', path, 'Each graph edge must be an object.'),
        );
        continue;
      }

      if (!isId(edge.id)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/id`,
            'An edge id must be a non-empty trimmed string without control characters.',
          ),
        );
      } else if (edgeIds.has(edge.id)) {
        issues.push(
          issue(
            'DUPLICATE_EDGE_ID',
            `${path}/id`,
            `Edge id "${edge.id}" is already declared.`,
          ),
        );
      } else {
        edgeIds.add(edge.id);
      }

      if (!isId(edge.source)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/source`,
            'An edge source must be a valid node id.',
          ),
        );
      } else if (!nodeIds.has(edge.source)) {
        issues.push(
          issue(
            'UNKNOWN_SOURCE_NODE',
            `${path}/source`,
            `Source node "${edge.source}" is not declared.`,
          ),
        );
      }

      if (!isId(edge.target)) {
        issues.push(
          issue(
            'INVALID_ID',
            `${path}/target`,
            'An edge target must be a valid node id.',
          ),
        );
      } else if (!nodeIds.has(edge.target)) {
        issues.push(
          issue(
            'UNKNOWN_TARGET_NODE',
            `${path}/target`,
            `Target node "${edge.target}" is not declared.`,
          ),
        );
      }

      if (!Object.hasOwn(edge, 'data')) {
        issues.push(
          issue('INVALID_DEFINITION', `${path}/data`, 'Edge data is required.'),
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new GraphValidationError('Graph definition is invalid.', issues);
  }
}

function unknownNode(id: NodeId): GraphValidationError {
  return new GraphValidationError(`Graph node "${id}" does not exist.`, [
    issue('UNKNOWN_NODE', '/nodeId', `Node "${id}" is not declared.`),
  ]);
}

function uniqueNodeIds(
  edges: readonly GraphEdge[],
  select: (edge: GraphEdge) => NodeId,
): readonly NodeId[] {
  const ids: NodeId[] = [];
  const seen = new Set<NodeId>();
  for (const edge of edges) {
    const id = select(edge);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return Object.freeze(ids);
}

export function createGraphKernel<Definition extends GraphDefinition>(
  definition: Definition,
): GraphKernel<Definition> {
  let frozen: JsonValue;
  try {
    frozen = cloneFrozenJson(definition);
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    throw new GraphValidationError('Graph definition is invalid.', [
      issue('INVALID_JSON_VALUE', error.path, error.message),
    ]);
  }

  validateDefinition(frozen);
  const value = frozen as Definition;
  const nodes = value.nodes as readonly DefinitionNode<Definition>[];
  const edges = value.edges as readonly DefinitionEdge<Definition>[];

  const nodeById = new Map<NodeId, DefinitionNode<Definition>>(
    nodes.map((node) => [node.id, node]),
  );
  const edgeById = new Map<EdgeId, DefinitionEdge<Definition>>(
    edges.map((edge) => [edge.id, edge]),
  );
  const inbound = new Map<NodeId, DefinitionEdge<Definition>[]>();
  const outbound = new Map<NodeId, DefinitionEdge<Definition>[]>();
  for (const node of nodes) {
    inbound.set(node.id, []);
    outbound.set(node.id, []);
  }
  for (const edge of edges) {
    inbound.get(edge.target)!.push(edge);
    outbound.get(edge.source)!.push(edge);
  }

  const inboundFrozen = new Map<NodeId, readonly DefinitionEdge<Definition>[]>();
  const outboundFrozen = new Map<NodeId, readonly DefinitionEdge<Definition>[]>();
  const predecessors = new Map<NodeId, readonly NodeId[]>();
  const successors = new Map<NodeId, readonly NodeId[]>();
  for (const node of nodes) {
    const nodeInbound = Object.freeze(inbound.get(node.id)!);
    const nodeOutbound = Object.freeze(outbound.get(node.id)!);
    inboundFrozen.set(node.id, nodeInbound);
    outboundFrozen.set(node.id, nodeOutbound);
    predecessors.set(
      node.id,
      uniqueNodeIds(nodeInbound, (edge) => edge.source),
    );
    successors.set(
      node.id,
      uniqueNodeIds(nodeOutbound, (edge) => edge.target),
    );
  }

  const requireNode = (id: NodeId): void => {
    if (!nodeById.has(id)) throw unknownNode(id);
  };
  const snapshot = Object.freeze({
    value,
    canonicalJson: canonicalJson(value),
    digest: digestJson(value),
  });

  return Object.freeze({
    definition: snapshot,
    node: (id: NodeId) => nodeById.get(id),
    edge: (id: EdgeId) => edgeById.get(id),
    predecessors: (id: NodeId) => {
      requireNode(id);
      return predecessors.get(id)!;
    },
    successors: (id: NodeId) => {
      requireNode(id);
      return successors.get(id)!;
    },
    inboundEdges: (id: NodeId) => {
      requireNode(id);
      return inboundFrozen.get(id)!;
    },
    outboundEdges: (id: NodeId) => {
      requireNode(id);
      return outboundFrozen.get(id)!;
    },
  });
}
