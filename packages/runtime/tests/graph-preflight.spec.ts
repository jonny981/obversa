import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EngineError, EngineIncompleteResultError,
  type AgentRequest, type AgentResult, type Engine, type EngineSelectionRecord,
  type EngineEventSink, type EngineFailureKind, type UsageReceipt,
} from '@obversa/engine';
import {
  createGraphExecutor, interruptRunPreflight, readRunPreflight,
  type GraphExecutorOptions, type GraphNodeBinding, type PreflightPauseResult,
} from '../src/api.ts';
import { compileGraph, type GraphType } from '../src/graph/type.js';
import { resolveGraphPlan, type ExecutionTarget } from '../src/graph/plan.js';
import { canonicalJson, digestJson, type JsonObject, type JsonValue } from '../src/graph/value.js';
import { type NewDomainEvent, type DomainEventEnvelope } from '../src/events/envelope.js';
import { validateDomainEventBatch } from '../src/events/store.js';
import { StorageError } from '../src/storage/error.js';
import { createLocalRunStorage } from '../src/storage/local.js';
import { createAttemptIdentity } from '../src/runtime/attempt.js';
import { loadRunPreflight, type CompletedProbe } from '../src/runtime/preflight-record.js';
import { persistRunDefinition, type RunStorageBinding } from '../src/runtime/run-definition.js';
import { assistantResult, engineSelection } from '../src/runtime/result-parts.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const primary: ExecutionTarget = {
  adapter: 'primary', provider: 'provider-a', modelFamily: 'family', model: 'model-a', tools: ['Read'],
};
const backup: ExecutionTarget = { ...primary, adapter: 'backup', model: 'model-b' };
const usage: UsageReceipt = { kind: 'reported', inputTokens: 7, outputTokens: 3 };
const storagePolicy = {
  schemaVersion: 1, maxEventPayloadBytes: 64_000, maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000, maxTotalArtifactBytesPerRun: 16_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
} as const;
const selected = (target: ExecutionTarget, version: string | null = '1.2.3', provider: string | null = target.provider) => engineSelection({
  adapter: target.adapter, adapterVersion: version, provider, modelFamily: target.modelFamily,
  model: target.model, executable: '/fixture/engine', capabilities: target.tools,
});
const key = (value: ExecutionTarget) => canonicalJson(value as unknown as JsonValue);
const toolFree = (value: EngineSelectionRecord) => engineSelection({ ...value, capabilities: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
interface Call {
  readonly kind: 'static' | 'live' | 'normal';
  readonly target: ExecutionTarget;
  readonly request: Omit<AgentRequest, 'prompt'> | AgentRequest;
  readonly signal: AbortSignal;
  readonly expected?: EngineSelectionRecord;
}
class FixtureEngine implements Engine {
  readonly name = 'admission-fixture';
  readonly measured: EngineSelectionRecord;
  admitHook?: NonNullable<Engine['admit']>;
  liveHook?: Engine['run'];
  normalHook?: Engine['run'];
  constructor(readonly target: ExecutionTarget, readonly calls: Call[], provider?: string | null) {
    this.measured = selected(target, '1.2.3', provider === undefined ? target.provider : provider);
  }
  async admit(request: Omit<AgentRequest, 'prompt'>, signal: AbortSignal, expected?: EngineSelectionRecord) {
    this.calls.push({ kind: 'static', target: this.target, request, signal, ...(expected === undefined ? {} : { expected }) });
    if (this.admitHook) return this.admitHook.call(this, request, signal, expected);
    if (expected !== undefined && canonicalJson(expected as unknown as JsonValue) !== canonicalJson(this.measured as unknown as JsonValue)) {
      throw new EngineError({ kind: 'invalid-config', message: 'fixture saved identity changed' });
    }
    return this.measured;
  }
  async run(request: AgentRequest, emit: EngineEventSink, signal: AbortSignal): Promise<AgentResult> {
    const live = request.purpose === 'preflight';
    this.calls.push({ kind: live ? 'live' : 'normal', target: this.target, request, signal });
    const hook = live ? this.liveHook : this.normalHook;
    if (hook) return hook.call(this, request, emit, signal);
    const requested = live ? toolFree(this.measured) : this.measured;
    return live ? assistantResult({ text: 'ok', requested, usage }) : {
      parts: [{ kind: 'structured', value: { ok: true }, final: true }],
      usage, requested, effective: requested,
    };
  }
}
interface LaneInput {
  readonly id: string;
  readonly targets: readonly ExecutionTarget[];
  readonly live?: 'required' | 'skip';
  readonly unsupported?: 'allow' | 'block';
}
async function fixture(input: {
  enabled?: boolean; timeoutMs?: number; lanes?: readonly LaneInput[];
  nodes?: readonly { readonly id: string; readonly laneId: string }[];
  provider?: string | null;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-graph-preflight-')));
  roots.push(root);
  const runId = 'preflight-run';
  const lanes = input.lanes ?? [{ id: 'lane', targets: [primary, backup] }];
  const nodes = input.nodes ?? [{ id: 'worker', laneId: lanes[0]!.id }];
  const effects: string[] = [];
  const graphType: GraphType = {
    kind: 'preflight-fixture', version: 1,
    compile(definition) {
      return {
        requirements: { memory: 'unused' },
        initialState: () => ({ state: 'ready' }),
        reduce(state, event) {
          if (event.type === 'node-dispatched' || event.type === 'node-resumed') return { state: 'in-flight' };
          if (event.type === 'node-completed') return { state: 'complete' };
          if (event.type === 'node-failed') return { state: 'failed' };
          if (event.type === 'node-paused') return { state: 'paused' };
          return state;
        },
        decide(state) {
          const status = (state as JsonObject).state;
          if (status === 'complete') return [{ kind: 'complete', output: { ok: true } }];
          if (status === 'failed') return [{ kind: 'fail', code: 'NODE_FAILED', message: 'fixture node failed' }];
          if (status === 'paused') return [{ kind: 'pause', reason: 'fixture graph pause' }];
          if (status === 'in-flight') return [];
          return [{ kind: 'dispatch', nodeId: nodes[0]!.id, position: 'work/0', input: {} }];
        },
        describe() {
          return {
            inputContract: {}, outputContract: {},
            phases: [{ id: 'work', name: 'Work', nodeIds: definition.nodes.map((node) => node.id) }],
            nodes: nodes.map((node) => ({ ...node, phaseId: 'work', inputContract: {}, outputContract: {} })),
            policies: { retry: {}, stop: {}, concurrency: {}, write: {}, budget: {}, action: {} },
            executionLanes: lanes.map((lane) => ({ id: lane.id, requested: lane.targets[0]!, knownSubstitutions: lane.targets.slice(1) })),
            requestedPermissions: [],
            bounds: {
              dispatches: { min: { kind: 'known', value: 0 }, max: { kind: 'known', value: 1 } },
              maxConcurrency: { kind: 'known', value: 1 }, maxFanOut: { kind: 'known', value: 1 },
            },
          };
        },
      };
    },
  };
  const graph = compileGraph(graphType, {
    id: 'preflight-graph', definitionVersion: 1, data: {}, nodes: nodes.map((node) => ({ id: node.id, data: {} })), edges: [],
  });
  const packageIdentity = { source: 'npm:@fixture/preflight', version: '1.0.0', digest: `sha256:${'3'.repeat(64)}` as const };
  const plan = resolveGraphPlan(graph.describe(), {
    package: packageIdentity, admission: { package: packageIdentity, permissions: [] },
    executionLanes: lanes.map((lane) => ({ id: lane.id, effective: lane.targets[0]!, fallbacks: lane.targets.slice(1) })),
    ...(input.enabled === false ? {} : { preflight: {
      timeoutMs: input.timeoutMs ?? 100,
      lanes: lanes.map((lane) => ({ laneId: lane.id, live: lane.live ?? 'required', unsupportedStatic: lane.unsupported ?? 'block' })),
    } }),
  });
  const storage = createLocalRunStorage({ directory: join(root, 'storage'), namespace: 'executor-preflight', policy: storagePolicy, knownSecrets: ['private-probe-secret'] });
  await persistRunDefinition(storage, {
    runId, eventId: 'run-start', timestamp: '2026-09-06T00:00:00.000Z',
    graphDefinition: graph.definition, resolvedPlan: plan, resolvedInputs: {}, workspaceBinding: null, hostBinding: null,
  });
  const calls: Call[] = [];
  const targets = [...new Map(lanes.flatMap((lane) => lane.targets).map((target) => [key(target), target])).values()];
  const engines = targets.map((target) => new FixtureEngine(target, calls, input.provider));
  const bindings: Record<string, GraphNodeBinding> = Object.fromEntries(nodes.map((node) => [node.id, {
    prompt: () => { effects.push('prompt'); return 'ordinary work'; },
    scratchDirectory: root, workspace: { mode: 'none' as const, directory: null, allowedPaths: [] },
    trustedCaller: {}, permissions: ['Read'],
    policy: { inputBytes: 100_000, outputBytes: 100_000, timeoutMs: 5_000, teardownGraceMs: 100,
      memoryBytes: 100_000_000, filesChanged: 0, linesChanged: 0, callTokens: null },
    resultContract: null, runData: null, parseResult: null, tokenBudget: null,
    decideAction: async () => { effects.push('action'); return { kind: 'allow' as const }; },
  }]));
  const options: GraphExecutorOptions = {
    runId, graph, storage, nodes: bindings, preflightScratchDirectory: root,
    engines: engines.map((engine) => ({ target: engine.target, selection: selected(engine.target, null, input.provider === undefined ? engine.target.provider : input.provider), engine, hardTokenLimitEnforceable: false })),
  };
  const executor = (overrides: Partial<GraphExecutorOptions> = {}) => createGraphExecutor({ ...options, ...overrides });
  const state = () => loadRunPreflight(storage, runId);
  const append = async (...events: NewDomainEvent[]) => {
    const current = await state();
    await storage.eventStore.append(current.stream, current.revision, validateDomainEventBatch(events));
  };
  const event = (type: string, payload: unknown, causationId: string | null = null): NewDomainEvent => ({
    eventId: randomUUID(), type, version: 1, timestamp: new Date().toISOString(), correlationId: runId, causationId, payload: payload as JsonValue,
  });
  return { root, runId, storage, options, lanes, nodes, bindings, calls, effects, engines, executor, state, append, event };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const signal = () => new AbortController().signal;
function paused(value: unknown): PreflightPauseResult {
  expect(value).toMatchObject({ kind: 'pause', code: 'PREFLIGHT_PAUSED' });
  return value as PreflightPauseResult;
}
const outcomes = (probes: readonly CompletedProbe[], stage: 'static' | 'live') => probes.filter((probe) => probe.payload.stage === stage).map((probe) => probe.payload.outcome);
async function graphPause(f: Fixture) {
  f.bindings[f.nodes[0]!.id] = { ...f.bindings[f.nodes[0]!.id]!, decideAction: async () => ({ kind: 'wait', reason: 'fixture hold', request: {} }) };
  expect(await (await f.executor()).run(signal())).toEqual({ kind: 'pause', reason: 'fixture graph pause' });
}
async function nodeFact(f: Fixture, target: ExecutionTarget, failure: EngineFailureKind) {
  const identity = createAttemptIdentity({ namespace: f.storage.record.namespace, streamId: f.runId, nodeId: f.nodes[0]!.id, position: 'work/0' });
  await f.append(f.event('graph:model-unavailable', {
    schemaVersion: 1, identity, target, selection: selected(target), effective: selected(target), failure,
  }));
}

describe('graph executor preflight', () => {
  it('finishes static checks and live admission before ordinary graph work', async () => {
    const f = await fixture();
    for (const engine of f.engines) engine.admitHook = async () => {
      expect(f.effects).toEqual([]);
      expect((await f.state()).openProbe?.payload.stage).toBe('static');
      return engine.measured;
    };
    f.engines[0]!.liveHook = async (request) => {
      expect(f.effects).toEqual([]);
      expect(request).toMatchObject({ purpose: 'preflight', model: primary.model, tools: [], allowedTools: [],
        workspaceMode: 'none', cwd: f.root, maxTokens: 16, leaf: true, attempt: { leaf: true } });
      const loaded = await f.state();
      expect(outcomes(loaded.probes, 'static')).toHaveLength(2);
      expect(loaded.events.some((event) => event.type === 'graph:node-dispatched')).toBe(false);
      return assistantResult({ text: 'ok', requested: toolFree(f.engines[0]!.measured), usage });
    };
    const result = await (await f.executor()).run(signal());
    expect(f.calls.map((call) => call.kind)).toEqual(['static', 'static', 'live', 'normal']);
    expect(result).toMatchObject({ kind: 'complete' });
    expect(f.calls.filter((call) => call.kind === 'live').map((call) => call.target)).toEqual([primary]);
    expect(f.effects).toEqual(['prompt', 'action']);
    expect((await f.state()).state.phase).toBe('admitted');
  });

  it('checks every real normal context and the unused lane before live', async () => {
    const other = { ...primary, adapter: 'other', model: 'other-model' };
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary, backup] }, { id: 'unused', targets: [other] }],
      nodes: [{ id: 'one', laneId: 'lane' }, { id: 'two', laneId: 'lane' }] });
    for (const id of ['one', 'two']) {
      const cwd = join(f.root, id); await mkdir(cwd);
      f.bindings[id] = { ...f.bindings[id]!, workspace: { mode: 'read', directory: cwd, allowedPaths: [] },
        permissions: [id], resultContract: { record: { name: id, version: 1, schemaDigest: digestJson({ type: 'string' }) }, schema: { type: 'string' }, validate() { throw new Error('must not validate a result'); } },
        policy: { ...f.bindings[id]!.policy, callTokens: { mode: 'observed', tokens: 123 } },
        tokenBudget: { reserve() { throw new Error('must not reserve'); }, child() { throw new Error('must not create child'); }, snapshot() { throw new Error('must not read budget'); } },
        parseResult() { throw new Error('must not parse'); } };
    }
    f.engines[0]!.liveHook = async () => { throw new EngineError({ kind: 'transient', message: 'stop before graph work' }); };
    paused(await (await f.executor()).run(signal()));
    const statics = f.calls.filter((call) => call.kind === 'static');
    expect(statics).toHaveLength(5);
    expect(statics.slice(0, 4).map((call) => call.request.cwd)).toEqual(['one', 'two', 'one', 'two'].map((id) => join(f.root, id)));
    expect(statics.slice(0, 4).map((call) => call.request.allowedTools)).toEqual([['one'], ['two'], ['one'], ['two']]);
    for (const call of statics.slice(0, 4)) expect(call.request).toMatchObject({ tools: ['Read'], jsonSchema: { type: 'string' }, maxTokens: 123,
      timeoutMs: 5_000, timeoutGraceMs: 100, maxOutputBytes: 100_000, maxMemoryBytes: 100_000_000, workspaceMode: 'read', leaf: true });
    expect(statics[4]!.request).toMatchObject({ model: 'other-model', tools: ['Read'], cwd: f.root, leaf: true });
    for (const field of ['prompt', 'purpose', 'allowedTools', 'workspaceMode', 'jsonSchema', 'maxTokens']) expect(Object.hasOwn(statics[4]!.request, field)).toBe(false);
    expect(statics[1]!.expected).toEqual(f.engines[0]!.measured);
    expect(statics[3]!.expected).toEqual(f.engines[1]!.measured);
    expect(f.effects).toEqual([]);
    const records = await f.state();
    for (const call of f.calls) {
      const attempt = call.request.attempt!;
      const start = records.events.find((event) => event.eventId === attempt.leafId)!;
      expect(start.type).toBe('preflight:probe-started');
      expect(attempt).toEqual({ runId: f.runId, attemptId: digestJson({ namespace: f.storage.record.namespace, runId: f.runId, preflightEventId: start.eventId }),
        leafId: start.eventId, path: ['preflight', start.eventId], label: 'preflight', iteration: 0, leaf: true });
    }
  });
});

