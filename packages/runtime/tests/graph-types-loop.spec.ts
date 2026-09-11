import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EngineError, assistantResult, engineSelection, reportedUsage, type EngineSelectionRecord } from '@obversa/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GraphCommand } from '../src/graph/commands.ts';
import type { NodeId } from '../src/graph/kernel.ts';
import { resolveGraphPlan, type ExecutionTarget, type PlanResolution } from '../src/graph/plan.ts';
import type { DomainEventEnvelope } from '../src/events/envelope.ts';
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

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
    proofArtifactDigest: null,
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

function seatReceipt(
  nodeId: NodeId,
  position: string,
  provider: string,
  modelFamily: string,
  model = `mock-${nodeId}`,
): ConvergenceEvent {
  const identity = { adapter: 'mock', provider, modelFamily, model };
  return {
    type: 'engine-attempt-recorded', version: 1,
    payload: { nodeId, position, sequence: 1, requested: identity, effective: identity },
  };
}

function failedNode(nodeId: NodeId, position: string, code: string): ConvergenceEvent {
  return { type: 'node-failed', version: 1, payload: { nodeId, position, code } };
}

function resumedNode(nodeId: NodeId, position: string): ConvergenceEvent {
  return { type: 'node-resumed', version: 1, payload: { nodeId, position } };
}

function seatInvalidated(seatId: NodeId): ConvergenceEvent {
  return { type: 'seat-invalidated', version: 1, payload: { seatId, reason: 'watched path changed' } };
}

const PROOF_ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const REVIEW_EVIDENCE = {
  inputHashes: { draft: 'sha256:draft' },
  workspaceFingerprint: 'sha256:workspace',
  proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
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
    source: 'file:examples/convergence',
    version: '1.0.0',
    digest: `sha256:${'d'.repeat(64)}` as const,
  };
  const laneNodes = definition.nodes.filter((node) => node.data.lane !== undefined);
  return {
    package: identity,
    admission: { package: identity, permissions: [] },
    executionLanes: laneNodes.map((node) => ({
      id: node.data.lane!.id,
      effective: node.data.lane!.requested,
      fallbacks: node.data.lane!.knownSubstitutions,
    })),
  };
}

const executorRoots: string[] = [];
let executorSequence = 0;

