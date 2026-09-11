import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Memory } from '@obversa/memory';
import {
  EngineError,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
  type EngineSelectionRecord,
} from '@obversa/engine';
import { MockEngine } from '@obversa/engine/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compileGraph,
  type GraphEvent,
  type GraphType,
} from '../src/graph/type.js';
import type { EngineAttemptRecordedPayload, GraphEngineIdentity } from '../src/api.js';
import type { GraphDefinition } from '../src/graph/kernel.js';
import {
  resolveGraphPlan,
  type ExecutionTarget,
  type GraphRequirements,
  type PlanResolution,
} from '../src/graph/plan.js';
import { cloneFrozenJson, digestJson, type JsonObject, type JsonValue } from '../src/graph/value.js';
import { defineResultContract } from '../src/runtime/result-contract.js';
import { validateNewDomainEvent, type DomainEventEnvelope } from '../src/events/envelope.js';
import type { EventStore } from '../src/events/store.js';
import { createLocalRunStorage } from '../src/storage/local.js';
import { StorageError } from '../src/storage/error.js';
import { createAttemptIdentity } from '../src/runtime/attempt.js';
import { persistRunDefinition, type RunStorageBinding } from '../src/runtime/run-definition.js';
import {
  createGraphExecutor,
  GraphExecutionError,
  type GraphEngineBinding,
  type GraphNodeBinding,
} from '../src/runtime/graph-executor.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

interface TestData extends JsonObject {
  readonly completeAfter: number;
  readonly failAfter: number;
  readonly idle: boolean;
  readonly reusePosition: boolean;
  readonly engineBacked: boolean;
  readonly memory: 'required' | 'unused';
  readonly parallel: boolean;
  readonly terminalWhileInFlight: boolean;
}

type TestDefinition = GraphDefinition<JsonObject, JsonObject, TestData>;

interface DispatchedPayload extends JsonObject {
  readonly nodeId: string;
  readonly position: string;
}

type TestEvent = GraphEvent<
  'node-dispatched',
  DispatchedPayload
> | GraphEvent<
  'node-completed',
  DispatchedPayload & { readonly result: JsonValue }
> | GraphEvent<
  'node-failed',
  DispatchedPayload & { readonly code: string }
> | GraphEvent<
  'node-paused',
  DispatchedPayload & { readonly reason: string; readonly request: JsonValue }
> | GraphEvent<
  'node-resumed',
  DispatchedPayload
>;

interface TestState extends JsonObject {
  readonly attempts: number;
  readonly status: 'ready' | 'in-flight' | 'complete' | 'failed' | 'paused';
}

const PRIMARY_TARGET: ExecutionTarget = {
  adapter: 'mock',
  provider: 'provider',
  modelFamily: 'family',
  model: 'primary',
  tools: [],
};
const FALLBACK_TARGET: ExecutionTarget = {
  ...PRIMARY_TARGET,
  model: 'fallback',
};
const REVIEWER_TARGET: ExecutionTarget = {
  ...PRIMARY_TARGET,
  tools: ['Read'],
};
const SAME_MODEL_FALLBACK_TARGET: ExecutionTarget = {
  ...PRIMARY_TARGET,
  adapter: 'mock-fallback',
};
const OTHER_PROVIDER_TARGET: ExecutionTarget = {
  ...PRIMARY_TARGET,
  provider: 'other-provider',
};
const OTHER_ADAPTER_PROVIDER_TARGET: ExecutionTarget = {
  ...OTHER_PROVIDER_TARGET,
  adapter: 'mock-fallback',
};
const PRIMARY_SELECTION: EngineSelectionRecord = {
  adapter: 'mock',
  adapterVersion: '1.0.0',
  provider: 'provider',
  modelFamily: 'family',
  model: 'primary',
  executable: null,
  capabilities: [],
};
const FALLBACK_SELECTION: EngineSelectionRecord = {
  ...PRIMARY_SELECTION,
  model: 'fallback',
};
const REVIEWER_SELECTION: EngineSelectionRecord = {
  ...PRIMARY_SELECTION,
  capabilities: ['Read'],
};
const SAME_MODEL_FALLBACK_SELECTION: EngineSelectionRecord = {
  ...PRIMARY_SELECTION,
  adapter: 'mock-fallback',
};
const OTHER_PROVIDER_SELECTION: EngineSelectionRecord = {
  ...PRIMARY_SELECTION,
  provider: 'other-provider',
};
const OTHER_ADAPTER_PROVIDER_SELECTION: EngineSelectionRecord = {
  ...OTHER_PROVIDER_SELECTION,
  adapter: 'mock-fallback',
};

const roots: string[] = [];
let sequence = 0;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function graphType(): GraphType<TestDefinition, TestState, TestEvent, GraphRequirements> {
  return {
    kind: 'executor-test',
    version: 1,
    compile(definition) {
      return {
        requirements: { memory: definition.data.memory },
        initialState: () => ({ attempts: 0, status: 'ready' }),
        reduce(state, event) {
          if (event.type === 'node-dispatched' && state.status === 'ready') {
            return { ...state, status: 'in-flight' };
          }
          if (event.type === 'node-completed' && state.status === 'in-flight') {
            const attempts = state.attempts + 1;
            return {
              attempts,
              status: attempts >= definition.data.completeAfter ? 'complete' : 'ready',
            };
          }
          if (event.type === 'node-failed' && state.status === 'in-flight') {
            const attempts = state.attempts + 1;
            return {
              attempts,
              status: attempts >= definition.data.failAfter ? 'failed' : 'ready',
            };
          }
          if (event.type === 'node-paused' && state.status === 'in-flight') {
            return { ...state, status: 'paused' };
          }
          if (event.type === 'node-resumed' && state.status === 'paused') {
            return { ...state, status: 'in-flight' };
          }
          return state;
        },
        decide(state) {
          if (definition.data.idle) return [];
          if (state.status === 'in-flight') {
            return definition.data.terminalWhileInFlight
              ? [{ kind: 'complete', output: { attempts: state.attempts } }]
              : [];
          }
          if (state.status === 'complete') {
            return [{ kind: 'complete', output: { attempts: state.attempts } }];
          }
          if (state.status === 'failed') {
            return [{ kind: 'fail', code: 'TEST_FAILED', message: 'The test node failed.' }];
          }
          if (state.status === 'paused') {
            return [{ kind: 'pause', reason: 'The test node paused.' }];
          }
          if (definition.data.parallel) {
            return definition.nodes.map((node) => ({
              kind: 'dispatch' as const,
              nodeId: node.id,
              input: { attempt: state.attempts + 1 },
              position: `turns/${state.attempts + 1}-${node.id}`,
            }));
          }
          return [{
            kind: 'dispatch',
            nodeId: 'worker',
            input: { attempt: state.attempts + 1 },
            position: `turns/${definition.data.reusePosition ? 1 : state.attempts + 1}`,
          }];
        },
        describe() {
          return {
            inputContract: {},
            outputContract: {},
            phases: [{ id: 'work', name: 'Work', nodeIds: definition.nodes.map((node) => node.id) }],
            nodes: definition.nodes.map((node) => ({
              id: node.id,
              phaseId: 'work',
              inputContract: {},
              outputContract: {},
              laneId: definition.data.engineBacked ? `${node.id}-lane` : null,
            })),
            policies: {
              retry: null,
              stop: null,
              concurrency: { global: 1 },
              write: null,
              budget: null,
              action: null,
            },
            executionLanes: definition.data.engineBacked
              ? definition.nodes.map((node) => node.id === 'worker'
                ? {
                    id: 'worker-lane',
                    requested: PRIMARY_TARGET,
                    knownSubstitutions: [
                      FALLBACK_TARGET,
                      SAME_MODEL_FALLBACK_TARGET,
                      OTHER_PROVIDER_TARGET,
                      OTHER_ADAPTER_PROVIDER_TARGET,
                    ],
                  }
                : {
                    id: `${node.id}-lane`,
                    requested: REVIEWER_TARGET,
                    knownSubstitutions: [],
                  })
              : [],
            requestedPermissions: [],
            bounds: {
              dispatches: {
                min: { kind: 'unknown', reason: 'test' },
                max: { kind: 'unknown', reason: 'test' },
              },
              maxConcurrency: { kind: 'known', value: 1 },
              maxFanOut: { kind: 'known', value: 1 },
            },
          };
        },
      };
    },
  };
}

function definition(overrides: Partial<TestData> = {}): TestDefinition {
  const data: TestData = {
    completeAfter: 1,
    failAfter: 1,
    idle: false,
    reusePosition: false,
    engineBacked: true,
    memory: 'unused',
    parallel: false,
    terminalWhileInFlight: false,
    ...overrides,
  };
  return {
    id: 'executor-test',
    definitionVersion: 1,
    data,
    nodes: data.parallel
      ? [{ id: 'worker', data: {} }, { id: 'reviewer', data: {} }]
      : [{ id: 'worker', data: {} }],
    edges: [],
  };
}