describe('preflight policy and routing', () => {
  it.each(['skip', 'allow', 'block'] as const)('retains explicit %s policy', async (mode) => {
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary], live: mode === 'skip' ? 'skip' : 'required', unsupported: mode === 'allow' ? 'allow' : 'block' }] });
    if (mode !== 'skip') Object.defineProperty(f.engines[0]!, 'admit', { value: undefined });
    if (mode === 'allow') {
      f.bindings[f.nodes[0]!.id] = { ...f.bindings[f.nodes[0]!.id]!, decideAction: async () => ({ kind: 'wait', reason: 'fixture hold', request: {} }) };
    }
    const result = await (await f.executor()).run(signal());
    const loaded = await f.state();
    expect(outcomes(loaded.probes, 'static')).toEqual([mode === 'skip' ? { kind: 'admitted', selection: f.engines[0]!.measured } : { kind: 'unsupported' }]);
    if (mode === 'skip') expect(f.calls.map((call) => call.kind)).toEqual(['static', 'normal']);
    if (mode === 'allow') {
      // The real answer supplies version/path; only declared identity can be checked without admission.
      expect(f.calls.filter((call) => call.kind === 'live')).toHaveLength(1);
      expect(result).toEqual({ kind: 'pause', reason: 'fixture graph pause' });
      expect(loaded.state.phase).toBe('admitted');
      expect(outcomes(loaded.probes, 'live')[0]).toMatchObject({ kind: 'succeeded' });
      expect(loaded.events.some((event) => event.type === 'graph:node-dispatched')).toBe(true);
    }
    if (mode === 'block') {
      expect(result).toMatchObject({ kind: 'fail', code: 'PREFLIGHT_FAILED' });
      expect(f.calls).toEqual([]);
      expect(f.effects).toEqual([]);
    }
  });

  it.each(['adapter', 'provider', 'modelFamily', 'model'] as const)('refuses unsupported static allow when live %s differs', async (field) => {
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary], unsupported: 'allow' }] });
    Object.defineProperty(f.engines[0]!, 'admit', { value: undefined });
    const identity = engineSelection({ ...f.engines[0]!.measured, [field]: 'different' });
    f.engines[0]!.liveHook = async () => assistantResult({ text: 'ok', requested: toolFree(identity), usage });
    expect(await (await f.executor()).run(signal())).toMatchObject({ kind: 'pause', code: 'PREFLIGHT_PAUSED' });
    expect(outcomes((await f.state()).probes, 'static')).toEqual([{ kind: 'unsupported' }]);
    expect(outcomes((await f.state()).probes, 'live')[0]).toMatchObject({ kind: 'failed', failure: 'unknown' });
    expect(f.calls.filter((call) => call.kind === 'normal')).toEqual([]);
    expect(f.effects).toEqual([]);
  });

  it.each(['missing-cli', 'invalid-config', 'auth', 'billing', 'quota', 'model-unavailable'] as const)(
    'stores a %s live failure and exclusion before the declared fallback', async (failure) => {
      const f = await fixture({ provider: null });
      f.engines[0]!.liveHook = async () => { throw new EngineError({ kind: failure, message: 'typed fixture failure' }); };
      f.engines[1]!.liveHook = async () => {
        const events = (await f.state()).events;
        const factIndex = events.findIndex((event) => event.type === 'graph:model-unavailable');
        expect(events[factIndex - 1]!.type).toBe('preflight:probe-finished');
        expect((events[factIndex]!.payload as JsonObject).failure).toBe(failure);
        return assistantResult({ text: 'ok', requested: toolFree(f.engines[1]!.measured), usage });
      };
      expect(await (await f.executor()).run(signal())).toMatchObject({ kind: 'complete' });
      expect(f.calls.filter((call) => call.kind === 'live').map((call) => call.target)).toEqual([primary, backup]);
      expect(f.calls.find((call) => call.kind === 'normal')!.target).toEqual(backup);
    },
  );

  it.each([
    ['the same adapter on another provider', { ...primary, provider: 'provider-b' }],
    ['another adapter on the same provider', { ...primary, adapter: 'other' }],
  ] as const)('keeps %s callable after selected adapter/provider auth fails', async (_case, usable) => {
    const sameCredentials = { ...primary, model: 'model-b' };
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary, sameCredentials, usable] }] });
    const effective = toolFree(selected(usable));
    f.engines[0]!.liveHook = async () => {
      throw new EngineError({ kind: 'auth', message: 'selected credentials rejected', effective });
    };
    await graphPause(f);
    expect(f.calls.filter((call) => call.kind === 'static').map((call) => call.target)).toEqual([
      primary, sameCredentials, usable,
    ]);
    expect(f.calls.filter((call) => call.kind === 'live').map((call) => call.target)).toEqual([primary, usable]);
    expect(f.calls.some((call) => call.kind === 'normal')).toBe(false);
    const failure = [...((await f.state()).probeFailures.values())][0]!.fact;
    expect(failure).toEqual({
      schemaVersion: 1,
      source: { kind: 'preflight', probeEventId: failure.source.probeEventId, laneId: 'lane' },
      target: primary,
      selection: f.engines[0]!.measured,
      effective,
      failure: 'auth',
    });

    const freshCalls: Call[] = [];
    const fresh = f.options.engines.map((binding) => ({
      ...binding,
      engine: new FixtureEngine(binding.target, freshCalls),
    }));
    f.bindings.worker = { ...f.bindings.worker!, decideAction: async () => ({ kind: 'allow' }) };
    expect(await (await f.executor({ engines: fresh })).resume('work/0', signal())).toMatchObject({ kind: 'complete' });
    expect(freshCalls.filter((call) => call.kind === 'static').map((call) => call.target)).toEqual([usable]);
    expect(freshCalls.filter((call) => call.kind === 'live')).toEqual([]);
    expect(freshCalls.filter((call) => call.kind === 'normal').map((call) => call.target)).toEqual([usable]);
  });

  it.each(['missing-cli', 'quota'] as const)('uses the shared same-model adapter scope for %s', async (failure) => {
    const alternate = { ...primary, adapter: 'alternate' };
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary, alternate, backup] }] });
    f.engines[0]!.liveHook = async () => { throw new EngineError({ kind: failure, message: 'typed failure' }); };
    expect(await (await f.executor()).run(signal())).toMatchObject({ kind: 'complete' });
    expect(f.calls.filter((call) => call.kind === 'live').map((call) => call.target.adapter)).toEqual(['primary', failure === 'missing-cli' ? 'alternate' : 'backup']);
  });

  it('visits unrecorded static contexts after a target was excluded, but never retries one', async () => {
    const f = await fixture({ nodes: [{ id: 'one', laneId: 'lane' }, { id: 'two', laneId: 'lane' }] });
    f.engines[0]!.admitHook = async () => { throw new EngineError({ kind: 'auth', message: 'typed static refusal' }); };
    expect(await (await f.executor()).run(signal())).toMatchObject({ kind: 'complete' });
    expect(f.calls.filter((call) => call.kind === 'static').map((call) => call.target)).toEqual([primary, primary, backup, backup]);
    expect(f.calls.filter((call) => call.kind === 'live').map((call) => call.target)).toEqual([backup]);
    const executor = await f.executor();
    const before = f.calls.filter((call) => call.target.adapter === 'primary').length;
    await executor.run(signal());
    expect(f.calls.filter((call) => call.target.adapter === 'primary')).toHaveLength(before);
  });

  it('terminates an all-dead lane before any graph work and stays terminal', async () => {
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary] }], nodes: [{ id: 'one', laneId: 'lane' }, { id: 'two', laneId: 'lane' }] });
    f.engines[0]!.admitHook = async () => { throw new EngineError({ kind: 'auth', message: 'dead' }); };
    const result = await (await f.executor()).run(signal());
    expect(result).toMatchObject({ kind: 'fail', code: 'PREFLIGHT_FAILED' });
    expect(f.calls).toHaveLength(1);
    expect(f.effects).toEqual([]);
    expect(await (await f.executor()).run(signal())).toEqual(result);
    expect(f.calls).toHaveLength(1);
  });

  it.each(['missing', 'relative', 'symlink', 'not-normalized'] as const)('rejects %s enabled scratch with its exact configuration code', async (mode) => {
    const f = await fixture();
    let path: string | undefined = f.root;
    if (mode === 'missing') path = undefined;
    if (mode === 'relative') path = 'relative';
    if (mode === 'not-normalized') path = `${f.root}/.`;
    if (mode === 'symlink') { path = join(f.root, 'link'); await symlink(f.root, path); }
    await expect(f.executor({ preflightScratchDirectory: path })).rejects.toMatchObject({ name: 'GraphExecutionError', code: 'INVALID_PREFLIGHT_CONFIG' });
    expect(f.calls).toEqual([]);
    expect((await f.state()).events).toHaveLength(1);
  });

  it('leaves omitted policy and unused optional scratch unchanged', async () => {
    const f = await fixture({ enabled: false });
    // The old binding is intentionally used when admission is absent.
    f.engines[0]!.normalHook = async () => {
      const identity = f.options.engines[0]!.selection;
      return { parts: [{ kind: 'structured', value: {}, final: true }], usage, requested: identity, effective: identity };
    };
    expect(await (await f.executor({ preflightScratchDirectory: 'unused-relative' })).run(signal())).toMatchObject({ kind: 'complete' });
    expect(f.calls.map((call) => call.kind)).toEqual(['normal']);
    expect((await f.state()).state.phase).toBe('disabled');
  });
});

