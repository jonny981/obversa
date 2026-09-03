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
  directedState,
  type DirectedStateDefinition,
  type DirectedStateEvent,
  type DirectedStateRequirements,
  type DirectedStateStatus,
  type StateTerminalKind,
} from '../src/graph-types/state.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function stateLane(id: string, provider = 'mock') {
  return {
    id,
    requested: {
      adapter: 'mock', provider, modelFamily: 'mock-family', model: `mock-${provider}`, tools: [] as readonly string[],
    },
    knownSubstitutions: [],
  } as const;
}

function machine(): DirectedStateDefinition {
  return {
    id: 'approval-flow',
    definitionVersion: 1,
    data: { initial: 'draft', fallbackRoute: 'hold' },
    nodes: [
      { id: 'draft', data: { terminal: null } },
      { id: 'await-approval', data: { terminal: null } },
      { id: 'revise', data: { terminal: null } },
      { id: 'approved', data: { terminal: 'complete' } },
      { id: 'rejected', data: { terminal: 'fail' } },
    ],
    edges: [
      { id: 'draft-done', source: 'draft', target: 'await-approval', data: { route: 'done' } },
      { id: 'draft-hold', source: 'draft', target: 'draft', data: { route: 'hold' } },
      { id: 'approval-approved', source: 'await-approval', target: 'approved', data: { route: 'approved' } },
      { id: 'approval-changes', source: 'await-approval', target: 'revise', data: { route: 'changes' } },
      { id: 'approval-hold', source: 'await-approval', target: 'await-approval', data: { route: 'hold' } },
      { id: 'revise-done', source: 'revise', target: 'draft', data: { route: 'done' } },
      { id: 'revise-hold', source: 'revise', target: 'revise', data: { route: 'hold' } },
    ],
  };
}

function dispatched(nodeId: NodeId, position: string): DirectedStateEvent {
  return { type: 'node-dispatched', version: 1, payload: { nodeId, position } };
}

function completed(nodeId: NodeId, position: string, route: string | null): DirectedStateEvent {
  return { type: 'node-completed', version: 1, payload: { nodeId, position, route } };
}

function failed(nodeId: NodeId, position: string): DirectedStateEvent {
  return { type: 'node-failed', version: 1, payload: { nodeId, position, code: 'ENGINE_UNAVAILABLE' } };
}

function requested(state: NodeId): DirectedStateEvent {
  return { type: 'callback-requested', version: 1, payload: { state, digest: DIGEST } };
}

function released(state: NodeId): DirectedStateEvent {
  return { type: 'callback-released', version: 1, payload: { state } };
}

function fold(events: readonly DirectedStateEvent[]): DirectedStateStatus {
  const compiled = compileGraph(directedState, machine());
  let state = compiled.initialState();
  for (const event of events) state = compiled.reduce(state, event);
  return state;
}

