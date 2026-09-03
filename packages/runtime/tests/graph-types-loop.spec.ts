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
  convergence,
  type ConvergenceDefinition,
  type ConvergenceEvent,
  type ConvergenceRequirements,
  type ConvergenceStatus,
  type LoopNodeState,
  type SeatRecord,
} from '../src/graph-types/loop.ts';

function nodeState(
  status: LoopNodeState['status'],
  attempts = 0,
  inFlight: string | null = null,
): LoopNodeState {
  return { status, attempts, inFlight };
}

function seatRecord(outcome: SeatRecord['outcome']): SeatRecord {
  return { outcome, verdict: null, confidence: null, provider: null, modelFamily: null, findings: [], stale: false };
}

function panel(overrides: Partial<ConvergenceDefinition['data']> = {}): ConvergenceDefinition {
  return {
    id: 'draft-review',
    definitionVersion: 1,
    data: {
      maxIterations: 2,
      maxReviewRestarts: 1,
      quorum: 2,
      requireDiversity: true,
      skippableSeats: [],
      seatConcurrency: 1,
      retryCapPerNode: 0,
      ...overrides,
    },
    nodes: [
      { id: 'generator', data: { role: 'generator' } },
      { id: 'evaluator', data: { role: 'evaluator' } },
      { id: 'seat-a', data: { role: 'seat', lane: reviewLane('seat-a') } },
      { id: 'seat-b', data: { role: 'seat', lane: reviewLane('seat-b') } },
      { id: 'repair', data: { role: 'repair' } },
    ],
    edges: [
      { id: 'generator-to-evaluator', source: 'generator', target: 'evaluator', data: {} },
      { id: 'evaluator-to-seat-a', source: 'evaluator', target: 'seat-a', data: {} },
      { id: 'evaluator-to-seat-b', source: 'evaluator', target: 'seat-b', data: {} },
    ],
  };
}

function convDispatched(nodeId: NodeId, round: number, attempt = 1): ConvergenceEvent {
  return {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId, position: `convergence/${round}/${nodeId}/${attempt}` },
  };
}

function seatDispatched(nodeId: NodeId, round: number, attempt = 1): ConvergenceEvent {
  return {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId, position: `review/${round}/${nodeId}/${attempt}` },
  };
}

function repairDispatched(round: number): ConvergenceEvent {
  return {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'repair', position: `convergence/repair/${round}` },
  };
}

function completed(
  nodeId: NodeId,
  position: string,
  result: JsonObject,
): ConvergenceEvent {
  return { type: 'node-completed', version: 1, payload: { nodeId, position, result } };
}

function failedNode(nodeId: NodeId, position: string, code: string): ConvergenceEvent {
  return { type: 'node-failed', version: 1, payload: { nodeId, position, code } };
}

function seatInvalidated(seatId: NodeId): ConvergenceEvent {
  return { type: 'seat-invalidated', version: 1, payload: { seatId, reason: 'watched path changed' } };
}

function seatSkip(seatId: NodeId): ConvergenceEvent {
  return { type: 'seat-skip', version: 1, payload: { seatId, reason: 'exhausted credit' } };
}

const PASS_ANTHROPIC = { verdict: 'pass', confidence: 0.9, provider: 'anthropic', modelFamily: 'claude' } as const;
const PASS_OPENAI = { verdict: 'pass', confidence: 0.85, provider: 'openai', modelFamily: 'gpt' } as const;
const PASS_XAI = { verdict: 'pass', confidence: 0.8, provider: 'xai', modelFamily: 'grok' } as const;

function reviewLane(
  id: string,
  provider = 'mock',
  modelFamily = 'mock-family',
  model = `mock-${id}`,
) {
  return {
    id,
    requested: { adapter: 'mock', provider, modelFamily, model, tools: [] as readonly string[] },
    knownSubstitutions: [],
  } as const;
}

