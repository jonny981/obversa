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
import { afterEach, describe, expect, it } from 'vitest';

import { compileGraph, type GraphEvent, type GraphType } from '../src/graph/type.js';
import type { GraphDefinition } from '../src/graph/kernel.js';
import {
  resolveGraphPlan,
  type ExecutionTarget,
  type GraphRequirements,
  type PlanResolution,
} from '../src/graph/plan.js';
import { cloneFrozenJson, type JsonObject, type JsonValue } from '../src/graph/value.js';
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
              laneId: definition.data.engineBacked && node.id === 'worker' ? 'worker-lane' : null,
            })),
            policies: {
              retry: null,
              stop: null,
              concurrency: { global: 1 },
              write: null,
              budget: null,
              action: null,
            },
            executionLanes: definition.data.engineBacked ? [{
              id: 'worker-lane',
              requested: PRIMARY_TARGET,
              knownSubstitutions: [FALLBACK_TARGET],
            }] : [],
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

async function storedRun(input: TestDefinition): Promise<{
  readonly graph: ReturnType<typeof compileGraph<TestDefinition, TestState, TestEvent, GraphRequirements>>;
  readonly runId: string;
  readonly storage: RunStorageBinding;
  readonly root: string;
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-graph-executor-')));
  roots.push(root);
  const runId = `executor-${sequence += 1}`;
  const graph = compileGraph(graphType(), input);
  const executionLanes: PlanResolution['executionLanes'] = input.data.engineBacked
    ? [{ id: 'worker-lane', effective: PRIMARY_TARGET, fallbacks: [FALLBACK_TARGET] }]
    : [];
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

  constructor(
    private readonly selection: EngineSelectionRecord,
    private readonly value: JsonValue = { ok: true },
  ) {}

  async run(
    request: AgentRequest,
    _onEvent: EngineEventSink,
    _signal: AbortSignal,
  ): Promise<AgentResult> {
    this.calls += 1;
    this.prompts.push(request.prompt);
    return {
      parts: [{ kind: 'structured', value: this.value, final: true }],
      usage: { kind: 'reported', inputTokens: 1, outputTokens: 1 },
      requested: this.selection,
      effective: this.selection,
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
    const run = await storedRun(definition({ completeAfter: 2 }));
    let primaryCalls = 0;
    const primary = new MockEngine(() => {
      primaryCalls += 1;
      throw new EngineError({ kind: 'auth', message: 'bad primary credentials' });
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
      'graph:model-unavailable',
      'graph:node-completed',
      'graph:node-dispatched',
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
    const run = await storedRun(definition({ failAfter: 2 }));
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
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
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
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
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
    const runData: GraphNodeBinding['runData'] = async () => {
      observedDispatchCounts.push(
        (await events(run.storage, run.runId))
          .filter((event) => event.type === 'graph:node-dispatched').length,
      );
      return { ok: true };
    };
    const executor = await createGraphExecutor({
      ...run,
      nodes: {
        worker: nodeBinding(run.root, { runData }),
        reviewer: nodeBinding(run.root, { runData }),
      },
      engines: [],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'complete' });
    expect(observedDispatchCounts).toEqual([2, 2]);
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

  it('uses the same provider and model identity to validate and skip a dead lane', async () => {
    const run = await storedRun(definition());
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
      kind: 'complete',
    });
    expect(primary.calls).toBe(0);
    expect(fallback.calls).toBe(1);
  });

  it('keeps the result append queue usable after a fact append fails', async () => {
    const run = await storedRun(definition());
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
    const fallback = new SelectedEngine(FALLBACK_SELECTION);
    const executor = await createGraphExecutor({
      ...run,
      storage: { ...run.storage, eventStore },
      nodes: { worker: nodeBinding(run.root, { prompt: () => 'Do the work.' }) },
      engines: [
        engineBinding(PRIMARY_TARGET, PRIMARY_SELECTION, primary),
        engineBinding(FALLBACK_TARGET, FALLBACK_SELECTION, fallback),
      ],
    });

    await expect(executor.run(new AbortController().signal)).resolves.toMatchObject({ kind: 'fail' });
    expect(primaryCalls).toBe(1);
    expect(fallback.calls).toBe(0);
    expect((await events(run.storage, run.runId)).find((event) => event.type === 'graph:node-failed')?.payload)
      .toMatchObject({ code: 'MODEL_UNAVAILABLE_RECORD' });
  });

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
