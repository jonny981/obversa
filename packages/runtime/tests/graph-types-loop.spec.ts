import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EngineError, type EngineSelectionRecord } from '@obversa/engine';
import { MockEngine } from '@obversa/engine/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { GraphCommand } from '../src/graph/commands.ts';
import type { NodeId } from '../src/graph/kernel.ts';
import { resolveGraphPlan, type PlanResolution } from '../src/graph/plan.ts';
import {
  assertGraphTypeConformance,
  runGraphTypeConformance,
  type GraphTypeConformanceFixture,
} from '../src/graph/conformance.ts';
import { compileGraph } from '../src/graph/type.ts';
import { digestJson, GraphValidationError, type JsonObject, type JsonValue } from '../src/graph/value.ts';
import {
  createGraphExecutor,
  type GraphEngineBinding,
  type GraphNodeBinding,
} from '../src/runtime/graph-executor.ts';
import { persistRunDefinition, type RunStorageBinding } from '../src/runtime/run-definition.ts';
import { defineResultContract } from '../src/runtime/result-contract.ts';
import { createLocalRunStorage } from '../src/storage/local.ts';
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
  return {
    outcome,
    verdict: null,
    confidence: null,
    provider: null,
    modelFamily: null,
    inputHashes: null,
    workspaceFingerprint: null,
    findings: [],
    stale: false,
  };
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
      { id: 'seat-a', data: { role: 'seat', lane: reviewLane('seat-a', 'anthropic', 'claude') } },
      { id: 'seat-b', data: { role: 'seat', lane: reviewLane('seat-b', 'openai', 'gpt') } },
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

function repairDispatched(round: number, attempt = 1): ConvergenceEvent {
  return {
    type: 'node-dispatched',
    version: 1,
    payload: { nodeId: 'repair', position: `convergence/repair/${round}/${attempt}` },
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

const REVIEW_EVIDENCE = {
  inputHashes: { draft: 'sha256:draft' },
  workspaceFingerprint: 'sha256:workspace',
} as const;
const PASS_ANTHROPIC = {
  verdict: 'pass', confidence: 0.9, provider: 'anthropic', modelFamily: 'claude',
  ...REVIEW_EVIDENCE,
} as const;
const PASS_OPENAI = {
  verdict: 'pass', confidence: 0.85, provider: 'openai', modelFamily: 'gpt',
  ...REVIEW_EVIDENCE,
} as const;
const PASS_XAI = {
  verdict: 'pass', confidence: 0.8, provider: 'xai', modelFamily: 'grok',
  ...REVIEW_EVIDENCE,
} as const;

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
      id: seat.data.lane!.id,
      effective: seat.data.lane!.requested,
      fallbacks: seat.data.lane!.knownSubstitutions,
    })),
  };
}

const executorRoots: string[] = [];
let executorSequence = 0;

