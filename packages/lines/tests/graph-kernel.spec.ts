import { describe, expect, it } from 'vitest';

import {
  GraphValidationError,
  createGraphKernel,
  type GraphDefinition,
} from '../src/graph/kernel.js';

function graphDefinition(): GraphDefinition {
  return {
    id: 'release-flow',
    definitionVersion: 3,
    data: { label: 'Release' },
    nodes: [
      { id: 'review', data: { order: 2 } },
      { id: 'build', data: { order: 1 } },
      { id: 'release', data: { order: 3 } },
    ],
    edges: [
      { id: 'build-review-a', source: 'build', target: 'review', data: null },
      { id: 'build-review-b', source: 'build', target: 'review', data: null },
      { id: 'review-build', source: 'review', target: 'build', data: null },
      { id: 'review-self', source: 'review', target: 'review', data: null },
      { id: 'review-release', source: 'review', target: 'release', data: null },
    ],
  };
}

function issuesFrom(definition: unknown) {
  try {
    createGraphKernel(definition as GraphDefinition);
  } catch (error) {
    expect(error).toBeInstanceOf(GraphValidationError);
    return (error as GraphValidationError).issues;
  }
  throw new Error('Expected graph validation to fail.');
}

describe('graph topology kernel', () => {
  it('keeps a detached immutable definition snapshot with a stable digest', () => {
    const input = graphDefinition();

    const first = createGraphKernel(input);
    const second = createGraphKernel(graphDefinition());

    expect(first.definition.value).toEqual(input);
    expect(first.definition.value).not.toBe(input);
    expect(first.definition.value.nodes).not.toBe(input.nodes);
    expect(first.definition.value.edges).not.toBe(input.edges);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(first.definition.value)).toBe(true);
    expect(Object.isFrozen(first.definition.value.nodes)).toBe(true);
    expect(Object.isFrozen(first.definition.value.nodes[0])).toBe(true);
    expect(Object.isFrozen(first.definition.value.edges)).toBe(true);
    expect(first.definition.canonicalJson).toBe(second.definition.canonicalJson);
    expect(first.definition.digest).toBe(second.definition.digest);
    expect(first.definition.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    (input.data as { label: string }).label = 'Changed';

    expect(first.definition.value.data).toEqual({ label: 'Release' });
  });

  it('preserves declaration order in lookups and topology queries', () => {
    const kernel = createGraphKernel(graphDefinition());

    expect(kernel.definition.value.nodes.map((node) => node.id)).toEqual([
      'review',
      'build',
      'release',
    ]);
    expect(kernel.definition.value.edges.map((edge) => edge.id)).toEqual([
      'build-review-a',
      'build-review-b',
      'review-build',
      'review-self',
      'review-release',
    ]);
    expect(kernel.node('build')).toEqual({ id: 'build', data: { order: 1 } });
    expect(kernel.edge('review-build')).toEqual({
      id: 'review-build',
      source: 'review',
      target: 'build',
      data: null,
    });
    expect(kernel.inboundEdges('review').map((edge) => edge.id)).toEqual([
      'build-review-a',
      'build-review-b',
      'review-self',
    ]);
    expect(kernel.outboundEdges('review').map((edge) => edge.id)).toEqual([
      'review-build',
      'review-self',
      'review-release',
    ]);
    expect(kernel.predecessors('review')).toEqual(['build', 'review']);
    expect(kernel.successors('review')).toEqual([
      'build',
      'review',
      'release',
    ]);
  });

  it('allows empty, cyclic, self-linked, and parallel-edge graphs', () => {
    expect(() => createGraphKernel(graphDefinition())).not.toThrow();
    expect(() =>
      createGraphKernel({
        id: 'empty',
        definitionVersion: 1,
        data: null,
        nodes: [],
        edges: [],
      }),
    ).not.toThrow();
  });

  it.each([
    ['empty', '', '/id'],
    ['surrounding whitespace', ' graph', '/id'],
    ['control characters', 'graph\nname', '/id'],
  ])('rejects an %s graph identifier', (_name, id, path) => {
    const definition = { ...graphDefinition(), id };

    expect(issuesFrom(definition)).toContainEqual(
      expect.objectContaining({ code: 'INVALID_ID', path }),
    );
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid definition version %s',
    (definitionVersion) => {
      const definition = { ...graphDefinition(), definitionVersion };

      expect(issuesFrom(definition)).toContainEqual(
        expect.objectContaining({
          code: 'INVALID_VERSION',
          path: '/definitionVersion',
        }),
      );
    },
  );

  it('reports duplicate node and edge identifiers at the duplicate', () => {
    const definition = graphDefinition();
    const duplicate = {
      ...definition,
      nodes: [
        ...definition.nodes,
        { id: 'review', data: { order: 4 } },
      ],
      edges: [
        ...definition.edges,
        { id: 'review-build', source: 'build', target: 'release', data: null },
      ],
    };

    expect(issuesFrom(duplicate)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'DUPLICATE_NODE_ID',
          path: '/nodes/3/id',
        }),
        expect.objectContaining({
          code: 'DUPLICATE_EDGE_ID',
          path: '/edges/5/id',
        }),
      ]),
    );
  });

  it('reports each missing edge endpoint before exposing a kernel', () => {
    const definition = graphDefinition();
    const missingEndpoints = {
      ...definition,
      edges: [
        ...definition.edges,
        { id: 'missing-both', source: 'unknown-a', target: 'unknown-b', data: null },
      ],
    };

    expect(issuesFrom(missingEndpoints)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNKNOWN_SOURCE_NODE',
          path: '/edges/5/source',
        }),
        expect.objectContaining({
          code: 'UNKNOWN_TARGET_NODE',
          path: '/edges/5/target',
        }),
      ]),
    );
  });

  it('reports invalid node, edge, and endpoint identifiers', () => {
    const definition = graphDefinition();
    const invalidIdentifiers = {
      ...definition,
      nodes: [{ id: ' node', data: null }, ...definition.nodes],
      edges: [
        {
          id: 'edge\n',
          source: ' build',
          target: 'review ',
          data: null,
        },
        ...definition.edges,
      ],
    };

    expect(issuesFrom(invalidIdentifiers)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_ID', path: '/nodes/0/id' }),
        expect.objectContaining({ code: 'INVALID_ID', path: '/edges/0/id' }),
        expect.objectContaining({ code: 'INVALID_ID', path: '/edges/0/source' }),
        expect.objectContaining({ code: 'INVALID_ID', path: '/edges/0/target' }),
      ]),
    );
  });

  it('wraps strict JSON failures as graph validation issues', () => {
    const definition = graphDefinition() as GraphDefinition & {
      hidden?: unknown;
    };
    definition.hidden = undefined;

    expect(issuesFrom(definition)).toEqual([
      expect.objectContaining({
        code: 'INVALID_JSON_VALUE',
        path: '/hidden',
      }),
    ]);
  });

  it('rejects malformed definition structure without changing the input', () => {
    const input = {
      id: 'malformed',
      definitionVersion: 1,
      data: null,
      nodes: {},
      edges: 'none',
    };

    expect(issuesFrom(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_DEFINITION', path: '/nodes' }),
        expect.objectContaining({ code: 'INVALID_DEFINITION', path: '/edges' }),
      ]),
    );
    expect(input).toEqual({
      id: 'malformed',
      definitionVersion: 1,
      data: null,
      nodes: {},
      edges: 'none',
    });
  });

  it('throws a structured error when a relationship query names no node', () => {
    const kernel = createGraphKernel(graphDefinition());

    for (const query of [
      () => kernel.predecessors('missing'),
      () => kernel.successors('missing'),
      () => kernel.inboundEdges('missing'),
      () => kernel.outboundEdges('missing'),
    ]) {
      expect(query).toThrowError(
        expect.objectContaining({
          issues: [
            expect.objectContaining({
              code: 'UNKNOWN_NODE',
              path: '/nodeId',
            }),
          ],
        }),
      );
    }
  });
});