function planResolution(definition: ConvergenceDefinition): PlanResolution {
  const identity = {
    source: 'file:examples/packages/convergence',
    version: '1.0.0',
    digest: `sha256:${'d'.repeat(64)}` as const,
  };
  const seats = definition.nodes.filter((node) => node.data.role === 'seat');
  return {
    package: identity,
    admission: { package: identity, permissions: [] },
    executionLanes: seats.map((seat) => ({
      id: seat.id,
      effective: {
        adapter: 'mock',
        provider: 'mock',
        modelFamily: 'mock-family',
        model: `mock-${seat.id}`,
        tools: [] as readonly string[],
      },
    })),
  };
}

function fold(
  events: readonly ConvergenceEvent[],
  definition: ConvergenceDefinition = panel(),
): ConvergenceStatus {
  const compiled = compileGraph(convergence, definition);
  let state = compiled.initialState();
  for (const event of events) state = compiled.reduce(state, event);
  return state;
}

function decideAt(
  events: readonly ConvergenceEvent[],
  definition: ConvergenceDefinition = panel(),
): readonly GraphCommand[] {
  const compiled = compileGraph(convergence, definition);
  return compiled.decide(fold(events, definition));
}

function expectIssue(definition: ConvergenceDefinition, code: string): void {
  let caught: unknown;
  try {
    compileGraph(convergence, definition);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GraphValidationError);
  const issues = (caught as GraphValidationError).issues;
  expect(issues.some((item) => item.code === code)).toBe(true);
}

