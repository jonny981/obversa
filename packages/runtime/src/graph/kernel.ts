import { GraphValidationError, compileGraphDefinition } from '@obversa/api';

export { GraphValidationError } from './value.js';
export type { GraphValidationIssue } from './value.js';

import type { EdgeId, NodeId, GraphEdge, GraphDefinition, GraphKernel } from '@obversa/api';
export type { GraphId, NodeId, EdgeId, GraphNode, GraphEdge, GraphDefinition, CompiledGraphDefinition, GraphKernel } from '@obversa/api';

type DefinitionNode<Definition extends GraphDefinition> =
  Definition['nodes'][number];
type DefinitionEdge<Definition extends GraphDefinition> =
  Definition['edges'][number];

function unknownNode(id: NodeId): GraphValidationError {
  return new GraphValidationError(`Graph node "${id}" does not exist.`, [
    { code: 'UNKNOWN_NODE', path: '/nodeId', message: `Node "${id}" is not declared.` },
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
  const snapshot = compileGraphDefinition(definition);
  const value = snapshot.value;
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