describe('preflight restoration and explicit permission', () => {
  it('restores measured normal identities in a fresh instance without another live answer', async () => {
    const f = await fixture(); await graphPause(f);
    const before = f.calls.filter((call) => call.kind === 'live').length;
    const freshCalls: Call[] = [];
    const fresh = f.options.engines.map((binding) => ({ ...binding, engine: new FixtureEngine(binding.target, freshCalls) }));
    f.bindings.worker = { ...f.bindings.worker!, decideAction: async () => ({ kind: 'allow' }) };
    expect(await (await f.executor({ engines: fresh })).resume('work/0', signal())).toMatchObject({ kind: 'complete' });
    expect(f.calls.filter((call) => call.kind === 'live')).toHaveLength(before);
    expect(freshCalls.map((call) => call.kind)).toEqual(['static', 'static', 'normal']);
    expect(freshCalls.filter((call) => call.kind === 'static').map((call) => call.expected)).toEqual(f.engines.map((engine) => engine.measured));
    expect((await f.state()).admissionCompletedAtRevision).not.toBeNull();
  });

  it('does not repeat static restoration on each call to the same executor', async () => {
    const f = await fixture();
    const executor = await f.executor();
    await executor.run(signal());
    const count = f.calls.length;
    await executor.run(signal());
    expect(f.calls).toHaveLength(count);
  });

  it.each(['path', 'version'] as const)('refuses changed saved %s before ordinary work', async (field) => {
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary] }] }); await graphPause(f);
    const engine = new FixtureEngine(primary, f.calls);
    engine.admitHook = async (_request, _signal, expected) => {
      expect(expected).toEqual(f.engines[0]!.measured);
      return { ...engine.measured, ...(field === 'path' ? { executable: '/fixture/replacement' } : { adapterVersion: '9' }) };
    };
    const count = f.calls.filter((call) => call.kind === 'normal').length;
    paused(await (await f.executor({ engines: [{ ...f.options.engines[0]!, engine }] })).resume('work/0', signal()));
    expect(f.calls.filter((call) => call.kind === 'normal')).toHaveLength(count);
    expect(outcomes((await f.state()).probes, 'static').at(-1)).toMatchObject({ kind: 'failed', failure: 'unknown' });
  });

  it.each(['rate-limit', 'transient', 'timeout', 'aborted', 'unknown'] as const)('requires one exact explicit resume after %s', async (failure) => {
    const f = await fixture();
    f.engines[0]!.liveHook = async () => { throw new EngineError({ kind: failure, message: 'pause once' }); };
    const executor = await f.executor();
    const p = paused(await executor.run(signal()));
    const count = f.calls.length;
    expect(await executor.run(signal())).toEqual(p);
    expect(await executor.resume('work/0', signal())).toEqual(p);
    const hiddenExtra = Object.defineProperty({ preflightEventId: p.preflightEventId }, 'extra', { value: true });
    const symbolExtra = { preflightEventId: p.preflightEventId, [Symbol('extra')]: true };
    const inheritedPosition = Object.assign(Object.create({ position: 'work/0' }) as object, { preflightEventId: p.preflightEventId });
    for (const target of [{ preflightEventId: 'stale' }, { preflightEventId: p.preflightEventId, position: 'work/0' }, {}, hiddenExtra, symbolExtra, inheritedPosition]) {
      await expect(Reflect.apply(executor.resume, executor, [target, signal()])).rejects.toMatchObject({ code: 'RESUME_EVENT_MISMATCH' });
    }
    expect(f.calls).toHaveLength(count);
    expect((await f.state()).state.pause).toEqual(p);
    f.engines[0]!.liveHook = async () => assistantResult({ text: 'ok', requested: toolFree(f.engines[0]!.measured), usage });
    expect(await executor.resume({ preflightEventId: p.preflightEventId }, signal())).toMatchObject({ kind: 'complete' });
    const records = await f.state();
    const consumed = records.events.find((event) => event.type === 'preflight:resumed')!;
    expect(consumed.payload).toEqual({ preflightEventId: p.preflightEventId });
    const next = records.events.find((event) => event.type === 'preflight:probe-started' && event.revision > consumed.revision)!;
    expect(next.causationId).toBe(consumed.eventId);
    const finalCount = f.calls.length;
    await expect(executor.resume({ preflightEventId: p.preflightEventId }, signal())).rejects.toMatchObject({ code: 'RESUME_EVENT_MISMATCH' });
    expect(f.calls).toHaveLength(finalCount);
    expect(records.events.filter((event) => event.type === 'preflight:resumed')).toHaveLength(1);
  });

  it('names both current and requested pause IDs without replacing the current token', async () => {
    const f = await fixture();
    f.engines[0]!.liveHook = async () => { throw new EngineError({ kind: 'rate-limit', message: 'wait' }); };
    const executor = await f.executor();
    const p = paused(await executor.run(signal()));
    const q = paused(await executor.resume({ preflightEventId: p.preflightEventId }, signal()));
    expect(q.preflightEventId).not.toBe(p.preflightEventId);
    const before = (await f.state()).revision;
    await expect(executor.resume({ preflightEventId: p.preflightEventId }, signal())).rejects.toThrow(p.preflightEventId);
    await expect(executor.resume({ preflightEventId: p.preflightEventId }, signal())).rejects.toThrow(q.preflightEventId);
    expect((await f.state()).revision).toBe(before);
    expect(await readRunPreflight(f.storage, f.runId)).toMatchObject({ pause: q });
  });

  it('refuses an unmatched recorded call until the owner closes it, then continues after consumed permission', async () => {
    const f = await fixture();
    const start = f.event('preflight:probe-started', { stage: 'static', laneId: 'lane', target: primary,
      selection: f.options.engines[0]!.selection, contextNodeId: 'worker', expectedSelection: null });
    await f.append(start);
    await expect((await f.executor()).run(signal())).rejects.toMatchObject({ code: 'PROTOCOL' });
    expect(f.calls).toEqual([]);
    expect((await f.state()).revision).toBe(2);
    // No process was started by this fixture. It owns the run and has nothing to clean up.
    const p = (await interruptRunPreflight(f.storage, f.runId))!;
    const consumed = f.event('preflight:resumed', { preflightEventId: p.preflightEventId }, p.preflightEventId);
    await f.append(consumed);
    expect(await (await f.executor()).run(signal())).toMatchObject({ kind: 'complete' });
    expect((await f.state()).events.filter((event) => event.type === 'preflight:resumed')).toHaveLength(1);
  });

  it.each([false, true])('keeps historical admission after ordinary exclusions (all routes=%s)', async (all) => {
    const f = await fixture(); await graphPause(f);
    const completedAt = (await f.state()).admissionCompletedAtRevision;
    await nodeFact(f, primary, 'auth');
    if (all) await nodeFact(f, backup, 'auth');
    f.calls.length = 0;
    f.bindings.worker = { ...f.bindings.worker!, decideAction: async () => ({ kind: 'allow' }) };
    const result = await (await f.executor()).resume('work/0', signal());
    expect(result.kind).toBe(all ? 'fail' : 'complete');
    expect(f.calls.some((call) => call.kind === 'live')).toBe(false);
    expect(f.calls.filter((call) => call.kind === 'static').map((call) => call.target)).toEqual(all ? [] : [backup]);
    const records = await f.state();
    expect(records.admissionCompletedAtRevision).toBe(completedAt);
    expect(records.events.some((event) => event.type === 'preflight:failed')).toBe(false);
  });
});