afterEach(async () => {
  await Promise.all(executorRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

async function storedConvergenceRun(
  definition: ConvergenceDefinition,
  typeVersion = convergence.version,
): Promise<{
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
  const graph = compileGraph({ ...convergence, version: typeVersion }, definition);
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
  input: Partial<Pick<
    GraphNodeBinding,
    'prompt' | 'resultContract' | 'runData' | 'parseResult' | 'decideAction'
  >>,
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
    decideAction: input.decideAction ?? (async () => ({ kind: 'allow' })),
  };
}

const reviewResultSchema = {
  type: 'object',
  required: [
    'verdict',
    'confidence',
    'inputHashes',
    'workspaceFingerprint',
    'proofArtifactDigest',
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
    provider: target.provider,
    modelFamily: target.modelFamily,
    model: target.model,
    executable: null,
    capabilities: [],
  };
  return {
    target,
    selection,
    engine: {
      name: 'mock',
      async run(request) {
        prompts.push(`${seatId}: ${request.prompt}`);
        if (response instanceof EngineError) throw response;
        return assistantResult({
          text: JSON.stringify(response),
          usage: reportedUsage({ inputTokens: 10, outputTokens: 5 }),
          requested: selection, effective: selection, stopReason: 'end_turn',
        });
      },
    },
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
  it('refuses a stored version-2 plan with STORED_GRAPH_MISMATCH before any node starts', async () => {
    const definition = panel();
    const run = await storedConvergenceRun(definition, 2);
    const dataCalls: string[] = [];
    const prompts: string[] = [];

    await expect(createGraphExecutor({
      ...run,
      graph: compileGraph(convergence, definition),
      nodes: Object.fromEntries(definition.nodes.map((node) => [node.id,
        executorNodeBinding(run.root, node.data.role === 'seat'
          ? { prompt: () => 'Review the draft.' }
          : { runData: async () => { dataCalls.push(node.id); return {}; } }),
      ])),
      engines: [
        reviewEngineBinding(definition, 'seat-a', PASS_ANTHROPIC, prompts),
        reviewEngineBinding(definition, 'seat-b', PASS_OPENAI, prompts),
      ],
    })).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'STORED_GRAPH_MISMATCH',
    });
    expect(dataCalls).toEqual([]);
    expect(prompts).toEqual([]);
    const eventTypes: string[] = [];
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) eventTypes.push(event.type);
    expect(eventTypes).toEqual(['graph:run-started']);
  });

  it('refuses a stored version-1 plan before executing the required proof-digest contract', async () => {
    const definition = panel();
    const run = await storedConvergenceRun(definition, 1);

    await expect(createGraphExecutor({
      ...run,
      graph: compileGraph(convergence, definition),
      nodes: {},
      engines: [
        reviewEngineBinding(definition, 'seat-a', PASS_ANTHROPIC, []),
        reviewEngineBinding(definition, 'seat-b', PASS_OPENAI, []),
      ],
    })).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'STORED_GRAPH_MISMATCH',
    });
    const eventTypes: string[] = [];
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) eventTypes.push(event.type);
    expect(eventTypes).toEqual(['graph:run-started']);
  });

  it('passes the graph type conformance kit', () => {
    const definition = panel();
    const receiptA = {
      nodeId: 'seat-a', position: 'review/1/seat-a/1', sequence: 1,
      requested: { adapter: 'mock', provider: 'anthropic', modelFamily: 'claude', model: 'mock-seat-a' },
      effective: { adapter: 'mock', provider: 'anthropic', modelFamily: 'claude', model: 'mock-seat-a' },
    } as const;
    const receiptB = {
      nodeId: 'seat-b', position: 'review/1/seat-b/1', sequence: 1,
      requested: { adapter: 'mock', provider: 'openai', modelFamily: 'gpt', model: 'mock-seat-b' },
      effective: { adapter: 'mock', provider: 'openai', modelFamily: 'gpt', model: 'mock-seat-b' },
    } as const;
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
        seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
        completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
        seatDispatched('seat-b', 1),
        seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
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
            engineAttempts: {}, writerProviders: [], writerModelFamilies: [],
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('pending'), evaluator: nodeState('pending'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: null, findingRounds: {}, pauseReason: null,
          },
          {
            engineAttempts: {}, writerProviders: [], writerModelFamilies: [],
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
            engineAttempts: {}, writerProviders: [], writerModelFamilies: [],
            phase: 'body', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('pending'),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: null, findingRounds: {}, pauseReason: null,
          },
          {
            engineAttempts: {}, writerProviders: [], writerModelFamilies: [],
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
            engineAttempts: {}, writerProviders: [], writerModelFamilies: [],
            phase: 'review', iteration: 1, restarts: 0,
            nodes: {
              generator: nodeState('passed', 1), evaluator: nodeState('passed', 1),
              'seat-a': nodeState('pending'), 'seat-b': nodeState('pending'), repair: nodeState('pending'),
            },
            seats: { 'seat-a': seatRecord(null), 'seat-b': seatRecord(null) },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
          },
          {
            engineAttempts: {}, writerProviders: [], writerModelFamilies: [],
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
            engineAttempts: { 'review/1/seat-a/1': receiptA }, writerProviders: [], writerModelFamilies: [],
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
            engineAttempts: { 'review/1/seat-a/1': receiptA }, writerProviders: [], writerModelFamilies: [],
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
                proofArtifactDigest: REVIEW_EVIDENCE.proofArtifactDigest,
                findings: [], stale: false,
              },
              'seat-b': seatRecord(null),
            },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
          },
          {
            engineAttempts: { 'review/1/seat-a/1': receiptA }, writerProviders: [], writerModelFamilies: [],
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
                proofArtifactDigest: REVIEW_EVIDENCE.proofArtifactDigest,
                findings: [], stale: false,
              },
              'seat-b': seatRecord(null),
            },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
          },
          {
            engineAttempts: { 'review/1/seat-a/1': receiptA, 'review/1/seat-b/1': receiptB }, writerProviders: [], writerModelFamilies: [],
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
                proofArtifactDigest: REVIEW_EVIDENCE.proofArtifactDigest,
                findings: [], stale: false,
              },
              'seat-b': seatRecord(null),
            },
            reviewEvidence: REVIEW_EVIDENCE, findingRounds: {}, pauseReason: null,
          },
          {
            engineAttempts: { 'review/1/seat-a/1': receiptA, 'review/1/seat-b/1': receiptB }, writerProviders: [], writerModelFamilies: [],
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
                proofArtifactDigest: REVIEW_EVIDENCE.proofArtifactDigest,
                findings: [], stale: false,
              },
              'seat-b': {
                outcome: 'valid', verdict: 'pass', confidence: 0.85,
                provider: 'openai', modelFamily: 'gpt',
                inputHashes: REVIEW_EVIDENCE.inputHashes,
                workspaceFingerprint: REVIEW_EVIDENCE.workspaceFingerprint,
                proofArtifactDigest: REVIEW_EVIDENCE.proofArtifactDigest,
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
          [{ kind: 'dispatch', nodeId: 'seat-a', input: { positionSummary: 'review/1, node seat-a, attempt 1', proofArtifactDigest: PROOF_ARTIFACT_DIGEST }, position: 'review/1/seat-a/1' }],
          [],
          [],
          [{ kind: 'dispatch', nodeId: 'seat-b', input: { positionSummary: 'review/1, node seat-b, attempt 1', proofArtifactDigest: PROOF_ARTIFACT_DIGEST }, position: 'review/1/seat-b/1' }],
          [],
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
    expect(description.graph.typeVersion).toBe(3);
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
        seatReceipt('seat-a', `review/1/seat-a/${round}`, 'mock', 'mock-family'),
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

  it('does not let seat results claim diversity absent from the reported identities', () => {
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude', 'mock-shared-review'),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'anthropic', 'claude', 'mock-shared-review'),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
    ];

    expect(decideAt(events, definition)).toEqual([{
      kind: 'fail',
      code: 'QUORUM_UNREACHABLE',
      message: 'Only 2 accepted passes; quorum is 2.',
    }]);
  });

  it('does not count an engine-seat pass without its reported identity receipt', () => {
    const definition = panel({ requireDiversity: false });
    const before = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
    ];
    const after = [
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
    ];
    expect(decideAt([...before, ...after], definition)).toEqual([
      expect.objectContaining({ kind: 'fail', code: 'QUORUM_UNREACHABLE' }),
    ]);
    expect(decideAt([
      ...before,
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      ...after,
    ], definition)).toEqual([expect.objectContaining({ kind: 'complete' })]);
  });

  it('rejects a review seat on either writer lane and accepts a separate lane', () => {
    for (const writerId of ['generator', 'repair'] as const) {
      const base = panel();
      const sharedLane = reviewLane('writer-and-review');
      expectIssue({
        ...base,
        nodes: base.nodes.map((node) => node.id === writerId
          ? { ...node, data: { ...node.data, lane: sharedLane } }
          : node.id === 'seat-a'
            ? { ...node, data: { ...node.data, lane: sharedLane } }
            : node),
      }, 'SELF_REVIEW_LANE');
    }

    const separate = panel();
    expect(() => compileGraph(convergence, {
      ...separate,
      nodes: separate.nodes.map((node) => node.id === 'generator'
        ? { ...node, data: { ...node.data, lane: reviewLane('writer') } }
        : node),
    })).not.toThrow();
  });

  it.each(
    (['generator', 'repair'] as const).flatMap((writerRole) =>
      (['requested', 'substitution'] as const).flatMap((writerCandidate) =>
        (['requested', 'substitution'] as const).flatMap((reviewerCandidate) =>
          (['provider', 'modelFamily'] as const).map((field) => ({
            writerRole, writerCandidate, reviewerCandidate, field,
          }))))),
  )('rejects $writerRole $writerCandidate sharing $field with reviewer $reviewerCandidate', ({
    writerRole, writerCandidate, reviewerCandidate, field,
  }) => {
    const writerTarget = {
      ...reviewLane('writer', 'writer-provider', 'writer-family').requested,
      adapter: 'writer-adapter',
    };
    const reviewerTarget = {
      ...reviewLane('reviewer', 'reviewer-provider', 'reviewer-family').requested,
      adapter: 'reviewer-adapter',
      [field]: writerTarget[field],
    };
    const safeWriter = reviewLane('writer-safe', 'writer-safe-provider', 'writer-safe-family').requested;
    const safeReviewer = reviewLane('reviewer-safe', 'reviewer-safe-provider', 'reviewer-safe-family').requested;
    const writerLane = {
      id: 'writer-lane',
      requested: writerCandidate === 'requested' ? writerTarget : safeWriter,
      knownSubstitutions: writerCandidate === 'substitution'
        ? [safeWriter, writerTarget] : [safeWriter],
    };
    const reviewerLane = {
      id: 'reviewer-lane',
      requested: reviewerCandidate === 'requested' ? reviewerTarget : safeReviewer,
      knownSubstitutions: reviewerCandidate === 'substitution'
        ? [safeReviewer, reviewerTarget] : [safeReviewer],
    };
    const base = panel({ requireDiversity: false, skippableSeats: ['seat-a'] });
    const definition: ConvergenceDefinition = {
      ...base,
      nodes: base.nodes.map((node) => node.data.role === writerRole
        ? { ...node, data: { ...node.data, lane: writerLane } }
        : node.id === 'seat-a'
          ? { ...node, data: { ...node.data, lane: reviewerLane } }
          : node),
    };

    let caught: unknown;
    try {
      compileGraph(convergence, definition);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphValidationError);
    const conflict = (caught as GraphValidationError).issues.find((item) =>
      item.code === 'SELF_REVIEW_LANE' && item.path === '/nodes/seat-a/data/lane');
    expect(conflict).toBeDefined();
    expect(conflict!.message).toContain(writerRole);
    expect(conflict!.message).toContain('seat-a');
    expect(conflict!.message).toContain(field);
    expect(conflict!.message).toContain(writerTarget[field]);
  });

  it('accepts disjoint writer and reviewer targets while reviewers share an identity without diversity', () => {
    const writerLane = {
      ...reviewLane('writer', 'writer-provider', 'writer-family'),
      knownSubstitutions: [reviewLane('writer-substitute', 'writer-sub-provider', 'writer-sub-family').requested],
    };
    const reviewerLane = {
      ...reviewLane('reviewer', 'reviewer-provider', 'reviewer-family'),
      knownSubstitutions: [reviewLane('reviewer-substitute', 'reviewer-sub-provider', 'reviewer-sub-family').requested],
    };
    const base = panel({ requireDiversity: false });
    const definition: ConvergenceDefinition = {
      ...base,
      nodes: base.nodes.map((node) => node.data.role === 'generator' || node.data.role === 'repair'
        ? { ...node, data: { ...node.data, lane: writerLane } }
        : node.data.role === 'seat'
          ? { ...node, data: { ...node.data, lane: { ...reviewerLane, id: node.id } } }
          : node),
    };
    const events: ConvergenceEvent[] = [
      convDispatched('generator', 1),
      { type: 'engine-attempt-recorded', version: 1, payload: {
        nodeId: 'generator', position: 'convergence/1/generator/1', sequence: 1,
        requested: targetIdentity(writerLane.requested), effective: targetIdentity(writerLane.requested),
      } },
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      seatReceipt('seat-a', 'review/1/seat-a/1', 'reviewer-provider', 'reviewer-family', 'mock-reviewer'),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'reviewer-provider', 'reviewer-family', 'mock-reviewer'),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
    ];

    expect(decideAt(events, definition)).toMatchObject([{ kind: 'complete' }]);
  });

  it('records premature scripted engine receipts without accepting their identity', () => {
    const compiled = compileGraph(convergence, panel());
    const before = compiled.initialState();
    const receipt = seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude');
    const rejected = compiled.reduce(before, receipt);

    expect(rejected).toEqual({
      ...before,
      engineReceiptRejections: [{
        code: 'INVALID_ENGINE_RECEIPT',
        nodeId: 'seat-a',
        position: 'review/1/seat-a/1',
        sequence: 1,
        reason: 'not-in-flight',
      }],
    });
    expect(compiled.decide(rejected)).toEqual(compiled.decide(before));
    expect(fold([receipt])).toEqual(rejected);
  });

  it.each([
    ['unsupported-version', 2, 'seat-a', 'review/1/seat-a/1'],
    ['no-engine-lane', 1, 'generator', 'convergence/1/generator/1'],
    ['position-mismatch', 1, 'seat-a', 'review/2/seat-a/1'],
  ] as const)('records a scripted receipt rejected for %s', (reason, version, nodeId, position) => {
    const compiled = compileGraph(convergence, panel());
    const before = fold([seatDispatched('seat-a', 1)]);
    const receipt = { ...seatReceipt(nodeId, position, 'anthropic', 'claude'), version };

    expect(compiled.reduce(before, receipt)).toEqual({
      ...before,
      engineReceiptRejections: [{
        code: 'INVALID_ENGINE_RECEIPT', nodeId, position, sequence: 1, reason,
      }],
    });
  });

  it('records skipped receipt sequences and still accepts the next consecutive receipt', () => {
    const compiled = compileGraph(convergence, panel());
    const receipt = seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude');
    const before = fold([seatDispatched('seat-a', 1), receipt]);
    const skipped = {
      ...receipt,
      payload: { ...receipt.payload, sequence: 3 },
    } as ConvergenceEvent;
    const rejected = compiled.reduce(before, skipped);

    expect(rejected).toEqual({
      ...before,
      engineReceiptRejections: [{
        code: 'INVALID_ENGINE_RECEIPT',
        nodeId: 'seat-a',
        position: 'review/1/seat-a/1',
        sequence: 3,
        reason: 'sequence-mismatch',
      }],
    });
    expect(compiled.reduce(rejected, skipped).engineReceiptRejections).toEqual([
      ...rejected.engineReceiptRejections!,
      ...rejected.engineReceiptRejections!,
    ]);
    const next = {
      ...receipt,
      payload: { ...receipt.payload, sequence: 2 },
    } as ConvergenceEvent;
    expect(compiled.reduce(rejected, next)).toEqual({
      ...rejected,
      engineAttempts: { 'review/1/seat-a/1': next.payload },
    });
  });

  it('keeps data-only writers and reviewers without inventing engine identity', () => {
    const base = panel({ requireDiversity: false });
    const definition: ConvergenceDefinition = {
      ...base,
      nodes: base.nodes.map((node) => ({ ...node, data: { role: node.data.role } })),
    };
    const graph = compileGraph(convergence, definition);
    expect(graph.describe().executionLanes).toEqual([]);
    expect(graph.describe().nodes.every((node) => node.laneId === null)).toBe(true);
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
    const state = fold(events, definition);
    expect(state.seats['seat-a']).toMatchObject({ provider: null, modelFamily: null });
    expect(state.seats['seat-b']).toMatchObject({ provider: null, modelFamily: null });
    expect(graph.decide(state)).toMatchObject([{ kind: 'complete' }]);
    expect(decideAt(events, {
      ...definition,
      data: { ...definition.data, requireDiversity: true },
    })).toMatchObject([{ kind: 'fail', code: 'QUORUM_UNREACHABLE' }]);
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
      seatReceipt('seat-claude', 'review/1/seat-claude/1', 'anthropic', 'claude', 'claude-test'),
      completed('seat-claude', 'review/1/seat-claude/1', PASS_ANTHROPIC),
      seatDispatched('seat-codex', 1),
      seatReceipt('seat-codex', 'review/1/seat-codex/1', 'openai', 'gpt', 'gpt-test'),
      completed('seat-codex', 'review/1/seat-codex/1', {
        verdict: 'findings', confidence: 0.7, provider: 'openai', modelFamily: 'gpt',
        findings: [finding],
        ...REVIEW_EVIDENCE,
      }),
      seatDispatched('seat-grok', 1),
      seatReceipt('seat-grok', 'review/1/seat-grok/1', 'xai', 'grok', 'grok-test'),
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
      input: {
        positionSummary: 'review/2, node seat-codex, attempt 2',
        proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
      },
      position: 'review/2/seat-codex/2',
    }]);
    const positions = reruns
      .filter((command): command is Extract<GraphCommand, { kind: 'dispatch' }> => command.kind === 'dispatch')
      .map((command) => command.position);
    expect(positions).not.toContain('review/2/seat-claude/2');

    const verdict = decideAt([
      ...backToReview,
      seatDispatched('seat-codex', 2, 2),
      seatReceipt('seat-codex', 'review/2/seat-codex/2', 'openai', 'gpt', 'gpt-test'),
      completed('seat-codex', 'review/2/seat-codex/2', PASS_OPENAI),
      seatDispatched('seat-grok', 2, 2),
      seatReceipt('seat-grok', 'review/2/seat-grok/2', 'xai', 'grok', 'grok-test'),
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      failedNode('seat-b', 'review/1/seat-b/1', 'auth'),
    ];
    const retry = decideAt(events, panel({ retryCapPerNode: 1 }));
    expect(retry).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-b',
      input: {
        positionSummary: 'review/1, node seat-b, attempt 2',
        proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
      },
      position: 'review/1/seat-b/2',
    }]);

    const state = fold(events, panel({ retryCapPerNode: 1 }));
    expect(state.seats['seat-b']!.outcome).toBe('non-verdict');
    expect(state.restarts).toBe(0);

    const verdict = decideAt([
      ...events,
      seatDispatched('seat-b', 1, 2),
      seatReceipt('seat-b', 'review/1/seat-b/2', 'openai', 'gpt'),
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
      seatDispatched('seat-c', 1),
      seatReceipt('seat-c', 'review/1/seat-c/1', 'openai', 'gpt'),
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
      completed('seat-b', 'review/1/seat-b/1', PASS_OPENAI),
      seatDispatched('seat-c', 1),
      seatReceipt('seat-c', 'review/1/seat-c/1', 'xai', 'grok'),
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'p1', 'f1'),
      completed('seat-a', 'review/1/seat-a/1', pass('p1', 'f1')),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'p2', 'f1'),
      completed('seat-b', 'review/1/seat-b/1', pass('p2', 'f1')),
      seatDispatched('seat-c', 1),
      seatReceipt('seat-c', 'review/1/seat-c/1', 'p3', 'f2'),
      completed('seat-c', 'review/1/seat-c/1', pass('p3', 'f2')),
      seatDispatched('seat-d', 1),
      seatReceipt('seat-d', 'review/1/seat-d/1', 'p3', 'f3'),
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
          seatReceipt('seat-a', `review/${round}/seat-a/1`, 'anthropic', 'claude'),
          completed('seat-a', `review/${round}/seat-a/1`, PASS_ANTHROPIC),
        );
      }
      events.push(
        seatDispatched('seat-b', round, round),
        seatReceipt('seat-b', `review/${round}/seat-b/${round}`, 'openai', 'gpt'),
        completed('seat-b', `review/${round}/seat-b/${round}`, {
          verdict: 'findings', confidence: 0.7, provider: 'openai', modelFamily: 'gpt',
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', PASS_ANTHROPIC),
      seatInvalidated('seat-a'),
    ];
    const commands = decideAt(events);
    expect(commands).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-a',
      input: {
        positionSummary: 'review/1, node seat-a, attempt 2',
        proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
      },
      position: 'review/1/seat-a/2',
    }]);
  });

  it('reruns an accepted seat when the recorded review bytes change', () => {
    const evidenceA = {
      inputHashes: { draft: 'sha256:draft-a' },
      workspaceFingerprint: 'sha256:workspace-a',
      proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
    };
    const evidenceB = {
      inputHashes: { draft: 'sha256:draft-b' },
      workspaceFingerprint: 'sha256:workspace-b',
      proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
    };
    const finding = { id: 'f1', kind: 'patch' as const, evidence: 'fix the draft' };
    const events: ConvergenceEvent[] = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...evidenceA }),
      seatDispatched('seat-a', 1),
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', { ...PASS_ANTHROPIC, ...evidenceA }),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
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
      input: {
        positionSummary: 'review/2, node seat-a, attempt 2',
        proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
      },
      position: 'review/2/seat-a/2',
    }]);
  });

  it.each([
    ['missing', {}],
    ['malformed', { proofArtifactDigest: 'sha256:invalid' }],
    ['different', { proofArtifactDigest: `sha256:${'b'.repeat(64)}` }],
  ] as const)('excludes findings with a %s proof digest from state and repair input', (_label, proof) => {
    const invalidFinding = { id: 'untrusted', kind: 'patch' as const, evidence: 'wrong proof' };
    const validFinding = { id: 'trusted', kind: 'patch' as const, evidence: 'current proof' };
    const events = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...REVIEW_EVIDENCE }),
      seatDispatched('seat-a', 1),
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', {
        verdict: 'findings', confidence: 0.8, findings: [invalidFinding],
        inputHashes: REVIEW_EVIDENCE.inputHashes,
        workspaceFingerprint: REVIEW_EVIDENCE.workspaceFingerprint,
        ...proof,
      }),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
      completed('seat-b', 'review/1/seat-b/1', {
        verdict: 'findings', confidence: 0.8, findings: [validFinding], ...REVIEW_EVIDENCE,
      }),
    ];

    const state = fold(events);
    expect(state.findingRounds).toEqual({ trusted: 1 });
    expect(state.seats['seat-a']!.findings).toEqual([]);
    expect(decideAt(events)).toEqual([{
      kind: 'dispatch',
      nodeId: 'repair',
      input: { positionSummary: 'repair round 1', findings: [validFinding] },
      position: 'convergence/repair/1/1',
    }]);
  });

  it('a seat result whose echoed digest does not match its dispatch is refused and the gate returns to wait', () => {
    const proofArtifactDigest = `sha256:${'a'.repeat(64)}`;
    const evidence = { ...REVIEW_EVIDENCE, proofArtifactDigest };
    const events: ConvergenceEvent[] = [
      convDispatched('generator', 1),
      completed('generator', 'convergence/1/generator/1', {}),
      convDispatched('evaluator', 1),
      completed('evaluator', 'convergence/1/evaluator/1', { gateMet: true, ...evidence }),
    ];

    expect(decideAt(events, panel({ quorum: 1, retryCapPerNode: 1 }))).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-a',
      input: {
        positionSummary: 'review/1, node seat-a, attempt 1',
        proofArtifactDigest,
      },
      position: 'review/1/seat-a/1',
    }]);

    const mismatched = [
      ...events,
      seatDispatched('seat-a', 1),
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', {
        ...PASS_ANTHROPIC,
        proofArtifactDigest: `sha256:${'b'.repeat(64)}`,
      }),
    ];
    const state = fold(mismatched, panel({ quorum: 1, retryCapPerNode: 1 }));

    expect(state.seats['seat-a']!.outcome).toBe('invalid');
    expect(decideAt(mismatched, panel({ quorum: 1, retryCapPerNode: 1 }))).toEqual([{
      kind: 'dispatch',
      nodeId: 'seat-a',
      input: {
        positionSummary: 'review/1, node seat-a, attempt 2',
        proofArtifactDigest,
      },
      position: 'review/1/seat-a/2',
    }]);
  });

  it('keeps a pass when only another seat watched the changed input', () => {
    const evidenceA = {
      inputHashes: { draft: 'sha256:draft-a', tests: 'sha256:tests-a' },
      workspaceFingerprint: 'sha256:workspace-a',
      proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
    };
    const evidenceB = {
      inputHashes: { draft: 'sha256:draft-b', tests: 'sha256:tests-a' },
      workspaceFingerprint: 'sha256:workspace-b',
      proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', { ...PASS_ANTHROPIC, ...evidenceA }),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
      completed('seat-b', 'review/1/seat-b/1', { ...PASS_OPENAI, ...evidenceA }),
      seatDispatched('seat-c', 1),
      seatReceipt('seat-c', 'review/1/seat-c/1', 'xai', 'grok'),
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

    state = compiled.reduce(state, seatReceipt('seat-a', 'review/1/seat-a/2', 'anthropic', 'claude'));

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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/1', {
        verdict: 'findings', confidence: 0.8, provider: 'anthropic', modelFamily: 'claude',
        findings: [finding],
        ...REVIEW_EVIDENCE,
      }),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
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
    expect(compiled.reduce(
      state,
      resumedNode('generator', 'convergence/2/generator/1'),
    )).toEqual(state);
    expect(compiled.reduce(
      state,
      resumedNode('generator', 'convergence/1/generator/1'),
    ).nodes.generator!.status).toBe('in-flight');
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
    state = compiled.reduce(state, seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'));
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
      input: {
        positionSummary: 'review/1, node seat-a, attempt 2',
        proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
      },
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
      seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude'),
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
      input: {
        positionSummary: 'review/1, node seat-a, attempt 2',
        proofArtifactDigest: PROOF_ARTIFACT_DIGEST,
      },
      position: 'review/1/seat-a/2',
    }]);

    const exhausted = [
      ...events,
      seatDispatched('seat-a', 1, 2),
      seatReceipt('seat-a', 'review/1/seat-a/2', 'anthropic', 'claude'),
      completed('seat-a', 'review/1/seat-a/2', {
        verdict: 'pass', provider: 'anthropic', modelFamily: 'claude',
        ...REVIEW_EVIDENCE,
      }),
      seatDispatched('seat-b', 1),
      seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt'),
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

  it('resumes a paused convergence node at its exact position after restart', async () => {
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
    const bindings = (generator: GraphNodeBinding): Readonly<Record<string, GraphNodeBinding>> => ({
      generator,
      evaluator: executorNodeBinding(run.root, {
        runData: async () => ({ gateMet: true, ...REVIEW_EVIDENCE }),
      }),
      'seat-a': executorNodeBinding(run.root, {
        prompt: () => 'Review as seat A.',
        resultContract: reviewResultContract,
        parseResult: parseReviewResult,
      }),
      'seat-b': executorNodeBinding(run.root, {
        prompt: () => 'Review as seat B.',
        resultContract: reviewResultContract,
        parseResult: parseReviewResult,
      }),
      repair: executorNodeBinding(run.root, {
        runData: async () => ({ repaired: true }),
      }),
    });
    const engines = () => [
      reviewEngineBinding(definition, 'seat-a', PASS_ANTHROPIC, []),
      reviewEngineBinding(definition, 'seat-b', PASS_OPENAI, []),
    ];
    const first = await createGraphExecutor({
      ...run,
      nodes: bindings(executorNodeBinding(run.root, {
        runData: async () => ({ draft: 'ready' }),
        decideAction: async () => ({
          kind: 'wait',
          reason: 'waiting for source',
          request: { action: 'supply-source' },
        }),
      })),
      engines: engines(),
    });
    await expect(first.run(new AbortController().signal)).resolves.toEqual({
      kind: 'pause',
      reason: 'Node "generator" is paused; the run waits.',
    });

    let calls = 0;
    const fresh = await createGraphExecutor({
      ...run,
      nodes: bindings(executorNodeBinding(run.root, {
        runData: async () => {
          calls += 1;
          return { draft: 'ready' };
        },
      })),
      engines: engines(),
    });
    await expect(fresh.resume(
      'convergence/1/generator/1',
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: 'complete' });
    expect(calls).toBe(1);

    let dispatches = 0;
    const resumedPayloads: JsonValue[] = [];
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) {
      if (
        event.type === 'graph:node-dispatched'
        && (event.payload as JsonObject).nodeId === 'generator'
      ) dispatches += 1;
      if (event.type === 'graph:node-resumed') resumedPayloads.push(event.payload);
    }
    expect(dispatches).toBe(1);
    expect(resumedPayloads).toContainEqual({
      nodeId: 'generator',
      position: 'convergence/1/generator/1',
    });
  });

  it.each([
    ['missing', {}],
    ['malformed', { proofArtifactDigest: 'sha256:invalid' }],
  ] as const)('returns a typed terminal without redispatch when evaluator proof is %s', async (_label, proof) => {
    const definition = panel();
    const run = await storedConvergenceRun(definition);
    const calls: string[] = [];
    const options = {
      ...run,
      nodes: {
        generator: executorNodeBinding(run.root, {
          runData: async () => {
            calls.push('generator');
            return { draft: 'ready' };
          },
        }),
        evaluator: executorNodeBinding(run.root, {
          runData: async () => {
            calls.push('evaluator');
            return {
              gateMet: true,
              inputHashes: REVIEW_EVIDENCE.inputHashes,
              workspaceFingerprint: REVIEW_EVIDENCE.workspaceFingerprint,
              ...proof,
            };
          },
        }),
      },
      engines: [
        reviewEngineBinding(definition, 'seat-a', PASS_ANTHROPIC, []),
        reviewEngineBinding(definition, 'seat-b', PASS_OPENAI, []),
      ],
    };
    const terminal = {
      kind: 'fail',
      code: 'CONVERGENCE_REVIEW_EVIDENCE_INVALID',
      message: 'The evaluator completed without valid review evidence.',
    };

    const executor = await createGraphExecutor(options);
    await expect(executor.run(new AbortController().signal)).resolves.toEqual(terminal);
    const reopened = await createGraphExecutor(options);
    await expect(reopened.run(new AbortController().signal)).resolves.toEqual(terminal);
    expect(calls).toEqual(['generator', 'evaluator']);
    const dispatched: JsonValue[] = [];
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) {
      if (event.type === 'graph:node-dispatched') dispatched.push(event.payload);
    }
    expect(dispatched).toEqual([
      { nodeId: 'generator', position: 'convergence/1/generator/1' },
      { nodeId: 'evaluator', position: 'convergence/1/evaluator/1' },
    ]);
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

    const receipts = graphEvents.filter((event) => event.type === 'graph:engine-attempt-recorded');
    expect(receipts.map((event) => ({ version: event.version, payload: event.payload })))
      .toEqual(expect.arrayContaining([
        { version: 1, payload: seatReceipt('seat-a', 'review/1/seat-a/1', 'anthropic', 'claude').payload },
        { version: 1, payload: seatReceipt('seat-b', 'review/1/seat-b/1', 'openai', 'gpt').payload },
      ]));
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      const nodeId = (receipt.payload as JsonObject).nodeId;
      const completion = graphEvents.findIndex((event) => event.type === 'graph:node-completed'
        && (event.payload as JsonObject).nodeId === nodeId);
      expect(graphEvents.indexOf(receipt)).toBeLessThan(completion);
    }
    const graphEventTypes = graphEvents.filter((event) => event.type !== 'graph:engine-attempt-recorded')
      .map((event) => event.type);
    expect(graphEventTypes).toEqual([
      'graph:run-started',
      'graph:node-dispatched',
      'graph:node-attempt-started',
      'graph:node-completed',
      'graph:node-dispatched',
      'graph:node-attempt-started',
      'graph:node-completed',
      'graph:node-dispatched',
      'graph:node-dispatched',
      'graph:node-attempt-started',
      'graph:node-attempt-started',
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

type ReportedIdentity = Pick<EngineSelectionRecord, 'adapter' | 'provider' | 'modelFamily' | 'model'>;
type EngineReply = JsonObject | EngineError | (() => JsonObject | EngineError);

function enginePanel(overrides: Partial<ConvergenceDefinition['data']> = {}): ConvergenceDefinition {
  const definition = panel({ maxIterations: 1, maxReviewRestarts: 0, ...overrides });
  return {
    ...definition,
    nodes: definition.nodes.map((node) => node.data.role === 'generator' || node.data.role === 'repair'
      ? { ...node, data: { ...node.data, lane: reviewLane(node.id, `${node.id}-provider`, `${node.id}-family`) } }
      : node),
  };
}

function withSubstitution(definition: ConvergenceDefinition, nodeId: string): ConvergenceDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => node.id !== nodeId ? node : {
      ...node,
      data: { ...node.data, lane: {
        ...node.data.lane!,
        knownSubstitutions: [reviewLane(`${nodeId}-fallback`, `${nodeId}-fallback-provider`, `${nodeId}-fallback-family`).requested],
      } },
    }),
  };
}