const packageIdentity = {
  source: 'npm:@example/executor-test',
  version: '1.0.0',
  digest: `sha256:${'4'.repeat(64)}` as const,
};

const policy = {
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
} as const;

async function storedRun(
  input: TestDefinition,
  options: {
    readonly workerFallbacks?: readonly ExecutionTarget[];
    readonly form?: ReturnType<typeof graphType>;
  } = {},
): Promise<{
  readonly graph: ReturnType<typeof compileGraph<TestDefinition, TestState, TestEvent, GraphRequirements>>;
  readonly runId: string;
  readonly storage: RunStorageBinding;
  readonly root: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-graph-executor-')));
  roots.push(root);
  const runId = `executor-${sequence += 1}`;
  const graph = compileGraph(options.form ?? graphType(), input);
  const executionLanes: PlanResolution['executionLanes'] = graph.describe().executionLanes.map((lane) => ({
    id: lane.id,
    effective: lane.requested,
    fallbacks: lane.id === 'worker-lane'
      ? options.workerFallbacks ?? [FALLBACK_TARGET]
      : [],
  }));
  const plan = resolveGraphPlan(graph.describe(), {
    package: packageIdentity,
    admission: { package: packageIdentity, permissions: [] },
    executionLanes,
  });
  const storage = createLocalRunStorage({
    directory: join(root, 'storage'),
    namespace: 'executor-tests',
    policy,
  });
  await persistRunDefinition(storage, {
    runId,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: plan,
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  return { graph, runId, storage, root };
}

function nodeBinding(root: string, input: {
  readonly prompt?: GraphNodeBinding['prompt'];
  readonly runData?: GraphNodeBinding['runData'];
  readonly decideAction?: GraphNodeBinding['decideAction'];
  readonly retrySafe?: boolean;
} = {}): GraphNodeBinding {
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
    resultContract: null,
    runData: input.runData ?? null,
    parseResult: null,
    tokenBudget: null,
    retrySafe: input.retrySafe,
    decideAction: input.decideAction ?? (async () => ({ kind: 'allow' })),
  };
}

function engineBinding(
  target: ExecutionTarget,
  selection: EngineSelectionRecord,
  engine: Engine,
): GraphEngineBinding {
  return { target, selection, engine, hardTokenLimitEnforceable: false };
}

class SelectedEngine implements Engine {
  readonly name = 'selected';
  calls = 0;
  readonly prompts: string[] = [];
  readonly attemptIds: (string | undefined)[] = [];

  constructor(
    private readonly selection: EngineSelectionRecord,
    private readonly value: JsonValue = { ok: true },
    private readonly effective: EngineSelectionRecord = selection,
  ) {}

  async run(
    request: AgentRequest,
    _onEvent: EngineEventSink,
    _signal: AbortSignal,
  ): Promise<AgentResult> {
    this.calls += 1;
    this.prompts.push(request.prompt);
    this.attemptIds.push(request.attempt?.attemptId);
    return {
      parts: [{ kind: 'structured', value: this.value, final: true }],
      usage: { kind: 'reported', inputTokens: 1, outputTokens: 1 },
      requested: this.selection,
      effective: this.effective,
      stopReason: 'end_turn',
    };
  }
}

async function events(storage: RunStorageBinding, runId: string): Promise<readonly DomainEventEnvelope[]> {
  const result: DomainEventEnvelope[] = [];
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: runId,
  })) result.push(event);
  return result;
}

async function appendGraphEvent(
  storage: RunStorageBinding,
  runId: string,
  event: { readonly type: string; readonly version: number; readonly payload: JsonValue },
): Promise<void> {
  const current = await events(storage, runId);
  await storage.eventStore.append(
    { namespace: storage.record.namespace, streamId: runId },
    current.at(-1)?.revision ?? 0,
    [validateNewDomainEvent({
      eventId: randomUUID(),
      type: `graph:${event.type}`,
      version: event.version,
      timestamp: new Date().toISOString(),
      correlationId: runId,
      causationId: null,
      payload: event.payload,
    })],
  );
}

const validMemory: Memory = {
  scope: 'executor-test',
  async execute(command) {
    return {
      ok: false,
      command: command.command,
      error: { code: 'STORAGE_ERROR', message: 'Not used by this test.' },
    };
  },
};

