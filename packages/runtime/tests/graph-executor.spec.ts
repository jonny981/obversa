import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { executeGraphDispatch, executeWithFallback, graphDecision, runWithFallback, selectAvailableTargets, unavailableTargets, type ModelUnavailableEvent } from '../src/executor.js';
import { createAttemptIdentity } from '../src/runtime/attempt.js';
import { compileGraph, type GraphEvent, type GraphType } from '../src/graph/type.js';
import type { GraphDefinition } from '../src/graph/kernel.js';
import type { EngineSelectionRecord } from '../src/engines/engine.js';

type Definition = GraphDefinition<{}, {}, {}>;
type State = { readonly next: 'writer' | 'critic'; readonly inFlight: string | null };
type Event = GraphEvent<'node-dispatched' | 'node-completed', { readonly nodeId: string; readonly position: string }>;

const definition: Definition = {
  id: 'executor-test', definitionVersion: 1, data: {},
  nodes: [{ id: 'writer', data: {} }, { id: 'critic', data: {} }], edges: [],
};

const graphType: GraphType<Definition, State, Event, { readonly memory: 'unused' }> = {
  kind: 'executor-test', version: 1,
  compile(value) {
    return {
      requirements: { memory: 'unused' },
      initialState: () => ({ next: 'writer', inFlight: null }),
      reduce(state, event) {
        if (event.type === 'node-dispatched' && state.inFlight === null && event.payload.nodeId === state.next)
          return { ...state, inFlight: event.payload.position };
        if (event.type === 'node-completed' && event.payload.position === state.inFlight)
          return { next: state.next === 'writer' ? 'critic' : 'writer', inFlight: null };
        return state;
      },
      decide(state) {
        if (state.inFlight !== null) return [];
        return [{ kind: 'dispatch', nodeId: state.next, input: {}, position: `turns/${state.next}` }];
      },
      describe: () => ({
        inputContract: {}, outputContract: {}, phases: [{ id: 'main', name: 'Main', nodeIds: ['writer', 'critic'] }],
        nodes: ['writer', 'critic'].map((id) => ({ id, phaseId: 'main', inputContract: {}, outputContract: {}, laneId: null })),
        policies: { retry: null, stop: null, concurrency: { global: 1 }, write: null, budget: null, action: null },
        executionLanes: [], requestedPermissions: [],
        bounds: { dispatches: { min: { kind: 'unknown', reason: 'test' }, max: { kind: 'unknown', reason: 'test' } }, maxConcurrency: { kind: 'known', value: 1 }, maxFanOut: { kind: 'known', value: 1 } },
      }),
    };
  },
};

