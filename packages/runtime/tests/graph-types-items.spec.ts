import { describe, expect, it } from 'vitest';

import type { GraphCommand } from '../src/graph/commands.ts';
import type { NodeId } from '../src/graph/kernel.ts';
import type { PlanResolution } from '../src/graph/plan.ts';
import {
  assertGraphTypeConformance,
  runGraphTypeConformance,
  type GraphTypeConformanceFixture,
} from '../src/graph/conformance.ts';
import { compileGraph } from '../src/graph/type.ts';
import { GraphValidationError } from '../src/graph/value.ts';
import {
  boundedItem,
  type BoundedItemDefinition,
  type BoundedItemEvent,
  type BoundedItemRequirements,
  type BoundedItemStatus,
} from '../src/graph-types/items.ts';

const AGGREGATE_RESULT = { passed: 2 };

function itemLane(id: string, provider = 'mock') {
  return {
    id,
    requested: {
      adapter: 'mock', provider, modelFamily: 'mock-family', model: `mock-${provider}`, tools: [] as readonly string[],
    },
    knownSubstitutions: [],
  } as const;
}

function worklist(overrides: Partial<BoundedItemDefinition['data']> = {}): BoundedItemDefinition {
  const data: BoundedItemDefinition['data'] = {
    items: ['doc-1', 'doc-2'],
    globalConcurrency: 2,
    perStageConcurrency: 2,
    attemptCapPerStage: 1,
    failurePolicy: 'fail',
    aggregate: 'tally',
    ...overrides,
  };
  const nodes = [
    { id: 'summarize', data: {} },
    { id: 'verify', data: {} },
  ];
  if (data.aggregate !== null) nodes.push({ id: data.aggregate, data: {} });
  return {
    id: 'document-batch',
    definitionVersion: 1,
    data,
    nodes,
    edges: [
      { id: 'summarize-to-verify', source: 'summarize', target: 'verify', data: {} },
    ],
  };
}

function claimed(itemId: string, stageId: NodeId, attempt: number): BoundedItemEvent {
  return { type: 'item-claimed', version: 1, payload: { itemId, stageId, attempt } };
}

function passedStage(itemId: string, stageId: NodeId, attempt: number): BoundedItemEvent {
  return { type: 'item-stage-completed', version: 1, payload: { itemId, stageId, attempt, result: {} } };
}

function failedStage(itemId: string, stageId: NodeId, attempt: number, code = 'ENGINE_UNAVAILABLE'): BoundedItemEvent {
  return { type: 'item-stage-failed', version: 1, payload: { itemId, stageId, attempt, code } };
}

function reopened(itemId: string, stageId: NodeId): BoundedItemEvent {
  return { type: 'item-reopened', version: 1, payload: { itemId, stageId } };
}

function pausedItem(itemId: string, stageId: NodeId, attempt: number, reason: string): BoundedItemEvent {
  return { type: 'item-paused', version: 1, payload: { itemId, stageId, attempt, reason } };
}

function resumedItem(itemId: string): BoundedItemEvent {
  return { type: 'item-resumed', version: 1, payload: { itemId } };
}

const aggregateClaimed: BoundedItemEvent = {
  type: 'aggregate-claimed',
  version: 1,
  payload: {},
};

function aggregateCompleted(): BoundedItemEvent {
  return { type: 'aggregate-completed', version: 1, payload: { result: AGGREGATE_RESULT } };
}

function planResolution(): PlanResolution {
  const identity = {
    source: 'file:examples/packages/bounded-items',
    version: '1.0.0',
    digest: `sha256:${'b'.repeat(64)}` as const,
  };
  return {
    package: identity,
    admission: { package: identity, permissions: [] },
    executionLanes: [],
  };
}

function orphanAggregate(): BoundedItemDefinition {
  const base = worklist();
  return { ...base, data: { ...base.data, aggregate: 'missing-node' } };
}

function frozen(definition: BoundedItemDefinition): BoundedItemEvent {
  return { type: 'items-frozen', version: 1, payload: { items: [...definition.data.items] } };
}