function targetIdentity(target: ExecutionTarget): ReportedIdentity {
  return { adapter: target.adapter, provider: target.provider, modelFamily: target.modelFamily, model: target.model };
}

async function reportedPanelRun(
  definition: ConvergenceDefinition,
  reported: Readonly<Record<string, Partial<ReportedIdentity>>> = {},
  replies: Readonly<Record<string, EngineReply>> = {},
) {
  const run = await storedConvergenceRun(definition);
  const calls: string[] = [];
  const engines: GraphEngineBinding[] = [];
  const nodes: Record<string, GraphNodeBinding> = {};
  for (const node of definition.nodes) {
    if (node.data.lane === undefined) {
      nodes[node.id] = executorNodeBinding(run.root, {
        runData: async () => ({ gateMet: true, ...REVIEW_EVIDENCE }),
      });
      continue;
    }
    nodes[node.id] = executorNodeBinding(run.root, { prompt: () => `Run ${node.id}.` });
    for (const target of [node.data.lane.requested, ...node.data.lane.knownSubstitutions]) {
      const requested = engineSelection({ ...targetIdentity(target), capabilities: target.tools });
      const effective = engineSelection({ ...requested, ...reported[target.model] });
      engines.push({
        target, selection: requested, hardTokenLimitEnforceable: false,
        engine: {
          name: 'reported-identity-fixture',
          async run() {
            calls.push(target.model);
            const scripted = replies[target.model];
            const reply = typeof scripted === 'function' ? scripted() : scripted;
            if (reply instanceof EngineError) throw reply;
            return {
              requested, effective,
              usage: { kind: 'reported', inputTokens: 1, outputTokens: 1 },
              parts: [{ kind: 'structured', final: true, value: reply ?? (node.data.role === 'seat'
                ? { verdict: 'pass', confidence: 0.95, findings: [], ...REVIEW_EVIDENCE }
                : { draft: 'ready' }) }],
            };
          },
        },
      });
    }
  }
  const options = { ...run, nodes, engines };
  const outcome = await (await createGraphExecutor(options)).run(new AbortController().signal);
  const readEvents = async (storage = run.storage): Promise<DomainEventEnvelope[]> => {
    const result: DomainEventEnvelope[] = [];
    for await (const event of storage.eventStore.read({ namespace: storage.record.namespace, streamId: run.runId })) result.push(event);
    return result;
  };
  const events = await readEvents();
  const receipts = (nodeId: string) => events.filter((event) => event.type === 'graph:engine-attempt-recorded'
    && (event.payload as JsonObject).nodeId === nodeId).map((event) => ({ version: event.version, ...event.payload as JsonObject }));
  const expectReplay = async () => {
    const previousCalls = [...calls];
    const storage = createLocalRunStorage({
      directory: join(run.root, 'storage'), namespace: run.storage.record.namespace, policy: run.storage.record.policy,
    });
    const reopened = await createGraphExecutor({ ...options, graph: compileGraph(convergence, definition), storage });
    await expect(reopened.run(new AbortController().signal)).resolves.toEqual(outcome);
    expect(calls).toEqual(previousCalls);
    expect(await readEvents(storage)).toEqual(events);
  };
  return { outcome, calls, events, receipts, expectReplay };
}