describe('createGraphExecutor', () => {
  it.each(['data', 'engine', 'permissive-contract', 'resume'] as const)(
    'validates the %s result once before saving completion', async (mode) => {
      const base = graphType();
      let checks = 0;
      const form: ReturnType<typeof graphType> = { ...base, compile(value, kernel) {
        return { ...base.compile(value, kernel), validateNodeResult(nodeId, result) {
          checks += 1;
          expect(nodeId).toBe('worker');
          return result !== null && typeof result === 'object' && !Array.isArray(result)
            && (result as JsonObject).ok === true
            ? null : { code: 'INVALID_TEST_RESULT', path: '/ok', message: 'Expected true.' };
        } };
      } };
      const run = await storedRun(definition({ engineBacked: mode === 'engine' }), { form });
      const binding = nodeBinding(run.root, {
        prompt: mode === 'engine' ? () => 'Answer.' : null,
        runData: mode === 'engine' ? null : async () => ({ ok: false }),
      });
      const schema = {};
      const executor = await createGraphExecutor({
        ...run,
        nodes: { worker: {
          ...binding,
          resultContract: mode === 'permissive-contract' ? defineResultContract({
            record: { name: 'any-json', version: 1, schemaDigest: digestJson(schema) },
            schema, validate: (value) => value as JsonValue,
          }) : null,
        } },
        engines: mode === 'engine' ? [
          engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, new SelectedEngine(PRIMARY_SELECTION, { ok: false })),
          engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
        ] : [],
      });
      if (mode === 'resume') await appendGraphEvent(run.storage, run.runId, {
        type: 'node-dispatched', version: 1, payload: { nodeId: 'worker', position: 'turns/1' },
      });
      const outcome = mode === 'resume'
        ? await executor.resume('turns/1', new AbortController().signal)
        : await executor.run(new AbortController().signal);
      expect(outcome).toMatchObject({ kind: 'fail', code: 'TEST_FAILED' });
      expect(checks).toBe(1);
      const durable = await events(run.storage, run.runId);
      expect(durable.filter((event) => event.type === 'graph:node-completed')).toEqual([]);
      expect(durable.at(-1)?.payload).toEqual({ nodeId: 'worker', position: 'turns/1', code: 'RESULT_INVALID' });
    },
  );

  it('builds each engine prompt from that dispatch input', async () => {
    const run = await storedRun(definition({ completeAfter: 2 }));
    const prompts: string[] = [];
    const mockPrimary = {
      ...PRIMARY_SELECTION,
      adapterVersion: null,
      provider: null,
      modelFamily: null,
    };
    const mockFallback = { ...mockPrimary, model: 'fallback' };
    const engine = new MockEngine((request) => {
      prompts.push(request.prompt);
      return 'accepted';
    });
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, {
          prompt: (input) => `Do attempt ${(input as { readonly attempt: number }).attempt}.`,
        }),
      },
      engines: [
        engineBinding(PRIMARY_TARGET, mockPrimary, engine),
        engineBinding(FALLBACK_TARGET, mockFallback, new MockEngine(() => 'unused')),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'complete',
    });
    expect(prompts).toEqual(['Do attempt 1.', 'Do attempt 2.']);
  });

  it('records an auth-dead primary once, then skips it on the next dispatch', async () => {
    const run = await storedRun(definition({ completeAfter: 2 }), {
      workerFallbacks: [SAME_MODEL_FALLBACK_TARGET],
    });
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind: 'auth', message: 'bad primary credentials' });
    });
    const fallback = new SelectedEngine(SAME_MODEL_FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toEqual({
      kind: 'complete',
      output: { attempts: 2 },
    });
    expect(primaryCalls).toBe(1);
    expect(fallback.calls).toBe(2);

    const durableTypes = (await events(run.storage, run.runId)).map((event) => event.type);
    expect(durableTypes).toEqual([
      'graph:run-started',
      'graph:node-dispatched',
      'graph:node-attempt-started',
      'graph:engine-attempt-recorded',
      'graph:model-unavailable',
      'graph:engine-attempt-recorded',
      'graph:node-completed',
      'graph:node-dispatched',
      'graph:node-attempt-started',
      'graph:engine-attempt-recorded',
      'graph:node-completed',
    ]);
  });

  it('does not call the fallback for a rate limit', async () => {
    const run = await storedRun(definition());
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind: 'rate-limit', message: 'try later' });
    });
    const fallback = new SelectedEngine(FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'fail',
      code: 'TEST_FAILED',
    });
    expect(primaryCalls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it('records ENGINE_UNAVAILABLE and retries without another engine call', async () => {
    const run = await storedRun(definition({ failAfter: 2 }), {
      workerFallbacks: [SAME_MODEL_FALLBACK_TARGET],
    });
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind: 'auth', message: 'primary is dead' });
    });
    const fallback = new MockEngine(() => {
      fallbackCalls += 1;
      throw new EngineError({ kind: 'auth', message: 'fallback is dead' });
    });
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toEqual({
      kind: 'fail',
      code: 'TEST_FAILED',
      message: 'The test node failed.',
    });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);

    const durable = await events(run.storage, run.runId);
    expect(durable.filter((event) => event.type === 'graph:node-failed').map((event) => event.payload))
      .toEqual([
        { nodeId: 'worker', position: 'turns/1', code: 'ENGINE_UNAVAILABLE' },
        { nodeId: 'worker', position: 'turns/2', code: 'ENGINE_UNAVAILABLE' },
      ]);

    const fresh = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
      ],
    });
    await expect(fresh.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
  });

  it('rejects an idle empty decision but returns waiting for recorded in-flight work', async () => {
    const idle = await storedRun(definition({ idle: true, engineBacked: false }));
    const idleExecutor = await createGraphExecutor({
      ...idle,
      nodes: { worker: nodeBinding(idle.root, { runData: async () => ({ ok: true }) }) },
      engines: [],
    });
    await expect(idleExecutor.run(new AbortController().signal)).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'EMPTY_DECISION',
    });

    const inFlight = await storedRun(definition({ engineBacked: false }));
    await appendGraphEvent(inFlight.storage, inFlight.runId, {
      type: 'node-dispatched',
      version: 1,
      payload: { nodeId: 'worker', position: 'turns/1' },
    });
    const resumed = await createGraphExecutor({
      ...inFlight,
      nodes: { worker: nodeBinding(inFlight.root, { runData: async () => ({ ok: true }) }) },
      engines: [],
    });
    await expect(resumed.run(new AbortController().signal)).resolves.toEqual({
      kind: 'waiting',
      positions: ['turns/1'],
    });
  });

  it('resumes a dispatch that stopped before node code without a second dispatch', async () => {
    const run = await storedRun(definition({ engineBacked: false }));
    await appendGraphEvent(run.storage, run.runId, {
      type: 'node-dispatched',
      version: 1,
      payload: { nodeId: 'worker', position: 'turns/1' },
    });
    let calls = 0;
    let receivedInput: JsonValue = null;
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, {
          runData: async (context) => {
            calls += 1;
            receivedInput = context.input;
            return { ok: true };
          },
        }),
      },
      engines: [],
    });

    await expect(executor.resume('turns/1', new AbortController().signal))
      .resolves.toMatchObject({ kind: 'complete' });
    expect(calls).toBe(1);
    expect(receivedInput).toEqual({ attempt: 1 });
    const durable = await events(run.storage, run.runId);
    expect(durable.filter((event) => event.type === 'graph:node-dispatched'))
      .toHaveLength(1);
    expect(durable.find((event) => event.type === 'graph:node-attempt-started')?.payload)
      .toEqual({
        identity: createAttemptIdentity({
          namespace: run.storage.record.namespace,
          streamId: run.runId,
          nodeId: 'worker',
          position: 'turns/1',
        }),
        retrySafe: false,
      });
  });

  it('pauses an uncertain attempt unless its saved policy permits retry', async () => {
    const run = await storedRun(definition({ engineBacked: false }));
    const identity = createAttemptIdentity({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
      nodeId: 'worker',
      position: 'turns/1',
    });
    await appendGraphEvent(run.storage, run.runId, {
      type: 'node-dispatched',
      version: 1,
      payload: { nodeId: 'worker', position: 'turns/1' },
    });
    await appendGraphEvent(run.storage, run.runId, {
      type: 'node-attempt-started',
      version: 1,
      payload: { identity, retrySafe: false },
    });
    let calls = 0;
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, {
          retrySafe: true,
          runData: async () => {
            calls += 1;
            return { ok: true };
          },
        }),
      },
      engines: [],
    });

    await expect(executor.resume('turns/1', new AbortController().signal))
      .resolves.toEqual({ kind: 'pause', reason: 'The test node paused.' });
    expect(calls).toBe(0);
    expect((await events(run.storage, run.runId)).find(
      (event) => event.type === 'graph:node-paused',
    )?.payload).toEqual({
      nodeId: 'worker',
      position: 'turns/1',
      reason: 'The previous process stopped after node code started, so its outcome is uncertain.',
      request: { kind: 'reconcile-attempt', attemptId: identity.attemptId },
    });
  });

  it('retries an uncertain attempt when its saved policy permits it', async () => {
    const run = await storedRun(definition());
    const identity = createAttemptIdentity({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
      nodeId: 'worker',
      position: 'turns/1',
    });
    await appendGraphEvent(run.storage, run.runId, {
      type: 'node-dispatched',
      version: 1,
      payload: { nodeId: 'worker', position: 'turns/1' },
    });
    await appendGraphEvent(run.storage, run.runId, {
      type: 'node-attempt-started',
      version: 1,
      payload: { identity, retrySafe: true },
    });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, {
          prompt: () => 'Retry the work.',
        }),
      },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });

    await expect(executor.resume('turns/1', new AbortController().signal))
      .resolves.toMatchObject({ kind: 'complete' });
    expect(primary.calls).toBe(1);
    expect(primary.attemptIds).toEqual([identity.attemptId]);
    const durable = await events(run.storage, run.runId);
    expect(durable.filter((event) => event.type === 'graph:node-dispatched'))
      .toHaveLength(1);
    expect(durable.find((event) => event.type === 'graph:node-resumed')?.payload)
      .toEqual({ nodeId: 'worker', position: 'turns/1' });
  });

  it('rejects a terminal decision while durable work is still in flight', async () => {
    const run = await storedRun(definition({
      engineBacked: false,
      terminalWhileInFlight: true,
    }));
    await appendGraphEvent(run.storage, run.runId, {
      type: 'node-dispatched',
      version: 1,
      payload: { nodeId: 'worker', position: 'turns/1' },
    });
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { runData: async () => ({ ok: true }) }) },
      engines: [],
    });

    await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'PROTOCOL',
    });
  });

  it('refuses a durable position before another attempt starts', async () => {
    const run = await storedRun(definition({ completeAfter: 2, reusePosition: true, engineBacked: false }));
    let calls = 0;
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, {
          runData: async () => {
            calls += 1;
            return { ok: true };
          },
        }),
      },
      engines: [],
    });

    await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'DUPLICATE_POSITION',
    });
    expect(calls).toBe(1);
  });

  it('records the whole dispatch decision before either data node starts', async () => {
    const run = await storedRun(definition({ engineBacked: false, parallel: true }));
    const observedDispatchCounts: number[] = [];
    const observedOwnStarts: boolean[] = [];
    const runData = (position: string): GraphNodeBinding['runData'] => async () => {
      const durable = await events(run.storage, run.runId);
      observedDispatchCounts.push(durable.filter(
        (event) => event.type === 'graph:node-dispatched',
      ).length);
      observedOwnStarts.push(durable.some((event) => (
        event.type === 'graph:node-attempt-started'
        && (event.payload as { readonly identity?: { readonly position?: string } })
          .identity?.position === position
      )));
      return { ok: true };
    };
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, { runData: runData('turns/1-worker') }),
        reviewer: nodeBinding(run.root, { runData: runData('turns/1-reviewer') }),
      },
      engines: [],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(observedDispatchCounts).toEqual([2, 2]);
    expect(observedOwnStarts).toEqual([true, true]);
  });

  it('re-folds and re-decides after a dispatch revision conflict', async () => {
    const run = await storedRun(definition({ engineBacked: false }));
    let rejectedFirstDispatch = false;
    let dispatchAppendCalls = 0;
    const eventStore: EventStore = {
      preflightAppend: (...args) => run.storage.eventStore.preflightAppend(...args),
      read: (...args) => run.storage.eventStore.read(...args),
      async append(stream, revision, batch) {
        if (batch.some((event) => event.type === 'graph:node-dispatched')) {
          dispatchAppendCalls += 1;
          if (!rejectedFirstDispatch) {
            rejectedFirstDispatch = true;
            throw new StorageError('REVISION_CONFLICT', 'fixture conflict');
          }
        }
        return await run.storage.eventStore.append(stream, revision, batch);
      },
    };
    let calls = 0;
    const executor = await createGraphExecutor({
      ...run,
      storage: { ...run.storage, eventStore },
      nodes: {
        worker: nodeBinding(run.root, {
          runData: async () => {
            calls += 1;
            return { ok: true };
          },
        }),
      },
      engines: [],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(dispatchAppendCalls).toBe(2);
    expect(calls).toBe(1);
  });

  it('requires a live Memory object when the stored graph requires memory', async () => {
    const run = await storedRun(definition({ engineBacked: false, memory: 'required' }));
    let receivedMemory: Memory | null | undefined;
    const options = {
      ...run,
      nodes: {
        worker: nodeBinding(run.root, {
          runData: async (context) => {
            receivedMemory = context.memory;
            return { ok: true };
          },
        }),
      },
      engines: [],
    };
    await expect(createGraphExecutor(options)).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'MISSING_MEMORY',
    });

    const fromPlainJavaScript = (value: unknown) => Reflect.apply(createGraphExecutor, undefined, [value]);
    await expect(fromPlainJavaScript({
      ...options,
      bindings: { memory: { scope: 'broken', execute: 'not a function' } },
    })).rejects.toMatchObject({ code: 'MISSING_MEMORY' });

    const executor = await createGraphExecutor({ ...options, bindings: { memory: validMemory } });
    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(receivedMemory).toBe(validMemory);
  });

  it('settles an oversized result as a small node failure', async () => {
    const run = await storedRun(definition({ engineBacked: false }));
    let calls = 0;
    const binding = nodeBinding(run.root, {
      runData: async () => {
        calls += 1;
        return { text: 'x'.repeat(70_000) };
      },
    });
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: binding },
      engines: [],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'fail',
    });
    expect((await events(run.storage, run.runId)).filter(
      (event) => event.type === 'graph:node-failed',
    )).toHaveLength(1);
    expect((await events(run.storage, run.runId)).find(
      (event) => event.type === 'graph:node-failed',
    )?.payload).toEqual({
      nodeId: 'worker',
      position: 'turns/1',
      code: 'RESULT_TOO_LARGE',
    });

    const fresh = await createGraphExecutor({
      ...run,
      nodes: { worker: binding },
      engines: [],
    });
    await expect(fresh.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'fail',
    });
    expect(calls).toBe(1);
  });

  it('records wait, deny, and abort as distinct graph results', async () => {
    const waiting = await storedRun(definition());
    const waitingEngine = new SelectedEngine(PRIMARY_SELECTION);
    const waitingExecutor = await createGraphExecutor({
      ...waiting,
      nodes: {
        worker: nodeBinding(waiting.root, {
          prompt: () => 'Do the work.',
          decideAction: async () => ({
            kind: 'wait',
            reason: 'owner approval required',
            request: { interaction: 'approve-write' },
          }),
        }),
      },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, waitingEngine),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });

    await expect(waitingExecutor.run(new AbortController().signal)).resolves.toEqual({
      kind: 'pause',
      reason: 'The test node paused.',
    });
    expect(waitingEngine.calls).toBe(0);
    expect((await events(waiting.storage, waiting.runId)).find(
      (event) => event.type === 'graph:node-paused',
    )?.payload).toEqual({
      nodeId: 'worker',
      position: 'turns/1',
      reason: 'owner approval required',
      request: { interaction: 'approve-write' },
    });

    const denied = await storedRun(definition());
    const deniedEngine = new SelectedEngine(PRIMARY_SELECTION);
    const deniedExecutor = await createGraphExecutor({
      ...denied,
      nodes: {
        worker: nodeBinding(denied.root, {
          prompt: () => 'Do the work.',
          decideAction: async () => ({ kind: 'deny', reason: 'not admitted' }),
        }),
      },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, deniedEngine),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });

    await expect(deniedExecutor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'fail',
    });
    expect(deniedEngine.calls).toBe(0);
    expect((await events(denied.storage, denied.runId)).find(
      (event) => event.type === 'graph:node-failed',
    )?.payload).toMatchObject({ code: 'DENIED' });

    const policyError = await storedRun(definition());
    const policyExecutor = await createGraphExecutor({
      ...policyError,
      nodes: {
        worker: nodeBinding(policyError.root, {
          prompt: () => 'Do the work.',
          decideAction: async () => {
            throw new Error('policy unavailable');
          },
        }),
      },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, new SelectedEngine(PRIMARY_SELECTION)),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });

    await expect(policyExecutor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'fail',
    });
    expect((await events(policyError.storage, policyError.runId)).find(
      (event) => event.type === 'graph:node-failed',
    )?.payload).toMatchObject({ code: 'ACTION_POLICY' });

    const aborted = await storedRun(definition());
    const abortedEngine = new MockEngine(() => {
      throw new EngineError({ kind: 'aborted', message: 'stopped by owner' });
    });
    const abortFallback = new SelectedEngine(FALLBACK_SELECTION);
    const abortedExecutor = await createGraphExecutor({
      ...aborted,
      nodes: { worker: nodeBinding(aborted.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, abortedEngine),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, abortFallback),
      ],
    });

    await expect(abortedExecutor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'fail',
    });
    expect((await events(aborted.storage, aborted.runId)).find(
      (event) => event.type === 'graph:node-failed',
    )?.payload).toMatchObject({ code: 'ABORTED' });
    expect(abortFallback.calls).toBe(0);
  });

  it('rejects a malformed model-unavailable event before deciding', async () => {
    const run = await storedRun(definition());
    await appendGraphEvent(run.storage, run.runId, {
      type: 'model-unavailable',
      version: 2,
      payload: { effective: PRIMARY_SELECTION } as unknown as JsonValue,
    });
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, new SelectedEngine(PRIMARY_SELECTION)),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });
    await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'INVALID_EVENT',
    });
  });

  it('rejects a model-unavailable identity outside the stored plan', async () => {
    const run = await storedRun(definition());
    const outside = { ...PRIMARY_SELECTION, model: 'outside' };
    await appendGraphEvent(run.storage, run.runId, {
      type: 'model-unavailable',
      version: 1,
      payload: cloneFrozenJson({
        schemaVersion: 1,
        identity: createAttemptIdentity({
          namespace: run.storage.record.namespace,
          streamId: run.runId,
          nodeId: 'worker',
          position: 'turns/1',
        }),
        selection: outside,
        effective: outside,
        failure: 'auth',
      } as unknown as JsonValue),
    });
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, new SelectedEngine(PRIMARY_SELECTION)),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });

    await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'INVALID_EVENT',
    });
  });

  it('accepts a recorded executable and version while excluding the selected adapter/provider', async () => {
    const run = await storedRun(definition(), {
      workerFallbacks: [SAME_MODEL_FALLBACK_TARGET],
    });
    const recordedPrimary = {
      ...PRIMARY_SELECTION,
      adapterVersion: '9.9.9',
      executable: '/different/mock',
    };
    await appendGraphEvent(run.storage, run.runId, {
      type: 'model-unavailable',
      version: 1,
      payload: cloneFrozenJson({
        schemaVersion: 1,
        identity: createAttemptIdentity({
          namespace: run.storage.record.namespace,
          streamId: run.runId,
          nodeId: 'worker',
          position: 'turns/recorded',
        }),
        selection: recordedPrimary,
        effective: recordedPrimary,
        failure: 'auth',
      } as unknown as JsonValue),
    });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const fallback = new SelectedEngine(SAME_MODEL_FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'complete',
    });
    expect(primary.calls).toBe(0);
    expect(fallback.calls).toBe(1);
  });

  it('binds two planned nodes that share a provider and model', async () => {
    const run = await storedRun(definition({ parallel: true }));
    const worker = new SelectedEngine(PRIMARY_SELECTION);
    const reviewer = new SelectedEngine(REVIEWER_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, { prompt: () => 'Write.' }),
        reviewer: nodeBinding(run.root, { prompt: () => 'Review.' }),
      },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, worker),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
        engineBinding(REVIEWER_TARGET, REVIEWER_SELECTION, reviewer),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'complete',
    });
    expect(worker.calls).toBe(1);
    expect(reviewer.calls).toBe(1);
  });

  it('allows a same-model adapter fallback after a missing CLI', async () => {
    const run = await storedRun(definition({ completeAfter: 2 }), {
      workerFallbacks: [SAME_MODEL_FALLBACK_TARGET],
    });
    const primary = new MockEngine(() => {
      throw new EngineError({ kind: 'missing-cli', message: 'primary CLI is unavailable' });
    });
    const fallback = new SelectedEngine(SAME_MODEL_FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'complete',
    });
    expect(fallback.calls).toBe(2);
  });

  it('keeps the result append queue usable after a fact append fails', async () => {
    const run = await storedRun(definition(), {
      workerFallbacks: [SAME_MODEL_FALLBACK_TARGET],
    });
    let rejectedFact = false;
    const eventStore: EventStore = {
      preflightAppend: (...args) => run.storage.eventStore.preflightAppend(...args),
      read: (...args) => run.storage.eventStore.read(...args),
      async append(stream, revision, batch) {
        if (!rejectedFact && batch.some((event) => event.type === 'graph:model-unavailable')) {
          rejectedFact = true;
          throw new Error('fixture fact append failed');
        }
        return await run.storage.eventStore.append(stream, revision, batch);
      },
    };
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind: 'auth', message: 'primary is dead' });
    });
    const fallback = new SelectedEngine(SAME_MODEL_FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      storage: { ...run.storage, eventStore },
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
    expect(primaryCalls).toBe(1);
    expect(fallback.calls).toBe(0);
    expect((await events(run.storage, run.runId)).find((event) => event.type === 'graph:node-failed')?.payload)
      .toMatchObject({ code: 'MODEL_UNAVAILABLE_RECORD' });
  });

  it.each(['model-unavailable', 'billing', 'quota'] as const)(
    '%s excludes a second adapter immediately and on the next dispatch', async (failure) => {
      const run = await storedRun(definition({ failAfter: 2 }), {
        workerFallbacks: [SAME_MODEL_FALLBACK_TARGET],
      });
      let primaryCalls = 0;
      const primary = new MockEngine(() => {
        primaryCalls += 1;
        throw new EngineError({ kind: failure, message: 'scripted provider/model failure' });
      });
      const fallback = new SelectedEngine(SAME_MODEL_FALLBACK_SELECTION);
      const executor = await createGraphExecutor({
        ...run,
        nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
        engines: [
          engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
          engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
        ],
      });
      await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
      expect(primaryCalls).toBe(1);
      expect(fallback.calls).toBe(0);
      const durable = await events(run.storage, run.runId);
      expect(durable.filter((event) => event.type === 'graph:model-unavailable').map((event) => event.payload))
        .toEqual([{
          schemaVersion: 1,
          identity: createAttemptIdentity({
            namespace: run.storage.record.namespace, streamId: run.runId,
            nodeId: 'worker', position: 'turns/1',
          }),
          selection: PRIMARY_SELECTION, effective: PRIMARY_SELECTION,
          target: PRIMARY_TARGET, failure,
        }]);
      expect(durable.filter((event) => event.type === 'graph:node-failed')).toHaveLength(2);
    },
  );

  it.each([
    ['auth', FALLBACK_TARGET, FALLBACK_SELECTION, SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION],
    ['quota', SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, OTHER_PROVIDER_TARGET, OTHER_PROVIDER_SELECTION],
  ] as const)('%s leaves the independently configured later target usable', async (
    kind, excludedTarget, excludedSelection, usableTarget, usableSelection,
  ) => {
    const run = await storedRun(definition({ failAfter: 2 }), {
      workerFallbacks: [excludedTarget, usableTarget],
    });
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind, message: 'scripted lasting failure' });
    });
    const excluded = new SelectedEngine(excludedSelection);
    const usable = new SelectedEngine(usableSelection);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(excludedTarget, excludedSelection, excluded),
        engineBinding(usableTarget, usableSelection, usable),
      ],
    });
    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(primaryCalls).toBe(1);
    expect(excluded.calls).toBe(0);
    expect(usable.calls).toBe(1);
  });

  it.each([
    [
      'the same adapter and another provider',
      OTHER_PROVIDER_SELECTION,
      OTHER_PROVIDER_TARGET,
      OTHER_PROVIDER_SELECTION,
    ],
    [
      'another adapter and another provider',
      OTHER_ADAPTER_PROVIDER_SELECTION,
      OTHER_ADAPTER_PROVIDER_TARGET,
      OTHER_ADAPTER_PROVIDER_SELECTION,
    ],
  ] as const)('auth uses the selected credentials despite effective evidence from %s', async (
    _effectiveCase,
    effective,
    usableTarget,
    usableSelection,
  ) => {
    const run = await storedRun(definition({ failAfter: 2 }), {
      workerFallbacks: [FALLBACK_TARGET, usableTarget],
    });
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({
        kind: 'auth', message: 'scripted credential failure', effective,
      });
    });
    const blocked = new SelectedEngine(FALLBACK_SELECTION);
    const usable = new SelectedEngine(usableSelection);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, blocked),
        engineBinding(usableTarget, usableSelection, usable),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toEqual({
      kind: 'complete', output: { attempts: 2 },
    });
    expect(primaryCalls).toBe(1);
    expect(blocked.calls).toBe(0);
    expect(usable.calls).toBe(1);
    expect((await events(run.storage, run.runId)).find(
      (event) => event.type === 'graph:model-unavailable',
    )?.payload).toEqual({
      schemaVersion: 1,
      identity: createAttemptIdentity({
        namespace: run.storage.record.namespace,
        streamId: run.runId,
        nodeId: 'worker',
        position: 'turns/1',
      }),
      selection: PRIMARY_SELECTION,
      effective,
      target: PRIMARY_TARGET,
      failure: 'auth',
    });
  });

  it.each([
    [
      'the same adapter and another provider',
      OTHER_PROVIDER_TARGET,
      OTHER_PROVIDER_SELECTION,
      PRIMARY_SELECTION,
    ],
    [
      'another adapter with the same provider and model',
      SAME_MODEL_FALLBACK_TARGET,
      SAME_MODEL_FALLBACK_SELECTION,
      PRIMARY_SELECTION,
    ],
    [
      'the same adapter and another provider from null observations',
      OTHER_PROVIDER_TARGET,
      OTHER_PROVIDER_SELECTION,
      { ...PRIMARY_SELECTION, provider: null, modelFamily: null },
    ],
  ] as const)('a fresh executor keeps %s available after recorded auth failure', async (
    _candidate,
    usableTarget,
    usableSelection,
    recordedSelection,
  ) => {
    const run = await storedRun(definition(), {
      workerFallbacks: [FALLBACK_TARGET, usableTarget],
    });
    const payload = cloneFrozenJson({
      schemaVersion: 1,
      identity: createAttemptIdentity({
        namespace: run.storage.record.namespace,
        streamId: run.runId,
        nodeId: 'worker',
        position: 'turns/recorded',
      }),
      selection: recordedSelection,
      effective: recordedSelection,
      target: PRIMARY_TARGET,
      failure: 'auth',
    } as unknown as JsonValue);
    await appendGraphEvent(run.storage, run.runId, {
      type: 'model-unavailable', version: 1, payload,
    });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const blocked = new SelectedEngine(FALLBACK_SELECTION);
    const usable = new SelectedEngine(usableSelection);
    const storage = createLocalRunStorage({
      directory: join(run.root, 'storage'), namespace: 'executor-tests', policy,
    });
    const executor = await createGraphExecutor({
      ...run,
      storage,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, blocked),
        engineBinding(usableTarget, usableSelection, usable),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'complete',
    });
    expect(primary.calls).toBe(0);
    expect(blocked.calls).toBe(0);
    expect(usable.calls).toBe(1);
    expect((await events(storage, run.runId)).find(
      (event) => event.type === 'graph:model-unavailable',
    )?.payload).toEqual(payload);
  });

  it('uses the complete recorded lane for a changed effective adapter during execution and replay', async () => {
    const run = await storedRun(definition({ completeAfter: 2 }), {
      workerFallbacks: [FALLBACK_TARGET, SAME_MODEL_FALLBACK_TARGET],
    });
    const effective = { ...SAME_MODEL_FALLBACK_SELECTION, provider: null, modelFamily: null };
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind: 'quota', message: 'scripted adapter substitution', effective });
    });
    const fallback = new SelectedEngine(FALLBACK_SELECTION);
    const substituted = new SelectedEngine(SAME_MODEL_FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, substituted),
      ],
    });
    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(primaryCalls).toBe(1);
    expect(fallback.calls).toBe(2);
    expect(substituted.calls).toBe(0);
    expect((await events(run.storage, run.runId)).find((event) => event.type === 'graph:model-unavailable')?.payload)
      .toMatchObject({ target: PRIMARY_TARGET, selection: PRIMARY_SELECTION, effective });
  });

  it.each(['rate-limit', 'transient'] as const)('%s produces no lasting exclusions on retry', async (kind) => {
    const run = await storedRun(definition({ failAfter: 2 }));
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind, message: 'scripted temporary failure' });
    });
    const fallback = new SelectedEngine(FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
      ],
    });
    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
    expect(primaryCalls).toBe(2);
    expect(fallback.calls).toBe(0);
    expect((await events(run.storage, run.runId)).filter((event) => event.type === 'graph:model-unavailable'))
      .toEqual([]);
  });

  it.each(['legacy', 'exact'] as const)('replays a %s null-provider fact without altering its evidence', async (shape) => {
    const run = await storedRun(definition(), { workerFallbacks: [SAME_MODEL_FALLBACK_TARGET] });
    const observed = { ...PRIMARY_SELECTION, provider: null, modelFamily: null,
      adapterVersion: '9.9.9', executable: '/recorded/old/mock' };
    const payload = cloneFrozenJson({
      schemaVersion: 1,
      identity: createAttemptIdentity({
        namespace: run.storage.record.namespace, streamId: run.runId,
        nodeId: 'worker', position: 'turns/recorded',
      }),
      selection: observed, effective: observed, failure: 'quota',
      ...(shape === 'exact' ? { target: PRIMARY_TARGET } : {}),
    } as unknown as JsonValue);
    await appendGraphEvent(run.storage, run.runId, { type: 'model-unavailable', version: 1, payload });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const fallback = new SelectedEngine(SAME_MODEL_FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(SAME_MODEL_FALLBACK_TARGET, SAME_MODEL_FALLBACK_SELECTION, fallback),
      ],
    });
    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
    expect(primary.calls).toBe(0);
    expect(fallback.calls).toBe(0);
    expect((await events(run.storage, run.runId)).find((event) => event.type === 'graph:model-unavailable')?.payload)
      .toEqual(payload);
  });

  it.each(['legacy', 'exact'] as const)('handles two compatible providers in a %s fact without guessing', async (shape) => {
    const run = await storedRun(definition(), { workerFallbacks: [OTHER_PROVIDER_TARGET] });
    const observed = { ...PRIMARY_SELECTION, provider: null, modelFamily: null };
    const payload = cloneFrozenJson({
      schemaVersion: 1,
      identity: createAttemptIdentity({
        namespace: run.storage.record.namespace, streamId: run.runId,
        nodeId: 'worker', position: 'turns/recorded',
      }),
      selection: observed, effective: observed, failure: 'quota',
      ...(shape === 'exact' ? { target: PRIMARY_TARGET } : {}),
    } as unknown as JsonValue);
    await appendGraphEvent(run.storage, run.runId, { type: 'model-unavailable', version: 1, payload });
    const before = await events(run.storage, run.runId);
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const fallback = new SelectedEngine(OTHER_PROVIDER_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(OTHER_PROVIDER_TARGET, OTHER_PROVIDER_SELECTION, fallback),
      ],
    });
    if (shape === 'legacy') {
      await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
        name: 'GraphExecutionError', code: 'ENGINE_IDENTITY_UNRESOLVED',
      });
      expect(fallback.calls).toBe(0);
      expect(await events(run.storage, run.runId)).toEqual(before);
    } else {
      await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
      expect(fallback.calls).toBe(1);
      expect((await events(run.storage, run.runId)).find((event) => event.type === 'graph:model-unavailable')?.payload)
        .toEqual(payload);
    }
    expect(primary.calls).toBe(0);
  });

  it('resolves an explicit provider from a legacy auth fact', async () => {
    const run = await storedRun(definition(), {
      workerFallbacks: [FALLBACK_TARGET, OTHER_PROVIDER_TARGET],
    });
    const payload = cloneFrozenJson({
      schemaVersion: 1,
      identity: createAttemptIdentity({
        namespace: run.storage.record.namespace, streamId: run.runId,
        nodeId: 'worker', position: 'turns/recorded',
      }),
      selection: PRIMARY_SELECTION,
      effective: PRIMARY_SELECTION,
      failure: 'auth',
    } as unknown as JsonValue);
    await appendGraphEvent(run.storage, run.runId, {
      type: 'model-unavailable', version: 1, payload,
    });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const blocked = new SelectedEngine(FALLBACK_SELECTION);
    const usable = new SelectedEngine(OTHER_PROVIDER_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, blocked),
        engineBinding(OTHER_PROVIDER_TARGET, OTHER_PROVIDER_SELECTION, usable),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'complete',
    });
    expect(primary.calls).toBe(0);
    expect(blocked.calls).toBe(0);
    expect(usable.calls).toBe(1);
    expect((await events(run.storage, run.runId)).find(
      (event) => event.type === 'graph:model-unavailable',
    )?.payload).toEqual(payload);
  });

  it('resolves one compatible provider from a legacy null-provider auth fact', async () => {
    const run = await storedRun(definition(), {
      workerFallbacks: [FALLBACK_TARGET, OTHER_PROVIDER_TARGET],
    });
    const observed = {
      ...FALLBACK_SELECTION, provider: null, modelFamily: null,
    };
    const payload = cloneFrozenJson({
      schemaVersion: 1,
      identity: createAttemptIdentity({
        namespace: run.storage.record.namespace, streamId: run.runId,
        nodeId: 'worker', position: 'turns/recorded',
      }),
      selection: observed,
      effective: observed,
      failure: 'auth',
    } as unknown as JsonValue);
    await appendGraphEvent(run.storage, run.runId, {
      type: 'model-unavailable', version: 1, payload,
    });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const blocked = new SelectedEngine(FALLBACK_SELECTION);
    const usable = new SelectedEngine(OTHER_PROVIDER_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, blocked),
        engineBinding(OTHER_PROVIDER_TARGET, OTHER_PROVIDER_SELECTION, usable),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({
      kind: 'complete',
    });
    expect(primary.calls).toBe(0);
    expect(blocked.calls).toBe(0);
    expect(usable.calls).toBe(1);
    expect((await events(run.storage, run.runId)).find(
      (event) => event.type === 'graph:model-unavailable',
    )?.payload).toEqual(payload);
  });

  it.each(['zero', 'multiple'] as const)(
    'refuses a legacy null-provider auth fact with %s compatible providers', async (matches) => {
      const run = await storedRun(definition(), {
        workerFallbacks: matches === 'multiple' ? [OTHER_PROVIDER_TARGET] : [FALLBACK_TARGET],
      });
      const observed = {
        ...PRIMARY_SELECTION,
        provider: null,
        modelFamily: null,
        ...(matches === 'zero' ? { model: 'undeclared' } : {}),
      };
      await appendGraphEvent(run.storage, run.runId, {
        type: 'model-unavailable', version: 1,
        payload: cloneFrozenJson({
          schemaVersion: 1,
          identity: createAttemptIdentity({
            namespace: run.storage.record.namespace, streamId: run.runId,
            nodeId: 'worker', position: 'turns/recorded',
          }),
          selection: observed, effective: observed, failure: 'auth',
        } as unknown as JsonValue),
      });
      const before = await events(run.storage, run.runId);
      const primary = new SelectedEngine(PRIMARY_SELECTION);
      const fallback = new SelectedEngine(
        matches === 'multiple' ? OTHER_PROVIDER_SELECTION : FALLBACK_SELECTION,
      );
      const executor = await createGraphExecutor({
        ...run,
        nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
        engines: [
          engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
          matches === 'multiple'
            ? engineBinding(OTHER_PROVIDER_TARGET, OTHER_PROVIDER_SELECTION, fallback)
            : engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
        ],
      });

      await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
        name: 'GraphExecutionError', code: 'ENGINE_IDENTITY_UNRESOLVED',
      });
      expect(primary.calls + fallback.calls).toBe(0);
      expect(await events(run.storage, run.runId)).toEqual(before);
    },
  );

  it.each(['missing-cli', 'invalid-config'] as const)(
    'keeps legacy %s failures adapter-wide without inferring a provider', async (failure) => {
      const run = await storedRun(definition(), { workerFallbacks: [OTHER_PROVIDER_TARGET] });
      const observed = { ...PRIMARY_SELECTION, provider: null, modelFamily: null };
      await appendGraphEvent(run.storage, run.runId, {
        type: 'model-unavailable', version: 1,
        payload: cloneFrozenJson({
          schemaVersion: 1,
          identity: createAttemptIdentity({
            namespace: run.storage.record.namespace, streamId: run.runId,
            nodeId: 'worker', position: 'turns/recorded',
          }),
          selection: observed, effective: observed, failure,
        } as unknown as JsonValue),
      });
      const primary = new SelectedEngine(PRIMARY_SELECTION);
      const fallback = new SelectedEngine(OTHER_PROVIDER_SELECTION);
      const executor = await createGraphExecutor({
        ...run,
        nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
        engines: [
          engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
          engineBinding(OTHER_PROVIDER_TARGET, OTHER_PROVIDER_SELECTION, fallback),
        ],
      });
      await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
      expect(primary.calls).toBe(0);
      expect(fallback.calls).toBe(0);
    },
  );

  it.each(['wrong-node', 'wrong-target', 'extra-field', 'null-target'] as const)(
    'rejects %s failure attribution before dispatch', async (invalid) => {
      const run = await storedRun(definition({ parallel: true }));
      const payload = {
        schemaVersion: 1,
        identity: createAttemptIdentity({
          namespace: run.storage.record.namespace, streamId: run.runId,
          nodeId: invalid === 'wrong-node' ? 'reviewer' : 'worker', position: 'turns/recorded',
        }),
        selection: PRIMARY_SELECTION, effective: PRIMARY_SELECTION, failure: 'auth',
        ...(invalid === 'wrong-target' ? { target: REVIEWER_TARGET } : {}),
        ...(invalid === 'extra-field' ? { extra: true } : {}),
        ...(invalid === 'null-target' ? { target: null } : {}),
      };
      await appendGraphEvent(run.storage, run.runId, {
        type: 'model-unavailable', version: 1, payload: cloneFrozenJson(payload as unknown as JsonValue),
      });
      const before = await events(run.storage, run.runId);
      const primary = new SelectedEngine(PRIMARY_SELECTION);
      const fallback = new SelectedEngine(FALLBACK_SELECTION);
      const reviewer = new SelectedEngine(REVIEWER_SELECTION);
      const executor = await createGraphExecutor({
        ...run,
        nodes: { worker: nodeBinding(run.root), reviewer: nodeBinding(run.root) },
        engines: [
          engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
          engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
          engineBinding(REVIEWER_TARGET, REVIEWER_SELECTION, reviewer),
        ],
      });
      await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_EVENT' });
      expect(primary.calls + fallback.calls + reviewer.calls).toBe(0);
      expect(await events(run.storage, run.runId)).toEqual(before);
    },
  );

  it('refuses a compiled graph that does not match the stored run definition', async () => {
    const run = await storedRun(definition({ engineBacked: false }));
    const other = compileGraph(graphType(), {
      ...definition({ engineBacked: false }),
      id: 'other-graph',
    });
    await expect(createGraphExecutor({
      ...run,
      graph: other,
      nodes: { worker: nodeBinding(run.root, { runData: async () => ({ ok: true }) }) },
      engines: [],
    })).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'STORED_GRAPH_MISMATCH',
    });
  });

  it('lets a parent data node return a child executor result', async () => {
    const child = await storedRun(definition({ engineBacked: false }));
    const childExecutor = await createGraphExecutor({
      ...child,
      nodes: { worker: nodeBinding(child.root, { runData: async () => ({ child: true }) }) },
      engines: [],
    });
    const parent = await storedRun(definition({ engineBacked: false }));
    const parentExecutor = await createGraphExecutor({
      ...parent,
      nodes: {
        worker: nodeBinding(parent.root, {
          runData: async (context) => {
            const childResult = await childExecutor.run(context.signal);
            return { child: cloneFrozenJson(childResult as unknown as JsonValue) };
          },
        }),
      },
      engines: [],
    });

    await expect(parentExecutor.run(new AbortController().signal)).resolves.toEqual({
      kind: 'complete',
      output: { attempts: 1 },
    });
    const parentCompleted = (await events(parent.storage, parent.runId))
      .find((event) => event.type === 'graph:node-completed');
    expect(parentCompleted?.payload).toMatchObject({
      result: { child: { kind: 'complete', output: { attempts: 1 } } },
    });
  });
});

