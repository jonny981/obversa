import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EngineError, EngineIncompleteResultError, type AgentRequest, type AgentResult, type Engine } from '@obversa/engine';
import { validateArtifactReference, type JsonObject, type GraphEngineBinding, type RunStorageBinding } from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { superviseEngines } from '../src/supervised-engines.js';
import { readSupervision, supervisionWriter } from '../src/supervised-record.js';
import { vi } from 'vitest';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000 });

const selection = {
  adapter: 'fixture', adapterVersion: '1', provider: 'provider', modelFamily: 'family',
  model: 'requested', executable: null, capabilities: [],
} as const;
const effective = { ...selection, model: 'effective' };
const request: AgentRequest = {
  prompt: 'private-prompt', env: { TOKEN: 'private-env' },
  attempt: { leaf: true, runId: 'run', attemptId: 'attempt', leafId: 'node', path: ['position'], label: 'private-label', iteration: 0 },
};
const result: AgentResult = {
  parts: [{ kind: 'assistant', text: 'done', final: true }],
  usage: { kind: 'reported', inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2 },
  requested: selection, effective, raw: { secret: 'private-raw' },
};

function binding(engine: Engine): GraphEngineBinding {
  return { engine, selection, hardTokenLimitEnforceable: false,
    target: { adapter: 'fixture', provider: 'provider', modelFamily: 'family', model: 'requested', tools: [] } };
}

const roots: string[] = [];
let storage: RunStorageBinding;

async function localStorage(maxArtifactBytes = 1_000_000): Promise<RunStorageBinding> {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-supervised-engines-'));
  roots.push(directory);
  return createLocalRunStorage({
    directory, namespace: 'engine-tests',
    policy: {
      schemaVersion: 1, maxEventPayloadBytes: 128_000, maxAppendBatchBytes: 256_000,
      maxArtifactBytes, maxTotalArtifactBytesPerRun: 4_000_000,
      retention: 'until-run-delete',
      sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
    },
  });
}

async function storedParts(payload: JsonObject): Promise<unknown> {
  const reference = validateArtifactReference(payload.partsArtifact);
  const bytes = await storage.artifactStore.read({ namespace: 'engine-tests', runId: 'run' }, reference);
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}