describe('preflight bounded calls and evidence', () => {
  it('removes static caller listeners and timers after successful settlement', async () => {
    const f = await fixture({ timeoutMs: 20 });
    const caller = new AbortController();
    expect(await (await f.executor()).run(caller.signal)).toMatchObject({ kind: 'complete' });
    const statics = f.calls.filter((call) => call.kind === 'static');
    caller.abort();
    await delay(30);
    expect(statics.every((call) => !call.signal.aborted)).toBe(true);
  });

  it.each(['timeout-success', 'timeout-reject', 'cancel'] as const)('bounds an abort-ignoring static call: %s', async (mode) => {
    const f = await fixture({ timeoutMs: 20 });
    const held = deferred<EngineSelectionRecord>();
    const entered = deferred<void>();
    f.engines[0]!.admitHook = (_request, _signal) => { entered.resolve(); return held.promise; };
    const caller = new AbortController();
    const running = (await f.executor()).run(caller.signal);
    try {
      const started = await Promise.race([
        entered.promise.then(() => ({ kind: 'entered' as const })),
        running.then(
          () => ({ kind: 'settled' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        ),
      ]);
      if (started.kind === 'rejected') throw started.error;
      if (started.kind === 'settled') throw new Error('Executor finished before static admission started');
      if (mode === 'cancel') caller.abort();
      const first = await Promise.race([running.then((result) => ({ result })), delay(1_000).then(() => ({ result: null }))]);
      const p = paused(first.result);
      const before = await f.state();
      expect(outcomes(before.probes, 'static')).toMatchObject([{ kind: 'failed', failure: mode === 'cancel' ? 'aborted' : 'timeout' }]);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.signal.aborted).toBe(true);
      expect(f.calls[0]!.request.timeoutMs).toBe(5_000);
      if (mode === 'timeout-reject') held.reject(new EngineError({ kind: 'billing', message: 'late billing' }));
      else held.resolve(f.engines[0]!.measured);
      await delay(10);
      expect(await f.state()).toEqual(before);
      expect(await readRunPreflight(f.storage, f.runId)).toMatchObject({ pause: p });
      expect(before.events.some((event) => event.type === 'graph:model-unavailable')).toBe(false);
      expect(Object.hasOwn(outcomes(before.probes, 'static')[0]!, 'usage')).toBe(false);
    } finally { held.resolve(f.engines[0]!.measured); await running; }
  });

  it('refuses synchronously late static success and ignores malformed billing-like identity', async () => {
    for (const late of [true, false]) {
      const f = await fixture({ timeoutMs: 5 });
      f.engines[0]!.admitHook = async () => {
        if (!late) return { adapter: 'billing authentication failed', capabilities: 7 } as unknown as EngineSelectionRecord;
        const deadline = performance.now() + 20;
        while (performance.now() < deadline) { /* Delay timer delivery deliberately. */ }
        return f.engines[0]!.measured;
      };
      paused(await (await f.executor()).run(signal()));
      const records = await f.state();
      expect(outcomes(records.probes, 'static')[0]).toMatchObject({ kind: 'failed', failure: late ? 'timeout' : 'unknown' });
      expect(records.probeFailures.size).toBe(0);
    }
  });

  it.each(['success-warning', 'incomplete', 'late-complete', 'unknown-usage', 'wrong-request', 'malformed'] as const)(
    'retains exactly the validated evidence for %s', async (mode) => {
      const f = await fixture({ timeoutMs: mode === 'late-complete' ? 5 : 100 });
      const requested = toolFree(f.engines[0]!.measured);
      const effective = engineSelection({ ...requested, model: 'observed-model', provider: null });
      const receipt: UsageReceipt = mode === 'unknown-usage' ? { kind: 'unknown' } : usage;
      const result: AgentResult = { ...assistantResult({ text: 'ok', requested, effective, usage: receipt }),
        transportFailure: { kind: 'transient', message: 'after final', exitCode: 7 }, raw: { providerObject: 'do not store' } };
      f.engines[0]!.liveHook = async (_request, emit) => {
        emit({ type: 'usage', usage: { kind: 'reported', inputTokens: 1, outputTokens: 1 }, model: primary.model });
        if (mode === 'incomplete') throw new EngineIncompleteResultError('partial', { ...result, parts: [{ kind: 'assistant', text: 'partial text', final: false }] });
        if (mode === 'late-complete') {
          const deadline = performance.now() + 20;
          while (performance.now() < deadline) { /* Already-settled late evidence remains available. */ }
        }
        if (mode === 'wrong-request') return { ...result, requested: { ...requested, adapterVersion: 'wrong' } };
        if (mode === 'malformed') return { ...result, parts: [{ kind: 'assistant', text: 17, final: true }] } as unknown as AgentResult;
        return result;
      };
      const outcome = await (await f.executor()).run(signal());
      const records = await f.state();
      const probe = records.probes.find((value) => value.payload.stage === 'live')!;
      expect(records.probeFailures.size).toBe(0);
      if (mode === 'success-warning' || mode === 'unknown-usage') expect(outcome.kind).toBe('complete');
      else paused(outcome);
      if (mode === 'malformed') {
        expect(probe.evidence).toBeNull();
        expect(probe.payload.outcome).toMatchObject({ kind: 'failed', failure: 'unknown' });
      } else {
        expect(probe.evidence?.kind).toBe(mode === 'incomplete' ? 'incomplete' : 'complete');
        expect(probe.evidence?.result.usage).toEqual(receipt);
        expect(probe.evidence?.result.effective).toEqual(effective);
        expect(probe.evidence?.result.transportFailure).toEqual(result.transportFailure);
        expect(Object.hasOwn(probe.evidence!.result, 'raw')).toBe(false);
        if (mode === 'late-complete') expect(probe.payload.outcome).toMatchObject({ kind: 'failed', failure: 'timeout' });
        if (mode === 'wrong-request') expect(probe.payload.outcome).toMatchObject({ kind: 'failed', failure: 'unknown' });
      }
    },
  );

  it.each(['admitted', 'unsupported-allow'] as const)(
    'turns a live success with requested tools into a retained unknown failure: %s', async (mode) => {
      const f = await fixture({ lanes: [{ id: 'lane', targets: [primary], unsupported: 'allow' }] });
      if (mode === 'unsupported-allow') Object.defineProperty(f.engines[0]!, 'admit', { value: undefined });
      const requested = f.engines[0]!.measured;
      const effective = engineSelection({ ...toolFree(requested), provider: 'reported-provider' });
      f.engines[0]!.liveHook = async () => assistantResult({ text: 'ok', requested, effective, usage });
      paused(await (await f.executor()).run(signal()));
      const records = await f.state();
      expect(outcomes(records.probes, 'static')).toEqual([
        mode === 'admitted' ? { kind: 'admitted', selection: requested } : { kind: 'unsupported' },
      ]);
      const probe = records.probes.find((value) => value.payload.stage === 'live')!;
      expect(probe.payload.outcome).toMatchObject({ kind: 'failed', failure: 'unknown', usage, effective });
      expect(probe.evidence).toMatchObject({ kind: 'complete', result: { requested, effective, usage } });
      expect(records.probeFailures.size).toBe(0);
      expect(records.events.some((event) => event.type === 'graph:model-unavailable')).toBe(false);
      expect(f.calls.filter((call) => call.kind === 'normal')).toEqual([]);
      expect(f.effects).toEqual([]);
    },
  );

  it('revisits an earlier lane only when another lane excludes its successful target', async () => {
    const shared = { ...primary, adapter: 'shared' };
    const b = { ...backup, adapter: 'b', model: 'b-model' };
    const f = await fixture({ lanes: [{ id: 'a', targets: [primary, backup] }, { id: 'b', targets: [shared, b] }] });
    f.engines.find((engine) => engine.target.adapter === 'shared')!.liveHook = async () => { throw new EngineError({ kind: 'quota', message: 'typed shared provider/model quota' }); };
    expect(await (await f.executor()).run(signal())).toMatchObject({ kind: 'complete' });
    expect(f.calls.filter((call) => call.kind === 'live').map((call) => call.target.adapter)).toEqual(['primary', 'shared', 'backup', 'b']);
    expect(f.calls.filter((call) => call.kind === 'live' && call.target.adapter === 'primary')).toHaveLength(1);
  });

  it.each(['unchanged', 'distinct', 'ambiguous', 'missing'] as const)('uses the record-owned live identity projection: %s', async (mode) => {
    const other = { ...primary, model: 'other-model' };
    const declarations = mode === 'distinct' ? [primary, other, backup]
      : mode === 'ambiguous' ? [primary, other, { ...other, provider: 'provider-b' }, backup] : [primary, backup];
    const f = await fixture({ provider: null, lanes: [{ id: 'lane', targets: declarations }] });
    const effective = engineSelection({ ...toolFree(f.engines[0]!.measured), model: mode === 'unchanged' ? primary.model : 'other-model' });
    f.engines[0]!.liveHook = async () => { throw new EngineError({ kind: 'quota', message: 'typed allowance exhausted', effective }); };
    const running = (await f.executor()).run(signal());
    if (mode === 'ambiguous' || mode === 'missing') {
      await expect(running).rejects.toMatchObject({ code: 'ENGINE_IDENTITY_UNRESOLVED' });
      const events: DomainEventEnvelope[] = [];
      for await (const event of f.storage.eventStore.read({ namespace: f.storage.record.namespace, streamId: f.runId })) events.push(event);
      expect(events.at(-1)?.type).toBe('graph:model-unavailable');
      expect((events.at(-1)!.payload as JsonObject).effective).toEqual(effective);
      expect(f.calls.filter((call) => call.kind === 'live')).toHaveLength(1);
    } else {
      expect(await running).toMatchObject({ kind: 'complete' });
      expect([...((await f.state()).probeFailures.values())][0]!.fact.effective).toEqual(effective);
      expect(f.calls.filter((call) => call.kind === 'live').at(-1)!.target).toEqual(backup);
    }
  });
});

describe('preflight storage failures', () => {
  it('records a rejected static diagnostic without an exclusion or model usage', async () => {
    const f = await fixture();
    f.engines[0]!.admitHook = async () => { throw new EngineError({ kind: 'auth', message: 'private-probe-secret' }); };
    paused(await (await f.executor()).run(signal()));
    const records = await f.state();
    expect(outcomes(records.probes, 'static')).toEqual([{ kind: 'recording-failed', storageCode: 'KNOWN_SECRET' }]);
    expect(records.probeFailures.size).toBe(0);
    expect(f.calls.map((call) => call.kind)).toEqual(['static']);
    expect(JSON.stringify(records.events)).not.toContain('private-probe-secret');
  });

  it('propagates an unexpected artifact failure with the live start still unmatched', async () => {
    const f = await fixture();
    const error = new Error('fixture artifact implementation failed');
    const artifactStore = {
      preflightWrite: f.storage.artifactStore.preflightWrite.bind(f.storage.artifactStore),
      read: f.storage.artifactStore.read.bind(f.storage.artifactStore),
      deleteRun: f.storage.artifactStore.deleteRun.bind(f.storage.artifactStore),
      async write() { throw error; },
    };
    await expect((await f.executor({ storage: { ...f.storage, artifactStore } })).run(signal())).rejects.toBe(error);
    expect((await f.state()).openProbe?.payload.stage).toBe('live');
    expect(f.calls.filter((call) => call.kind === 'live')).toHaveLength(1);
    expect(f.effects).toEqual([]);
  });

  it('propagates terminal append refusal without restarting admission', async () => {
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary] }] });
    f.engines[0]!.admitHook = async () => { throw new EngineError({ kind: 'auth', message: 'all dead' }); };
    const storage: RunStorageBinding = { ...f.storage, eventStore: {
      read: f.storage.eventStore.read.bind(f.storage.eventStore),
      preflightAppend: f.storage.eventStore.preflightAppend.bind(f.storage.eventStore),
      async append(stream, revision, batch) {
        if (batch.some((event) => event.type === 'preflight:failed')) throw new StorageError('STORAGE_LIMIT_EXCEEDED', 'terminal append refused');
        return f.storage.eventStore.append(stream, revision, batch);
      },
    } };
    await expect((await f.executor({ storage })).run(signal())).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
    expect(f.calls).toHaveLength(1);
    const records = await f.state();
    expect(records.probeFailures.size).toBe(1);
    expect(records.openProbe).toBeNull();
    expect(records.events.at(-1)?.type).toBe('graph:model-unavailable');
    expect(f.effects).toEqual([]);
  });

  it.each(['evidence-secret', 'evidence-size', 'diagnostic-secret'] as const)('records safe metadata and pauses on %s', async (mode) => {
    const f = await fixture();
    const result = assistantResult({ text: mode === 'evidence-secret' ? 'private-probe-secret' : mode === 'evidence-size' ? 'x'.repeat(1_000_001) : 'ok',
      requested: toolFree(f.engines[0]!.measured), usage });
    f.engines[0]!.liveHook = async () => result;
    const written: string[] = [];
    const storage: RunStorageBinding = { ...f.storage, artifactStore: {
      preflightWrite: f.storage.artifactStore.preflightWrite.bind(f.storage.artifactStore),
      read: f.storage.artifactStore.read.bind(f.storage.artifactStore),
      deleteRun: f.storage.artifactStore.deleteRun.bind(f.storage.artifactStore),
      async write(scope, artifact) {
        written.push(artifact.purpose);
        if (mode === 'diagnostic-secret' && artifact.purpose === 'preflight-diagnostic') {
          const document = JSON.parse(Buffer.from(artifact.bytes).toString('utf8')) as Record<string, unknown>;
          return f.storage.artifactStore.write(scope, { ...artifact, bytes: Buffer.from(JSON.stringify({ ...document, detail: 'private-probe-secret' })) });
        }
        return f.storage.artifactStore.write(scope, artifact);
      },
    } };
    paused(await (await f.executor({ storage })).run(signal()));
    const records = await f.state();
    expect(outcomes(records.probes, 'live')).toEqual([{
      kind: 'recording-failed', storageCode: mode === 'evidence-size' ? 'STORAGE_LIMIT_EXCEEDED' : 'KNOWN_SECRET',
      usage, effective: result.effective, evidence: null, diagnostic: null,
    }]);
    expect(records.events.at(-1)?.type).toBe('preflight:paused');
    expect(records.probeFailures.size).toBe(0);
    expect(f.calls.filter((call) => call.kind === 'live')).toHaveLength(1);
    expect(JSON.stringify(records.events)).not.toContain('private-probe-secret');
    if (mode === 'diagnostic-secret') expect(written).toEqual(['preflight-evidence', 'preflight-diagnostic']);
  });

  it.each(['start', 'finish', 'fact', 'resume', 'conflict'] as const)('propagates %s append refusal without another call', async (mode) => {
    const f = await fixture();
    let active = true;
    if (mode === 'fact') f.engines[0]!.admitHook = async () => { throw new EngineError({ kind: 'auth', message: 'typed refusal' }); };
    if (mode === 'resume') f.engines[0]!.liveHook = async () => { throw new EngineError({ kind: 'transient', message: 'pause first' }); };
    const storage: RunStorageBinding = { ...f.storage, eventStore: {
      read: f.storage.eventStore.read.bind(f.storage.eventStore),
      preflightAppend: f.storage.eventStore.preflightAppend.bind(f.storage.eventStore),
      async append(stream, revision, batch) {
        const match = mode === 'start' || mode === 'conflict' ? batch.some((event) => event.type === 'preflight:probe-started')
          : mode === 'finish' ? batch.some((event) => event.type === 'preflight:probe-finished')
          : mode === 'fact' ? batch.some((event) => event.type === 'graph:model-unavailable')
          : batch.some((event) => event.type === 'preflight:resumed');
        if (active && match) {
          active = false;
          if (mode === 'conflict') {
            await f.storage.eventStore.append(stream, revision, validateDomainEventBatch([f.event('runner:fixture-competing', {})]));
          } else throw new StorageError('STORAGE_LIMIT_EXCEEDED', 'fixture append refusal');
        }
        return f.storage.eventStore.append(stream, revision, batch);
      },
    } };
    const executor = await f.executor({ storage });
    const p = mode === 'resume' ? paused(await executor.run(signal())) : null;
    const count = f.calls.length;
    await expect(p === null ? executor.run(signal()) : executor.resume({ preflightEventId: p.preflightEventId }, signal()))
      .rejects.toMatchObject({ code: mode === 'conflict' ? 'REVISION_CONFLICT' : 'STORAGE_LIMIT_EXCEEDED' });
    expect(f.calls.length - count).toBe(mode === 'finish' || mode === 'fact' ? 1 : 0);
    const records = await f.state();
    expect(records.events.some((event) => event.type === 'graph:node-dispatched')).toBe(false);
    if (mode === 'finish' || mode === 'fact') {
      expect(records.openProbe).not.toBeNull();
      const interrupted = await interruptRunPreflight(f.storage, f.runId);
      expect(interrupted?.code).toBe('PREFLIGHT_PAUSED');
    }
    if (p !== null) expect(records.state.pause).toEqual(p);
  });

  it.each(['raw', 'wrong-run', 'wrong-purpose', 'missing', 'version', 'sequence'] as const)('refuses stored %s evidence before calls', async (mode) => {
    const f = await fixture({ lanes: [{ id: 'lane', targets: [primary] }] });
    const selection = f.engines[0]!.measured;
    const s = f.event('preflight:probe-started', { stage: 'static', laneId: 'lane', target: primary, selection, contextNodeId: 'worker', expectedSelection: null });
    const sf = f.event('preflight:probe-finished', { probeEventId: s.eventId, stage: 'static', outcome: { kind: 'admitted', selection } }, s.eventId);
    await f.append(s, sf);
    const l = f.event('preflight:probe-started', { stage: 'live', laneId: 'lane', target: primary, selection });
    const result = assistantResult({ text: 'ok', requested: toolFree(selection), usage });
    const document = { schemaVersion: 1, runId: mode === 'wrong-run' ? 'another-run' : f.runId, probeEventId: l.eventId,
      evidence: { kind: 'complete', result: { ...result, ...(mode === 'raw' ? { raw: {} } : {}) } } };
    const scope = { namespace: f.storage.record.namespace, runId: f.runId };
    const evidence = await f.storage.artifactStore.write(scope, { bytes: Buffer.from(JSON.stringify(document)), mediaType: 'application/json',
      purpose: mode === 'wrong-purpose' ? 'other' : 'preflight-evidence', contentMode: 'state' });
    const diagnostic = await f.storage.artifactStore.write(scope, { bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, runId: f.runId, probeEventId: l.eventId, detail: 'ok' })),
      mediaType: 'application/json', purpose: 'preflight-diagnostic', contentMode: 'state' });
    const finish = f.event('preflight:probe-finished', { probeEventId: mode === 'sequence' ? 'not-the-start' : l.eventId, stage: 'live',
      outcome: { kind: 'succeeded', usage, effective: result.effective, evidence: mode === 'missing' ? { ...evidence, digest: `sha256:${'0'.repeat(64)}` } : evidence, diagnostic } }, l.eventId);
    await f.append(l, mode === 'version' ? { ...finish, version: 2 } : finish);
    await expect((await f.executor()).run(signal())).rejects.toBeInstanceOf(StorageError);
    expect(f.calls).toEqual([]);
    expect(f.effects).toEqual([]);
  });
});