function planResolution(): PlanResolution {
  const identity = {
    source: 'file:examples/packages/directed-state',
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}` as const,
  };
  return {
    package: identity,
    admission: { package: identity, permissions: [] },
    executionLanes: [],
  };
}

function invalidTarget(): DirectedStateDefinition {
  const base = machine();
  return {
    ...base,
    edges: [
      ...base.edges,
      { id: 'draft-nowhere', source: 'draft', target: 'sign-off', data: { route: 'nowhere' } },
    ],
  };
}

function noTerminalPath(): DirectedStateDefinition {
  const base = machine();
  return {
    ...base,
    edges: base.edges.map((edge) => edge.id === 'revise-done'
      ? { ...edge, target: 'revise' }
      : edge),
  };
}

function missingFallback(): DirectedStateDefinition {
  const base = machine();
  return { ...base, edges: base.edges.filter((edge) => edge.id !== 'draft-hold') };
}

function duplicateRoute(): DirectedStateDefinition {
  const base = machine();
  return {
    ...base,
    edges: [
      ...base.edges,
      { id: 'draft-done-again', source: 'draft', target: 'revise', data: { route: 'done' } },
    ],
  };
}

function invalidInitial(): DirectedStateDefinition {
  return { ...machine(), data: { initial: 'sign-off', fallbackRoute: 'hold' } };
}

function terminalWithEdges(): DirectedStateDefinition {
  const base = machine();
  return {
    ...base,
    edges: [
      ...base.edges,
      { id: 'approved-back', source: 'approved', target: 'draft', data: { route: 'back' } },
    ],
  };
}

function invalidTerminalKind(): DirectedStateDefinition {
  const base = machine();
  return {
    ...base,
    nodes: base.nodes.map((node) => node.id === 'approved'
      ? { ...node, data: { terminal: 'bogus' as unknown as StateTerminalKind } }
      : node),
  };
}

function expectIssue(definition: DirectedStateDefinition, code: string): void {
  let caught: unknown;
  try {
    compileGraph(directedState, definition);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GraphValidationError);
  const issues = (caught as GraphValidationError).issues;
  expect(issues.some((item) => item.code === code)).toBe(true);
}

describe('directed-state graph type', () => {
  it('passes the graph type conformance kit', () => {
    const fixture: GraphTypeConformanceFixture<
      DirectedStateDefinition,
      DirectedStateStatus,
      DirectedStateEvent,
      DirectedStateRequirements
    > = {
      graphType: directedState,
      definition: machine(),
      events: [
        dispatched('draft', 'states/draft/1'),
        completed('draft', 'states/draft/1', 'done'),
        dispatched('await-approval', 'states/await-approval/1'),
        requested('await-approval'),
        completed('await-approval', 'states/await-approval/1', 'approved'),
        dispatched('approved', 'states/approved/1'),
        completed('approved', 'states/approved/1', null),
      ],
      invalidDefinitions: [invalidTarget(), noTerminalPath(), missingFallback()],
      planResolution: planResolution(),
      expected: {
        states: [
          { active: 'draft', visits: {}, inFlight: null, pending: null, settled: null },
          { active: 'draft', visits: { draft: 1 }, inFlight: 'states/draft/1', pending: null, settled: null },
          { active: 'await-approval', visits: { draft: 1 }, inFlight: null, pending: null, settled: null },
          {
            active: 'await-approval',
            visits: { draft: 1, 'await-approval': 1 },
            inFlight: 'states/await-approval/1',
            pending: null,
            settled: null,
          },
          {
            active: 'await-approval',
            visits: { draft: 1, 'await-approval': 1 },
            inFlight: 'states/await-approval/1',
            pending: { state: 'await-approval', digest: DIGEST },
            settled: null,
          },
          {
            active: 'approved',
            visits: { draft: 1, 'await-approval': 1 },
            inFlight: null,
            pending: null,
            settled: null,
          },
          {
            active: 'approved',
            visits: { draft: 1, 'await-approval': 1, approved: 1 },
            inFlight: 'states/approved/1',
            pending: null,
            settled: null,
          },
          {
            active: 'approved',
            visits: { draft: 1, 'await-approval': 1, approved: 1 },
            inFlight: null,
            pending: null,
            settled: { kind: 'complete', state: 'approved' },
          },
        ],
        commands: [
          [{
            kind: 'dispatch',
            nodeId: 'draft',
            input: { positionSummary: 'state "draft", attempt 1' },
            position: 'states/draft/1',
          }],
          [],
          [{
            kind: 'dispatch',
            nodeId: 'await-approval',
            input: { positionSummary: 'state "await-approval", attempt 1' },
            position: 'states/await-approval/1',
          }],
          [],
          [],
          [{
            kind: 'dispatch',
            nodeId: 'approved',
            input: { positionSummary: 'state "approved", attempt 1' },
            position: 'states/approved/1',
          }],
          [],
          [{ kind: 'complete', output: { terminal: 'approved' } }],
        ],
        bounds: {
          dispatches: {
            min: { kind: 'known', value: 1 },
            max: { kind: 'unknown', reason: 'a state machine may cycle without a declared bound' },
          },
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

  it('compiles and describes the machine', () => {
    const compiled = compileGraph(directedState, machine());
    const description = compiled.describe();
    expect(description.graph.kind).toBe('directed-state');
    expect(description.graph.typeVersion).toBe(1);
    expect(description.nodes.map((node) => node.id)).toEqual(
      ['draft', 'await-approval', 'revise', 'approved', 'rejected'],
    );
    expect(description.bounds.dispatches.max.kind).toBe('unknown');
  });

  it('merges identical engine lanes by id', () => {
    const lane = stateLane('writer');
    const base = machine();
    const definition: DirectedStateDefinition = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'draft' || node.id === 'revise'
        ? { ...node, data: { ...node.data, lane } }
        : node),
    };

    const description = compileGraph(directedState, definition).describe();
    expect(description.nodes.filter((node) => node.id === 'draft' || node.id === 'revise'))
      .toMatchObject([{ laneId: lane.id }, { laneId: lane.id }]);
    expect(description.executionLanes).toEqual([lane]);
  });

  it('rejects conflicting declarations for one engine lane id', () => {
    const base = machine();
    expectIssue({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'draft'
        ? { ...node, data: { ...node.data, lane: stateLane('writer', 'anthropic') } }
        : node.id === 'revise'
          ? { ...node, data: { ...node.data, lane: stateLane('writer', 'openai') } }
          : node),
    }, 'CONFLICTING_LANE');
  });

  it('waits for recorded in-flight work before returning a terminal command', () => {
    const compiled = compileGraph(directedState, machine());
    expect(compiled.decide({
      active: 'approved',
      visits: { approved: 1 },
      inFlight: 'states/approved/1',
      pending: null,
      settled: { kind: 'complete', state: 'approved' },
    })).toEqual([]);
  });

  it('rejects an edge to an undeclared state', () => {
    expectIssue(invalidTarget(), 'UNKNOWN_TARGET_NODE');
  });

  it('rejects a state with no path to a terminal', () => {
    expectIssue(noTerminalPath(), 'NO_TERMINAL_PATH');
  });

  it('rejects a state without the fallback route', () => {
    expectIssue(missingFallback(), 'MISSING_FALLBACK_ROUTE');
  });

  it('rejects a duplicate route from one state', () => {
    expectIssue(duplicateRoute(), 'DUPLICATE_ROUTE');
  });

  it('rejects an undeclared initial state', () => {
    expectIssue(invalidInitial(), 'INVALID_INITIAL');
  });

  it('rejects a terminal state with outgoing edges', () => {
    expectIssue(terminalWithEdges(), 'TERMINAL_HAS_EDGES');
  });

  it('rejects an unknown terminal kind', () => {
    expectIssue(invalidTerminalKind(), 'INVALID_TERMINAL');
  });

  it('rebuilds the same active state and next command from the same events', () => {
    const events: readonly DirectedStateEvent[] = [
      dispatched('draft', 'states/draft/1'),
      completed('draft', 'states/draft/1', 'done'),
      dispatched('await-approval', 'states/await-approval/1'),
      completed('await-approval', 'states/await-approval/1', 'changes'),
      dispatched('revise', 'states/revise/1'),
      completed('revise', 'states/revise/1', 'done'),
    ];

    const first = compileGraph(directedState, machine());
    const second = compileGraph(directedState, machine());
    const foldAll = (compiled: typeof first): DirectedStateStatus => {
      let state = compiled.initialState();
      for (const event of events) state = compiled.reduce(state, event);
      return state;
    };
    const firstState = foldAll(first);
    const secondState = foldAll(second);

    expect(firstState).toEqual(secondState);
    expect(firstState.active).toBe('draft');
    expect(firstState.visits).toEqual({ draft: 1, 'await-approval': 1, revise: 1 });
    const commands: readonly GraphCommand[] = first.decide(firstState);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'draft',
      input: { positionSummary: 'state "draft", attempt 2' },
      position: 'states/draft/2',
    }]);
  });

  it('holds an empty decision while a callback is pending and takes a fresh position after release and failure', () => {
    const base: readonly DirectedStateEvent[] = [
      dispatched('draft', 'states/draft/1'),
      completed('draft', 'states/draft/1', 'done'),
      dispatched('await-approval', 'states/await-approval/1'),
    ];
    const compiled = compileGraph(directedState, machine());
    let state = compiled.initialState();
    for (const event of base) state = compiled.reduce(state, event);

    state = compiled.reduce(state, requested('await-approval'));
    expect(state.pending).toEqual({ state: 'await-approval', digest: DIGEST });
    expect(compiled.decide(state)).toEqual([]);

    state = compiled.reduce(state, released('await-approval'));
    expect(state.pending).toBeNull();
    expect(compiled.decide(state)).toEqual([]);

    state = compiled.reduce(state, failed('await-approval', 'states/await-approval/1'));
    expect(state.inFlight).toBeNull();
    const commands = compiled.decide(state);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.kind).toBe('dispatch');
    if (commands[0]!.kind === 'dispatch') {
      expect(commands[0]!.position).toBe('states/await-approval/2');
    }
  });

  it('ignores a stale completion for an earlier attempt', () => {
    const compiled = compileGraph(directedState, machine());
    let state = compiled.initialState();
    state = compiled.reduce(state, dispatched('draft', 'states/draft/1'));
    state = compiled.reduce(state, failed('draft', 'states/draft/1'));
    state = compiled.reduce(state, dispatched('draft', 'states/draft/2'));

    const stale = compiled.reduce(state, completed('draft', 'states/draft/1', 'done'));
    expect(stale).toEqual(state);
    expect(stale.active).toBe('draft');
    expect(stale.inFlight).toBe('states/draft/2');

    state = compiled.reduce(state, completed('draft', 'states/draft/2', 'done'));
    expect(state.active).toBe('await-approval');
    expect(state.inFlight).toBeNull();
  });

  it('ignores a second dispatch while an attempt is in flight', () => {
    const compiled = compileGraph(directedState, machine());
    let state = compiled.initialState();
    state = compiled.reduce(state, dispatched('draft', 'states/draft/1'));
    const second = compiled.reduce(state, dispatched('draft', 'states/draft/2'));
    expect(second).toEqual(state);
    expect(second.inFlight).toBe('states/draft/1');
    expect(second.visits).toEqual({ draft: 1 });
    expect(compiled.decide(second)).toEqual([]);
  });

  it('falls back to the declared route when a result route matches no edge', () => {
    for (const route of ['weird-key', null] as const) {
      const state = fold([
        dispatched('draft', 'states/draft/1'),
        completed('draft', 'states/draft/1', route),
      ]);
      expect(state.active).toBe('draft');
      const commands = compileGraph(directedState, machine()).decide(state);
      expect(commands[0]!.kind).toBe('dispatch');
      if (commands[0]!.kind === 'dispatch') {
        expect(commands[0]!.position).toBe('states/draft/2');
      }
    }
  });

  it('settles fail and pause terminals with typed commands', () => {
    const twoTerminals: DirectedStateDefinition = {
      id: 'two-terminals',
      definitionVersion: 1,
      data: { initial: 'check', fallbackRoute: 'hold' },
      nodes: [
        { id: 'check', data: { terminal: null } },
        { id: 'rejected', data: { terminal: 'fail' } },
        { id: 'held', data: { terminal: 'pause' } },
      ],
      edges: [
        { id: 'check-reject', source: 'check', target: 'rejected', data: { route: 'reject' } },
        { id: 'check-wait', source: 'check', target: 'held', data: { route: 'wait' } },
        { id: 'check-hold', source: 'check', target: 'check', data: { route: 'hold' } },
      ],
    };
    const compiled = compileGraph(directedState, twoTerminals);
    const settle = (route: string): readonly GraphCommand[] => {
      let state = compiled.initialState();
      state = compiled.reduce(state, dispatched('check', 'states/check/1'));
      state = compiled.reduce(state, completed('check', 'states/check/1', route));
      const terminal = state.active;
      state = compiled.reduce(state, dispatched(terminal, `states/${terminal}/1`));
      state = compiled.reduce(state, completed(terminal, `states/${terminal}/1`, null));
      return compiled.decide(state);
    };

    const failCommands = settle('reject');
    expect(failCommands).toHaveLength(1);
    expect(failCommands[0]!.kind).toBe('fail');
    if (failCommands[0]!.kind === 'fail') {
      expect(failCommands[0]!.code).toBe('STATE_TERMINAL_FAIL');
      expect(failCommands[0]!.message).toContain('rejected');
    }

    const pauseCommands = settle('wait');
    expect(pauseCommands).toHaveLength(1);
    expect(pauseCommands[0]!.kind).toBe('pause');
    if (pauseCommands[0]!.kind === 'pause') {
      expect(pauseCommands[0]!.reason).toContain('held');
    }
  });
});
