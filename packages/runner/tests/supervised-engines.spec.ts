import { describe, expect, it } from 'vitest';
import { EngineError, EngineIncompleteResultError, type AgentRequest, type AgentResult, type Engine } from '@obversa/engine';
import type { JsonObject, GraphEngineBinding } from '@obversa/runtime';
import { superviseEngines } from '../src/supervised-engines.js';

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
    const wrapped = superviseEngines([original], async (type, payload) => { records.push({ type, payload }); });
    expect(await wrapped[0]!.engine.run(request, onEvent, signal)).toBe(result);
    expect(events).toEqual([{ type: 'text', delta: 'progress' }]);
    expect(records).toEqual([
      { type: 'engine-started', payload: { attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection } },
      { type: 'engine-completed', payload: {
        attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection,
        parts: [{ kind: 'assistant', text: 'done', final: true }],
        usage: { kind: 'reported', inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2 },
        requested: selection, effective,
      } },
    ]);
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
      async (type, payload) => { records.push({ type, payload }); });
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(records[1]).toEqual({ type: 'engine-failed', payload: {
      attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection,
      parts: [{ kind: 'assistant', text: 'partial', final: false }],
      usage: { kind: 'reported', inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 2 },
      requested: selection, effective,
      transportFailure: { kind: 'timeout', message: 'transport ended', exitCode: 9 },
    } });
    expect(JSON.stringify(records)).not.toMatch(/private-/u);
  });

  it('records unknown usage for a synchronous throw without inventing effective identity', async () => {
    const failure = new Error('private-error');
    const records: JsonObject[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', run() { throw failure; } })],
      async (_type, payload) => { records.push(payload); });
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(records[1]).toEqual({
      attemptId: 'attempt', position: 'position', nodeId: 'node', selected: selection,
      usage: { kind: 'unknown' }, parts: [], requested: selection, effective: null,
    });
  });

  it('does not call an engine if its start record cannot be appended', async () => {
    const failure = new Error('storage');
    let calls = 0;
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { calls += 1; return result; } })],
      async () => { throw failure; });
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(calls).toBe(0);
  });

  it('keeps a typed engine failure effective identity without inventing usage', async () => {
    const failure = new EngineError({ kind: 'timeout', message: 'private-error', effective });
    const records: JsonObject[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { throw failure; } })],
      async (_type, payload) => { records.push(payload); });
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBe(failure);
    expect(records[1]!.effective).toEqual(effective);
    expect(records[1]!.usage).toEqual({ kind: 'unknown' });
  });

  it('does not admit an invalid success result or lose its failed-call record', async () => {
    const records: { type: string; payload: JsonObject }[] = [];
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { return { ...result, parts: [] }; } })],
      async (type, payload) => { records.push({ type, payload }); });
    await expect(wrapped!.engine.run(request, () => {}, new AbortController().signal)).rejects.toBeInstanceOf(TypeError);
    expect(records.map((record) => record.type)).toEqual(['engine-started', 'engine-failed']);
    expect(records[1]!.payload.usage).toEqual({ kind: 'unknown' });
  });

  it('does not turn a failed completion append into another engine failure record', async () => {
    const failure = new Error('storage');
    const types: string[] = [];
    const completed: AgentResult = { ...result, transportFailure: { kind: 'transient', message: 'transport ended', exitCode: 7 } };
    const [wrapped] = superviseEngines([binding({ name: 'fixture', async run() { return completed; } })],
      async (type) => { types.push(type); if (type === 'engine-completed') throw failure; });
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
      async (type) => { if (type === 'engine-failed') throw appendFailure; });
    const caught = await wrapped!.engine.run(request, () => {}, new AbortController().signal).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(EngineIncompleteResultError);
    expect(caught).toMatchObject({ evidence: failure.evidence, cause: { errors: [failure, appendFailure] } });
  });
});