const primaryIdentity: GraphEngineIdentity = {
  adapter: 'mock', provider: 'provider', modelFamily: 'family', model: 'primary',
};
const fallbackIdentity: GraphEngineIdentity = { ...primaryIdentity, model: 'fallback' };
const reportedIdentity: GraphEngineIdentity = {
  adapter: 'reported-adapter', provider: 'reported-provider',
  modelFamily: 'reported-family', model: 'reported-model',
};
const reportedSelection: EngineSelectionRecord = { ...PRIMARY_SELECTION, ...reportedIdentity };

function engineReceipt(overrides: Partial<EngineAttemptRecordedPayload> = {}): EngineAttemptRecordedPayload {
  return {
    nodeId: 'worker', position: 'turns/1', sequence: 1,
    requested: primaryIdentity, effective: primaryIdentity,
    ...overrides,
  };
}

async function appendStartedPosition(run: Awaited<ReturnType<typeof storedRun>>, retrySafe = true): Promise<void> {
  await appendGraphEvent(run.storage, run.runId, {
    type: 'node-dispatched', version: 1,
    payload: { nodeId: 'worker', position: 'turns/1' },
  });
  await appendGraphEvent(run.storage, run.runId, {
    type: 'node-attempt-started', version: 1,
    payload: {
      identity: createAttemptIdentity({
        namespace: run.storage.record.namespace, streamId: run.runId,
        nodeId: 'worker', position: 'turns/1',
      }),
      retrySafe,
    },
  });
}