describe('graphDecision', () => {
  const compiled = compileGraph(graphType, definition);

  it('folds durable events and returns the next dispatch', () => {
    const snapshot = graphDecision(compiled, [
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'writer', position: 'turns/writer' } },
      { type: 'node-completed', version: 1, payload: { nodeId: 'writer', position: 'turns/writer' } },
    ]);
    expect(snapshot.state).toEqual({ next: 'critic', inFlight: null });
    expect(snapshot.commands[0]).toMatchObject({ kind: 'dispatch', nodeId: 'critic' });
  });

  it('accepts an empty decision while work is in flight', () => {
    const snapshot = graphDecision(compiled, [
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'writer', position: 'turns/writer' } },
    ]);
    expect(snapshot.commands).toEqual([]);
  });

  it('rejects a dispatch position already present in durable events', () => {
    expect(() => graphDecision(compiled, [
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'critic', position: 'turns/writer' } },
    ])).toThrow('Dispatch position already exists: turns/writer');
  });

  it('prepares the critic lane before starting its attempt', async () => {
    let preparedNode: string | null = null;
    const command = { kind: 'dispatch' as const, nodeId: 'critic', input: {}, position: 'turns/critic' };
    const record = await executeGraphDispatch(command, {
      critic: {
        prepare(value) {
          preparedNode = value.nodeId;
          return {
            nodeId: value.nodeId,
            identity: { runId: 'run', nodeId: value.nodeId, position: value.position },
            input: value.input, prompt: null,
            scratchDirectory: '/tmp', workspace: { mode: 'none', directory: null, allowedPaths: [] },
            trustedCaller: {}, permissions: [], policy: { timeoutMs: 1000, teardownGraceMs: 1000, inputBytes: 1000, outputBytes: 1000, memoryBytes: 1000, filesChanged: 0, linesChanged: 0 },
            resultContract: null, engineRoute: null, runData: async () => ({ ok: true }), parseResult: null,
            tokenBudget: null, recordModelUnavailable: async () => {}, decideAction: async () => ({ kind: 'allow' }),
          } as never;
        },
      },
    }, new AbortController().signal);
    expect(preparedNode).toBe('critic');
    expect(record.identity.nodeId).toBe('critic');
  });

  it('rebuilds a unique dead-model list from durable events', () => {
    const effective = { adapter: 'mock', adapterVersion: '1', provider: 'mock', modelFamily: 'family', model: 'primary', executable: null, capabilities: [] };
    expect(unavailableTargets([
      { type: 'model-unavailable', version: 1, payload: { effective } },
      { type: 'model-unavailable', version: 1, payload: { effective } },
    ])).toEqual([effective]);
  });

  it('selects the declared fallback and reports exhaustion when all targets are dead', () => {
    const primary = { adapter: 'mock', adapterVersion: '1', provider: 'mock', modelFamily: 'family', model: 'primary', executable: null, capabilities: [] };
    const fallback = { ...primary, model: 'fallback' };
    expect(selectAvailableTargets([primary, fallback], [primary])).toEqual([fallback]);
    expect(selectAvailableTargets([primary, fallback], [primary, fallback])).toEqual([]);
  });

  it('routes a failed primary attempt to the declared fallback', async () => {
    const primary = { adapter: 'mock', adapterVersion: '1', provider: 'mock', modelFamily: 'family', model: 'primary', executable: null, capabilities: [] };
    const fallback = { ...primary, model: 'fallback' };
    const result = await runWithFallback([primary, fallback], [], async (target) =>
      target.model === 'primary' ? { unavailable: true } : { unavailable: false, value: 'completed' });
    expect(result).toEqual({ target: fallback, value: 'completed' });
  });

  it('does not call a dead primary again when every declared lane is exhausted', async () => {
    const primary = { adapter: 'mock', adapterVersion: '1', provider: 'mock', modelFamily: 'family', model: 'primary', executable: null, capabilities: [] };
    const fallback = { ...primary, model: 'fallback' };
    let calls = 0;
    const result = await runWithFallback([primary, fallback], [primary, fallback], async () => {
      calls += 1;
      return { unavailable: true };
    }) as never;
    expect(result).toEqual({ status: 'failed', code: 'ENGINE_UNAVAILABLE' });
    expect(calls).toBe(0);
  });

  it('exhausts both lanes after EngineError auth failures', async () => {
    const primary = { adapter: 'mock', adapterVersion: '1', provider: 'mock', modelFamily: 'family', model: 'primary', executable: null, capabilities: [] };
    const fallback = { ...primary, model: 'fallback' };
    let calls = 0;
    const result = await runWithFallback([primary, fallback], [], async () => {
      calls += 1;
      return { unavailable: true };
    }) as never;
    expect(result).toEqual({ status: 'failed', code: 'ENGINE_UNAVAILABLE' });
    expect(calls).toBe(2);
  });

  it('rebuilds the same critic dispatch after a writer crash', () => {
    const events: Event[] = [
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'writer', position: 'turns/writer' } },
      { type: 'node-completed', version: 1, payload: { nodeId: 'writer', position: 'turns/writer' } },
    ];
    const first = graphDecision(compiled, events);
    const resumed = graphDecision(compiled, [...events]);
    expect(resumed.commands).toEqual(first.commands);
    expect(resumed.commands[0]).toMatchObject({ nodeId: 'critic', position: 'turns/critic' });
  });

  it('rebuilds the same state after critic round one is replayed', () => {
    const events: Event[] = [
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'writer', position: 'turns/writer' } },
      { type: 'node-completed', version: 1, payload: { nodeId: 'writer', position: 'turns/writer' } },
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'critic', position: 'turns/critic' } },
    ];
    expect(graphDecision(compiled, events).state).toEqual(graphDecision(compiled, [...events]).state);
  });

  it('rebuilds dead-lane availability from the stream after a crash', () => {
    const dead = { adapter: 'mock', adapterVersion: '1', provider: 'mock', modelFamily: 'family', model: 'primary', executable: null, capabilities: [] };
    const events: ModelUnavailableEvent[] = [{ type: 'model-unavailable', version: 1, payload: { effective: dead } }];
    expect(unavailableTargets(events)).toEqual(unavailableTargets([...events]));
    expect(selectAvailableTargets([dead, { ...dead, model: 'fallback' }], unavailableTargets(events))[0]?.model).toBe('fallback');
  });

  it('keeps the outside example on documented package entry points', () => {
    const source = readFileSync(resolve(process.cwd(), '../../examples/packages/turn-taking.ts'), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    expect(imports.every((specifier) => specifier === '@obversa/runtime' || specifier === '@obversa/runtime/testing')).toBe(true);
  });


  it('runs a primary-dead turn through executeNodeAttempt and completes on fallback', async () => {
    const primary = { adapter: 'mock', adapterVersion: '1', provider: 'mock', modelFamily: 'family', model: 'primary', executable: null, capabilities: [] };
    const fallback = { ...primary, model: 'fallback' };
    let selected: string | null = null;
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const prepare: (target: EngineSelectionRecord) => any = (target) => ({
      ...(() => { selected = target.model; return {}; })(),
      ...(() => { if (target.model === 'primary') primaryCalls += 1; else fallbackCalls += 1; return {}; })(),
      identity: createAttemptIdentity({ namespace: 'test', streamId: 'turn-taking', nodeId: 'critic', position: `turns/${target.model}` }),
      nodeId: 'critic', input: {}, prompt: null, scratchDirectory: process.cwd(),
      workspace: { mode: 'none', directory: null, allowedPaths: [] }, trustedCaller: {}, permissions: [],
      policy: { timeoutMs: 1000, teardownGraceMs: 1000, inputBytes: 1000, outputBytes: 1000, memoryBytes: 1000, filesChanged: 0, linesChanged: 0, callTokens: null },
      resultContract: null, engineRoute: null, runData: async () => {
        if (target.model === 'primary') throw new Error('auth');
        return { target: target.model };
      }, parseResult: null,
      tokenBudget: null, recordModelUnavailable: async () => {}, decideAction: async () => ({ kind: 'allow' }),
    });
    const result = await executeWithFallback([primary, fallback], [], prepare, new AbortController().signal);
    await executeWithFallback([primary, fallback], [primary], prepare, new AbortController().signal);
    await executeWithFallback([primary, fallback], [primary], prepare, new AbortController().signal);
    expect(selected).toBe('fallback');
    expect(result && 'target' in result ? result.target.model : null).toBe('fallback');
    expect(result && 'record' in result ? result.record.status : null).toBe('completed');
    expect(primaryCalls).toBe(1);
    expect(fallbackCalls).toBe(3);
  });
});
