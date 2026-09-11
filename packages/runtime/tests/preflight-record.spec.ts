import { chmod, mkdtemp, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as api from '../src/api.ts';
import type { ArtifactReference } from '../src/artifacts/store.js';
import type { NewDomainEvent } from '../src/events/envelope.js';
import type { DomainEventBatch, EventStore } from '../src/events/store.js';
import type { AgentResult, EngineFailureKind, EngineSelectionRecord } from '../src/engines/engine.js';
import { createGraphKernel } from '../src/graph/kernel.js';
import { resolveGraphPlan, type ExecutionTarget, type GraphDescription } from '../src/graph/plan.js';
import type { JsonValue } from '../src/graph/value.js';
import { engineFailureExclusionKeys } from '../src/runtime/engine-availability.js';
import { assistantResult, engineSelection } from '../src/runtime/result-parts.js';
import { persistRunDefinition, type RunStorageBinding } from '../src/runtime/run-definition.js';
import { createLocalRunStorage } from '../src/storage/local.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const primary: ExecutionTarget = {
  adapter: 'fixture', provider: 'provider-a', modelFamily: 'family', model: 'model-a', tools: ['Read'],
};
const backup: ExecutionTarget = { ...primary, adapter: 'backup', model: 'model-b' };
const storagePolicy = {
  schemaVersion: 1, maxEventPayloadBytes: 64_000, maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000, maxTotalArtifactBytesPerRun: 8_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
} as const;
function selected(target: ExecutionTarget, provider: string | null = target.provider) {
  return engineSelection({
    adapter: target.adapter, adapterVersion: '1.2.3', provider,
    modelFamily: target.modelFamily, model: target.model, executable: '/fixture/command',
    capabilities: target.tools,
  });
}
function liveSelection(value: EngineSelectionRecord) {
  return engineSelection({ ...value, capabilities: [] });
}
async function fixture(options: {
  enabled?: boolean; live?: 'required' | 'skip'; unsupported?: 'allow' | 'block';
  targets?: readonly ExecutionTarget[]; nodes?: readonly string[]; provider?: string | null;
  laneId?: string; secondLane?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-preflight-record-'));
  roots.push(directory);
  const storage = createLocalRunStorage({
    directory, namespace: 'preflight-tests', policy: storagePolicy, knownSecrets: ['private-probe-secret'],
  });
  const runId = 'record-run';
  const laneId = options.laneId ?? 'lane';
  const targets = options.targets ?? [primary];
  const nodes = options.nodes ?? ['worker'];
  const graph = createGraphKernel({
    id: 'record-graph', definitionVersion: 1, data: {},
    nodes: nodes.map((id) => ({ id, data: {} })), edges: [],
  });
  const description: GraphDescription = {
    schemaVersion: 1,
    graph: { id: 'record-graph', definitionVersion: 1, kind: 'fixture', typeVersion: 1, definitionDigest: graph.definition.digest },
    inputContract: {}, outputContract: {},
    phases: [{ id: 'work', name: 'Work', nodeIds: nodes }],
    nodes: nodes.map((id) => ({ id, phaseId: 'work', inputContract: {}, outputContract: {}, laneId })),
    edges: [], policies: { retry: {}, stop: {}, concurrency: {}, write: {}, budget: {}, action: {} },
    executionLanes: [
      { id: laneId, requested: targets[0]!, knownSubstitutions: targets.slice(1) },
      ...(options.secondLane ? [{ id: 'other-lane', requested: targets[0]!, knownSubstitutions: targets.slice(1) }] : []),
    ],
    requestedPermissions: [], requirements: { memory: 'unused' },
    bounds: {
      dispatches: { min: { kind: 'known', value: 0 }, max: { kind: 'known', value: nodes.length } },
      maxConcurrency: { kind: 'known', value: 1 }, maxFanOut: { kind: 'known', value: 1 },
    },
  };
  const packageIdentity = { source: 'npm:@fixture/preflight', version: '1.0.0', digest: `sha256:${'2'.repeat(64)}` as const };
  const plan = resolveGraphPlan(description, {
    package: packageIdentity, admission: { package: packageIdentity, permissions: [] },
    executionLanes: [
      { id: laneId, effective: targets[0]!, fallbacks: targets.slice(1) },
      ...(options.secondLane ? [{ id: 'other-lane', effective: targets[0]!, fallbacks: targets.slice(1) }] : []),
    ],
    ...(options.enabled === false ? {} : {
      preflight: { timeoutMs: 100, lanes: [
        { laneId, live: options.live ?? 'required', unsupportedStatic: options.unsupported ?? 'block' },
        ...(options.secondLane ? [{ laneId: 'other-lane', live: 'required' as const, unsupportedStatic: 'block' as const }] : []),
      ] },
    }),
  });
  await persistRunDefinition(storage, {
    runId, eventId: 'run-start', timestamp: '2026-09-06T00:00:00.000Z',
    graphDefinition: graph.definition, resolvedPlan: plan, resolvedInputs: {},
    workspaceBinding: null, hostBinding: null,
  });
  const stream = { namespace: storage.record.namespace, streamId: runId };
  const scope = { namespace: storage.record.namespace, runId };
  let revision = 1;
  let count = 0;
  let resumeCause: string | null = null;
  const selections = targets.map((target) => selected(target, options.provider === undefined ? target.provider : options.provider));
  const event = (type: string, payload: unknown, causationId: string | null = null, overrides: Partial<NewDomainEvent> = {}): NewDomainEvent => ({
    eventId: `event-${++count}`, type, version: 1, timestamp: '2026-09-06T00:00:01.000Z',
    correlationId: runId, causationId, payload: payload as JsonValue, ...overrides,
  });
  const append = async (...events: NewDomainEvent[]) => {
    revision = await storage.eventStore.append(stream, revision, events as unknown as DomainEventBatch);
  };
  const document = async (purpose: string, value: unknown, foreign = false) => storage.artifactStore.write(
    foreign ? { ...scope, runId: 'foreign-run' } : scope,
    { bytes: Buffer.from(JSON.stringify(value)), mediaType: 'application/json', purpose, contentMode: 'state' },
  );
  const diagnostic = (start: NewDomainEvent, overrides = {}) => document('preflight-diagnostic', {
    schemaVersion: 1, runId, probeEventId: start.eventId, detail: 'fixture diagnostic', ...overrides,
  });
  const start = (stage: 'static' | 'live', index = 0, overrides = {}) => event('preflight:probe-started', {
    laneId, target: targets[index], selection: selections[index], stage,
    ...(stage === 'static' ? { contextNodeId: nodes[0] ?? null, expectedSelection: null } : {}), ...overrides,
  }, resumeCause);
  const finish = (probe: NewDomainEvent, outcome: unknown, stage = (probe.payload as { stage: string }).stage) => event(
    'preflight:probe-finished', { probeEventId: probe.eventId, stage, outcome }, probe.eventId,
  );
  const pause = (finished: NewDomainEvent, reason = 'engine-failure') => event('preflight:paused', {
    finishedProbeEventId: finished.eventId, reason,
  }, finished.eventId);
  const resume = (paused: NewDomainEvent) => {
    const value = event('preflight:resumed', { preflightEventId: paused.eventId }, paused.eventId);
    resumeCause = value.eventId;
    return value;
  };
  const staticDone = async (index = 0, outcome: unknown = { kind: 'admitted', selection: selections[index] }, overrides = {}) => {
    const probe = start('static', index, overrides);
    const finished = finish(probe, outcome);
    await append(probe, finished);
    return { probe, finished };
  };
  const result = (index = 0): AgentResult => assistantResult({
    text: 'ok', usage: { kind: 'reported', inputTokens: 7, outputTokens: 3 },
    requested: liveSelection(selections[index]!),
  });
  const evidence = (probe: NewDomainEvent, value: unknown, kind = 'complete', overrides = {}, foreign = false) => document(
    'preflight-evidence', { schemaVersion: 1, runId, probeEventId: probe.eventId, evidence: { kind, result: value }, ...overrides }, foreign,
  );
  const liveDone = async (value = result(), kind: 'succeeded' | 'failed' = 'succeeded', failure: EngineFailureKind = 'timeout', evidenceKind = 'complete') => {
    const probe = start('live');
    await append(probe);
    const reference = await evidence(probe, value, evidenceKind);
    const outcome = {
      kind, usage: value.usage, effective: value.effective, evidence: reference,
      diagnostic: await diagnostic(probe), ...(kind === 'failed' ? { failure } : {}),
    };
    const finished = finish(probe, outcome);
    const paused = pause(finished);
    await append(...(kind === 'failed' ? [finished, paused] : [finished]));
    return { probe, finished, paused, reference, outcome };
  };
  const exclusion = (probe: NewDomainEvent, finished: NewDomainEvent, failure: EngineFailureKind, effective: EngineSelectionRecord | null, index = 0) => event('graph:model-unavailable', {
    schemaVersion: 1, source: { kind: 'preflight', probeEventId: probe.eventId, laneId },
    target: targets[index], selection: selections[index], effective: effective ?? selections[index], failure,
  }, finished.eventId);
  return { directory, storage, runId, targets, nodes, selections, plan, stream, scope, event, append, document,
    diagnostic, start, finish, pause, resume, staticDone, result, evidence, liveDone, exclusion };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(f: Fixture, storage = f.storage) {
  const { loadRunPreflight } = await import('../src/runtime/preflight-record.js');
  return loadRunPreflight(storage, f.runId);
}
async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else found.push(path);
  }
  return found;
}
const invalid = { code: 'INVALID_STORED_VALUE' };
const authPrimary = {
  adapter: 'adapter-a', provider: 'provider-p', modelFamily: 'family', model: 'model-m', tools: ['Read'],
} satisfies ExecutionTarget;
const authSameProviderModel = { ...authPrimary, model: 'model-n' } satisfies ExecutionTarget;
const authSameAdapterModel = { ...authPrimary, provider: 'provider-q' } satisfies ExecutionTarget;
const authOtherAdapterModel = { ...authPrimary, adapter: 'adapter-b' } satisfies ExecutionTarget;
const authOtherAdapterProviderModel = {
  ...authOtherAdapterModel, provider: 'provider-q',
} satisfies ExecutionTarget;
const authTargets = [
  authPrimary,
  authSameProviderModel,
  authSameAdapterModel,
  authOtherAdapterModel,
  authOtherAdapterProviderModel,
] as const;