afterEach(async () => {
  await Promise.all(executorRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function storedConvergenceRun(definition: ConvergenceDefinition): Promise<{
  readonly graph: ReturnType<typeof compileGraph<
    ConvergenceDefinition,
    ConvergenceStatus,
    ConvergenceEvent,
    ConvergenceRequirements
  >>;
  readonly root: string;
  readonly runId: string;
  readonly storage: RunStorageBinding;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-convergence-')));
  executorRoots.push(root);
  const runId = `convergence-${executorSequence += 1}`;
  const graph = compileGraph(convergence, definition);
  const storage = createLocalRunStorage({
    directory: join(root, 'storage'),
    namespace: 'convergence-tests',
    policy: {
      schemaVersion: 1,
      maxEventPayloadBytes: 64_000,
      maxAppendBatchBytes: 128_000,
      maxArtifactBytes: 1_000_000,
      maxTotalArtifactBytesPerRun: 4_000_000,
      retention: 'until-run-delete',
      sensitiveContent: {
        marked: 'reject',
        exact: 'reject',
        freeText: 'redact-before-hash',
      },
    },
  });
  await persistRunDefinition(storage, {
    runId,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: resolveGraphPlan(graph.describe(), planResolution(definition)),
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  return { graph, root, runId, storage };
}

function executorNodeBinding(
  root: string,
  input: Partial<Pick<GraphNodeBinding, 'prompt' | 'resultContract' | 'runData' | 'parseResult'>>,
): GraphNodeBinding {
  return {
    prompt: input.prompt ?? null,
    scratchDirectory: root,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {},
    permissions: [],
    policy: {
      inputBytes: 100_000,
      outputBytes: 100_000,
      timeoutMs: 5_000,
      teardownGraceMs: 100,
      memoryBytes: 100_000_000,
      filesChanged: 0,
      linesChanged: 0,
      callTokens: null,
    },
    resultContract: input.resultContract ?? null,
    runData: input.runData ?? null,
    parseResult: input.parseResult ?? null,
    tokenBudget: null,
    decideAction: async () => ({ kind: 'allow' }),
  };
}

const reviewResultSchema = {
  type: 'object',
  required: [
    'verdict',
    'confidence',
    'inputHashes',
    'workspaceFingerprint',
  ],
} as const;
const reviewResultContract = defineResultContract({
  record: {
    name: 'convergence-review',
    version: 1,
    schemaDigest: digestJson(reviewResultSchema),
  },
  schema: reviewResultSchema,
  validate(value: unknown): JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('review result must be an object');
    }
    return value as JsonObject;
  },
});

function reviewEngineBinding(
  definition: ConvergenceDefinition,
  seatId: NodeId,
  response: JsonObject | EngineError,
  prompts: string[],
): GraphEngineBinding {
  const node = definition.nodes.find((candidate) => candidate.id === seatId)!;
  const target = node.data.lane!.requested;
  const selection: EngineSelectionRecord = {
    adapter: target.adapter,
    adapterVersion: null,
    provider: null,
    modelFamily: null,
    model: target.model,
    executable: null,
    capabilities: [],
  };
  return {
    target,
    selection,
    engine: new MockEngine((request) => {
      prompts.push(`${seatId}: ${request.prompt}`);
      if (response instanceof EngineError) throw response;
      return JSON.stringify(response);
    }),
    hardTokenLimitEnforceable: false,
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
        completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
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
            reviewEvidence: null, findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('in-flight', 1, 'convergence/1/generator/1'),
              evaluator: nodeState('pending'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: null, findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('pending'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: null, findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1),
              evaluator: nodeState('in-flight', 1, 'convergence/1/evaluator/1'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: null, findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('in-flight', 1, 'review/1/seat-a/1'),
              'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('passed', 1), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: {
              'seat-a': {
                outcome: 'valid', verdict: 'pass', confidence: 0.9,
                provider: 'anthropic', modelFamily: 'claude',
                inputHashes: REVIEW_EVIDENCE.inputHashes,
                workspaceFingerprint: REVIEW_EVIDENCE.workspaceFingerprint,
                findings: [], stale: false,
              },
              'seat-b': seatRecord(null),
            },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
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
              'seat-a': {
                outcome: 'valid', verdict: 'pass', confidence: 0.9,
                provider: 'anthropic', modelFamily: 'claude',
                inputHashes: REVIEW_EVIDENCE.inputHashes,
                workspaceFingerprint: REVIEW_EVIDENCE.workspaceFingerprint,
                findings: [], stale: false,
              },
              'seat-b': seatRecord(null),
            },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
          },
          {
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('passed', 1), 'seat-b': nodeState('passed', 1), repair: nodeState('pending'),
            },
            seats: {
              'seat-a': {
                outcome: 'valid', verdict: 'pass', confidence: 0.9,
                provider: 'anthropic', modelFamily: 'claude',
                inputHashes: REVIEW_EVIDENCE.inputHashes,
                workspaceFingerprint: REVIEW_EVIDENCE.workspaceFingerprint,
                findings: [], stale: false,
              },
              'seat-b': {
                outcome: 'valid', verdict: 'pass', confidence: 0.85,
                provider: 'openai', modelFamily: 'gpt',
                inputHashes: REVIEW_EVIDENCE.inputHashes,
                workspaceFingerprint: REVIEW_EVIDENCE.workspaceFingerprint,
                findings: [], stale: false,
              },
            },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
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
              findings: [],
            },
          }],
        ],
        bounds: {
          dispatches: { min: { kind: 'known', value: 4 }, max: { kind: 'known', value: 11 } },
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
    expect(description.bounds.dispatches.max).toEqual({ kind: 'known', value: 11 });
  });

  it('bounds body re-entry and seat reruns across every repair round', () => {
    const definition: ConvergenceDefinition = {
      ...panel({ maxIterations: 1, maxReviewRestarts: 2, quorum: 1, requireDiversity: false }),
      nodes: [
        { id: 'generator', data: { role: 'generator' } },
        { id: 'evaluator', data: { role: 'evaluator' } },
        { id: 'seat-a', data: { role: 'seat', lane: reviewLane('seat-a') } },
        { id: 'repair', data: { role: 'repair' } },
      ],
      edges: [],
    };
    const events: ConvergenceEvent[] = [];
    for (let round = 1; round <= 3; round += 1) {
      const finding = { id: `f${round}`, kind: 'patch' as const, evidence: `round ${round}` };
      events.push(
        convDispatched('generator', 1, round),
        completed('generator', `convergence/1/generator/${round}`, {}),
        convDispatched('evaluator', 1, round),
        completed('evaluator', `convergence/1/evaluator/${round}`, {
          gateMet: true,
          ...REVIEW_EVIDENCE,
        }),
        seatDispatched('seat-a', 1, round),
        completed('seat-a', `review/1/seat-a/${round}`, {
          verdict: 'findings', confidence: 0.8, provider: 'anthropic', modelFamily: 'claude',
          findings: [finding],
          ...REVIEW_EVIDENCE,
        }),
      );
      if (round < 3) {
        events.push(
          repairDispatched(round, round),
          completed('repair', `convergence/repair/${round}/${round}`, { fixed: true }),
        );
      }
    }

    const compiled = compileGraph(convergence, definition);
    const dispatches = events.filter((event) => event.type === 'node-dispatched').length;
    expect(dispatches).toBe(11);
    expect(compiled.describe().bounds.dispatches.max).toEqual({ kind: 'known', value: 11 });
    expect(compiled.decide(events.reduce(compiled.reduce, compiled.initialState()))).toEqual([{
      kind: 'fail',
      code: 'CONVERGENCE_EXHAUSTED',
      message: 'Exhausted after 1 iterations and 2 repair rounds.',
    }]);
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

  it('does not let seat results claim diversity absent from the planned lanes', () => {
    const lane = reviewLane('shared-review', 'anthropic', 'claude');
    const definition: ConvergenceDefinition = {
      ...panel(),
      nodes: panel().nodes.map((node) => node.data.role === 'seat'
        ? { ...node, data: { ...node.data, lane } }
        : node),
    };
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
    ];

    expect(decideAt(events, definition)).toEqual([{
      kind: 'fail',
      code: 'QUORUM_UNREACHABLE',
      message: 'Only 2 accepted passes; quorum is 2.',
    }]);
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

  it('rejects an empty evidence path list for a review seat', () => {
    const base = panel();
    expectIssue({
      ...base,
      nodes: base.nodes.map((node) => node.id === 'seat-a'
        ? { ...node, data: { ...node.data, evidencePaths: [] } }
        : node),
    }, 'INVALID_EVIDENCE_PATHS');
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
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
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
      position: 'convergence/repair/1/1',
    }]);

    const afterRepair = [
      ...roundOne,
      repairDispatched(1),
      completed('repair', 'convergence/repair/1/1', { fixed: true }),
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
      completed('evaluator', 'convergence/2/evaluator/2', { gateMet: true, ...REVIEW_EVIDENCE }),
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
        findings: [],
      },
    }]);
  });

  it('treats an engine failure as a non-verdict that retries without spending a repair round', () => {
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
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

  it('skips an unavailable skippable seat and rechecks the quorum', () => {
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      failedNode('seat-b', 'review/1/seat-b/1', 'ENGINE_UNAVAILABLE'),
    ];
    const commands = decideAt(events, panel({ skippableSeats: ['seat-b'], quorum: 1 }));
    expect(commands).toEqual([{
      kind: 'complete',
      output: {
        iterations: 1,
        restarts: 0,
        seats: { 'seat-a': 'accepted', 'seat-b': 'skipped' },
        findings: [],
      },
    }]);

    const unreachable = decideAt(events, panel({ skippableSeats: ['seat-b'], quorum: 2 }));
    expect(unreachable).toEqual([{
      kind: 'fail',
      code: 'QUORUM_UNREACHABLE',
      message: 'Only 1 accepted passes; quorum is 2.',
    }]);
  });

  it('opens when a diverse quorum exists beside a duplicate-provider pass', () => {
    const definition: ConvergenceDefinition = {
      ...panel({ seatConcurrency: 3 }),
      nodes: [
        { id: 'generator', data: { role: 'generator' } },
        { id: 'evaluator', data: { role: 'evaluator' } },
        { id: 'seat-a', data: { role: 'seat', lane: reviewLane('seat-a', 'anthropic', 'claude') } },
        { id: 'seat-b', data: { role: 'seat', lane: reviewLane('seat-b', 'openai', 'gpt') } },
        { id: 'seat-c', data: { role: 'seat', lane: reviewLane('seat-c', 'openai', 'gpt') } },
        { id: 'repair', data: { role: 'repair' } },
      ],
      edges: [],
    };
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
      seatDispatched('seat-c', 1),
      completed('seat-c', 'review/1/seat-c/1', PASS_OPENAI),
    ];

    expect(decideAt(events, definition)).toEqual([{
      kind: 'complete',
      output: {
        iterations: 1,
        restarts: 0,
        seats: { 'seat-a': 'accepted', 'seat-b': 'accepted', 'seat-c': 'accepted' },
        findings: [],
      },
    }]);
  });

  it('keeps a remaining seat blocking finding in a met quorum output', () => {
    const definition: ConvergenceDefinition = {
      ...panel({ seatConcurrency: 3 }),
      nodes: [
        { id: 'generator', data: { role: 'generator' } },
        { id: 'evaluator', data: { role: 'evaluator' } },
        { id: 'seat-a', data: { role: 'seat', lane: reviewLane('seat-a', 'anthropic', 'claude') } },
        { id: 'seat-b', data: { role: 'seat', lane: reviewLane('seat-b', 'openai', 'gpt') } },
        { id: 'seat-c', data: { role: 'seat', lane: reviewLane('seat-c', 'xai', 'grok') } },
        { id: 'repair', data: { role: 'repair' } },
      ],
      edges: [],
    };
    const finding = { id: 'f1', kind: 'decision' as const, evidence: 'product choice needed' };
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
      seatDispatched('seat-c', 1),
      completed('seat-c', 'review/1/seat-c/1', {
        verdict: 'findings', confidence: 0.8, findings: [finding], ...REVIEW_EVIDENCE,
      }),
    ];

    expect(decideAt(events, definition)).toEqual([{
      kind: 'complete',
      output: {
        iterations: 1,
        restarts: 0,
        seats: { 'seat-a': 'accepted', 'seat-b': 'accepted', 'seat-c': 'invalid' },
        findings: [finding],
      },
    }]);
  });

  it('does not mistake separate provider and family counts for a diverse quorum', () => {
    const definition: ConvergenceDefinition = {
      ...panel({ quorum: 3, seatConcurrency: 4 }),
      nodes: [
        { id: 'generator', data: { role: 'generator' } },
        { id: 'evaluator', data: { role: 'evaluator' } },
        { id: 'seat-a', data: { role: 'seat', lane: reviewLane('seat-a', 'p1', 'f1') } },
        { id: 'seat-b', data: { role: 'seat', lane: reviewLane('seat-b', 'p2', 'f1') } },
        { id: 'seat-c', data: { role: 'seat', lane: reviewLane('seat-c', 'p3', 'f2') } },
        { id: 'seat-d', data: { role: 'seat', lane: reviewLane('seat-d', 'p3', 'f3') } },
        { id: 'repair', data: { role: 'repair' } },
      ],
      edges: [],
    };
    const pass = (provider: string, modelFamily: string) => ({
      verdict: 'pass' as const,
      confidence: 0.9,
      provider,
      modelFamily,
      ...REVIEW_EVIDENCE,
    });
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', pass('p1', 'f1')),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', pass('p2', 'f1')),
      seatDispatched('seat-c', 1),
      completed('seat-c', 'review/1/seat-c/1', pass('p3', 'f2')),
      seatDispatched('seat-d', 1),
      completed('seat-d', 'review/1/seat-d/1', pass('p3', 'f3')),
    ];

    expect(decideAt(events, definition)).toEqual([{
      kind: 'fail',
      code: 'QUORUM_UNREACHABLE',
      message: 'Only 4 accepted passes; quorum is 3.',
    }]);
  });

  it('pauses when a required review seat has no available engine', () => {
    const base = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-b', 1),
    ];
    const unavailable = decideAt([
      ...base,
      failedNode('seat-b', 'review/1/seat-b/1', 'ENGINE_UNAVAILABLE'),
    ]);
    expect(unavailable).toEqual([{
      kind: 'pause',
      reason: 'Seat "seat-b" has no available engine; the run pauses.',
    }]);
  });

  it('clears a recorded pause when the next dispatch starts', () => {
    const compiled = compileGraph(convergence, panel({ retryCapPerNode: 1 }));
    let state = fold([
      convDispatched('generator', 1),
      failedNode('generator', 'convergence/1/generator/1', 'ABORTED'),
    ]);

    expect(compiled.decide(state)).toEqual([{
      kind: 'pause',
      reason: 'Node "generator" was aborted; the run pauses.',
    }]);

    state = compiled.reduce(state, convDispatched('generator', 1, 2));
    expect(compiled.decide(state)).toEqual([]);
    expect(state.pauseReason).toBeNull();
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
        completed('evaluator', `convergence/${round}/evaluator/${round}`, { gateMet: true, ...REVIEW_EVIDENCE }),
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
          repairDispatched(round, round),
          completed('repair', `convergence/repair/${round}/${round}`, { fixed: true }),
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
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
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

  it('reruns an accepted seat when the recorded review bytes change', () => {
    const evidenceA = {
      inputHashes: { draft: 'sha256:draft-a' },
      workspaceFingerprint: 'sha256:workspace-a',
    };
    const evidenceB = {
      inputHashes: { draft: 'sha256:draft-b' },
      workspaceFingerprint: 'sha256:workspace-b',
    };
    const finding = { id: 'f1', kind: 'patch' as const, evidence: 'fix the draft' };
    const events: ConvergenceEvent[] = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...evidenceA }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', { ...PASS_ANTHROPIC, ...evidenceA }),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', {
        verdict: 'findings', confidence: 0.8, provider: 'openai', modelFamily: 'gpt',
        findings: [finding],
        ...evidenceA,
      }),
      repairDispatched(1),
      completed('repair', 'convergence/repair/1/1', { fixed: true }),
      convDispatched('generator', 2, 2),
      completed('generator', 'convergence/2/generator/2', {}),
      convDispatched('evaluator', 2, 2),
      completed('evaluator', 'convergence/2/evaluator/2', { gateMet: true, ...evidenceB }),
    ];

    expect(decideAt(events, panel({ retryCapPerNode: 1 }))).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-a',
      input: { positionSummary: 'review/2, node seat-a, attempt 2' },
      position: 'review/2/seat-a/2',
    }]);
  });

  it('keeps a pass when only another seat watched the changed input', () => {
    const evidenceA = {
      inputHashes: { draft: 'sha256:draft-a', tests: 'sha256:tests-a' },
      workspaceFingerprint: 'sha256:workspace-a',
    };
    const evidenceB = {
      inputHashes: { draft: 'sha256:draft-b', tests: 'sha256:tests-a' },
      workspaceFingerprint: 'sha256:workspace-b',
    };
    const definition: ConvergenceDefinition = {
      ...panel({ quorum: 3, seatConcurrency: 3, retryCapPerNode: 1 }),
      nodes: [
        {
          id: 'seat-a',
          data: {
            role: 'seat',
            lane: reviewLane('seat-a', 'anthropic', 'claude'),
            evidencePaths: ['draft'],
          },
        },
        {
          id: 'seat-b',
          data: {
            role: 'seat',
            lane: reviewLane('seat-b', 'openai', 'gpt'),
            evidencePaths: ['tests'],
          },
        },
        {
          id: 'seat-c',
          data: { role: 'seat', lane: reviewLane('seat-c', 'xai', 'grok') },
        },
        { id: 'generator', data: { role: 'generator' } },
        { id: 'evaluator', data: { role: 'evaluator' } },
        { id: 'repair', data: { role: 'repair' } },
      ],
      edges: [],
    };
    const finding = { id: 'f1', kind: 'patch' as const, evidence: 'fix the draft' };
    const events: ConvergenceEvent[] = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...evidenceA }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', { ...PASS_ANTHROPIC, ...evidenceA }),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', { ...PASS_OPENAI, ...evidenceA }),
      seatDispatched('seat-c', 1),
      completed('seat-c', 'review/1/seat-c/1', {
        verdict: 'findings', confidence: 0.8, findings: [finding], ...evidenceA,
      }),
      repairDispatched(1),
      completed('repair', 'convergence/repair/1/1', { fixed: true }),
      convDispatched('generator', 2, 2),
      completed('generator', 'convergence/2/generator/2', {}),
      convDispatched('evaluator', 2, 2),
      completed('evaluator', 'convergence/2/evaluator/2', { gateMet: true, ...evidenceB }),
    ];

    const state = fold(events, definition);
    expect(state.seats['seat-a']!.outcome).toBe('invalid');
    expect(state.seats['seat-b']).toMatchObject({
      outcome: 'valid',
      inputHashes: { tests: 'sha256:tests-a' },
      workspaceFingerprint: 'sha256:workspace-a',
    });
    expect(decideAt(events, definition)
      .filter((command) => command.kind === 'dispatch')
      .map((command) => command.nodeId)).toEqual(['seat-a', 'seat-c']);
  });

  it('ignores a stale completion for an earlier attempt', () => {
    const compiled = compileGraph(convergence, panel({ retryCapPerNode: 1 }));
    let state = compiled.initialState();
    state = compiled.reduce(state, convDispatched('generator', 1));
    state = compiled.reduce(state, completed('generator', 'convergence/1/generator/1', {}));
    state = compiled.reduce(state, convDispatched('evaluator', 1));
    state = compiled.reduce(state, completed(
      'evaluator',
      'convergence/1/evaluator/1',
      { gateMet: true, ...REVIEW_EVIDENCE },
    ));
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

  it('retries a failed repair with a fresh attempt position', () => {
    const finding = { id: 'f1', kind: 'patch' as const, evidence: 'fix the output' };
    const beforeRepair: ConvergenceEvent[] = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', {
        verdict: 'findings', confidence: 0.8, provider: 'anthropic', modelFamily: 'claude',
        findings: [finding],
      }),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', {
        verdict: 'low-confidence', confidence: 0.2, provider: 'openai', modelFamily: 'gpt',
      }),
      {
        type: 'node-dispatched', version: 1,
        payload: { nodeId: 'repair', position: 'convergence/repair/1/1' },
      },
      failedNode('repair', 'convergence/repair/1/1', 'EFFECT_FAILED'),
    ];
    const definition = panel({ quorum: 1, retryCapPerNode: 1 });

    expect(decideAt(beforeRepair, definition)).toEqual([{
      kind: 'dispatch',
      nodeId: 'repair',
      input: { positionSummary: 'repair round 1', findings: [finding] },
      position: 'convergence/repair/1/2',
    }]);

    expect(decideAt([
      ...beforeRepair,
      {
        type: 'node-dispatched', version: 1,
        payload: { nodeId: 'repair', position: 'convergence/repair/1/2' },
      },
      completed('repair', 'convergence/repair/1/2', { fixed: true }),
    ], definition)).toEqual([{
      kind: 'dispatch',
      nodeId: 'generator',
      input: { positionSummary: 'convergence/2, node generator, attempt 2' },
      position: 'convergence/2/generator/2',
    }]);
  });

  it('pauses typed on an abort and while any node is paused', () => {
    const aborted = decideAt([
      convDispatched('generator', 1),
      failedNode('generator', 'convergence/1/generator/1', 'ABORTED'),
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
      payload: {
        nodeId: 'generator',
        position: 'convergence/1/generator/1',
        reason: 'waiting',
        request: null,
      },
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
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      seatDispatched('seat-b', 1),
    ], definition);
    state = compiled.reduce(state, {
      type: 'node-paused', version: 1,
      payload: {
        nodeId: 'seat-a',
        position: 'review/1/seat-a/1',
        reason: 'waiting',
        request: null,
      },
    });

    expect(state.nodes['seat-b']!.status).toBe('in-flight');
    expect(compiled.decide(state)).toEqual([]);
  });

  it('discards a late verdict for a seat invalidated while in flight', () => {
    const compiled = compileGraph(convergence, panel());
    let state = compiled.initialState();
    state = compiled.reduce(state, convDispatched('generator', 1));
    state = compiled.reduce(state, completed('generator', 'convergence/1/generator/1', {}));
    state = compiled.reduce(state, convDispatched('evaluator', 1));
    state = compiled.reduce(state, completed(
      'evaluator',
      'convergence/1/evaluator/1',
      { gateMet: true, ...REVIEW_EVIDENCE },
    ));
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
    expect(compiled.decide(late)).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-a',
      input: { positionSummary: 'review/1, node seat-a, attempt 2' },
      position: 'review/1/seat-a/2',
    }]);
  });

  it('stops after the retry cap when a seat never returns trusted evidence', () => {
    const definition = panel({ retryCapPerNode: 1 });
    const events: ConvergenceEvent[] = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      completed('seat-a', 'review/1/seat-a/1', {
        verdict: 'pass', provider: 'anthropic', modelFamily: 'claude',
        ...REVIEW_EVIDENCE,
      }),
    ];
    const state = fold(events, definition);
    expect(state.seats['seat-a']!.outcome).toBe('invalid');

    const commands = decideAt(events, definition);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-a',
      input: { positionSummary: 'review/1, node seat-a, attempt 2' },
      position: 'review/1/seat-a/2',
    }]);

    const exhausted = [
      ...events,
      seatDispatched('seat-a', 1, 2),
      completed('seat-a', 'review/1/seat-a/2', {
        verdict: 'pass', provider: 'anthropic', modelFamily: 'claude',
        ...REVIEW_EVIDENCE,
      }),
      seatDispatched('seat-b', 1),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
    ];
    const exhaustedState = fold(exhausted, definition);
    expect(exhaustedState.seats['seat-a']!.outcome).toBe('non-verdict');
    expect(decideAt(exhausted, definition)).toEqual([{
      kind: 'pause',
      reason: 'Seats unresolved after retries: seat-a.',
    }]);
    expect(exhausted.filter((event) => event.type === 'node-dispatched')).toHaveLength(5);
    expect(compileGraph(convergence, definition).describe().bounds.dispatches.max)
      .toEqual({ kind: 'known', value: 22 });
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

  it('runs a full review round through the graph executor and engine-backed seats', async () => {
    const base = panel({ seatConcurrency: 2 });
    const definition: ConvergenceDefinition = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'seat-a'
        ? { ...node, data: { ...node.data, lane: reviewLane('seat-a', 'anthropic', 'claude') } }
        : node.id === 'seat-b'
          ? { ...node, data: { ...node.data, lane: reviewLane('seat-b', 'openai', 'gpt') } }
          : node),
    };
    const run = await storedConvergenceRun(definition);
    const prompts: string[] = [];
    const parseReviewResult: GraphNodeBinding['parseResult'] = (part) => {
      if (part.kind !== 'assistant') throw new TypeError('review result must be assistant text');
      return JSON.parse(part.text) as JsonValue;
    };
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        generator: executorNodeBinding(run.root, {
          runData: async () => ({ draft: 'ready' }),
        }),
        evaluator: executorNodeBinding(run.root, {
          runData: async () => ({ gateMet: true, ...REVIEW_EVIDENCE }),
        }),
        'seat-a': executorNodeBinding(run.root, {
          prompt: (input) => `Review ${(input as JsonObject).positionSummary}.`,
          resultContract: reviewResultContract,
          parseResult: parseReviewResult,
        }),
        'seat-b': executorNodeBinding(run.root, {
          prompt: (input) => `Review ${(input as JsonObject).positionSummary}.`,
          resultContract: reviewResultContract,
          parseResult: parseReviewResult,
        }),
        repair: executorNodeBinding(run.root, {
          runData: async () => ({ repaired: true }),
        }),
      },
      engines: [
        reviewEngineBinding(definition, 'seat-a', PASS_ANTHROPIC, prompts),
        reviewEngineBinding(definition, 'seat-b', PASS_OPENAI, prompts),
      ],
    });

    const outcome = await executor.run(new AbortController().signal);
    const graphEvents = [];
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) {
      if (event.type.startsWith('graph:')) graphEvents.push(event);
    }
    expect(graphEvents
      .filter((event) => event.type === 'graph:node-failed')
      .map((event) => event.payload)).toEqual([]);
    const completedPayloads = graphEvents
      .filter((event) => event.type === 'graph:node-completed')
      .map((event) => event.payload);
    expect(completedPayloads).toHaveLength(4);
    expect(completedPayloads).toEqual(expect.arrayContaining([
        { nodeId: 'generator', position: 'convergence/1/generator/1', result: { draft: 'ready' } },
        {
          nodeId: 'evaluator',
          position: 'convergence/1/evaluator/1',
          result: { gateMet: true, ...REVIEW_EVIDENCE },
        },
        {
          nodeId: 'seat-a',
          position: 'review/1/seat-a/1',
          result: PASS_ANTHROPIC,
        },
        {
          nodeId: 'seat-b',
          position: 'review/1/seat-b/1',
          result: PASS_OPENAI,
        },
      ]));
    expect(outcome).toEqual({
      kind: 'complete',
      output: {
        iterations: 1,
        restarts: 0,
        seats: { 'seat-a': 'accepted', 'seat-b': 'accepted' },
        findings: [],
      },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts).toEqual(expect.arrayContaining([
      'seat-a: Review review/1, node seat-a, attempt 1.',
      'seat-b: Review review/1, node seat-b, attempt 1.',
    ]));

    const graphEventTypes = graphEvents.map((event) => event.type);
    expect(graphEventTypes).toEqual([
      'graph:run-started',
      'graph:node-dispatched',
      'graph:node-completed',
      'graph:node-dispatched',
      'graph:node-completed',
      'graph:node-dispatched',
      'graph:node-dispatched',
      'graph:node-completed',
      'graph:node-completed',
    ]);
  });

  it('pauses after a real engine rate limit exhausts a required seat retry cap', async () => {
    const base = panel({ seatConcurrency: 2 });
    const definition: ConvergenceDefinition = {
      ...base,
      nodes: base.nodes.map((node) => node.id === 'seat-a'
        ? { ...node, data: { ...node.data, lane: reviewLane('seat-a', 'anthropic', 'claude') } }
        : node.id === 'seat-b'
          ? { ...node, data: { ...node.data, lane: reviewLane('seat-b', 'openai', 'gpt') } }
          : node),
    };
    const run = await storedConvergenceRun(definition);
    const parseReviewResult: GraphNodeBinding['parseResult'] = (part) => {
      if (part.kind !== 'assistant') throw new TypeError('review result must be assistant text');
      return JSON.parse(part.text) as JsonValue;
    };
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        generator: executorNodeBinding(run.root, { runData: async () => ({ draft: 'ready' }) }),
        evaluator: executorNodeBinding(run.root, {
          runData: async () => ({ gateMet: true, ...REVIEW_EVIDENCE }),
        }),
        'seat-a': executorNodeBinding(run.root, {
          prompt: () => 'Review as seat A.', resultContract: reviewResultContract, parseResult: parseReviewResult,
        }),
        'seat-b': executorNodeBinding(run.root, {
          prompt: () => 'Review as seat B.', resultContract: reviewResultContract, parseResult: parseReviewResult,
        }),
        repair: executorNodeBinding(run.root, { runData: async () => ({ repaired: true }) }),
      },
      engines: [
        reviewEngineBinding(definition, 'seat-a', PASS_ANTHROPIC, []),
        reviewEngineBinding(
          definition,
          'seat-b',
          new EngineError({ kind: 'rate-limit', message: '429 try later' }),
          [],
        ),
      ],
    });

    expect(await executor.run(new AbortController().signal)).toEqual({
      kind: 'pause',
      reason: 'Seats unresolved after retries: seat-b.',
    });
    const failureCodes: string[] = [];
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) {
      if (event.type === 'graph:node-failed') {
        const payload = event.payload as JsonObject;
        if (typeof payload.code === 'string') failureCodes.push(payload.code);
      }
    }
    expect(failureCodes).toEqual(['EFFECT_FAILED']);
  });
});