beforeEach(async () => { storage = await localStorage(); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('supervised engine evidence', () => {
  it('records before the call and retains success evidence while preserving engine this and arguments', async () => {
    const records: { type: string; payload: JsonObject }[] = [];
    const events: unknown[] = [];
    const signal = new AbortController().signal;
    const onEvent = (event: unknown): void => { events.push(event); };
    const engine: Engine = {
      name: 'fixture',
      async run(actual, sink, actualSignal) {
        expect(this).toBe(engine);
        expect(actual).toBe(request);
        expect(sink).toBe(onEvent);
        expect(actualSignal).toBe(signal);
        expect(records.map((record) => record.type)).toEqual(['engine-started']);
        sink({ type: 'text', delta: 'progress' });
        return result;
      },
    };
    const original = binding(engine);
    const wrapped = superviseEngines([original], async (type, payload) => { records.push({ type, payload }); }, storage, 'run');
    expect(await wrapped[0]!.engine.run(request, onEvent, signal)).toBe(result);
    expect(events).toEqual([{ type: 'text', delta: 'progress' }]);
    expect(records[0]).toEqual(
      { type: 'engine-started', payload: { attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection } },
    );
    expect(records[1]).toEqual({ type: 'engine-completed', payload: {
        attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection,
        partsArtifact: expect.any(Object),
        usage: { kind: 'reported', inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2 },
        requested: selection, effective,
      } });
    expect(await storedParts(records[1]!.payload)).toEqual([{ kind: 'assistant', text: 'done', final: true }]);
    expect(JSON.stringify(records)).not.toMatch(/private-/u);
    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(Object.isFrozen(wrapped[0])).toBe(true);
    expect(Object.isFrozen(wrapped[0]!.engine)).toBe(true);
    expect(Object.isFrozen(wrapped[0]!.target.tools)).toBe(true);
    expect(Object.isFrozen(original.target.tools)).toBe(false);
  });

  it('retains incomplete parts, measured usage and transport evidence and rethrows the same failure', async () => {
    const failure = new EngineIncompleteResultError('private-error', {
      ...result, parts: [{ kind: 'assistant', text: 'partial', final: false }],
      transportFailure: { kind: 'timeout', message: 'transport ended', exitCode: 9 },
    });
    const records: { type: string; payload: JsonObject }[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { throw failure; } })],
      async (type, payload) => { records.push({ type, payload }); }, storage, 'run');
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(records[1]).toEqual({ type: 'engine-failed', payload: {
      attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection,
      partsArtifact: expect.any(Object),
      usage: { kind: 'reported', inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2 },
      requested: selection, effective,
      transportFailure: { kind: 'timeout', message: 'transport ended', exitCode: 9 },
    } });
    expect(await storedParts(records[1]!.payload)).toEqual([{ kind: 'assistant', text: 'partial', final: false }]);
    expect(JSON.stringify(records)).not.toMatch(/private-/u);
  });

  it('records unknown usage for a synchronous throw without inventing effective identity', async () => {
    const failure = new Error('private-error');
    const records: JsonObject[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', run() { throw failure; } })],
      async (_type, payload) => { records.push(payload); }, storage, 'run');
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(records[1]).toEqual({
      attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection,
      usage: { kind: 'unknown' }, partsArtifact: null, requested: selection, effective: null,
    });
  });

  it('does not call an engine if its start record cannot be appended', async () => {
    const failure = new Error('storage');
    let calls = 0;
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { calls += 1; return result; } })],
      async () => { throw failure; }, storage, 'run');
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(calls).toBe(0);
  });

  it('keeps a typed engine failure effective identity without inventing usage', async () => {
    const failure = new EngineError({ kind: 'timeout', message: 'private-error', effective });
    const records: JsonObject[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { throw failure; } })],
      async (_type, payload) => { records.push(payload); }, storage, 'run');
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(records[1]!.effective).toEqual(effective);
    expect(records[1]!.usage).toEqual({ kind: 'unknown' });
  });

  it('does not admit an invalid success result or lose its failed-call record', async () => {
    const records: { type: string; payload: JsonObject }[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { return { ...result, parts: [] }; } })],
      async (type, payload) => { records.push({ type, payload }); }, storage, 'run');
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBeInstanceOf(TypeError);
    expect(records.map((record) => record.type)).toEqual(['engine-started', 'engine-failed']);
    expect(records[1]!.payload.usage).toEqual({ kind: 'unknown' });
  });

  it('does not turn a failed completion append into another engine failure record', async () => {
    const failure = new Error('storage');
    const types: string[] = [];
    const completed: AgentResult = { ...result, transportFailure: { kind: 'transient', message: 'transport ended', exitCode: 7 } };
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { return completed; } })],
      async (type) => { types.push(type); if (type === 'engine-completed') throw failure; }, storage, 'run');
    const caught = await wrapped!.engine.run(request, () => {}, new AbortController().signal).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineIncompleteResultError);
    expect(caught).toMatchObject({ cause: failure, evidence: {
      parts: [{ kind: 'assistant', text: 'done', final: true }],
      usage: { kind: 'reported', inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2 },
      requested: selection, effective,
      transportFailure: { kind: 'transient', message: 'transport ended', exitCode: 7 },
    } });
    expect(types).toEqual(['engine-started', 'engine-completed']);
  });

  it('retains the original incomplete failure if appending that failure also fails', async () => {
    const failure = new EngineIncompleteResultError('engine', { ...result, parts: [] });
    const appendFailure = new Error('storage');
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { throw failure; } })],
      async (type) => { if (type === 'engine-failed') throw appendFailure; }, storage, 'run');
    const caught = await wrapped!.engine.run(request, () => {}, new AbortController().signal).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineIncompleteResultError);
    expect(caught).toMatchObject({ evidence: failure.evidence, cause: { errors: [failure, appendFailure] } });
  });

  it('stores large incomplete parts outside the supervision event and rethrows the same failure', async () => {
    const parts = [{ kind: 'assistant' as const, text: 'x'.repeat(200_000), final: false }];
    const failure = new EngineIncompleteResultError('engine', { ...result, parts });
    const [wrapped] = superviseEngines(
      [binding({ name: 'fixture', async run() { throw failure; } })],
      supervisionWriter(storage, 'run'), storage, 'run',
    );

    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    const failed = (await readSupervision(storage, 'run')).find((event) => event.type === 'runner:engine-failed')!;
    expect(failed.payload).not.toHaveProperty('parts');
    expect(await storedParts(failed.payload as JsonObject)).toEqual(parts);
  });

  it('retains complete evidence when its parts artifact exceeds storage policy', async () => {
    storage = await localStorage(1);
    const types: string[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { return result; } })],
      async (type) => { types.push(type); }, storage, 'run');

    const caught = await wrapped!.engine.run(request, () => {}, new AbortController().signal).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineIncompleteResultError);
    expect(caught).toMatchObject({ evidence: result });
    expect(types).toEqual(['engine-started']);
  });

  it('retains original incomplete evidence when its parts artifact exceeds storage policy', async () => {
    storage = await localStorage(1);
    const failure = new EngineIncompleteResultError('engine', {
      ...result, parts: [{ kind: 'assistant', text: 'partial', final: false }],
    });
    const types: string[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { throw failure; } })],
      async (type) => { types.push(type); }, storage, 'run');

    const caught = await wrapped!.engine.run(request, () => {}, new AbortController().signal).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineIncompleteResultError);
    expect(caught).toMatchObject({ evidence: failure.evidence, cause: { errors: [failure, expect.any(Error)] } });
    expect(types).toEqual(['engine-started']);
  });
});