describe('durable engine attempt identities', () => {
  it('records both reported calls before fallback and completion and delivers them to the reducer', async () => {
    const run = await storedRun(definition());
    const primary = new MockEngine(() => {
      throw new EngineError({ kind: 'model-unavailable', message: 'primary unavailable', effective: reportedSelection });
    });
    const answer = new SelectedEngine(FALLBACK_SELECTION, { ok: true }, reportedSelection);
    let observedBeforeFallback: readonly DomainEventEnvelope[] = [];
    const fallback: Engine = {
      name: 'fallback',
      async run(...args) {
        observedBeforeFallback = await events(run.storage, run.runId);
        return answer.run(...args);
      },
    };
    const reduced: JsonValue[] = [];
    const nodes = { worker: nodeBinding(run.root, { prompt: () => 'Answer.' }) };
    const engines = [
      engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
      engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
    ];
    const executor = await createGraphExecutor({
      ...run, nodes, engines,
      graph: {
        ...run.graph,
        reduce(state: TestState, event: GraphEvent) {
          if (event.type === 'engine-attempt-recorded') reduced.push(event.payload);
          return run.graph.reduce(state, event as TestEvent);
        },
      },
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    const expected = [
      engineReceipt({ effective: reportedIdentity }),
      engineReceipt({ sequence: 2, requested: fallbackIdentity, effective: reportedIdentity }),
    ];
    expect(observedBeforeFallback.filter((event) => event.type === 'graph:engine-attempt-recorded')
      .map((event) => event.payload)).toEqual(expected.slice(0, 1));
    const durable = await events(run.storage, run.runId);
    expect(durable.filter((event) => event.type === 'graph:engine-attempt-recorded')
      .map((event) => event.payload)).toEqual(expected);
    expect(durable.map((event) => event.type)).toEqual([
      'graph:run-started', 'graph:node-dispatched', 'graph:node-attempt-started',
      'graph:engine-attempt-recorded', 'graph:model-unavailable',
      'graph:engine-attempt-recorded', 'graph:node-completed',
    ]);
    expect(reduced).toEqual(expect.arrayContaining(expected));
    expect(durable.at(-1)?.payload).toEqual({ nodeId: 'worker', position: 'turns/1', result: { ok: true } });

    const storage = createLocalRunStorage({ directory: join(run.root, 'storage'), namespace: 'executor-tests', policy });
    const fresh = await createGraphExecutor({ ...run, storage, nodes, engines });
    await expect(fresh.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(answer.calls).toBe(1);
  });

  it('keeps an unknown primary null and starts each new position sequence at one', async () => {
    const run = await storedRun(definition({ completeAfter: 2 }));
    const primary = new MockEngine(() => { throw new EngineError({ kind: 'model-unavailable', message: 'no answer' }); });
    const fallback = new SelectedEngine(FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Answer.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
      ],
    });
    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect((await events(run.storage, run.runId)).filter((event) => event.type === 'graph:engine-attempt-recorded')
      .map((event) => event.payload)).toEqual([
        engineReceipt({ effective: null }),
        engineReceipt({ sequence: 2, requested: fallbackIdentity, effective: fallbackIdentity }),
        engineReceipt({ position: 'turns/2', requested: fallbackIdentity, effective: fallbackIdentity }),
      ]);
  });

  it('continues the stored per-position sequence when a fresh executor resumes after result append failure', async () => {
    const run = await storedRun(definition());
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const nodes = { worker: nodeBinding(run.root, { prompt: () => 'Answer.', retrySafe: true }) };
    const engines = [
      engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
      engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
    ];
    const interruption = new Error('process stopped before node completion was stored');
    const eventStore: EventStore = {
      preflightAppend: (...args) => run.storage.eventStore.preflightAppend(...args),
      read: (...args) => run.storage.eventStore.read(...args),
      async append(stream, revision, batch) {
        if (batch.some((event) => event.type === 'graph:node-completed')) throw interruption;
        return run.storage.eventStore.append(stream, revision, batch);
      },
    };
    const first = await createGraphExecutor({ ...run, storage: { ...run.storage, eventStore }, nodes, engines });
    await expect(first.run(new AbortController().signal)).rejects.toBe(interruption);
    const storage = createLocalRunStorage({ directory: join(run.root, 'storage'), namespace: 'executor-tests', policy });
    const fresh = await createGraphExecutor({ ...run, storage, nodes, engines });
    await expect(fresh.resume('turns/1', new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(primary.calls).toBe(2);
    const durable = await events(storage, run.runId);
    expect(durable.filter((event) => event.type === 'graph:engine-attempt-recorded').map((event) => event.payload))
      .toEqual([
        engineReceipt(),
        engineReceipt({ sequence: 2, requested: null, effective: null }),
        engineReceipt({ sequence: 3 }),
      ]);
    expect(durable.filter((event) => event.type === 'graph:node-dispatched')).toHaveLength(1);
  });

  it.each(['result', 'unavailable'] as const)('refuses completion and fallback when the %s receipt cannot be stored', async (outcome) => {
    const run = await storedRun(definition());
    const receiptError = new StorageError('STORAGE_LIMIT_EXCEEDED', 'receipt rejected');
    const eventStore: EventStore = {
      preflightAppend: (...args) => run.storage.eventStore.preflightAppend(...args),
      read: (...args) => run.storage.eventStore.read(...args),
      async append(stream, revision, batch) {
        if (batch.some((event) => event.type === 'graph:engine-attempt-recorded')) throw receiptError;
        return run.storage.eventStore.append(stream, revision, batch);
      },
    };
    const answer = new SelectedEngine(PRIMARY_SELECTION);
    let primaryCalls = 0;
    const primary: Engine = {
      name: 'primary',
      async run(...args) {
        primaryCalls += 1;
        if (outcome === 'unavailable') throw new EngineError({ kind: 'auth', message: 'no answer' });
        return answer.run(...args);
      },
    };
    const fallback = new SelectedEngine(FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run, storage: { ...run.storage, eventStore },
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Answer.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
      ],
    });
    await expect(executor.run(new AbortController().signal)).rejects.toBe(receiptError);
    expect(primaryCalls).toBe(1);
    expect(fallback.calls).toBe(0);
    expect((await events(run.storage, run.runId)).map((event) => event.type)).toEqual([
      'graph:run-started', 'graph:node-dispatched', 'graph:node-attempt-started',
    ]);
  });

  it('preserves the engine receipt when the result is too large to store', async () => {
    const run = await storedRun(definition());
    const primary = new SelectedEngine(PRIMARY_SELECTION, { text: 'x'.repeat(70_000) }, reportedSelection);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Answer.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });
    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
    const durable = await events(run.storage, run.runId);
    expect(durable.filter((event) => event.type === 'graph:engine-attempt-recorded').map((event) => event.payload))
      .toEqual([engineReceipt({ effective: reportedIdentity })]);
    expect(durable.at(-1)?.payload).toEqual({ nodeId: 'worker', position: 'turns/1', code: 'RESULT_TOO_LARGE' });
  });

  it.each([
    ['version', { version: 2 }],
    ['missing effective', { payload: { nodeId: 'worker', position: 'turns/1', sequence: 1, requested: primaryIdentity } }],
    ['unknown field', { payload: { ...engineReceipt(), extra: true } }],
    ['invalid reported model', { payload: engineReceipt({ effective: { ...primaryIdentity, model: 42 } as unknown as GraphEngineIdentity }) }],
    ['missing identity field', { payload: { ...engineReceipt(), effective: { adapter: 'mock', provider: 'provider', model: 'primary' } } }],
    ['unknown identity field', { payload: { ...engineReceipt(), effective: { ...primaryIdentity, extra: true } } }],
    ['empty adapter', { payload: engineReceipt({ effective: { ...primaryIdentity, adapter: '' } }) }],
    ['zero sequence', { payload: engineReceipt({ sequence: 0 }) }],
    ['skipped sequence', { payload: engineReceipt({ sequence: 2 }) }],
    ['fractional sequence', { payload: engineReceipt({ sequence: 1.5 }) }],
    ['foreign node', { payload: engineReceipt({ nodeId: 'other' }) }],
    ['foreign position', { payload: engineReceipt({ position: 'turns/other' }) }],
    ['unplanned request', { payload: engineReceipt({ requested: reportedIdentity }) }],
    ['reported answer without requested target', { payload: engineReceipt({ requested: null }) }],
  ] as const)('rejects a stored engine receipt with %s before running an engine', async (_name, change) => {
    const run = await storedRun(definition());
    await appendStartedPosition(run);
    await appendGraphEvent(run.storage, run.runId, {
      type: 'engine-attempt-recorded', version: 1, payload: engineReceipt(), ...change,
    });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Answer.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });
    await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
      name: 'GraphExecutionError', code: 'INVALID_EVENT',
    });
    expect(primary.calls).toBe(0);
  });

  it.each(['before-dispatch', 'before-start', 'duplicate', 'after-completion', 'while-paused', 'data-node'] as const)('rejects a stored engine receipt %s', async (mode) => {
    const run = await storedRun(definition({ engineBacked: mode !== 'data-node' }));
    if (mode !== 'before-start' && mode !== 'before-dispatch') await appendStartedPosition(run);
    if (mode === 'before-start') {
      await appendGraphEvent(run.storage, run.runId, {
        type: 'node-dispatched', version: 1, payload: { nodeId: 'worker', position: 'turns/1' },
      });
    }
    if (mode === 'while-paused') {
      await appendGraphEvent(run.storage, run.runId, {
        type: 'node-paused', version: 1,
        payload: { nodeId: 'worker', position: 'turns/1', reason: 'approval', request: {} },
      });
    }
    if (mode === 'duplicate') {
      await appendGraphEvent(run.storage, run.runId, { type: 'engine-attempt-recorded', version: 1, payload: engineReceipt() });
    }
    if (mode === 'after-completion') {
      await appendGraphEvent(run.storage, run.runId, {
        type: 'node-completed', version: 1,
        payload: { nodeId: 'worker', position: 'turns/1', result: { ok: true } },
      });
    }
    await appendGraphEvent(run.storage, run.runId, { type: 'engine-attempt-recorded', version: 1, payload: engineReceipt() });
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      nodes: { worker: nodeBinding(run.root, mode === 'data-node'
        ? { runData: async () => ({ ok: true }) } : { prompt: () => 'Answer.' }) },
      engines: mode === 'data-node' ? [] : [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });
    await expect(executor.run(new AbortController().signal)).rejects.toMatchObject({
      name: 'GraphExecutionError', code: 'INVALID_EVENT',
    });
    expect(primary.calls).toBe(0);
  });
});