async function storedEventBytes(f: Fixture): Promise<string> {
  const events: unknown[] = [];
  for await (const event of f.storage.eventStore.read(f.stream)) events.push(event);
  return JSON.stringify(events);
}

async function appendAuthFailure(
  f: Fixture,
  stage: 'static' | 'live',
  effective: EngineSelectionRecord | null = null,
) {
  if (stage === 'live') {
    for (let index = 0; index < f.targets.length; index++) await f.staticDone(index);
  }
  const probe = f.start(stage);
  const diagnostic = await f.diagnostic(probe);
  const outcome = stage === 'static'
    ? { kind: 'failed', failure: 'auth', effective, diagnostic }
    : { kind: 'failed', failure: 'auth', usage: { kind: 'unknown' }, effective, evidence: null, diagnostic };
  const finished = f.finish(probe, outcome);
  const fact = f.exclusion(probe, finished, 'auth', effective);
  await f.append(probe, finished, fact);
  if (stage === 'static') {
    for (let index = 1; index < f.targets.length; index++) await f.staticDone(index);
  }
  return { probe, finished, fact };
}

describe('durable preflight records', () => {
  it('public reader starts pending without an engine or host', async () => {
    const f = await fixture();
    expect(api.readRunPreflight).toBeTypeOf('function');
    expect(await api.readRunPreflight(f.storage, f.runId)).toEqual({
      phase: 'pending', pause: null, resumedPreflightEventId: null, unfinishedProbeEventId: null,
    });
  });

  it('preserves omitted policy bytes and disables old runs', async () => {
    const f = await fixture({ enabled: false });
    const before = f.plan.canonicalJson;
    expect((await api.readRunPreflight(f.storage, f.runId)).phase).toBe('disabled');
    expect(await api.interruptRunPreflight(f.storage, f.runId)).toBeNull();
    expect((await api.loadRunDefinition(f.storage, f.runId)).resolvedPlan.canonicalJson).toBe(before);
    expect(JSON.parse(before)).not.toHaveProperty('preflight');
    await f.append(f.start('static'));
    await expect(api.readRunPreflight(f.storage, f.runId)).rejects.toMatchObject(invalid);
  });

  it('covers every real static context and fallback without fabricating live receipts', async () => {
    const f = await fixture({ live: 'skip', nodes: ['worker', 'reviewer'], targets: [primary, backup] });
    await f.staticDone();
    await f.staticDone(1);
    expect((await snapshot(f)).state.phase).toBe('pending');
    await f.staticDone(0, undefined, { contextNodeId: 'reviewer', expectedSelection: f.selections[0] });
    await f.staticDone(1, undefined, { contextNodeId: 'reviewer', expectedSelection: f.selections[1] });
    const loaded = await snapshot(f);
    expect(loaded.state.phase).toBe('admitted');
    expect(loaded.probes.every((probe) => probe.start.payload.stage === 'static')).toBe(true);
    expect(loaded.admissionCompletedAtRevision).toBe(9);
  });

  it('accepts null context only for an unused lane', async () => {
    const f = await fixture({ live: 'skip', nodes: [] });
    await f.staticDone();
    expect((await snapshot(f)).state.phase).toBe('admitted');
    const used = await fixture();
    await used.append(used.start('static', 0, { contextNodeId: null }));
    await expect(snapshot(used)).rejects.toMatchObject(invalid);
  });

  it('preserves valid lane and node identifiers longer than envelope identifiers', async () => {
    const laneId = `lane-${'x'.repeat(300)}`;
    const nodeId = `node-${'y'.repeat(300)}`;
    const f = await fixture({ live: 'skip', laneId, nodes: [nodeId] });
    await f.staticDone();
    const loaded = await snapshot(f);
    expect(loaded.state.phase).toBe('admitted');
    expect(loaded.probes[0]!.start.payload).toMatchObject({ laneId, contextNodeId: nodeId });
  });

  it('rejects live work until static coverage includes every declared fallback', async () => {
    const f = await fixture({ targets: [primary, backup] });
    await f.staticDone();
    await f.append(f.start('live'));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it('rejects a second successful-lane live call while another lane is pending', async () => {
    const f = await fixture({ secondLane: true });
    await f.staticDone();
    await f.staticDone(0, undefined, { laneId: 'other-lane', contextNodeId: null });
    await f.liveDone();
    const loaded = await snapshot(f);
    expect(loaded.state.phase).toBe('pending');
    expect(loaded.admissionCompletedAtRevision).toBeNull();
    expect(loaded.probes.filter((probe) => probe.payload.stage === 'live')).toHaveLength(1);
    await f.append(f.start('live'));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it('allows another target before global admission only after the prior successful target is excluded', async () => {
    const f = await fixture({ secondLane: true, targets: [primary, backup] });
    for (let index = 0; index < 2; index++) {
      await f.staticDone(index);
      await f.staticDone(index, undefined, { laneId: 'other-lane', contextNodeId: null });
    }
    await f.liveDone();
    const otherProbe = f.start('live', 0, { laneId: 'other-lane' });
    const otherFinish = f.finish(otherProbe, {
      kind: 'failed', failure: 'quota', usage: { kind: 'unknown' }, effective: null,
      evidence: null, diagnostic: await f.diagnostic(otherProbe),
    });
    const otherFact = f.exclusion(otherProbe, otherFinish, 'quota', null);
    await f.append(otherProbe, otherFinish, { ...otherFact, payload: {
      ...(otherFact.payload as Record<string, JsonValue>),
      source: { kind: 'preflight', probeEventId: otherProbe.eventId, laneId: 'other-lane' },
    } });
    const changed = await snapshot(f);
    expect(changed.admissionCompletedAtRevision).toBeNull();
    expect([...changed.probeFailures.values()][0]!.exclusionKeys).toEqual(['provider-model:["provider-a","model-a"]']);
    const fallbackStart = f.start('live', 1);
    await f.append(fallbackStart);
    expect((await snapshot(f)).state.unfinishedProbeEventId).toBe(fallbackStart.eventId);
  });

  it('rejects an unused live backup while the successful receipt remains eligible', async () => {
    const f = await fixture({ secondLane: true, targets: [primary, backup] });
    for (let index = 0; index < 2; index++) {
      await f.staticDone(index);
      await f.staticDone(index, undefined, { laneId: 'other-lane', contextNodeId: null });
    }
    await f.liveDone();
    await f.append(f.start('live', 1));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it.each(['allow', 'block'] as const)('keeps unsupported static explicit under %s', async (unsupported) => {
    const f = await fixture({ live: 'skip', unsupported });
    await f.staticDone(0, { kind: 'unsupported' });
    const loaded = await snapshot(f);
    expect(loaded.probes[0]!.payload.outcome.kind).toBe('unsupported');
    expect(loaded.state.phase).toBe(unsupported === 'allow' ? 'admitted' : 'pending');
    if (unsupported === 'block') {
      await f.append(f.event('preflight:failed', { laneId: 'lane', code: 'PREFLIGHT_FAILED', reason: 'no-admissible-target' }));
      expect((await snapshot(f)).state.phase).toBe('failed');
      await f.append(f.start('static'));
      await expect(snapshot(f)).rejects.toMatchObject(invalid);
    }
  });

  it.each([
    ['accepts measured version and executable', null, 'admitted'],
    ['rejects a different adapter', { adapter: 'other-adapter' }, 'invalid'],
    ['rejects a different provider', { provider: 'provider-b' }, 'invalid'],
    ['rejects a different model family', { modelFamily: 'other-family' }, 'invalid'],
    ['rejects a different model', { model: 'other-model' }, 'invalid'],
  ] as const)('%s after unsupported static allow', async (_name, change, expected) => {
    const f = await fixture({ unsupported: 'allow' });
    const declared = engineSelection({
      adapter: primary.adapter, provider: primary.provider, modelFamily: primary.modelFamily,
      model: primary.model, executable: null, capabilities: primary.tools,
    });
    await f.staticDone(0, { kind: 'unsupported' }, { selection: declared });
    const probe = f.start('live', 0, { selection: declared });
    await f.append(probe);
    const requested = engineSelection({
      ...declared, adapterVersion: '9.9.9', executable: '/observed/fixture',
      ...(change ?? {}), capabilities: [],
    });
    const value = assistantResult({ text: 'ok', usage: f.result().usage, requested });
    const reference = await f.evidence(probe, value);
    await f.append(f.finish(probe, {
      kind: 'succeeded', usage: value.usage, effective: value.effective,
      evidence: reference, diagnostic: await f.diagnostic(probe),
    }));
    if (expected === 'invalid') {
      await expect(snapshot(f)).rejects.toMatchObject(invalid);
    } else {
      const loaded = await snapshot(f);
      expect(loaded.state.phase).toBe('admitted');
      expect(loaded.probes[1]!.evidence?.result.requested).toEqual(requested);
      expect(requested).toMatchObject({ adapterVersion: '9.9.9', executable: '/observed/fixture' });
      expect(declared).toMatchObject({ adapterVersion: null, executable: null });
    }
  });

  it('rejects nonempty requested capabilities after unsupported static allow', async () => {
    const f = await fixture({ unsupported: 'allow' });
    const declared = engineSelection({
      adapter: primary.adapter, provider: primary.provider, modelFamily: primary.modelFamily,
      model: primary.model, executable: null, capabilities: primary.tools,
    });
    await f.staticDone(0, { kind: 'unsupported' }, { selection: declared });
    const probe = f.start('live', 0, { selection: declared });
    await f.append(probe);
    const requested = engineSelection({
      ...declared, adapterVersion: '9.9.9', executable: '/observed/fixture', capabilities: ['Read'],
    });
    const value = assistantResult({ text: 'ok', usage: f.result().usage, requested });
    const reference = await f.evidence(probe, value);
    await f.append(f.finish(probe, {
      kind: 'succeeded', usage: value.usage, effective: value.effective,
      evidence: reference, diagnostic: await f.diagnostic(probe),
    }));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it.each([
    ['adapter version', { adapterVersion: '9.9.9' }],
    ['executable', { executable: '/different/fixture' }],
  ] as const)('requires the exact admitted %s in live evidence', async (_name, change) => {
    const f = await fixture();
    await f.staticDone();
    const probe = f.start('live');
    await f.append(probe);
    const requested = engineSelection({ ...liveSelection(f.selections[0]!), ...change });
    const value = assistantResult({ text: 'ok', usage: f.result().usage, requested });
    const reference = await f.evidence(probe, value);
    await f.append(f.finish(probe, {
      kind: 'succeeded', usage: value.usage, effective: value.effective,
      evidence: reference, diagnostic: await f.diagnostic(probe),
    }));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it('retains complete evidence, unknown usage, effective substitution and transport warning', async () => {
    const f = await fixture();
    await f.staticDone();
    const value: AgentResult = { ...f.result(), usage: { kind: 'unknown' },
      effective: engineSelection({ ...f.result().effective, model: 'observed-alias' }),
      transportFailure: { kind: 'transient', message: 'late transport warning', exitCode: 1 } };
    await f.liveDone(value);
    const loaded = await snapshot(f);
    expect(loaded.state.phase).toBe('admitted');
    expect(loaded.probes[1]!.evidence).toEqual({ kind: 'complete', result: value });
    expect(loaded.probes[1]!.payload.outcome).toMatchObject({ usage: { kind: 'unknown' }, effective: value.effective });
    expect(JSON.stringify(loaded.events)).not.toContain('late transport warning');
  });

  it.each(['complete', 'incomplete'])('never admits failed %s evidence', async (kind) => {
    const f = await fixture();
    await f.staticDone();
    const value: AgentResult = kind === 'complete' ? f.result() : {
      ...f.result(), parts: [{ kind: 'assistant', text: 'partial', final: false }],
    };
    const { paused } = await f.liveDone(value, 'failed', kind === 'complete' ? 'timeout' : 'unknown', kind);
    const loaded = await snapshot(f);
    expect(loaded.state).toMatchObject({ phase: 'paused', pause: { preflightEventId: paused.eventId } });
    expect(loaded.admissionCompletedAtRevision).toBeNull();
    expect(loaded.probes[1]!.evidence).toEqual({ kind, result: value });
    expect(loaded.probeFailures.size).toBe(0);
  });

  it.each(['static', 'live'] as const)('interrupts %s once with a real atomic finish and pause', async (stage) => {
    const f = await fixture();
    if (stage === 'live') await f.staticDone();
    const probe = f.start(stage);
    await f.append(probe);
    const before = await snapshot(f);
    const appends: { revision: number; events: DomainEventBatch }[] = [];
    const eventStore: EventStore = {
      ...f.storage.eventStore,
      read: f.storage.eventStore.read.bind(f.storage.eventStore),
      preflightAppend: f.storage.eventStore.preflightAppend.bind(f.storage.eventStore),
      async append(stream, revision, events) {
        appends.push({ revision, events });
        return f.storage.eventStore.append(stream, revision, events);
      },
    };
    const storage = { ...f.storage, eventStore };
    const paused = await api.interruptRunPreflight(storage, f.runId);
    expect(paused).toMatchObject({ kind: 'pause', code: 'PREFLIGHT_PAUSED', preflightEventId: expect.any(String) });
    expect(appends).toHaveLength(1);
    expect(appends[0]!.revision).toBe(before.revision);
    expect(appends[0]!.events.map((event) => event.type)).toEqual(['preflight:probe-finished', 'preflight:paused']);
    const loaded = await snapshot(f);
    expect(loaded.events.slice(0, before.events.length)).toEqual(before.events);
    const outcome = loaded.probes.at(-1)!.payload.outcome;
    expect(outcome).toEqual(stage === 'static' ? { kind: 'interrupted' } : {
      kind: 'interrupted', usage: { kind: 'unknown' }, effective: null, evidence: null, diagnostic: null,
    });
    expect(await api.interruptRunPreflight(storage, f.runId)).toEqual(paused);
    expect(appends).toHaveLength(1);
  });

  it('propagates a revision conflict without another append or a fabricated pause', async () => {
    const f = await fixture();
    await f.append(f.start('static'));
    let appends = 0;
    const storage = { ...f.storage, eventStore: {
      read: f.storage.eventStore.read.bind(f.storage.eventStore),
      preflightAppend: f.storage.eventStore.preflightAppend.bind(f.storage.eventStore),
      async append(stream, revision, events) {
        appends++;
        await f.storage.eventStore.append(stream, revision, [f.event('example:competing-write', {})]);
        return f.storage.eventStore.append(stream, revision, events);
      },
    } satisfies EventStore };
    await expect(api.interruptRunPreflight(storage, f.runId)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(appends).toBe(1);
    expect((await snapshot(f)).state).toMatchObject({ phase: 'pending', pause: null, unfinishedProbeEventId: expect.any(String) });
  });

  it('consumes the current pause once and permits a crash before the next start', async () => {
    const f = await fixture();
    const probe = f.start('static');
    const finished = f.finish(probe, { kind: 'interrupted' });
    const paused = f.pause(finished, 'interrupted');
    await f.append(probe, finished, paused);
    const resumed = f.resume(paused);
    await f.append(resumed);
    expect((await snapshot(f)).state).toEqual({ phase: 'pending', pause: null, resumedPreflightEventId: paused.eventId, unfinishedProbeEventId: null });
    expect(await api.interruptRunPreflight(f.storage, f.runId)).toBeNull();
    await f.staticDone();
    expect((await snapshot(f)).probes).toHaveLength(2);
    await f.append(f.resume(paused));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it('preserves historical admission through ordinary exclusions and static restoration', async () => {
    const f = await fixture();
    await f.staticDone();
    await f.liveDone();
    const first = await snapshot(f);
    await f.append(f.event('graph:model-unavailable', { ordinary: 'reader deliberately does not validate node payloads' }));
    await f.staticDone(0, undefined, { expectedSelection: f.selections[0] });
    const restored = await snapshot(f);
    expect(restored.state.phase).toBe('admitted');
    expect(restored.admissionCompletedAtRevision).toBe(first.admissionCompletedAtRevision);
    expect(restored.probes.filter((probe) => probe.start.payload.stage === 'live')).toHaveLength(1);
    await f.append(f.start('live'));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it.each(['extra', 'version', 'run', 'lane', 'target', 'context', 'selection', 'cause', 'unknown-type'])('rejects malformed start %s', async (shape) => {
    const f = await fixture();
    let probe = f.start('static');
    const payload = probe.payload as Record<string, JsonValue>;
    if (shape === 'extra') probe = { ...probe, payload: { ...payload, extra: true } };
    if (shape === 'version') probe = { ...probe, version: 2 };
    if (shape === 'run') probe = { ...probe, correlationId: 'other-run' };
    if (shape === 'lane') probe = { ...probe, payload: { ...payload, laneId: 'unknown' } };
    if (shape === 'target') probe = { ...probe, payload: { ...payload, target: { ...primary, tools: [] } } as JsonValue };
    if (shape === 'context') probe = { ...probe, payload: { ...payload, contextNodeId: 'unknown-node' } };
    if (shape === 'selection') probe = { ...probe, payload: { ...payload, selection: { ...f.selections[0], extra: true } } as JsonValue };
    if (shape === 'cause') probe = { ...probe, causationId: 'not-a-resume' };
    if (shape === 'unknown-type') probe = { ...probe, type: 'preflight:invented' };
    await f.append(probe);
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it.each(['double-start', 'orphan-finish', 'double-finish', 'stage', 'pause-without-finish', 'wrong-pause', 'double-pause', 'start-while-paused', 'stale-resume', 'retry-without-resume', 'false-all-dead'])('rejects sequence %s', async (shape) => {
    const f = await fixture();
    const probe = f.start('static');
    const finished = f.finish(probe, { kind: 'interrupted' });
    const paused = f.pause(finished, 'interrupted');
    if (shape === 'double-start') await f.append(probe, f.start('static'));
    if (shape === 'orphan-finish') await f.append(finished);
    if (shape === 'double-finish') await f.append(probe, finished, { ...finished, eventId: 'second-finish' });
    if (shape === 'stage') await f.append(probe, f.finish(probe, { kind: 'interrupted' }, 'live'));
    if (shape === 'pause-without-finish') await f.append(paused);
    if (shape === 'wrong-pause') await f.append(probe, finished, f.pause(finished, 'engine-failure'));
    if (shape === 'double-pause') await f.append(probe, finished, paused, { ...paused, eventId: 'second-pause' });
    if (shape === 'start-while-paused') await f.append(probe, finished, paused, f.start('static'));
    if (shape === 'stale-resume') await f.append(probe, finished, paused, f.event('preflight:resumed', { preflightEventId: 'stale' }, 'stale'));
    if (shape === 'retry-without-resume') await f.append(probe, finished, f.start('static'));
    if (shape === 'false-all-dead') await f.append(f.event('preflight:failed', { laneId: 'lane', code: 'PREFLIGHT_FAILED', reason: 'no-admissible-target' }));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it.each(['raw', 'assistant', 'usage-extra', 'usage-missing', 'negative-usage', 'identity-extra', 'transport-extra', 'document-extra', 'document-run', 'document-probe', 'document-version', 'incomplete-success', 'requested-mismatch', 'receipt-mismatch'])('rejects stored evidence %s', async (shape) => {
    const f = await fixture();
    await f.staticDone();
    const probe = f.start('live');
    await f.append(probe);
    const value = structuredClone(f.result()) as unknown as Record<string, unknown>;
    if (shape === 'raw') value.raw = { provider: 'raw' };
    if (shape === 'assistant') value.parts = [{ kind: 'assistant', text: {}, final: true }];
    if (shape === 'usage-extra') value.usage = { kind: 'unknown', inputTokens: 0 };
    if (shape === 'usage-missing') delete value.usage;
    if (shape === 'negative-usage') value.usage = { kind: 'reported', inputTokens: -1, outputTokens: 0 };
    if (shape === 'identity-extra') value.requested = { ...f.result().requested, extra: true };
    if (shape === 'transport-extra') value.transportFailure = { kind: 'unknown', message: 'warning', exitCode: 1, extra: true };
    if (shape === 'requested-mismatch') value.requested = { ...f.result().requested, model: 'other' };
    const overrides = shape === 'document-extra' ? { extra: true }
      : shape === 'document-run' ? { runId: 'other' }
      : shape === 'document-probe' ? { probeEventId: 'other' }
      : shape === 'document-version' ? { schemaVersion: 2 } : {};
    const reference = await f.evidence(probe, value, shape === 'incomplete-success' ? 'incomplete' : 'complete', overrides);
    await f.append(f.finish(probe, {
      kind: 'succeeded', usage: shape === 'receipt-mismatch' ? { kind: 'unknown' } : f.result().usage,
      effective: f.result().effective, evidence: reference, diagnostic: await f.diagnostic(probe),
    }));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it.each(['foreign', 'missing', 'corrupt', 'wrong-purpose', 'wrong-diagnostic'])('refuses %s artifacts without reinterpreting the call', async (kind) => {
    const f = await fixture();
    await f.staticDone();
    const probe = f.start('live');
    await f.append(probe);
    let reference: ArtifactReference = await f.evidence(probe, f.result(), 'complete', {}, kind === 'foreign');
    if (kind === 'missing' || kind === 'corrupt') {
      const blob = (await files(join(f.directory, 'artifacts'))).find((path) => path.endsWith(reference.digest.slice(7)));
      expect(blob).toBeDefined();
      if (kind === 'missing') await unlink(blob!);
      else { await chmod(blob!, 0o600); await writeFile(blob!, 'corrupt'); }
    }
    if (kind === 'wrong-purpose') reference = { ...reference, purpose: 'other' };
    const diagnostic = await f.diagnostic(probe, kind === 'wrong-diagnostic' ? { probeEventId: 'other' } : {});
    await f.append(f.finish(probe, { kind: 'succeeded', usage: f.result().usage, effective: f.result().effective, evidence: reference, diagnostic }));
    const code = kind === 'foreign' ? 'ARTIFACT_NOT_ADMITTED' : kind === 'missing' ? 'ARTIFACT_NOT_FOUND'
      : kind === 'corrupt' ? 'ARTIFACT_INTEGRITY' : 'INVALID_STORED_VALUE';
    await expect(snapshot(f)).rejects.toMatchObject({ code });
  });

  it('records artifact refusal metadata without the rejected bytes or an exclusion', async () => {
    const f = await fixture();
    await f.staticDone();
    const probe = f.start('live');
    await f.append(probe);
    await expect(f.evidence(probe, { ...f.result(), parts: [{ kind: 'assistant', text: 'private-probe-secret', final: true }] })).rejects.toMatchObject({ code: 'KNOWN_SECRET' });
    const finished = f.finish(probe, {
      kind: 'recording-failed', storageCode: 'KNOWN_SECRET', usage: f.result().usage,
      effective: f.result().effective, evidence: null, diagnostic: null,
    });
    await f.append(finished, f.pause(finished, 'recording-failure'));
    const loaded = await snapshot(f);
    expect(loaded.state.phase).toBe('paused');
    expect(loaded.probeFailures.size).toBe(0);
    expect(loaded.probes[1]!.payload.outcome).toMatchObject({ usage: f.result().usage, effective: f.result().effective });
    expect(JSON.stringify(loaded)).not.toContain('private-probe-secret');
  });

  it.each(['quota', 'billing'] as const)('projects %s without an effective observation but leaves stored values unchanged', async (failure) => {
    const f = await fixture({ provider: null });
    await f.staticDone();
    const probe = f.start('live');
    const finished = f.finish(probe, { kind: 'failed', failure, usage: { kind: 'unknown' }, effective: null, evidence: null, diagnostic: await f.diagnostic(probe) });
    const fact = f.exclusion(probe, finished, failure, null);
    await f.append(probe, finished, fact);
    const loaded = await snapshot(f);
    const parsed = loaded.probeFailures.get(fact.eventId)!;
    expect(parsed.fact.target).toEqual(primary);
    expect(parsed.fact.selection).toEqual(f.selections[0]);
    expect(parsed.fact.effective).toEqual(f.selections[0]);
    expect(parsed.exclusionKeys).toEqual(engineFailureExclusionKeys({
      selection: f.selections[0]!, effective: f.selections[0]!, target: primary, failure,
    }, [primary]));
    await f.append(f.event('preflight:failed', { laneId: 'lane', code: 'PREFLIGHT_FAILED', reason: 'no-admissible-target' }, finished.eventId));
    expect((await snapshot(f)).state.phase).toBe('failed');
  });

  it.each([
    ['auth', 'adapter-provider'], ['missing-cli', 'adapter'], ['invalid-config', 'adapter'],
    ['model-unavailable', 'provider-model'], ['billing', 'provider-model'], ['quota', 'provider-model'],
    ['rate-limit', null], ['transient', null], ['timeout', null], ['aborted', null], ['unknown', null],
  ] as const)('records plain %s with only its allowed exclusion', async (failure, scope) => {
    const f = await fixture();
    await f.staticDone();
    const probe = f.start('live');
    const finished = f.finish(probe, {
      kind: 'failed', failure, usage: { kind: 'unknown' }, effective: null,
      evidence: null, diagnostic: await f.diagnostic(probe),
    });
    const next = scope === null ? f.pause(finished) : f.exclusion(probe, finished, failure, null);
    await f.append(probe, finished, next);
    const loaded = await snapshot(f);
    const keys = [...loaded.probeFailures.values()].flatMap((fact) => fact.exclusionKeys);
    expect(keys).toEqual(scope === null ? [] : scope === 'adapter'
      ? ['adapter:["fixture"]'] : scope === 'adapter-provider'
        ? ['adapter-provider:["fixture","provider-a"]'] : ['provider-model:["provider-a","model-a"]']);
    expect(loaded.state.phase).toBe(scope === null ? 'paused' : 'pending');
  });

  it.each([
    ['static', 'rejects A/P/N after A/P/M auth', 1, false],
    ['static', 'permits A/Q/M after A/P/M auth', 2, true],
    ['static', 'permits B/P/M after A/P/M auth', 3, true],
    ['live', 'rejects A/P/N after A/P/M auth', 1, false],
    ['live', 'permits A/Q/M after A/P/M auth', 2, true],
    ['live', 'permits B/P/M after A/P/M auth', 3, true],
  ] as const)('%s failure %s', async (stage, _name, candidateIndex, accepted) => {
    const f = await fixture({ targets: authTargets, provider: null });
    const { fact } = await appendAuthFailure(f, stage);
    const loaded = await snapshot(f);
    const parsed = loaded.probeFailures.get(fact.eventId)!;
    expect(parsed.exclusionKeys).toEqual(['adapter-provider:["adapter-a","provider-p"]']);
    expect(parsed.fact.selection.provider).toBeNull();
    expect(JSON.stringify(parsed.fact.selection)).toBe(JSON.stringify(f.selections[0]));

    const continuation = f.start('live', candidateIndex);
    await f.append(continuation);
    const beforeReads = await storedEventBytes(f);
    if (accepted) {
      const first = await snapshot(f);
      const second = await snapshot(f);
      expect(first.state.unfinishedProbeEventId).toBe(continuation.eventId);
      expect(second.state).toEqual(first.state);
    } else {
      await expect(snapshot(f)).rejects.toMatchObject(invalid);
      await expect(snapshot(f)).rejects.toMatchObject(invalid);
    }
    expect(await storedEventBytes(f)).toBe(beforeReads);
  });

  it.each([
    ['static', 'A/Q', 2, 'provider-q', 2],
    ['live', 'B/Q', 4, 'provider-q', 4],
    ['live', 'B/null across P and Q', 3, null, 3],
  ] as const)('%s auth preserves reported %s and keeps it eligible', async (
    stage, _name, effectiveIndex, observedProvider, continuationIndex,
  ) => {
    const f = await fixture({ targets: authTargets, provider: null });
    const normalEffective = selected(authTargets[effectiveIndex], observedProvider);
    const effective = stage === 'live' ? liveSelection(normalEffective) : normalEffective;
    const { fact } = await appendAuthFailure(f, stage, effective);
    const first = await snapshot(f);
    const parsed = first.probeFailures.get(fact.eventId)!;
    expect(parsed.exclusionKeys).toEqual(['adapter-provider:["adapter-a","provider-p"]']);
    expect(JSON.stringify(parsed.fact.selection)).toBe(JSON.stringify(f.selections[0]));
    expect(JSON.stringify(parsed.fact.effective)).toBe(JSON.stringify(effective));
    if (observedProvider === null) {
      expect(f.targets.filter((target) => target.adapter === effective.adapter
        && target.modelFamily === effective.modelFamily && target.model === effective.model)
        .map((target) => target.provider).sort()).toEqual(['provider-p', 'provider-q']);
    }

    const continuation = f.start('live', continuationIndex);
    await f.append(continuation);
    const beforeReads = await storedEventBytes(f);
    const accepted = await snapshot(f);
    const repeated = await snapshot(f);
    expect(accepted.state.unfinishedProbeEventId).toBe(continuation.eventId);
    expect(repeated.state).toEqual(accepted.state);
    expect(JSON.stringify(repeated.probeFailures.get(fact.eventId)!.fact.effective)).toBe(JSON.stringify(effective));
    expect(await storedEventBytes(f)).toBe(beforeReads);
  });

  it.each([
    ['static', 'independent provider', [authPrimary, authSameAdapterModel]],
    ['live', 'independent adapter', [authPrimary, authOtherAdapterModel]],
  ] as const)('%s auth rejects false all-dead while an %s remains eligible', async (stage, _name, targets) => {
    const f = await fixture({ targets, provider: null });
    const { finished, fact } = await appendAuthFailure(f, stage);
    expect((await snapshot(f)).probeFailures.get(fact.eventId)!.exclusionKeys)
      .toEqual(['adapter-provider:["adapter-a","provider-p"]']);
    await f.append(f.event(
      'preflight:failed',
      { laneId: 'lane', code: 'PREFLIGHT_FAILED', reason: 'no-admissible-target' },
      finished.eventId,
    ));
    const beforeReads = await storedEventBytes(f);
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
    expect(await storedEventBytes(f)).toBe(beforeReads);
  });

  it('rejects a changed saved identity before a restoration can finish', async () => {
    const f = await fixture();
    await f.staticDone();
    await f.append(f.start('static', 0, { expectedSelection: { ...f.selections[0], adapterVersion: '9.9.9' } }));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it.each(['unchanged', 'distinct', 'ambiguous', 'missing'] as const)('uses one projection for nullable observed %s identity', async (caseName) => {
    const alternate = { ...primary, model: 'model-b' };
    const targets = caseName === 'unchanged' || caseName === 'missing' ? [primary]
      : caseName === 'distinct' ? [primary, alternate]
      : [primary, alternate, { ...alternate, provider: 'provider-b' }];
    const f = await fixture({ targets, provider: null });
    for (let index = 0; index < targets.length; index++) await f.staticDone(index);
    const effective = engineSelection({ ...liveSelection(f.selections[0]!), model: caseName === 'unchanged' ? primary.model : 'model-b' });
    const probe = f.start('live');
    const finished = f.finish(probe, { kind: 'failed', failure: 'quota', usage: { kind: 'unknown' }, effective, evidence: null, diagnostic: await f.diagnostic(probe) });
    const fact = f.exclusion(probe, finished, 'quota', effective);
    await f.append(probe, finished, fact);
    if (caseName === 'ambiguous' || caseName === 'missing') {
      await expect(snapshot(f)).rejects.toMatchObject({ code: 'ENGINE_IDENTITY_UNRESOLVED' });
    } else {
      const parsed = (await snapshot(f)).probeFailures.get(fact.eventId)!;
      expect(parsed.fact.effective).toEqual(effective);
      expect(parsed.exclusionKeys).toEqual(engineFailureExclusionKeys({
        selection: f.selections[0]!, effective: engineSelection({ ...effective, capabilities: primary.tools }), target: primary, failure: 'quota',
      }, targets));
    }
  });

  it.each(['missing', 'duplicate', 'wrong-target', 'wrong-failure', 'wrong-source', 'wrong-effective', 'extra', 'version'])('rejects probe exclusion %s', async (kind) => {
    const f = await fixture();
    const probe = f.start('static');
    const finished = f.finish(probe, { kind: 'failed', failure: 'auth', effective: null, diagnostic: await f.diagnostic(probe) });
    let fact = f.exclusion(probe, finished, 'auth', null);
    const payload = fact.payload as Record<string, JsonValue>;
    if (kind === 'wrong-target') fact = { ...fact, payload: { ...payload, target: backup } as unknown as JsonValue };
    if (kind === 'wrong-failure') fact = { ...fact, payload: { ...payload, failure: 'billing' } };
    if (kind === 'wrong-source') fact = { ...fact, payload: { ...payload, source: { kind: 'preflight', probeEventId: 'other', laneId: 'lane' } } };
    if (kind === 'wrong-effective') fact = { ...fact, payload: { ...payload, effective: selected(backup) } as unknown as JsonValue };
    if (kind === 'extra') fact = { ...fact, payload: { ...payload, identity: {} } };
    if (kind === 'version') fact = { ...fact, version: 2 };
    await f.append(probe, finished, ...(kind === 'missing' ? [] : [fact]), ...(kind === 'duplicate' ? [{ ...fact, eventId: 'duplicate-fact' }] : []));
    await expect(snapshot(f)).rejects.toMatchObject(invalid);
  });

  it('counts the first-record read separately from its one full captured traversal', async () => {
    const f = await fixture();
    await f.staticDone();
    const yielded: number[] = [];
    const storage = { ...f.storage, eventStore: {
      preflightAppend: f.storage.eventStore.preflightAppend.bind(f.storage.eventStore),
      append: f.storage.eventStore.append.bind(f.storage.eventStore),
      async *read(stream, after) {
        const index = yielded.push(0) - 1;
        for await (const envelope of f.storage.eventStore.read(stream, after)) {
          yielded[index] = yielded[index]! + 1;
          yield envelope;
        }
      },
    } satisfies EventStore };
    const loaded = await snapshot(f, storage);
    expect(yielded).toEqual([1, 3]);
    expect(loaded.events).toHaveLength(3);
    expect(loaded.revision).toBe(3);
    expect(loaded.events[0]!.eventId).toBe('run-start');
  });

  it('rejects a changed first record between definition loading and capture', async () => {
    const f = await fixture();
    let reads = 0;
    const storage = { ...f.storage, eventStore: {
      preflightAppend: f.storage.eventStore.preflightAppend.bind(f.storage.eventStore),
      append: f.storage.eventStore.append.bind(f.storage.eventStore),
      async *read(stream, after) {
        const current = ++reads;
        for await (const envelope of f.storage.eventStore.read(stream, after)) {
          yield current === 2 && envelope.revision === 1 ? { ...envelope, eventId: 'changed-first-record' } : envelope;
        }
      },
    } satisfies EventStore };
    await expect(snapshot(f, storage)).rejects.toMatchObject(invalid);
    expect(reads).toBe(2);
  });
});