describe('convergence quorum from reported engine identities', () => {
  it.each(['provider', 'modelFamily'] as const)('excludes an actual reviewer %s shared with the writer when diversity is disabled', async (dimension) => {
    const run = await reportedPanelRun(enginePanel({ requireDiversity: false }), {
      'mock-generator': { provider: 'actual-writer', modelFamily: 'actual-writer-family' },
      'mock-seat-a': { [dimension]: dimension === 'provider' ? 'actual-writer' : 'actual-writer-family' },
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.calls).toEqual(['mock-generator', 'mock-seat-a', 'mock-seat-b']);
    expect(run.receipts('seat-a')).toEqual([expect.objectContaining({
      version: 1, sequence: 1, effective: expect.objectContaining({
        [dimension]: dimension === 'provider' ? 'actual-writer' : 'actual-writer-family',
      }),
    })]);
    await run.expectReplay();
  });

  it('records both reviewer calls and excludes a fallback reporting the writer provider', async () => {
    const definition = withSubstitution(enginePanel({ requireDiversity: false }), 'seat-a');
    const run = await reportedPanelRun(definition, {
      'mock-seat-a-fallback': { provider: 'generator-provider' },
    }, {
      'mock-seat-a': new EngineError({ kind: 'model-unavailable', message: 'primary is unavailable' }),
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.calls).toEqual(['mock-generator', 'mock-seat-a', 'mock-seat-a-fallback', 'mock-seat-b']);
    expect(run.receipts('seat-a')).toEqual([
      expect.objectContaining({ version: 1, sequence: 1, effective: null }),
      expect.objectContaining({ version: 1, sequence: 2, effective: expect.objectContaining({ provider: 'generator-provider' }) }),
    ]);
    await run.expectReplay();
  });

  it('excludes a reviewer when the actual writer reports that reviewer provider', async () => {
    const run = await reportedPanelRun(enginePanel({ requireDiversity: false }), {
      'mock-generator': { provider: 'anthropic' },
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.receipts('generator')).toEqual([expect.objectContaining({
      requested: expect.objectContaining({ provider: 'generator-provider' }),
      effective: expect.objectContaining({ provider: 'anthropic' }),
    })]);
    await run.expectReplay();
  });

  it.each([true, false])('uses actual reviewer diversity when requireDiversity is %s', async (requireDiversity) => {
    const sameReviewer = { provider: 'actual-reviewer', modelFamily: 'actual-reviewer-family' };
    const run = await reportedPanelRun(enginePanel({ requireDiversity }), {
      'mock-seat-a': sameReviewer, 'mock-seat-b': sameReviewer,
    });
    expect(run.outcome).toMatchObject(requireDiversity
      ? { kind: 'fail', code: 'QUORUM_UNREACHABLE' }
      : { kind: 'complete', output: { seats: { 'seat-a': 'accepted', 'seat-b': 'accepted' } } });
    expect(run.receipts('seat-a')).toEqual([expect.objectContaining({ effective: expect.objectContaining(sameReviewer) })]);
    expect(run.receipts('seat-b')).toEqual([expect.objectContaining({ effective: expect.objectContaining(sameReviewer) })]);
    await run.expectReplay();
  });

  it.each([
    ['unknown', { provider: null, modelFamily: null, model: null }],
    ['provider missing', { provider: null }],
    ['family missing', { modelFamily: null }],
  ] as const)('does not let verdict JSON replace a reported reviewer identity with %s', async (_label, effective) => {
    const run = await reportedPanelRun(enginePanel({ requireDiversity: false }), {
      'mock-seat-a': effective,
    }, {
      'mock-seat-a': { ...PASS_ANTHROPIC, provider: 'forged-provider', modelFamily: 'forged-family' },
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.receipts('seat-a')).toEqual([expect.objectContaining({ effective: expect.objectContaining(effective) })]);
    expect(run.events.filter((event) => event.type === 'graph:node-completed'
      && (event.payload as JsonObject).nodeId === 'seat-a').map((event) => event.payload)).toEqual([
      expect.objectContaining({ result: expect.objectContaining({ provider: 'forged-provider', modelFamily: 'forged-family' }) }),
    ]);
    await run.expectReplay();
  });

  it.each(['primary', 'substitution'] as const)('keeps the declared %s of an unreported writer call in the exclusion set after fallback succeeds', async (which) => {
    const definition = withSubstitution(enginePanel({ requireDiversity: false }), 'generator');
    const provider = which === 'primary' ? 'generator-provider' : 'generator-fallback-provider';
    const run = await reportedPanelRun(definition, {
      'mock-generator-fallback': { provider: 'reported-writer', modelFamily: 'reported-writer-family' },
      'mock-seat-a': { provider },
    }, {
      'mock-generator': new EngineError({ kind: 'model-unavailable', message: 'no reported primary identity' }),
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.calls).toEqual(['mock-generator', 'mock-generator-fallback', 'mock-seat-a', 'mock-seat-b']);
    expect(run.receipts('generator')).toEqual([
      expect.objectContaining({ version: 1, sequence: 1, effective: null }),
      expect.objectContaining({ version: 1, sequence: 2, effective: expect.objectContaining({ provider: 'reported-writer' }) }),
    ]);
    await run.expectReplay();
  });

  it('excludes a cached accepted reviewer after a repair reports that reviewer provider without changing proof bytes', async () => {
    let seatBCalls = 0;
    const run = await reportedPanelRun(enginePanel({ maxIterations: 2, maxReviewRestarts: 1 }), {
      'mock-repair': { provider: 'anthropic' },
    }, {
      'mock-seat-b': () => ++seatBCalls === 1
        ? { verdict: 'findings', confidence: 0.95, ...REVIEW_EVIDENCE, findings: [{ id: 'repair-one', kind: 'patch', evidence: 'fix one item' }] }
        : { ...PASS_OPENAI, findings: [] },
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.calls).toEqual(['mock-generator', 'mock-seat-a', 'mock-seat-b', 'mock-repair', 'mock-generator', 'mock-seat-b']);
    expect(run.calls.filter((model) => model === 'mock-seat-a')).toHaveLength(1);
    expect(run.receipts('repair')).toEqual([expect.objectContaining({
      effective: expect.objectContaining({ provider: 'anthropic' }),
    })]);
    const evidence = run.events.filter((event) => event.type === 'graph:node-completed'
      && (event.payload as JsonObject).nodeId === 'evaluator').map((event) => (event.payload as JsonObject).result);
    expect(evidence).toEqual([
      { gateMet: true, ...REVIEW_EVIDENCE }, { gateMet: true, ...REVIEW_EVIDENCE },
    ]);
    await run.expectReplay();
  });

  it('completes through two other reviewers but labels the conflicting third reviewer invalid', async () => {
    const base = enginePanel({ quorum: 2 });
    const definition: ConvergenceDefinition = {
      ...base,
      nodes: [...base.nodes, { id: 'seat-c', data: { role: 'seat', lane: reviewLane('seat-c', 'xai', 'grok') } }],
    };
    const run = await reportedPanelRun(definition, { 'mock-seat-a': { provider: 'generator-provider' } });
    expect(run.outcome).toMatchObject({
      kind: 'complete', output: { seats: { 'seat-a': 'invalid', 'seat-b': 'accepted', 'seat-c': 'accepted' } },
    });
    expect(run.calls).toEqual(['mock-generator', 'mock-seat-a', 'mock-seat-b', 'mock-seat-c']);
    expect(run.receipts('seat-a')).toEqual([expect.objectContaining({ effective: expect.objectContaining({ provider: 'generator-provider' }) })]);
    await run.expectReplay();
  });

  it.each([
    ['reported provider', { provider: 'actual-writer', modelFamily: null }, { provider: 'actual-writer' }],
    ['unreported family', { provider: 'actual-writer', modelFamily: null }, { modelFamily: 'generator-fallback-family' }],
    ['reported family', { provider: null, modelFamily: 'actual-family' }, { modelFamily: 'actual-family' }],
    ['unreported provider', { provider: null, modelFamily: 'actual-family' }, { provider: 'generator-fallback-provider' }],
  ] as const)('preserves exclusion for a writer with partial identity: %s', async (_label, writer, reviewer) => {
    const run = await reportedPanelRun(withSubstitution(enginePanel({ requireDiversity: false }), 'generator'), {
      'mock-generator': writer,
      'mock-seat-a': reviewer,
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.receipts('generator')).toEqual([expect.objectContaining({
      effective: expect.objectContaining(writer),
    })]);
    await run.expectReplay();
  });

  it('keeps a failed writer call reported identity after a different fallback completes', async () => {
    const failedIdentity = engineSelection({
      adapter: 'mock', provider: 'failed-writer', modelFamily: 'failed-writer-family', model: 'failed-model',
    });
    const run = await reportedPanelRun(withSubstitution(enginePanel({ requireDiversity: false }), 'generator'), {
      'mock-seat-a': { provider: 'failed-writer' },
    }, {
      'mock-generator': new EngineError({
        kind: 'model-unavailable', message: 'failed after identifying itself', effective: failedIdentity,
      }),
    });
    expect(run.outcome).toMatchObject({ kind: 'fail', code: 'QUORUM_UNREACHABLE' });
    expect(run.calls).toEqual(['mock-generator', 'mock-generator-fallback', 'mock-seat-a', 'mock-seat-b']);
    expect(run.receipts('generator')).toEqual([
      expect.objectContaining({ sequence: 1, effective: {
        adapter: 'mock', provider: 'failed-writer', modelFamily: 'failed-writer-family', model: 'failed-model',
      } }),
      expect.objectContaining({ sequence: 2, effective: expect.objectContaining({ provider: 'generator-fallback-provider' }) }),
    ]);
    await run.expectReplay();
  });
});