describe('convergence graph type', () => {
  it('passes the graph type conformance kit', () => {
    const definition = panel();
    const fixture: GraphTypeConformanceFixture<
      ConvergenceDefinition,
      ConvergenceStatus,
      ConvergenceEvent,
      ConvergenceRequirements
    > = {
      graphType: convergence,
      definition,
      events: [
        convDispatched('generator', 1),
        completed('generator', 'convergence/1/generator/1', { summary: 'draft one' }),
        convDispatched('evaluator', 1),
        completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
        seatDispatched('seat-a', 1),
        completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
        seatDispatched('seat-b', 1),
        completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
      ],
      invalidDefinitions: [
        {
          ...panel(),
          nodes: [
            ...panel().nodes,
            { id: 'generator-2', data: { role: 'generator' } },
          ],
        },
        panel({ quorum: 3 }),
        panel({ skippableSeats: ['nope'] }),
        panel({ maxIterations: 0 }),
      ],
      planResolution: planResolution(definition),
      expected: {
        states: [
          {
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('pending'), evaluator: nodeState('pending'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('in-flight', 1, 'convergence/1/generator/1'),
              evaluator: nodeState('pending'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('pending'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1),
              evaluator: nodeState('in-flight', 1, 'convergence/1/evaluator/1'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('in-flight', 1, 'review/1/seat-a/1'),
              'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('passed', 1), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: {
              'seat-a': { outcome: 'valid', verdict: 'pass', confidence: 0.9, provider: 'anthropic', modelFamily: 'claude', findings: [], stale: false },
              'seat-b': seatRecord(null),
            },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('passed', 1),
              'seat-b': nodeState('in-flight', 1, 'review/1/seat-b/1'),
              repair: nodeState('pending'),
            },
            seats: {
              'seat-a': { outcome: 'valid', verdict: 'pass', confidence: 0.9, provider: 'anthropic', modelFamily: 'claude', findings: [], stale: false },
              'seat-b': seatRecord(null),
            },
            findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('passed', 1), 'seat-b': nodeState('passed', 1), repair: nodeState('pending'),
            },
            seats: {
              'seat-a': { outcome: 'valid', verdict: 'pass', confidence: 0.9, provider: 'anthropic', modelFamily: 'claude', findings: [], stale: false },
              'seat-b': { outcome: 'valid', verdict: 'pass', confidence: 0.85, provider: 'openai', modelFamily: 'gpt', findings: [], stale: false },
            },
            findingRounds: {}, pauseReason: null,
          },
        ],
        commands: [
          [{ kind: 'dispatch', nodeId: 'generator', input: { positionSummary: 'convergence/1, node generator, attempt 1' }, position: 'convergence/1/generator/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'evaluator', input: { positionSummary: 'convergence/1, node evaluator, attempt 1' }, position: 'convergence/1/evaluator/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'seat-a', input: { positionSummary: 'review/1, node seat-a, attempt 1' }, position: 'review/1/seat-a/1' }],
          [],
          [{ kind: 'dispatch', nodeId: 'seat-b', input: { positionSummary: 'review/1, node seat-b, attempt 1' }, position: 'review/1/seat-b/1' }],
          [],
          [{
            kind: 'complete',
            output: {
              iterations: 1,
              restarts: 0,
              seats: { 'seat-a': 'accepted', 'seat-b': 'accepted' },
            },
          }],
        ],
        bounds: {
          dispatches: { min: { kind: 'known', value: 4 }, max: { kind: 'known', value: 9 } },
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

  it('compiles and describes the panel', () => {
    const compiled = compileGraph(convergence, panel());
    const description = compiled.describe();
    expect(description.graph.kind).toBe('convergence');
    expect(description.graph.typeVersion).toBe(1);
    expect(description.nodes.filter((node) => node.laneId !== null).map((node) => node.id))
      .toEqual(['seat-a', 'seat-b']);
    expect(description.bounds.dispatches.min).toEqual({ kind: 'known', value: 4 });
    expect(description.bounds.dispatches.max).toEqual({ kind: 'known', value: 9 });
  });

  it('merges identical engine lanes by id', () => {
    const lane = reviewLane('shared-review');
    const definition: ConvergenceDefinition = {
      ...panel(),
      nodes: panel().nodes.map((node) => node.data.role === 'seat'
        ? { ...node, data: { ...node.data, lane } }
        : node),
    };

    const description = compileGraph(convergence, definition).describe();
    expect(description.nodes.filter((node) => node.id.startsWith('seat-')))
      .toMatchObject([{ laneId: lane.id }, { laneId: lane.id }]);
    expect(description.executionLanes).toEqual([lane]);
  });

  it('rejects conflicting declarations for one engine lane id', () => {
    const base = panel();
    expectIssue({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'seat-a'
        ? { ...node, data: { ...node.data, lane: reviewLane('shared-review', 'anthropic') } }
        : node.id === 'seat-b'
          ? { ...node, data: { ...node.data, lane: reviewLane('shared-review', 'openai') } }
          : node),
    }, 'CONFLICTING_LANE');
  });

  it('rejects a second generator node', () => {
    expectIssue({
      ...panel(),
      nodes: [...panel().nodes, { id: 'generator-2', data: { role: 'generator' } }],
    }, 'ROLE_COUNT');
  });

  it('rejects a quorum above the seat count', () => {
    expectIssue(panel({ quorum: 3 }), 'INVALID_QUORUM');
  });

  it('rejects an unknown skippable seat', () => {
    expectIssue(panel({ skippableSeats: ['nope'] }), 'UNKNOWN_SEAT');
  });

  it('rejects an invalid iteration limit', () => {
    expectIssue(panel({ maxIterations: 0 }), 'INVALID_LIMIT');
  });

  it('reuses accepted seats and reruns only the invalid ones after a repair', () => {
    const definition: ConvergenceDefinition = {
      ...panel({ quorum: 2, maxIterations: 3, retryCapPerNode: 1 }),
      nodes: [
        { id: 'generator', data: { role: 'generator' } },
        { id: 'evaluator', data: { role: 'evaluator' } },
        { id: 'seat-claude', data: { role: 'seat', lane: reviewLane('seat-claude', 'anthropic', 'claude', 'claude-test') } },
        { id: 'seat-codex', data: { role: 'seat', lane: reviewLane('seat-codex', 'openai', 'gpt', 'gpt-test') } },
        { id: 'seat-grok', data: { role: 'seat', lane: reviewLane('seat-grok', 'xai', 'grok', 'grok-test') } },
        { id: 'repair', data: { role: 'repair' } },
      ],
      edges: [],
    };
    const finding = { id: 'f1', kind: 'patch' as const, evidence: 'left pad mismatch' };
    const roundOne = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
      seatDispatched('seat-claude', 1),
      completed('seat-claude', 'review/1/seat-claude/1', PASS_ANTHROPIC),
      seatDispatched('seat-codex', 1),
      completed('seat-codex', 'review/1/seat-codex/1', {
        verdict: 'findings', confidence: 0.7, provider: 'openai', modelFamily: 'gpt',
        findings: [finding],
      }),
      seatDispatched('seat-grok', 1),
      completed('seat-grok', 'review/1/seat-grok/1', {
        verdict: 'low-confidence', confidence: 0.2, provider: 'xai', modelFamily: 'grok',
      }),
    ];

    const repair = decideAt(roundOne, definition);
    expect(repair).toEqual([{
      kind: 'dispatch',
      nodeId: 'repair',
      input: { positionSummary: 'repair round 1', findings: [finding] },
      position: 'convergence/repair/1',
    }]);

    const afterRepair = [
      ...roundOne,
      repairDispatched(1),
      completed('repair', 'convergence/repair/1', { fixed: true }),
    ];
    const body = decideAt(afterRepair, definition);
    expect(body).toEqual([{
      kind: 'dispatch',
      nodeId: 'generator',
      input: { positionSummary: 'convergence/2, node generator, attempt 2' },
      position: 'convergence/2/generator/2',
    }]);

    const backToReview = [
      ...afterRepair,
      convDispatched('generator', 2, 2),
      completed('generator', 'convergence/2/generator/2', {}),
      convDispatched('evaluator', 2, 2),
      completed('evaluator', 'convergence/2/evaluator/2', { gateMet: true }),
    ];
    const reruns = decideAt(backToReview, definition);
    expect(reruns).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-codex',
      input: { positionSummary: 'review/2, node seat-codex, attempt 2' },
      position: 'review/2/seat-codex/2',
    }]);
    const positions = reruns
      .filter((command): command is Extract<GraphCommand, { kind: 'dispatch' }> => command.kind === 'dispatch')
      .map((command) => command.position);
    expect(positions).not.toContain('review/2/seat-claude/2');

    const verdict = decideAt([
      ...backToReview,
      seatDispatched('seat-codex', 2, 2),
      completed('seat-codex', 'review/2/seat-codex/2', PASS_OPENAI),
      seatDispatched('seat-grok', 2, 2),
      completed('seat-grok', 'review/2/seat-grok/2', PASS_XAI),
    ], definition);
    expect(verdict).toEqual([{
      kind: 'complete',
      output: {
        iterations: 2,
        restarts: 1,
        seats: { 'seat-claude': 'accepted', 'seat-codex': 'accepted', 'seat-grok': 'accepted' },
      },
    }]);
  });

  it('treats an engine failure as a non-verdict that retries without spending a repair round', () => {
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      failedNode('seat-b', 'review/1/seat-b/1', 'auth'),
    ];
    const retry = decideAt(events, panel({ retryCapPerNode: 1 }));
    expect(retry).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-b',
      input: { positionSummary: 'review/1, node seat-b, attempt 2' },
      position: 'review/1/seat-b/2',
    }]);

    const state = fold(events, panel({ retryCapPerNode: 1 }));
    expect(state.seats['seat-b']!.outcome).toBe('non-verdict');
    expect(state.restarts).toBe(0);

    const verdict = decideAt([
      ...events,
      seatDispatched('seat-b', 1, 2),
      completed('seat-b', 'review/1/seat-b/2', PASS_OPENAI),
    ], panel({ retryCapPerNode: 1 }));
    expect(verdict[0]!.kind).toBe('complete');
  });

  it('skips a skippable seat for exhausted credit and rechecks the quorum', () => {
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      failedNode('seat-b', 'review/1/seat-b/1', 'billing'),
      seatSkip('seat-b'),
    ];
    const commands = decideAt(events, panel({ skippableSeats: ['seat-b'], quorum: 1 }));
    expect(commands).toEqual([{
      kind: 'complete',
      output: { iterations: 1, restarts: 0, seats: { 'seat-a': 'accepted', 'seat-b': 'skipped' } },
    }]);

    const unreachable = decideAt(events, panel({ skippableSeats: ['seat-b'], quorum: 2 }));
    expect(unreachable).toEqual([{
      kind: 'fail',
      code: 'QUORUM_UNREACHABLE',
      message: 'Only 1 accepted passes; quorum is 2.',
    }]);
  });

  it('pauses typed on exhausted credit for a non-skippable seat and on rate limits', () => {
    const base = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
      seatDispatched('seat-b', 1),
    ];
    const credit = decideAt([
      ...base,
      failedNode('seat-b', 'review/1/seat-b/1', 'billing'),
    ]);
    expect(credit).toEqual([{
      kind: 'pause',
      reason: 'Seat "seat-b" ran out of credit.',
    }]);

    const rate = decideAt([
      ...base,
      failedNode('seat-b', 'review/1/seat-b/1', 'rate-limit'),
    ]);
    expect(rate).toEqual([{
      kind: 'pause',
      reason: 'Seat "seat-b" hit a rate limit; the run pauses.',
    }]);
  });

  it('fails typed when iterations or repair rounds are exhausted', () => {
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: false }),
      convDispatched('generator', 2, 2),
      completed('generator', 'convergence/2/generator/2', {}),
      convDispatched('evaluator', 2, 2),
      completed('evaluator', 'convergence/2/evaluator/2', { gateMet: false }),
    ];
    const verdict = decideAt(events, panel());
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'CONVERGENCE_EXHAUSTED',
      message: 'Exhausted after 2 iterations and 0 repair rounds.',
    }]);
  });

  it('fails typed on a hard generator failure', () => {
    const verdict = decideAt([
      convDispatched('generator', 1),
      failedNode('generator', 'convergence/1/generator/1', 'EFFECT_FAILED'),
    ]);
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'CONVERGENCE_NODE_FAILED',
      message: 'Failed nodes: generator.',
    }]);
  });

  it('escalates a finding that survives two repair rounds', () => {
    const definition = panel({ maxIterations: 3, maxReviewRestarts: 2, retryCapPerNode: 1 });
    const finding = { id: 'f1', kind: 'patch' as const, evidence: 'left pad mismatch' };
    const events: ConvergenceEvent[] = [];
    for (let round = 1; round <= 3; round += 1) {
      events.push(
        convDispatched('generator', round, round),
        completed('generator', `convergence/${round}/generator/${round}`, {}),
        convDispatched('evaluator', round, round),
        completed('evaluator', `convergence/${round}/evaluator/${round}`, { gateMet: true }),
      );
      if (round === 1) {
        events.push(
          seatDispatched('seat-a', round),
          completed('seat-a', `review/${round}/seat-a/1`, PASS_ANTHROPIC),
        );
      }
      events.push(
        seatDispatched('seat-b', round, round),
        completed('seat-b', `review/${round}/seat-b/${round}`, {
          verdict: 'findings', confidence: 0.7, provider: 'openai', modelFamily: 'gpt',
          findings: [finding],
        }),
      );
      if (round < 3) {
        events.push(
          repairDispatched(round),
          completed('repair', `convergence/repair/${round}`, { fixed: true }),
        );
      }
    }
    const verdict = decideAt(events, definition);
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'FINDING_ESCALATED',
      message: 'Recurring findings: f1.',
    }]);
  });

  it('reruns a seat whose evidence was invalidated', () => {
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatInvalidated('seat-a'),
    ];
    const commands = decideAt(events);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-a',
      input: { positionSummary: 'review/1, node seat-a, attempt 2' },
      position: 'review/1/seat-a/2',
    }]);
  });

  it('ignores a stale completion for an earlier attempt', () => {
    const compiled = compileGraph(convergence, panel({ retryCapPerNode: 1 }));
    let state = compiled.initialState();
    state = compiled.reduce(state, seatDispatched('seat-a', 1));
    state = compiled.reduce(state, failedNode('seat-a', 'review/1/seat-a/1', 'auth'));
    state = compiled.reduce(state, seatDispatched('seat-a', 1, 2));

    const stale = compiled.reduce(
      state,
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
    );
    expect(stale).toEqual(state);
    expect(stale.nodes['seat-a']!.status).toBe('in-flight');

    const after = compiled.reduce(
      state,
      completed('seat-a', 'review/1/seat-a/2', PASS_ANTHROPIC),
    );
    expect(after.seats['seat-a']!.outcome).toBe('valid');
  });

  it('offers body retries within the cap and fails past it', () => {
    const events = [
      convDispatched('generator', 1),
      failedNode('generator', 'convergence/1/generator/1', 'EFFECT_FAILED'),
    ];
    const retry = decideAt(events, panel({ retryCapPerNode: 1 }));
    expect(retry).toEqual([{
      kind: 'dispatch',
      nodeId: 'generator',
      input: { positionSummary: 'convergence/1, node generator, attempt 2' },
      position: 'convergence/1/generator/2',
    }]);

    const verdict = decideAt(events, panel({ retryCapPerNode: 0 }));
    expect(verdict).toEqual([{
      kind: 'fail',
      code: 'CONVERGENCE_NODE_FAILED',
      message: 'Failed nodes: generator.',
    }]);
  });

  it('pauses typed on an abort and while any node is paused', () => {
    const aborted = decideAt([
      convDispatched('generator', 1),
      failedNode('generator', 'convergence/1/generator/1', 'aborted'),
    ]);
    expect(aborted).toEqual([{
      kind: 'pause',
      reason: 'Node "generator" was aborted; the run pauses.',
    }]);

    const compiled = compileGraph(convergence, panel());
    let state = compiled.initialState();
    state = compiled.reduce(state, convDispatched('generator', 1));
    state = compiled.reduce(state, {
      type: 'node-paused', version: 1,
      payload: { nodeId: 'generator', position: 'convergence/1/generator/1', reason: 'waiting' },
    });
    expect(compiled.decide(state)).toEqual([{
      kind: 'pause',
      reason: 'Node "generator" is paused; the run waits.',
    }]);
  });

  it('waits for an in-flight review before returning a sibling pause', () => {
    const definition = panel({ seatConcurrency: 2 });
    const compiled = compileGraph(convergence, definition);
    let state = fold([
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
      seatDispatched('seat-a', 1),
      seatDispatched('seat-b', 1),
    ], definition);
    state = compiled.reduce(state, {
      type: 'node-paused', version: 1,
      payload: { nodeId: 'seat-a', position: 'review/1/seat-a/1', reason: 'waiting' },
    });

    expect(state.nodes['seat-b']!.status).toBe('in-flight');
    expect(compiled.decide(state)).toEqual([]);
  });

  it('discards a late verdict for a seat invalidated while in flight', () => {
    const compiled = compileGraph(convergence, panel());
    let state = compiled.initialState();
    state = compiled.reduce(state, seatDispatched('seat-a', 1));
    state = compiled.reduce(state, seatInvalidated('seat-a'));
    expect(state.seats['seat-a']!.stale).toBe(true);

    const late = compiled.reduce(
      state,
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
    );
    expect(late.seats['seat-a']!.outcome).toBe('invalid');
    expect(late.seats['seat-a']!.verdict).toBeNull();
    expect(late.seats['seat-a']!.stale).toBe(false);
  });

  it('does not trust a pass with missing confidence', () => {
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', {
        verdict: 'pass', provider: 'anthropic', modelFamily: 'claude',
      }),
    ];
    const state = fold(events);
    expect(state.seats['seat-a']!.outcome).toBe('invalid');

    const commands = decideAt(events);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-b',
      input: { positionSummary: 'review/1, node seat-b, attempt 1' },
      position: 'review/1/seat-b/1',
    }]);
  });

  it('pauses typed on a recorded limit pause', () => {
    const commands = decideAt([
      {
        type: 'limit-paused', version: 1,
        payload: { reason: 'No progress for three iterations; the run pauses.' },
      },
    ]);
    expect(commands).toEqual([{
      kind: 'pause',
      reason: 'No progress for three iterations; the run pauses.',
    }]);
  });
});
