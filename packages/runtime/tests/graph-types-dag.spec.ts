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
import { GraphValidationError, type JsonObject } from '../src/graph/value.ts';
import {
  dag,
  type DagDefinition,
  type DagEvent,
  type DagNodeState,
  type DagRequirements,
  type DagStatus,
} from '../src/graph-types/dag.ts';

function nodeState(
  status: DagNodeState['status'],
  attempts = 0,
  inFlight: string | null = null,
): DagNodeState {
  return { status, attempts, inFlight, pauseReason: null };
}

function graph(overrides: Partial<DagDefinition['data']> = {}): DagDefinition {
  return {
    id: 'build-graph',
    definitionVersion: 1,
    data: {
      globalConcurrency: 1,
      keyedConcurrency: {},
      stopOnError: true,
      retryCapPerNode: 0,
      ...overrides,
    },
    nodes: [
      { id: 'plan', data: { kind: 'required', key: null } },
      { id: 'build-a', data: { kind: 'required', key: null } },
      { id: 'build-b', data: { kind: 'required', key: null } },
      { id: 'report', data: { kind: 'optional', key: null } },
      { id: 'probe', data: { kind: 'required', key: null } },
      { id: 'cleanup', data: { kind: 'finalizer', key: null } },
    ],
    edges: [
      { id: 'plan-to-build-a', source: 'plan', target: 'build-a', data: {} },
      { id: 'plan-to-build-b', source: 'plan', target: 'build-b', data: {} },
      { id: 'build-a-to-report', source: 'build-a', target: 'report', data: {} },
      { id: 'build-b-to-report', source: 'build-b', target: 'report', data: {} },
    ],
  };
}

function dispatched(nodeId: NodeId, attempt = 1): DagEvent {
  return {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId, position: `dag/${nodeId}/${attempt}` },
  };
}

function completed(nodeId: NodeId, result: JsonObject = {}, attempt = 1): DagEvent {
  return {
    type: 'node-completed',
    version: 1,
    payload: { nodeId, position: `dag/${nodeId}/${attempt}`, result },
  };
}

function failed(nodeId: NodeId, code = 'ENGINE_UNAVAILABLE', attempt = 1): DagEvent {
  return {
    type: 'node-failed',
    version: 1,
    payload: { nodeId, position: `dag/${nodeId}/${attempt}`, code },
  };
}

function pausedNode(nodeId: NodeId, reason: string, attempt = 1): DagEvent {
  return {
    type: 'node-paused',
    version: 1,
    payload: { nodeId, position: `dag/${nodeId}/${attempt}`, reason },
  };
}

function resumedNode(nodeId: NodeId): DagEvent {
  return { type: 'node-resumed', version: 1, payload: { nodeId } };
}

function planResolution(): PlanResolution {
  const identity = {
    source: 'file:examples/packages/dag',
    version: '1.0.0',
    digest: `sha256:${'c'.repeat(64)}` as const,
  };
  return {
    package: identity,
    admission: { package: identity, permissions: [] },
    executionLanes: [],
  };
}

function fold(
  events: readonly DagEvent[],
  definition: DagDefinition = graph(),
): DagStatus {
  const compiled = compileGraph(dag, definition);
  let state = compiled.initialState();
  for (const event of events) state = compiled.reduce(state, event);
  return state;
}

function decideAt(
  events: readonly DagEvent[],
  definition: DagDefinition = graph(),
): readonly GraphCommand[] {
  const compiled = compileGraph(dag, definition);
  return compiled.decide(fold(events, definition));
}

function expectIssue(definition: DagDefinition, code: string): void {
  let caught: unknown;
  try {
    compileGraph(dag, definition);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GraphValidationError);
  const issues = (caught as GraphValidationError).issues;
  expect(issues.some((item) => item.code === code)).toBe(true);
}

