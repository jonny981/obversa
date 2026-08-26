import { describe, expect, it } from 'vitest';

import type { GraphCommand } from '../src/graph/commands.ts';
import type { GraphDescription } from '../src/graph/plan.ts';
import {
  GraphValidationError,
  type GraphDefinition,
} from '../src/graph/kernel.ts';
import {
  compileGraph,
  type GraphEvent,
  type GraphType,
} from '../src/graph/type.ts';

const definition = {
  id: 'two-role-review',
  definitionVersion: 1,
  data: {},
  nodes: [
    { id: 'author', data: {} },
    { id: 'reviewer', data: {} },
  ],
  edges: [
    { id: 'author-to-reviewer', source: 'author', target: 'reviewer', data: {} },
  ],
} as const satisfies GraphDefinition;

type State = {
  readonly next: 'author' | 'reviewer' | 'done';
};

type CompletedEvent = GraphEvent<
  'node-completed',
  { readonly nodeId: 'author' | 'reviewer' }
>;

function deeplyNestedJson(depth = 10_000): unknown {
  return JSON.parse(`${'['.repeat(depth)}null${']'.repeat(depth)}`);
}

function description(): Omit<
  GraphDescription,
  'schemaVersion' | 'graph' | 'edges' | 'requirements'
> {
  return {
    inputContract: {},
    outputContract: {},
    phases: [
      { id: 'work', name: 'Work', nodeIds: ['author', 'reviewer'] },
    ],
    nodes: [
      {
        id: 'author',
        phaseId: 'work',
        inputContract: {},
        outputContract: {},
        laneId: null,
      },
      {
        id: 'reviewer',
        phaseId: 'work',
        inputContract: {},
        outputContract: {},
        laneId: null,
      },
    ],
    policies: {
      retry: null,
      stop: null,
      concurrency: null,
      write: null,
      budget: null,
      action: null,
    },
    executionLanes: [],
    requestedPermissions: [],
    bounds: {
      dispatches: {
        min: { kind: 'known', value: 2 },
        max: { kind: 'known', value: 2 },
      },
      maxConcurrency: { kind: 'known', value: 1 },
      maxFanOut: { kind: 'known', value: 1 },
    },
  };
}

function graphType(
  decideOverride?: (state: State) => readonly GraphCommand[],
): GraphType<typeof definition, State, CompletedEvent, { readonly memory: 'unused' }> {
  return {
    kind: 'two-role',
    version: 1,
    compile(_value, _kernel) {
      return {
        requirements: { memory: 'unused' },
        initialState: () => ({ next: 'author' }),
        reduce(state, event) {
          if (event.payload.nodeId !== state.next) return state;
          return {
            next: state.next === 'author' ? 'reviewer' : 'done',
          };
        },
        decide: decideOverride ?? ((state) => {
          if (state.next === 'done') {
            return [{ kind: 'complete', output: { accepted: true } }];
          }
          return [{
            kind: 'dispatch',
            nodeId: state.next,
            input: {},
            position: `work/${state.next}`,
          }];
        }),
        describe: description,
      };
    },
  };
}

