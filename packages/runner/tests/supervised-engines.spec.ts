import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EngineError, EngineIncompleteResultError,
  type AgentRequest, type AgentResult, type Engine, type EngineSelectionRecord,
} from '@obversa/engine';
import { validateArtifactReference, type JsonObject, type GraphEngineBinding, type RunStorageBinding } from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { superviseEngines } from '../src/supervised-engines.js';
import { readSupervision, supervisionWriter } from '../src/supervised-record.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

describe('supervised engine admission', () => {
  it('preserves absent admission without adding an undefined property', () => {
    const engine: Engine = { name: 'fixture', async run() { return result; } };
    const [wrapped] = superviseEngines([binding(engine)],
      supervisionWriter(storage, 'run'), storage, 'run');
    expect(wrapped!.engine.admit).toBeUndefined();
    expect(Object.hasOwn(wrapped!.engine, 'admit')).toBe(false);
  });

  it('captures admission once and forwards its receiver and exact arguments without model work', async () => {
    const writes = vi.spyOn(storage.artifactStore, 'write');
    const appends = vi.spyOn(storage.eventStore, 'append');
    const staticRequest: Omit<AgentRequest, 'prompt'> = {
      model: 'requested', tools: ['read'], allowedTools: ['Read'],
      workspaceMode: 'read', cwd: '/tmp', attempt: request.attempt,
    };
    const signal = new AbortController().signal;
    const measured: EngineSelectionRecord = { ...selection, adapterVersion: '2', capabilities: ['read'] };
    const expected: EngineSelectionRecord = { ...measured };
    const calls: Parameters<NonNullable<Engine['admit']>>[] = [];
    let reads = 0;
    let runs = 0;
    const engine: Engine = {
      name: 'fixture',
      async run() { runs += 1; return result; },
    };
    const admit: NonNullable<Engine['admit']> = async function (this: Engine, ...args) {
      expect(this).toBe(engine);
      calls.push(args);
      return measured;
    };
    Object.defineProperty(engine, 'admit', {
      get() { reads += 1; return admit; },
    });
    const [wrapped] = superviseEngines([binding(engine)],
      supervisionWriter(storage, 'run'), storage, 'run');
    const originalSelection = wrapped!.selection;

    expect(reads).toBe(1);
    expect(await wrapped!.engine.admit!(staticRequest, signal, expected)).toBe(measured);
    expect(await wrapped!.engine.admit!(staticRequest, signal)).toBe(measured);
    expect(reads).toBe(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]).toBe(staticRequest);
      expect(call[1]).toBe(signal);
    }
    expect(calls[0]![2]).toBe(expected);
    expect(calls[1]![2]).toBeUndefined();
    expect(runs).toBe(0);
    expect(appends).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(wrapped!.selection).toBe(originalSelection);
    expect(wrapped!.selection).toEqual(selection);
    expect(Object.isFrozen(wrapped!.selection)).toBe(true);
    expect(Object.isFrozen(wrapped!.engine)).toBe(true);
  });

  it.each(['success', 'incomplete', 'plain-error'] as const)(
    'forwards a %s probe without ordinary records or artifacts', async (outcome) => {
      const writes = vi.spyOn(storage.artifactStore, 'write');
      const appends = vi.spyOn(storage.eventStore, 'append');
      const probe: AgentRequest = { ...request, purpose: 'preflight' };
      const signal = new AbortController().signal;
      const streamed = { type: 'text' as const, delta: 'probe progress' };
      const events: unknown[] = [];
      const onEvent = (event: unknown): void => { events.push(event); };
      const completed: AgentResult = {
        ...result, transportFailure: { kind: 'transient', message: 'after final', exitCode: 7 },
      };
      const failure = outcome === 'incomplete'
        ? new EngineIncompleteResultError('probe incomplete', {
          ...result, parts: [{ kind: 'assistant', text: 'partial', final: false }],
          transportFailure: { kind: 'timeout', message: 'probe stopped', exitCode: 9 },
        })
        : new Error('probe failed');
      let calls = 0;
      const engine: Engine = {
        name: 'fixture',
        run(actual, sink, actualSignal) {
          calls += 1;
          expect(this).toBe(engine);
          expect(actual).toBe(probe);
          expect(sink).toBe(onEvent);
          expect(actualSignal).toBe(signal);
          sink(streamed);
          if (outcome === 'plain-error') throw failure;
          if (outcome === 'incomplete') return Promise.reject(failure);
          return Promise.resolve(completed);
        },
      };
      const [wrapped] = superviseEngines([binding(engine)],
        supervisionWriter(storage, 'run'), storage, 'run');
      const pending = wrapped!.engine.run(probe, onEvent, signal);
      if (outcome === 'success') expect(await pending).toBe(completed);
      else await expect(pending).rejects.toBe(failure);
      expect(calls).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toBe(streamed);
      expect(appends).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
      expect(await readSupervision(storage, 'run')).toEqual([]);
    },
  );

  it.each(['success', 'incomplete', 'plain-error'] as const)(
    'keeps normal admission metadata in ordinary %s records after explicit and inner probe admission', async (outcome) => {
      const measured: EngineSelectionRecord = { ...selection, adapterVersion: '2', capabilities: ['read'] };
      const probeSelection: EngineSelectionRecord = { ...measured, capabilities: [] };
      const normal: Omit<AgentRequest, 'prompt'> = { model: 'requested', tools: ['read'] };
      const probe: AgentRequest = { ...request, purpose: 'preflight', tools: [] };
      const signal = new AbortController().signal;
      const completed: AgentResult = { ...result, requested: measured };
      const failure = outcome === 'incomplete'
        ? new EngineIncompleteResultError('ordinary incomplete', {
          ...completed, parts: [{ kind: 'assistant', text: 'partial', final: false }],
        })
        : new Error('ordinary failed');
      let probeAdmissions = 0;
      const engine: Engine = {
        name: 'fixture',
        async admit(actual) {
          expect(this).toBe(engine);
          if (actual.purpose === 'preflight') {
            probeAdmissions += 1;
            return probeSelection;
          }
          return measured;
        },
        async run(actual, _sink, actualSignal) {
          expect(this).toBe(engine);
          if (actual.purpose === 'preflight') {
            const { prompt: _prompt, ...withoutPrompt } = actual;
            await this.admit!(withoutPrompt, actualSignal);
            return { ...result, requested: probeSelection };
          }
          if (outcome !== 'success') throw failure;
          return completed;
        },
      };
      const [wrapped] = superviseEngines([binding(engine)],
        supervisionWriter(storage, 'run'), storage, 'run');
      const originalSelection = wrapped!.selection;
      expect(await wrapped!.engine.admit!(normal, signal)).toBe(measured);
      const { prompt: _prompt, ...probeAdmission } = probe;
      expect(await wrapped!.engine.admit!(probeAdmission, signal)).toBe(probeSelection);
      await wrapped!.engine.run(probe, () => {}, signal);
      expect(probeAdmissions).toBe(2);
      expect(await readSupervision(storage, 'run')).toEqual([]);

      const pending = wrapped!.engine.run(request, () => {}, signal);
      if (outcome === 'success') expect(await pending).toBe(completed);
      else await expect(pending).rejects.toBe(failure);
      const records = await readSupervision(storage, 'run');
      expect(records.map((record) => record.type)).toEqual([
        'runner:engine-started', outcome === 'success' ? 'runner:engine-completed' : 'runner:engine-failed',
      ]);
      for (const record of records) expect((record.payload as JsonObject).selected).toEqual(measured);
      const terminal = records[1]!.payload as JsonObject;
      expect(terminal.requested).toEqual(measured);
      if (outcome === 'plain-error') {
        expect(terminal.usage).toEqual({ kind: 'unknown' });
        expect(terminal.partsArtifact).toBeNull();
      } else {
        expect(terminal.usage).toEqual(result.usage);
        expect(terminal.effective).toEqual(effective);
        expect(await storedParts(terminal)).toEqual(outcome === 'success'
          ? result.parts : [{ kind: 'assistant', text: 'partial', final: false }]);
      }
      expect(wrapped!.selection).toBe(originalSelection);
      expect(wrapped!.selection).toEqual(selection);
    },
  );

  it.each([false, true])(
    'uses purpose at admission entry despite caller mutation (initial preflight=%s)', async (initiallyPreflight) => {
      const measured: EngineSelectionRecord = { ...selection, adapterVersion: '2' };
      const staticRequest: Omit<AgentRequest, 'prompt'> = {
        model: 'requested', ...(initiallyPreflight ? { purpose: 'preflight' as const } : {}),
      };
      const signal = new AbortController().signal;
      let finish!: (value: EngineSelectionRecord) => void;
      const held = new Promise<EngineSelectionRecord>((resolve) => { finish = resolve; });
      let entered = false;
      const ordinarySelection = initiallyPreflight ? selection : measured;
      const engine: Engine = {
        name: 'fixture',
        admit(actual, actualSignal) {
          expect(this).toBe(engine);
          expect(actual).toBe(staticRequest);
          expect(actualSignal).toBe(signal);
          expect(actual.purpose === 'preflight').toBe(initiallyPreflight);
          entered = true;
          return held;
        },
        async run() { return { ...result, requested: ordinarySelection }; },
      };
      const [wrapped] = superviseEngines([binding(engine)],
        supervisionWriter(storage, 'run'), storage, 'run');

      const pending = wrapped!.engine.admit!(staticRequest, signal);
      expect(entered).toBe(true);
      if (initiallyPreflight) delete staticRequest.purpose;
      else staticRequest.purpose = 'preflight';
      finish(measured);
      expect(await pending).toBe(measured);
      expect(staticRequest.purpose === 'preflight').toBe(!initiallyPreflight);
      expect(await readSupervision(storage, 'run')).toEqual([]);
      await wrapped!.engine.run(request, () => {}, signal);
      const records = await readSupervision(storage, 'run');
      expect(records.map((record) => record.type)).toEqual(['runner:engine-started', 'runner:engine-completed']);
      for (const record of records) {
        expect((record.payload as JsonObject).selected).toEqual(ordinarySelection);
      }
      expect(wrapped!.selection).toEqual(selection);
    },
  );

  it('preserves prior normal selection when later admission rejects', async () => {
    const measured: EngineSelectionRecord = { ...selection, adapterVersion: '2' };
    const failure = new Error('admission refused');
    const signal = new AbortController().signal;
    const staticRequest: Omit<AgentRequest, 'prompt'> = { model: 'requested' };
    let admissions = 0;
    const engine: Engine = {
      name: 'fixture',
      async admit() {
        admissions += 1;
        if (admissions > 1) throw failure;
        return measured;
      },
      async run() { return { ...result, requested: measured }; },
    };
    const [wrapped] = superviseEngines([binding(engine)],
      supervisionWriter(storage, 'run'), storage, 'run');
    await wrapped!.engine.admit!(staticRequest, signal);
    await expect(wrapped!.engine.admit!(staticRequest, signal)).rejects.toBe(failure);
    expect(await readSupervision(storage, 'run')).toEqual([]);
    await wrapped!.engine.run(request, () => {}, signal);
    const records = await readSupervision(storage, 'run');
    expect(records.map((record) => record.type)).toEqual(['runner:engine-started', 'runner:engine-completed']);
    for (const record of records) expect((record.payload as JsonObject).selected).toEqual(measured);
  });
});