function fold(
  events: readonly BoundedItemEvent[],
  definition: BoundedItemDefinition = worklist(),
): BoundedItemStatus {
  const compiled = compileGraph(boundedItem, definition);
  let state = compiled.initialState();
  for (const event of [frozen(definition), ...events]) state = compiled.reduce(state, event);
  return state;
}

function decideAt(
  events: readonly BoundedItemEvent[],
  definition: BoundedItemDefinition = worklist(),
): readonly GraphCommand[] {
  const compiled = compileGraph(boundedItem, definition);
  return compiled.decide(fold(events, definition));
}

function expectIssue(definition: BoundedItemDefinition, code: string): void {
  let caught: unknown;
  try {
    compileGraph(boundedItem, definition);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GraphValidationError);
  const issues = (caught as GraphValidationError).issues;
  expect(issues.some((item) => item.code === code)).toBe(true);
}

describe('bounded-item graph type', () => {
  it('passes the graph type conformance kit', () => {
    const fixture: GraphTypeConformanceFixture<
      BoundedItemDefinition,
      BoundedItemStatus,
      BoundedItemEvent,
      BoundedItemRequirements
    > = {
      graphType: boundedItem,
      definition: worklist(),
      events: [
        frozen(worklist()),
        claimed('doc-1', 'summarize', 1),
        claimed('doc-2', 'summarize', 1),
        passedStage('doc-1', 'summarize', 1),
        passedStage('doc-2', 'summarize', 1),
        claimed('doc-1', 'verify', 1),
        claimed('doc-2', 'verify', 1),
        passedStage('doc-1', 'verify', 1),
        passedStage('doc-2', 'verify', 1),
        aggregateClaimed,
        aggregateCompleted(),
      ],
      invalidDefinitions: [
        worklist({ items: ['doc-1', 'doc-1'] }),
        orphanAggregate(),
        { ...worklist(), edges: [] },
      ],
      planResolution: planResolution(),
      expected: {
        states: [
          {
            frozen: null,
            items: {},
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'pending', nextStage: 0, attempts: {}, capAttempts: {} },
              'doc-2': { status: 'pending', nextStage: 0, attempts: {}, capAttempts: {} },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'in-flight', nextStage: 0, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
              'doc-2': { status: 'pending', nextStage: 0, attempts: {}, capAttempts: {} },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'in-flight', nextStage: 0, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
              'doc-2': { status: 'in-flight', nextStage: 0, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'pending', nextStage: 1, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
              'doc-2': { status: 'in-flight', nextStage: 0, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'pending', nextStage: 1, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
              'doc-2': { status: 'pending', nextStage: 1, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'in-flight', nextStage: 1, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
              'doc-2': { status: 'pending', nextStage: 1, attempts: { 0: 1 }, capAttempts: { 0: 1 } },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'in-flight', nextStage: 1, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
              'doc-2': { status: 'in-flight', nextStage: 1, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'done', nextStage: 2, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
              'doc-2': { status: 'in-flight', nextStage: 1, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'done', nextStage: 2, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
              'doc-2': { status: 'done', nextStage: 2, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
            },
            aggregate: 'not-run',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'done', nextStage: 2, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
              'doc-2': { status: 'done', nextStage: 2, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
            },
            aggregate: 'in-flight',
            aggregateResult: null,
          },
          {
            frozen: ['doc-1', 'doc-2'],
            items: {
              'doc-1': { status: 'done', nextStage: 2, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
              'doc-2': { status: 'done', nextStage: 2, attempts: { 0: 1, 1: 1 }, capAttempts: { 0: 1, 1: 1 } },
            },
            aggregate: 'done',
            aggregateResult: AGGREGATE_RESULT,
          },
        ],
        commands: [
          [],
          [
            {
              kind: 'dispatch',
              nodeId: 'summarize',
              input: { positionSummary: 'item doc-1, stage summarize, attempt 1' },
              position: 'items/doc-1/summarize/1',
            },
            {
              kind: 'dispatch',
              nodeId: 'summarize',
              input: { positionSummary: 'item doc-2, stage summarize, attempt 1' },
              position: 'items/doc-2/summarize/1',
            },
          ],
          [],
          [],
          [],
          [
            {
              kind: 'dispatch',
              nodeId: 'verify',
              input: { positionSummary: 'item doc-1, stage verify, attempt 1' },
              position: 'items/doc-1/verify/1',
            },
            {
              kind: 'dispatch',
              nodeId: 'verify',
              input: { positionSummary: 'item doc-2, stage verify, attempt 1' },
              position: 'items/doc-2/verify/1',
            },
          ],
          [],
          [],
          [],
          [{
            kind: 'dispatch',
            nodeId: 'tally',
            input: { positionSummary: 'aggregate, attempt 1' },
            position: 'aggregate/1',
          }],
          [],
          [{
            kind: 'complete',
            output: {
              items: { 'doc-1': 'done', 'doc-2': 'done' },
              aggregate: AGGREGATE_RESULT,
            },
          }],
        ],
        bounds: {
          dispatches: { min: { kind: 'known', value: 3 }, max: { kind: 'known', value: 5 } },
          maxConcurrency: { kind: 'known', value: 2 },
          maxFanOut: { kind: 'known', value: 2 },
        },
      },
    };

    const report = runGraphTypeConformance(fixture);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    assertGraphTypeConformance(fixture);
  });

  it('compiles and describes the worklist', () => {
    const compiled = compileGraph(boundedItem, worklist());
    const description = compiled.describe();
    expect(description.graph.kind).toBe('bounded-item');
    expect(description.graph.typeVersion).toBe(1);
    expect(description.nodes.map((node) => node.id)).toEqual(['summarize', 'verify', 'tally']);
    expect(description.bounds.dispatches.min).toEqual({ kind: 'known', value: 3 });
    expect(description.bounds.dispatches.max).toEqual({ kind: 'known', value: 5 });
  });

  it('merges identical engine lanes by id', () => {
    const lane = itemLane('worker');
    const base = worklist();
    const definition: BoundedItemDefinition = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'summarize' || node.id === 'verify'
        ? { ...node, data: { ...node.data, lane } }
        : node),
    };

    const description = compileGraph(boundedItem, definition).describe();
    expect(description.nodes.filter((node) => node.id === 'summarize' || node.id === 'verify'))
      .toMatchObject([{ laneId: lane.id }, { laneId: lane.id }]);
    expect(description.executionLanes).toEqual([lane]);
  });

  it('rejects conflicting declarations for one engine lane id', () => {
    const base = worklist();
    expectIssue({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'summarize'
        ? { ...node, data: { ...node.data, lane: itemLane('worker', 'anthropic') } }
        : node.id === 'verify'
          ? { ...node, data: { ...node.data, lane: itemLane('worker', 'openai') } }
          : node),
    }, 'CONFLICTING_LANE');
  });

  it('waits for recorded in-flight work before dispatching another item', () => {
    expect(decideAt([
      claimed('doc-1', 'summarize', 1),
    ])).toEqual([]);
  });

  it('dispatches one full batch before waiting for recorded work', () => {
    expect(decideAt([])).toEqual([
      {
        kind: 'dispatch',
        nodeId: 'summarize',
        input: { positionSummary: 'item doc-1, stage summarize, attempt 1' },
        position: 'items/doc-1/summarize/1',
      },
      {
        kind: 'dispatch',
        nodeId: 'summarize',
        input: { positionSummary: 'item doc-2, stage summarize, attempt 1' },
        position: 'items/doc-2/summarize/1',
      },
    ]);
  });

  it('rejects duplicate item identifiers before any dispatch', () => {
    expectIssue(worklist({ items: ['doc-1', 'doc-1'] }), 'DUPLICATE_ITEM');
  });

  it('rejects an undeclared aggregate node', () => {
    expectIssue(orphanAggregate(), 'INVALID_AGGREGATE');
  });

  it('rejects stages that do not form one linear sequence', () => {
    expectIssue({ ...worklist(), edges: [] }, 'INVALID_STAGE_SEQUENCE');
  });

  it('rejects an invalid failure policy', () => {
    expectIssue(
      worklist({ failurePolicy: 'ignore' as unknown as 'fail' }),
      'INVALID_FAILURE_POLICY',
    );
  });

  it('rejects an invalid concurrency limit', () => {
    expectIssue(worklist({ globalConcurrency: 0 }), 'INVALID_LIMIT');
  });

  it('fails the fold when the freeze does not match the declared list', () => {
    const compiled = compileGraph(boundedItem, worklist());
    expect(() => compiled.reduce(compiled.initialState(), {
      type: 'items-frozen',
      version: 1,
      payload: { items: ['doc-1', 'doc-extra'] },
    })).toThrow(GraphValidationError);
  });

  it('ignores a second freeze so the item set cannot grow', () => {
    const definition = worklist();
    const compiled = compileGraph(boundedItem, definition);
    let state = compiled.initialState();
    state = compiled.reduce(state, frozen(definition));
    state = compiled.reduce(state, {
      type: 'items-frozen',
      version: 1,
      payload: { items: ['doc-1', 'doc-2', 'doc-extra'] },
    });
    expect(Object.keys(state.items)).toEqual(['doc-1', 'doc-2']);
  });

  it('retries a failed stage up to the attempt cap before settling the item', () => {
    const definition = worklist({ attemptCapPerStage: 2, aggregate: null, items: ['doc-1'] });
    const retry = decideAt([
      claimed('doc-1', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
    ], definition);
    expect(retry).toEqual([{
      kind: 'dispatch',
      nodeId: 'summarize',
      input: { positionSummary: 'item doc-1, stage summarize, attempt 2' },
      position: 'items/doc-1/summarize/2',
    }]);

    const verdict = decideAt([
      claimed('doc-1', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
      claimed('doc-1', 'summarize', 2),
      failedStage('doc-1', 'summarize', 2),
    ], definition);
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'ITEMS_FAILED',
      message: 'Failed items: doc-1.',
    }]);
  });

  it('never re-dispatches a recorded item stage result', () => {
    const commands = decideAt([
      claimed('doc-1', 'summarize', 1),
      passedStage('doc-1', 'summarize', 1),
    ]);
    const positions = commands
      .filter((command): command is Extract<GraphCommand, { kind: 'dispatch' }> => command.kind === 'dispatch')
      .map((command) => command.position);
    expect(positions).not.toContain('items/doc-1/summarize/1');
  });

  it('waits for a slow sibling before starting a fast item\'s second stage', () => {
    const commands = decideAt([
      claimed('doc-1', 'summarize', 1),
      claimed('doc-2', 'summarize', 1),
      passedStage('doc-1', 'summarize', 1),
    ]);
    expect(commands).toEqual([]);
  });

  it('respects the per-stage concurrency cap', () => {
    const threeItems = worklist({
      items: ['doc-1', 'doc-2', 'doc-3'],
      globalConcurrency: 3,
      perStageConcurrency: 1,
      aggregate: null,
    });
    // doc-1 holds the only summarize slot; the global cap would allow more.
    const commands = decideAt([
      claimed('doc-1', 'summarize', 1),
    ], threeItems);
    expect(commands).toEqual([]);
  });

  it('isolates a failed item and fails the run only after the rest settle', () => {
    const commands = decideAt([
      claimed('doc-1', 'summarize', 1),
      claimed('doc-2', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
    ]);
    expect(commands).toEqual([]);

    const verdict = decideAt([
      claimed('doc-1', 'summarize', 1),
      claimed('doc-2', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
      passedStage('doc-2', 'summarize', 1),
      claimed('doc-2', 'verify', 1),
      passedStage('doc-2', 'verify', 1),
      aggregateClaimed,
      aggregateCompleted(),
    ]);
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'ITEMS_FAILED',
      message: 'Failed items: doc-1.',
    }]);
  });

  it('records failures in the output under the complete policy', () => {
    const verdict = decideAt([
      claimed('doc-1', 'summarize', 1),
      claimed('doc-2', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
      passedStage('doc-2', 'summarize', 1),
      claimed('doc-2', 'verify', 1),
      passedStage('doc-2', 'verify', 1),
      aggregateClaimed,
      aggregateCompleted(),
    ], worklist({ failurePolicy: 'complete' }));
    expect(verdict).toEqual([{
      kind: 'complete',
      output: {
        items: { 'doc-1': 'failed', 'doc-2': 'done' },
        aggregate: AGGREGATE_RESULT,
      },
    }]);
  });

  it('reopens one item at a declared stage with a fresh cap budget at the minimum cap', () => {
    const definition = worklist();
    const events = [
      claimed('doc-1', 'summarize', 1),
      passedStage('doc-1', 'summarize', 1),
      claimed('doc-1', 'verify', 1),
      passedStage('doc-1', 'verify', 1),
      claimed('doc-2', 'summarize', 1),
      passedStage('doc-2', 'summarize', 1),
      claimed('doc-2', 'verify', 1),
      passedStage('doc-2', 'verify', 1),
      reopened('doc-2', 'summarize'),
    ];
    const state = fold(events, definition);
    expect(state.items['doc-1']!.status).toBe('done');
    expect(state.items['doc-2']!.status).toBe('pending');
    expect(state.items['doc-2']!.nextStage).toBe(0);

    const commands = decideAt(events, definition);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'summarize',
      input: { positionSummary: 'item doc-2, stage summarize, attempt 2' },
      position: 'items/doc-2/summarize/2',
    }]);
  });

  it('ignores a stale completion for an earlier attempt', () => {
    const definition = worklist({ attemptCapPerStage: 2, aggregate: null, items: ['doc-1'] });
    const base = [
      claimed('doc-1', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
      reopened('doc-1', 'summarize'),
      claimed('doc-1', 'summarize', 2),
    ];
    const state = fold(base, definition);
    const stale = compileGraph(boundedItem, definition)
      .reduce(state, passedStage('doc-1', 'summarize', 1));
    expect(stale).toEqual(state);
    expect(stale.items['doc-1']!.status).toBe('in-flight');

    const after = compileGraph(boundedItem, definition)
      .reduce(state, passedStage('doc-1', 'summarize', 2));
    expect(after.items['doc-1']!.status).toBe('pending');
    expect(after.items['doc-1']!.nextStage).toBe(1);
  });

  it('pauses the run when every remaining item is paused', () => {
    const definition = worklist({ attemptCapPerStage: 2, aggregate: null });
    const commands = decideAt([
      claimed('doc-1', 'summarize', 1),
      claimed('doc-2', 'summarize', 1),
      pausedItem('doc-1', 'summarize', 1, 'waiting for input'),
      pausedItem('doc-2', 'summarize', 1, 'waiting for input'),
    ], definition);
    expect(commands).toEqual([{
      kind: 'pause',
      reason: 'Every remaining item is paused; nothing else can run.',
    }]);

    const resumed = decideAt([
      claimed('doc-1', 'summarize', 1),
      claimed('doc-2', 'summarize', 1),
      pausedItem('doc-1', 'summarize', 1, 'waiting for input'),
      pausedItem('doc-2', 'summarize', 1, 'waiting for input'),
      resumedItem('doc-1'),
    ], definition);
    expect(resumed).toEqual([{
      kind: 'dispatch',
      nodeId: 'summarize',
      input: { positionSummary: 'item doc-1, stage summarize, attempt 2' },
      position: 'items/doc-1/summarize/2',
    }]);
  });

  it('ignores a late pause for an earlier attempt', () => {
    const definition = worklist({ attemptCapPerStage: 2, aggregate: null, items: ['doc-1'] });
    const events = [
      claimed('doc-1', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
      claimed('doc-1', 'summarize', 2),
    ];
    const state = fold(events, definition);
    const late = compileGraph(boundedItem, definition)
      .reduce(state, pausedItem('doc-1', 'summarize', 1, 'late'));
    expect(late).toEqual(state);
    expect(late.items['doc-1']!.status).toBe('in-flight');

    const paused = compileGraph(boundedItem, definition)
      .reduce(state, pausedItem('doc-1', 'summarize', 2, 'current'));
    expect(paused.items['doc-1']!.status).toBe('paused');
  });

  it('treats an item past its attempt cap as failed without a dispatch', () => {
    const definition = worklist({ attemptCapPerStage: 1, items: ['doc-1', 'doc-2'] });
    const verdict = decideAt([
      claimed('doc-1', 'summarize', 1),
      failedStage('doc-1', 'summarize', 1),
      claimed('doc-2', 'summarize', 1),
      failedStage('doc-2', 'summarize', 1),
      aggregateClaimed,
      aggregateCompleted(),
    ], definition);
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'ITEMS_FAILED',
      message: 'Failed items: doc-1, doc-2.',
    }]);
  });
});