describe('dag graph type', () => {
  it('passes the graph type conformance kit', () => {
    const fixture: GraphTypeConformanceFixture<
      DagDefinition,
      DagStatus,
      DagEvent,
      DagRequirements
    > = {
      graphType: dag,
      definition: graph(),
      events: [
        dispatched('plan'),
        completed('plan'),
        dispatched('build-a'),
        completed('build-a'),
        dispatched('build-b'),
        completed('build-b'),
        dispatched('report'),
        completed('report'),
        dispatched('probe'),
        completed('probe', { skipped: true }),
        dispatched('cleanup'),
        completed('cleanup'),
      ],
      invalidDefinitions: [
        {
          ...graph(),
          edges: [
            ...graph().edges,
            { id: 'report-to-plan', source: 'report', target: 'plan', data: {} },
          ],
        },
        {
          ...graph(),
          edges: [...graph().edges, { id: 'report-to-cleanup', source: 'report', target: 'cleanup', data: {} }],
        },
        {
          ...graph(),
          nodes: graph().nodes.map((node) => node.id === 'build-a'
            ? { ...node, data: { ...node.data, key: 'build' } }
            : node),
        },
      ],
      planResolution: planResolution(),
      expected: {
        states: [
          { nodes: {
            plan: nodeState('pending'), 'build-a': nodeState('pending'), 'build-b': nodeState('pending'),
            report: nodeState('pending'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('in-flight', 1, 'dag/plan/1'), 'build-a': nodeState('pending'), 'build-b': nodeState('pending'),
            report: nodeState('pending'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('pending'), 'build-b': nodeState('pending'),
            report: nodeState('pending'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('in-flight', 1, 'dag/build-a/1'), 'build-b': nodeState('pending'),
            report: nodeState('pending'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('pending'),
            report: nodeState('pending'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('in-flight', 1, 'dag/build-b/1'),
            report: nodeState('pending'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('passed', 1),
            report: nodeState('pending'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('passed', 1),
            report: nodeState('in-flight', 1, 'dag/report/1'), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('passed', 1),
            report: nodeState('passed', 1), probe: nodeState('pending'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('passed', 1),
            report: nodeState('passed', 1), probe: nodeState('in-flight', 1, 'dag/probe/1'), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('passed', 1),
            report: nodeState('passed', 1), probe: nodeState('skipped', 1), cleanup: nodeState('pending'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('passed', 1),
            report: nodeState('passed', 1), probe: nodeState('skipped', 1), cleanup: nodeState('in-flight', 1, 'dag/cleanup/1'),
          } },
          { nodes: {
            plan: nodeState('passed', 1), 'build-a': nodeState('passed', 1), 'build-b': nodeState('passed', 1),
            report: nodeState('passed', 1), probe: nodeState('skipped', 1), cleanup: nodeState('passed', 1),
          } },
        ],
        commands: [
          [{ kind: 'dispatch', nodeId: 'plan', input: { positionSummary: 'node plan, attempt 1' }, position: 'dag/plan/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'build-a', input: { positionSummary: 'node build-a, attempt 1' }, position: 'dag/build-a/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'build-b', input: { positionSummary: 'node build-b, attempt 1' }, position: 'dag/build-b/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'report', input: { positionSummary: 'node report, attempt 1' }, position: 'dag/report/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'probe', input: { positionSummary: 'node probe, attempt 1' }, position: 'dag/probe/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'cleanup', input: { positionSummary: 'node cleanup, attempt 1' }, position: 'dag/cleanup/1' }],
          [],
          [{
            kind: 'complete',
            output: {
              nodes: {
                plan: 'passed', 'build-a': 'passed', 'build-b': 'passed',
                report: 'passed', probe: 'skipped', cleanup: 'passed',
              },
            },
          }],
        ],
        bounds: {
          dispatches: { min: { kind: 'known', value: 6 }, max: { kind: 'known', value: 6 } },
          maxConcurrency: { kind: 'known', value: 1 },
          maxFanOut: { kind: 'known', value: 1 },
        },
      },
    };

    const report = runGraphTypeConformance(fixture);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    assertGraphTypeConformance(fixture);
  });

  it('compiles and describes the graph', () => {
    const compiled = compileGraph(dag, graph());
    const description = compiled.describe();
    expect(description.graph.kind).toBe('dag');
    expect(description.graph.typeVersion).toBe(1);
    expect(description.nodes.map((node) => node.id)).toEqual(
      ['plan', 'build-a', 'build-b', 'report', 'probe', 'cleanup'],
    );
    expect(description.bounds.dispatches.min).toEqual({ kind: 'known', value: 6 });
    expect(description.bounds.dispatches.max).toEqual({ kind: 'known', value: 6 });
    expect(description.bounds.maxFanOut).toEqual({ kind: 'known', value: 1 });
  });

  it('rejects a dependency cycle', () => {
    expectIssue({
      ...graph(),
      edges: [
        ...graph().edges,
        { id: 'report-to-plan', source: 'report', target: 'plan', data: {} },
      ],
    }, 'DAG_CYCLE');
  });

  it('rejects a finalizer with edges', () => {
    expectIssue({
      ...graph(),
      edges: [...graph().edges, { id: 'report-to-cleanup', source: 'report', target: 'cleanup', data: {} }],
    }, 'FINALIZER_HAS_EDGES');
  });

  it('rejects a node key without a declared limit', () => {
    expectIssue({
      ...graph(),
      nodes: graph().nodes.map((node) => node.id === 'build-a'
        ? { ...node, data: { ...node.data, key: 'build' } }
        : node),
    }, 'MISSING_KEY_LIMIT');
  });

  it('rejects an unknown node kind', () => {
    expectIssue({
      ...graph(),
      nodes: graph().nodes.map((node) => node.id === 'probe'
        ? { ...node, data: { ...node.data, kind: 'conditional' as unknown as 'required' } }
        : node),
    }, 'INVALID_NODE_KIND');
  });

  it('rejects an invalid concurrency limit', () => {
    expectIssue(graph({ globalConcurrency: 0 }), 'INVALID_LIMIT');
  });

  it('rejects an invalid retry cap', () => {
    expectIssue(graph({ retryCapPerNode: -1 }), 'INVALID_LIMIT');
  });

  it('blocks dependents of a failed required node, stops scheduling, and keeps the failure through the finalizer', () => {
    const commands = decideAt([dispatched('plan'), failed('plan')]);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'cleanup',
      input: { positionSummary: 'node cleanup, attempt 1' },
      position: 'dag/cleanup/1',
    }]);

    const verdict = decideAt([dispatched('plan'), failed('plan'), dispatched('cleanup'), completed('cleanup')]);
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'DAG_NODE_FAILED',
      message: 'Failed required nodes: plan.',
    }]);
  });

  it('continues independent branches without stopOnError and still fails on the required node', () => {
    const definition = graph({ stopOnError: false });
    const commands = decideAt([dispatched('plan'), failed('plan')], definition);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'probe',
      input: { positionSummary: 'node probe, attempt 1' },
      position: 'dag/probe/1',
    }]);

    const verdict = decideAt([
      dispatched('plan'), failed('plan'),
      dispatched('probe'), completed('probe'),
      dispatched('cleanup'), completed('cleanup'),
    ], definition);
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'DAG_NODE_FAILED',
      message: 'Failed required nodes: plan.',
    }]);
  });

  it('treats an optional failure as non-blocking and non-failing', () => {
    const definition: DagDefinition = {
      ...graph(),
      nodes: [
        { id: 'opt', data: { kind: 'optional', key: null } },
        { id: 'downstream', data: { kind: 'required', key: null } },
      ],
      edges: [{ id: 'opt-to-downstream', source: 'opt', target: 'downstream', data: {} }],
    };
    const commands = decideAt([dispatched('opt'), failed('opt')], definition);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'downstream',
      input: { positionSummary: 'node downstream, attempt 1' },
      position: 'dag/downstream/1',
    }]);

    const verdict = decideAt([
      dispatched('opt'), failed('opt'),
      dispatched('downstream'), completed('downstream'),
    ], definition);
    expect(verdict).toEqual([{
      kind: 'complete',
      output: { nodes: { opt: 'failed', downstream: 'passed' } },
    }]);
  });

  it('treats an expected skip as neutral for dependents', () => {
    const definition: DagDefinition = {
      ...graph(),
      nodes: [
        { id: 'gate', data: { kind: 'required', key: null } },
        { id: 'body', data: { kind: 'required', key: null } },
      ],
      edges: [{ id: 'gate-to-body', source: 'gate', target: 'body', data: {} }],
    };
    const commands = decideAt([dispatched('gate'), completed('gate', { skipped: true })], definition);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'body',
      input: { positionSummary: 'node body, attempt 1' },
      position: 'dag/body/1',
    }]);
  });

  it('dispatches every ready node that fits the caps in one decision', () => {
    const definition = graph({ globalConcurrency: 3 });
    const commands = decideAt([dispatched('plan'), completed('plan')], definition);
    expect(commands).toEqual([
      { kind: 'dispatch', nodeId: 'build-a', input: { positionSummary: 'node build-a, attempt 1' }, position: 'dag/build-a/1' },
      { kind: 'dispatch', nodeId: 'build-b', input: { positionSummary: 'node build-b, attempt 1' }, position: 'dag/build-b/1' },
      { kind: 'dispatch', nodeId: 'probe', input: { positionSummary: 'node probe, attempt 1' }, position: 'dag/probe/1' },
    ]);
    expect(compileGraph(dag, definition).describe().bounds.maxFanOut)
      .toEqual({ kind: 'known', value: 3 });
  });

  it('preserves the node pause reason in the DAG pause decision', () => {
    const definition: DagDefinition = {
      ...graph(),
      nodes: [
        { id: 'solo', data: { kind: 'required', key: null } },
      ],
      edges: [],
    };
    const compiled = compileGraph(dag, definition);
    let state = compiled.initialState();
    state = compiled.reduce(state, dispatched('solo'));
    state = compiled.reduce(state, pausedNode('solo', 'waiting for input'));

    expect(compiled.decide(state)).toEqual([{
      kind: 'pause',
      reason: 'waiting for input',
    }]);
  });

  it('ignores terminal events while paused and resumes the same attempt', () => {
    const definition: DagDefinition = {
      ...graph(),
      nodes: [
        { id: 'solo', data: { kind: 'required', key: null } },
      ],
      edges: [],
    };
    const compiled = compileGraph(dag, definition);
    let state = compiled.initialState();
    state = compiled.reduce(state, dispatched('solo'));
    state = compiled.reduce(state, pausedNode('solo', 'waiting for input'));

    const lateWhilePaused = compiled.reduce(state, completed('solo'));
    expect(lateWhilePaused).toEqual(state);

    state = compiled.reduce(state, resumedNode('solo'));
    expect(state.nodes.solo!.status).toBe('in-flight');
    expect(state.nodes.solo!.inFlight).toBe('dag/solo/1');

    state = compiled.reduce(state, completed('solo'));
    expect(state.nodes.solo!.status).toBe('passed');
    expect(compiled.decide(state)).toEqual([{
      kind: 'complete',
      output: { nodes: { solo: 'passed' } },
    }]);
  });

  it('offers policy retries for a failed required node until the cap, then fails the DAG', () => {
    const definition: DagDefinition = {
      ...graph({ stopOnError: false, retryCapPerNode: 1 }),
      nodes: [{ id: 'solo', data: { kind: 'required', key: null } }],
      edges: [],
    };
    const compiled = compileGraph(dag, definition);
    let state = compiled.initialState();
    state = compiled.reduce(state, dispatched('solo'));
    state = compiled.reduce(state, failed('solo'));

    expect(compiled.decide(state)).toEqual([{
      kind: 'dispatch',
      nodeId: 'solo',
      input: { positionSummary: 'node solo, attempt 2' },
      position: 'dag/solo/2',
    }]);

    state = compiled.reduce(state, dispatched('solo', 2));
    expect(state.nodes.solo!.status).toBe('in-flight');
    expect(state.nodes.solo!.inFlight).toBe('dag/solo/2');

    const stale = compiled.reduce(state, completed('solo', {}, 1));
    expect(stale).toEqual(state);

    const recovered = compiled.reduce(state, completed('solo', {}, 2));
    expect(recovered.nodes.solo!.status).toBe('passed');
    expect(compiled.decide(recovered)).toEqual([{
      kind: 'complete',
      output: { nodes: { solo: 'passed' } },
    }]);

    state = compiled.reduce(state, failed('solo', 'ENGINE_UNAVAILABLE', 2));
    expect(state.nodes.solo!.status).toBe('failed');
    expect(compiled.decide(state)).toEqual([{
      kind: 'fail',
      code: 'DAG_NODE_FAILED',
      message: 'Failed required nodes: solo.',
    }]);
  });

  it('enforces the keyed concurrency limit', () => {
    const definition: DagDefinition = {
      ...graph(),
      data: { globalConcurrency: 4, keyedConcurrency: { build: 1 }, stopOnError: false, retryCapPerNode: 0 },
      nodes: [
        { id: 'first', data: { kind: 'required', key: 'build' } },
        { id: 'second', data: { kind: 'required', key: 'build' } },
      ],
      edges: [],
    };
    const initial = decideAt([], definition);
    expect(initial).toEqual([{
      kind: 'dispatch',
      nodeId: 'first',
      input: { positionSummary: 'node first, attempt 1' },
      position: 'dag/first/1',
    }]);

    const blocked = decideAt([dispatched('first')], definition);
    expect(blocked).toEqual([]);

    const unblocked = decideAt([dispatched('first'), completed('first')], definition);
    expect(unblocked).toEqual([{
      kind: 'dispatch',
      nodeId: 'second',
      input: { positionSummary: 'node second, attempt 1' },
      position: 'dag/second/1',
    }]);
  });

  it('ignores stale events after a node settles', () => {
    const definition: DagDefinition = {
      ...graph(),
      nodes: [{ id: 'solo', data: { kind: 'required', key: null } }],
      edges: [],
    };
    const compiled = compileGraph(dag, definition);
    let state = compiled.initialState();
    state = compiled.reduce(state, dispatched('solo'));
    state = compiled.reduce(state, completed('solo'));

    const lateCompletion = compiled.reduce(state, completed('solo'));
    expect(lateCompletion).toEqual(state);
    const lateFailure = compiled.reduce(state, failed('solo'));
    expect(lateFailure).toEqual(state);
    const lateDispatch = compiled.reduce(state, dispatched('solo', 2));
    expect(lateDispatch).toEqual(state);
    expect(state.nodes.solo!.status).toBe('passed');
  });
});