describe('compileGraph', () => {
  it('replays the same events to the same state and ordered command', () => {
    const compiled = compileGraph(graphType(), definition);
    const initial = compiled.initialState();
    const authorDone: CompletedEvent = {
      type: 'node-completed',
      version: 1,
      payload: { nodeId: 'author' },
    };
    const reviewerDone: CompletedEvent = {
      type: 'node-completed',
      version: 1,
      payload: { nodeId: 'reviewer' },
    };

    const afterAuthorA = compiled.reduce(initial, authorDone);
    const afterAuthorB = compiled.reduce(initial, authorDone);
    expect(afterAuthorA).toEqual({ next: 'reviewer' });
    expect(afterAuthorB).toEqual(afterAuthorA);
    expect(compiled.decide(afterAuthorA)).toEqual([{
      kind: 'dispatch',
      nodeId: 'reviewer',
      input: {},
      position: 'work/reviewer',
    }]);
    expect(compiled.decide(compiled.reduce(afterAuthorA, reviewerDone))).toEqual([
      { kind: 'complete', output: { accepted: true } },
    ]);
    expect(initial).toEqual({ next: 'author' });
    expect(authorDone.payload).toEqual({ nodeId: 'author' });
  });

  it('passes frozen copies to graph code and never freezes caller inputs', () => {
    let seenStateFrozen = false;
    let seenEventFrozen = false;
    const mutating: GraphType<
      typeof definition,
      State,
      CompletedEvent,
      { readonly memory: 'unused' }
    > = {
      ...graphType(),
      compile(value, kernel) {
        const compiled = graphType().compile(value, kernel);
        return {
          ...compiled,
          reduce(state, event) {
            seenStateFrozen = Object.isFrozen(state);
            seenEventFrozen = Object.isFrozen(event) && Object.isFrozen(event.payload);
            return compiled.reduce(state, event);
          },
        };
      },
    };
    const compiled = compileGraph(mutating, definition);
    const state: State = { next: 'author' };
    const event: CompletedEvent = {
      type: 'node-completed',
      version: 1,
      payload: { nodeId: 'author' },
    };

    compiled.reduce(state, event);

    expect(seenStateFrozen).toBe(true);
    expect(seenEventFrozen).toBe(true);
    expect(Object.isFrozen(state)).toBe(false);
    expect(Object.isFrozen(event)).toBe(false);
  });

  it.each([
    ['a missing payload', { type: 'node-completed', version: 1 }],
    ['an extra field', {
      type: 'node-completed',
      version: 1,
      payload: { nodeId: 'author' },
      receivedAt: 123,
    }],
  ])('rejects an event with %s before reducer code runs', (_label, event) => {
    let reductions = 0;
    const observing: GraphType<
      typeof definition,
      State,
      CompletedEvent,
      { readonly memory: 'unused' }
    > = {
      ...graphType(),
      compile(value, kernel) {
        const compiled = graphType().compile(value, kernel);
        return {
          ...compiled,
          reduce(state, input) {
            reductions += 1;
            return compiled.reduce(state, input);
          },
        };
      },
    };
    const compiled = compileGraph(observing, definition);

    expect(() => compiled.reduce(
      { next: 'author' },
      event as never,
    )).toThrowError(GraphValidationError);
    expect(reductions).toBe(0);
  });

  it('rejects invalid decisions before the runtime can dispatch them', () => {
    const unknown = compileGraph(
      graphType(() => [{
        kind: 'dispatch',
        nodeId: 'missing',
        input: {},
        position: 'work/missing',
      }]),
      definition,
    );
    expect(() => unknown.decide({ next: 'author' })).toThrow(/unknown node/i);

    const duplicate = compileGraph(
      graphType(() => [
        { kind: 'dispatch', nodeId: 'author', input: {}, position: 'work/author' },
        { kind: 'dispatch', nodeId: 'author', input: {}, position: 'work/author' },
      ]),
      definition,
    );
    expect(() => duplicate.decide({ next: 'author' })).toThrow(/duplicate/i);

    const mixed = compileGraph(
      graphType(() => [
        { kind: 'complete', output: {} },
        { kind: 'dispatch', nodeId: 'author', input: {}, position: 'work/author' },
      ]),
      definition,
    );
    expect(() => mixed.decide({ next: 'author' })).toThrow(/terminal/i);
  });

  it('accepts an empty decision as no new work to start', () => {
    const empty = compileGraph(graphType(() => []), definition);

    const decision = empty.decide({ next: 'author' });

    expect(decision).toEqual([]);
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it('returns GraphValidationError for an excessively deep definition', () => {
    const deepDefinition = {
      ...definition,
      data: deeplyNestedJson(),
    };

    expect(() => compileGraph(graphType(), deepDefinition as never)).toThrowError(
      expect.objectContaining({
        name: 'GraphValidationError',
        issues: [expect.objectContaining({ code: 'INVALID_JSON_VALUE' })],
      }),
    );
  });

  it('returns one structured error for non-JSON graph state or commands', () => {
    const invalidState: GraphType<
      typeof definition,
      State,
      CompletedEvent,
      { readonly memory: 'unused' }
    > = {
      ...graphType(),
      compile(value, kernel) {
        return {
          ...graphType().compile(value, kernel),
          initialState: () => ({ bad: undefined }) as never,
        };
      },
    };
    expect(() => compileGraph(invalidState, definition)).toThrowError(
      GraphValidationError,
    );

    const invalidCommand = compileGraph(
      graphType(() => [{
        kind: 'dispatch',
        nodeId: 'author',
        input: { bad: undefined },
        position: 'work/author',
      }] as never),
      definition,
    );
    expect(() => invalidCommand.decide({ next: 'author' })).toThrowError(
      GraphValidationError,
    );
  });

  it.each([null, 'pause', 42])(
    'returns GraphValidationError for malformed command entry %j',
    (entry) => {
      const compiled = compileGraph(
        graphType(() => [entry] as never),
        definition,
      );

      expect(() => compiled.decide({ next: 'author' })).toThrowError(
        GraphValidationError,
      );
    },
  );

  it('keeps compiler-owned description metadata when graph code returns collisions', () => {
    const colliding: GraphType<
      typeof definition,
      State,
      CompletedEvent,
      { readonly memory: 'unused' }
    > = {
      ...graphType(),
      compile(value, kernel) {
        const compiled = graphType().compile(value, kernel);
        return {
          ...compiled,
          describe: () => ({
            ...description(),
            schemaVersion: 999,
            graph: {
              id: 'outside-id',
              definitionVersion: 999,
              kind: 'outside-kind',
              typeVersion: 999,
              definitionDigest: `sha256:${'9'.repeat(64)}`,
            },
            edges: [],
            requirements: { memory: 'required' },
          }) as never,
        };
      },
    };

    const compiled = compileGraph(colliding, definition);

    expect(compiled.describe()).toMatchObject({
      schemaVersion: 1,
      graph: {
        id: definition.id,
        definitionVersion: definition.definitionVersion,
        kind: 'two-role',
        typeVersion: 1,
        definitionDigest: compiled.definition.digest,
      },
      edges: [{
        id: 'author-to-reviewer',
        source: 'author',
        target: 'reviewer',
      }],
      requirements: { memory: 'unused' },
    });
  });
});