describe('engine identity recovery', () => {
  it.each([true, false])('records an unknown interrupted engine attempt before resume with retrySafe=%s', async (retrySafe) => {
    const run = await storedRun(definition());
    await appendStartedPosition(run, retrySafe);
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const storage = createLocalRunStorage({ directory: join(run.root, 'storage'), namespace: 'executor-tests', policy });
    const executor = await createGraphExecutor({
      ...run, storage,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Answer.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
      ],
    });
    await expect(executor.resume('turns/1', new AbortController().signal)).resolves.toMatchObject({
      kind: retrySafe ? 'complete' : 'pause',
    });
    expect(primary.calls).toBe(retrySafe ? 1 : 0);
    const durable = await events(storage, run.runId);
    expect(durable.filter((event) => event.type === 'graph:engine-attempt-recorded').map((event) => event.payload))
      .toEqual(retrySafe
        ? [engineReceipt({ requested: null, effective: null }), engineReceipt({ sequence: 2 })]
        : [engineReceipt({ requested: null, effective: null })]);
    const unknownIndex = durable.findIndex((event) => event.type === 'graph:engine-attempt-recorded');
    expect(durable[unknownIndex + 1]?.type).toBe(retrySafe ? 'graph:node-resumed' : 'graph:node-paused');
  });

  it('does not invent an interrupted engine call when resuming a recorded policy wait', async () => {
    const run = await storedRun(definition());
    const primary = new SelectedEngine(PRIMARY_SELECTION);
    const engines = [
      engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
      engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, new SelectedEngine(FALLBACK_SELECTION)),
    ];
    const waiting = await createGraphExecutor({
      ...run, engines,
      nodes: { worker: nodeBinding(run.root, {
        prompt: () => 'Answer.',
        decideAction: async () => ({ kind: 'wait', reason: 'approval', request: {} }),
      }) },
    });
    await expect(waiting.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'pause' });
    expect(primary.calls).toBe(0);
    expect((await events(run.storage, run.runId)).filter((event) => event.type === 'graph:engine-attempt-recorded'))
      .toEqual([]);
    const fresh = await createGraphExecutor({
      ...run, engines,
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Answer.' }) },
    });
    await expect(fresh.resume('turns/1', new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(primary.calls).toBe(1);
    expect((await events(run.storage, run.runId)).filter((event) => event.type === 'graph:engine-attempt-recorded')
      .map((event) => event.payload)).toEqual([engineReceipt()]);
  });
});
