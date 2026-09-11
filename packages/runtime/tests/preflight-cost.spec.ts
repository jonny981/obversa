import { describe, it, expect } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';

import { preflight, preflightEngine, formatPreflight } from '../src/engines/preflight.ts';
import { MockEngine } from '../src/engines/mock.ts';
import { costReport, formatCostReport, priceFor, type PriceTable } from '../src/core/cost.ts';
import { Stats } from '../src/core/stats.ts';
import {
  EngineError, EngineIncompleteResultError,
  type AgentRequest, type AgentResult, type AttemptMetadata,
  type Engine, type EngineEventSink, type EngineFailureKind,
  type EngineIncompleteResultEvidence, type UsageReceipt,
} from '../src/engines/engine.ts';
import { LANE_DEAD_FAILURES } from '../src/engines/failure.ts';
import { assistantResult, engineSelection } from '../src/runtime/result-parts.ts';

describe('preflight', () => {
  it('passes a live lane and reports its reply and usage', async () => {
    const result = await preflightEngine(new MockEngine(() => 'ok'));
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('ok');
    expect(result.usage).toBeTruthy();
  });

  it('classifies a dead lane instead of throwing', async () => {
    const dead: Engine = {
      name: 'dead-lane',
      async run() {
        throw new Error('Credit balance is too low');
      },
    };
    const result = await preflightEngine(dead);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('billing');
    expect(result.engine).toBe('dead-lane');
    expect(formatPreflight(result)).toContain('billing');
  });

  it('probes several lanes independently', async () => {
    const live = new MockEngine(() => 'ok');
    const dead: Engine = {
      name: 'dead',
      async run() {
        throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      },
    };
    const results = await preflight([live, dead]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]!.failure).toBe('missing-cli');
  });
});

const PRICES: PriceTable = {
  'claude-sonnet-5': { inputPerMTokUsd: 3, outputPerMTokUsd: 15 },
  'claude-haiku-4-5': { inputPerMTokUsd: 1, outputPerMTokUsd: 5 },
  'claude-opus-4-8': { inputPerMTokUsd: 15, outputPerMTokUsd: 75 },
};

describe('cost accounting', () => {
  it('matches exact ids and dated prefixes, not lookalikes', () => {
    expect(priceFor(PRICES, 'claude-sonnet-5')).toBeTruthy();
    expect(priceFor(PRICES, 'claude-sonnet-5-20250929')).toBe(
      PRICES['claude-sonnet-5'],
    );
    expect(priceFor(PRICES, 'claude-sonnet-50')).toBeUndefined();
    expect(priceFor(PRICES, 'gpt-5.2')).toBeUndefined();
  });

  it('prices measured usage per model and totals it', () => {
    const report = costReport(
      {
        models: [
          { model: 'claude-sonnet-5-20250929', calls: 10, reportedCalls: 10, unknownUsageCalls: 0, inputTokens: 2_000_000, outputTokens: 100_000 },
          { model: 'claude-haiku-4-5', calls: 20, reportedCalls: 20, unknownUsageCalls: 0, inputTokens: 1_000_000, outputTokens: 50_000 },
        ],
      },
      PRICES,
    );
    // sonnet: 2M*3 + 0.1M*15 = 7.5; haiku: 1M*1 + 0.05M*5 = 1.25
    expect(report.models[0]!.usd).toBe(7.5);
    expect(report.models[1]!.usd).toBe(1.25);
    expect(report.spentUsd).toBe(8.75);
    expect(report.unpricedModels).toEqual([]);
  });

  it('never silently zeroes an unpriced model', () => {
    const report = costReport(
      {
        models: [
          { model: 'claude-haiku-4-5', calls: 1, reportedCalls: 1, unknownUsageCalls: 0, inputTokens: 1_000_000, outputTokens: 0 },
          { model: 'gpt-5.2', calls: 1, reportedCalls: 1, unknownUsageCalls: 0, inputTokens: 1_000_000, outputTokens: 0 },
        ],
      },
      PRICES,
    );
    expect(report.spentUsd).toBeUndefined(); // a partial total is not a total
    expect(report.unpricedModels).toEqual(['gpt-5.2']);
    const text = formatCostReport(report).join('\n');
    expect(text).toContain('incomplete price coverage');
    expect(text).not.toContain('add them to the price table');
  });

  it('withholds totals when cached input has no distinct rates', () => {
    const stats = new Stats();
    stats.record({
      kind: 'engine:usage',
      ts: 1,
      path: [],
      model: 'claude-sonnet-5',
      usage: {
        kind: 'reported',
        inputTokens: 31,
        outputTokens: 3,
        cacheCreationInputTokens: 11,
        cacheReadInputTokens: 13,
      },
    });
    stats.record({
      kind: 'engine:usage',
      ts: 2,
      path: [],
      model: 'claude-sonnet-5',
      usage: {
        kind: 'reported',
        inputTokens: 17,
        outputTokens: 1,
        cacheCreationInputTokens: 2,
        cacheReadInputTokens: 3,
      },
    });

    const snapshot = stats.snapshot();
    expect(snapshot.models).toEqual([
      {
        model: 'claude-sonnet-5',
        calls: 2,
        reportedCalls: 2,
        unknownUsageCalls: 0,
        inputTokens: 48,
        outputTokens: 4,
        cacheCreationInputTokens: 13,
        cacheReadInputTokens: 16,
      },
    ]);

    const report = costReport(snapshot, PRICES, 'claude-opus-4-8');
    expect(report.models).toEqual([
      {
        model: 'claude-sonnet-5',
        calls: 2,
        reportedCalls: 2,
        unknownUsageCalls: 0,
        inputTokens: 48,
        outputTokens: 4,
        usd: undefined,
      },
    ]);
    expect(report.spentUsd).toBeUndefined();
    expect(report.baselineUsd).toBeUndefined();
    expect(report.savedUsd).toBeUndefined();
    expect(report.unpricedModels).toEqual(['claude-sonnet-5']);
    expect(formatCostReport(report).join('\n')).toContain('incomplete price coverage');
  });

  it('keeps missing usage unknown and withholds every price total', () => {
    const stats = new Stats();
    stats.record({
      kind: 'engine:usage',
      ts: 1,
      path: [],
      model: 'claude-haiku-4-5',
      usage: { kind: 'unknown' },
    });

    const snapshot = stats.snapshot();
    expect(snapshot.models).toEqual([
      {
        model: 'claude-haiku-4-5',
        calls: 1,
        reportedCalls: 0,
        unknownUsageCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
      },
    ]);

    const report = costReport(snapshot, PRICES, 'claude-opus-4-8');
    expect(report.models).toEqual([
      {
        model: 'claude-haiku-4-5',
        calls: 1,
        reportedCalls: 0,
        unknownUsageCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        usd: undefined,
      },
    ]);
    expect(report.spentUsd).toBeUndefined();
    expect(report.baselineUsd).toBeUndefined();
    expect(report.savedUsd).toBeUndefined();
    expect(formatCostReport(report).join('\n')).toContain(
      'usage unknown for 1 call(s)',
    );
  });

  it('reconstructs the baseline on the SAME token stream and reports savings', () => {
    const report = costReport(
      {
        models: [
          { model: 'claude-haiku-4-5', calls: 5, reportedCalls: 5, unknownUsageCalls: 0, inputTokens: 2_000_000, outputTokens: 200_000 },
        ],
      },
      PRICES,
      'claude-opus-4-8',
    );
    // measured: 2M*1 + 0.2M*5 = 3; baseline: 2M*15 + 0.2M*75 = 45
    expect(report.spentUsd).toBe(3);
    expect(report.baselineUsd).toBe(45);
    expect(report.savedUsd).toBe(42);
    const text = formatCostReport(report).join('\n');
    expect(text).toContain('reconstructed');
    expect(text).toContain('saved vs baseline: $42');
  });

  it('reports a run that cost MORE than baseline as over, not saved', () => {
    const report = costReport(
      {
        models: [
          { model: 'claude-opus-4-8', calls: 1, reportedCalls: 1, unknownUsageCalls: 0, inputTokens: 1_000_000, outputTokens: 0 },
        ],
      },
      PRICES,
      'claude-haiku-4-5',
    );
    expect(report.savedUsd).toBe(-14);
    expect(formatCostReport(report).join('\n')).toContain('over baseline: $14');
  });
});

const probeRequested = engineSelection({
  adapter: 'probe-fixture', adapterVersion: '1.2.3', provider: 'fixture-provider',
  modelFamily: 'fixture-family', model: 'requested-model',
  executable: '/fixture/engine', capabilities: [],
});
const probeEffective = engineSelection({ ...probeRequested, model: 'observed-model' });
const streamReceipt: UsageReceipt = { kind: 'reported', inputTokens: 2, outputTokens: 1 };
const terminalReceipt: UsageReceipt = {
  kind: 'reported', inputTokens: 7, outputTokens: 3,
  cacheCreationInputTokens: 1, cacheReadInputTokens: 2,
};
function probeResult(usage: UsageReceipt = terminalReceipt): AgentResult {
  return assistantResult({ text: 'ok', requested: probeRequested, effective: probeEffective, usage });
}
function pendingProbe<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('bounded live preflight evidence', () => {
  it('uses terminal usage instead of an older streamed receipt', async () => {
    const engine: Engine = {
      name: 'fixture',
      async run(_request, emit) {
        emit({ type: 'usage', usage: streamReceipt, model: 'requested-model' });
        return probeResult();
      },
    };
    const result = await preflightEngine(engine);
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual(terminalReceipt);
    expect(result.effective).toEqual(probeEffective);
    expect(result.evidence).toEqual({ kind: 'complete', result: probeResult() });
  });

  it('forces the tool-free request and copies supplied attempt metadata as leaf', async () => {
    const attempt: AttemptMetadata = {
      leaf: false, runId: 'probe-run', attemptId: 'supplied-attempt',
      leafId: 'probe-leaf', path: ['supplied', 'path'], label: 'probe label', iteration: 3,
    };
    const original = structuredClone(attempt);
    let observed: AgentRequest | undefined;
    let observedSignal: AbortSignal | undefined;
    let calls = 0;
    const engine: Engine = {
      name: 'fixture',
      async run(request, _emit, signal) {
        calls += 1; observed = request; observedSignal = signal;
        return probeResult();
      },
    };
    const caller = new AbortController();
    const result = await preflightEngine(engine, {
      model: 'requested-model', timeoutMs: 1_000, cwd: '/safe/scratch', attempt,
      signal: caller.signal,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    expect(observed).toEqual({
      prompt: 'Reply with the single word: ok', model: 'requested-model',
      purpose: 'preflight', tools: [], allowedTools: [], workspaceMode: 'none',
      leaf: true, maxTokens: 16, timeoutMs: 1_000, cwd: '/safe/scratch',
      attempt: { ...original, leaf: true },
    });
    expect(observed!.attempt).not.toBe(attempt);
    expect(observed!.attempt!.path).not.toBe(attempt.path);
    expect(attempt).toEqual(original);
    expect(observedSignal).not.toBe(caller.signal);
    expect(observedSignal!.aborted).toBe(false);
  });

  it('preserves omitted cwd and attempt and the existing 60-second default', async () => {
    let observed: AgentRequest | undefined;
    const engine: Engine = { name: 'fixture', async run(request) { observed = request; return probeResult(); } };
    await preflightEngine(engine);
    expect(observed!.timeoutMs).toBe(60_000);
    expect('cwd' in observed!).toBe(false);
    expect('attempt' in observed!).toBe(false);
  });

  it.each([
    ['purpose', 'preflight'], ['tools', []], ['allowedTools', []],
    ['workspaceMode', 'none'], ['leaf', true], ['maxTokens', 16],
  ] as const)('forces the %s field', async (field, value) => {
    let observed: AgentRequest | undefined;
    await preflightEngine({ name: 'fixture', async run(request) {
      observed = request;
      return probeResult();
    } });
    expect(observed![field]).toEqual(value);
  });

  it('lets terminal unknown usage override a streamed measurement', async () => {
    const engine: Engine = {
      name: 'fixture', async run(_request, emit) {
        emit({ type: 'usage', usage: streamReceipt, model: 'requested-model' });
        return probeResult({ kind: 'unknown' });
      },
    };
    expect((await preflightEngine(engine)).usage).toEqual({ kind: 'unknown' });
  });

  it('retains valid final evidence and a transport warning as successful reachability', async () => {
    const terminal = { ...probeResult(), raw: { secret: 'must-not-be-evidence' },
      transportFailure: { kind: 'timeout' as const, message: 'transport cleanup warning', exitCode: null } };
    const result = await preflightEngine({ name: 'fixture', async run() { return terminal; } });
    const { raw: _raw, ...safe } = terminal;
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.evidence).toEqual({ kind: 'complete', result: safe });
    expect('raw' in result.evidence!.result).toBe(false);
    expect(result.effective).toEqual(probeEffective);
  });

  it.each([false, true])('retains incomplete evidence but refuses admission (final=%s)', async (final) => {
    const evidence: EngineIncompleteResultEvidence = {
      ...probeResult(), parts: [{ kind: 'assistant', text: 'partial or unaccepted', final }],
      transportFailure: { kind: 'billing', message: 'recorded provider warning', exitCode: 2 },
      raw: { provider: 'must-not-be-evidence' },
    };
    const engine: Engine = {
      name: 'fixture', async run(_request, emit) {
        emit({ type: 'usage', usage: streamReceipt, model: 'requested-model' });
        throw new EngineIncompleteResultError('incomplete response', evidence);
      },
    };
    const result = await preflightEngine(engine);
    const { raw: _raw, ...safe } = evidence;
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unknown');
    expect(LANE_DEAD_FAILURES.has(result.failure!)).toBe(false);
    expect(result.evidence).toEqual({ kind: 'incomplete', result: safe });
    expect(result.usage).toEqual(terminalReceipt);
    expect(result.effective).toEqual(probeEffective);
    expect('raw' in result.evidence!.result).toBe(false);
  });

  it('lets incomplete terminal unknown usage override earlier streamed usage', async () => {
    const engine: Engine = {
      name: 'fixture', async run(_request, emit) {
        emit({ type: 'usage', usage: streamReceipt, model: 'requested-model' });
        throw new EngineIncompleteResultError('incomplete', {
          ...probeResult({ kind: 'unknown' }), parts: [],
        });
      },
    };
    const result = await preflightEngine(engine);
    expect(result.ok).toBe(false);
    expect(result.usage).toEqual({ kind: 'unknown' });
    expect(result.evidence!.kind).toBe('incomplete');
  });

  const malformed: ReadonlyArray<readonly [string, (value: AgentResult) => unknown]> = [
    ['assistant text', (value) => ({ ...value, parts: [{ kind: 'assistant', text: {}, final: true }] })],
    ['two finals', (value) => ({ ...value, parts: [...value.parts, ...value.parts] })],
    ['negative usage', (value) => ({ ...value, usage: { kind: 'reported', inputTokens: -1, outputTokens: 2 } })],
    ['missing usage', (value) => ({ ...value, usage: undefined })],
    ['relative executable', (value) => ({ ...value, effective: { ...value.effective, executable: 'relative' } })],
    ['transport kind', (value) => ({ ...value, transportFailure: { kind: 'invalid-config-but-not-an-enum', message: 'invalid config', exitCode: 1 } })],
  ];
  it.each(malformed)('refuses malformed %s in returned and incomplete evidence', async (_name, damage) => {
    for (const incomplete of [false, true]) {
      const engine: Engine = {
        name: 'fixture', async run() {
          const value = damage(probeResult());
          if (incomplete) throw new EngineIncompleteResultError('invalid config', value as EngineIncompleteResultEvidence);
          return value as AgentResult;
        },
      };
      const result = await preflightEngine(engine);
      expect(result.ok).toBe(false);
      expect(result.failure).toBe('unknown');
      expect(LANE_DEAD_FAILURES.has(result.failure!)).toBe(false);
      expect(result.evidence).toBeUndefined();
      expect(result.effective).toBeUndefined();
      expect(result.usage).toEqual({ kind: 'unknown' });
    }
  });

  it('ignores malformed streamed usage while accepting valid terminal evidence', async () => {
    const engine: Engine = {
      name: 'fixture', async run(_request, emit) {
        emit({ type: 'usage', usage: { kind: 'reported', inputTokens: -1, outputTokens: 2 }, model: 'bad' });
        return probeResult();
      },
    };
    const result = await preflightEngine(engine);
    expect(result.ok).toBe(true);
    expect(result.usage).toEqual(terminalReceipt);
  });

  it.each([
    'auth', 'model-unavailable', 'rate-limit', 'billing', 'quota',
    'transient', 'timeout', 'aborted', 'missing-cli', 'invalid-config', 'unknown',
  ] satisfies EngineFailureKind[])('preserves plain typed %s without retry', async (kind) => {
    let calls = 0;
    const engine: Engine = {
      name: 'fixture', async run(_request, emit) {
        calls += 1;
        emit({ type: 'usage', usage: streamReceipt, model: 'requested-model' });
        throw new EngineError({ kind, message: `scripted ${kind}`, effective: probeEffective });
      },
    };
    const result = await preflightEngine(engine, { model: 'requested-model' });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, failure: kind, detail: `scripted ${kind}`,
      model: 'requested-model', effective: probeEffective, usage: streamReceipt });
    expect(result.evidence).toBeUndefined();
  });

  it('keeps usage unknown when a plain error has no receipt', async () => {
    const result = await preflightEngine({ name: 'fixture', async run() { throw new Error('failure'); } });
    expect(result.usage).toEqual({ kind: 'unknown' });
  });

  it('bounds an abort-ignoring engine and ignores its late final and late stream', async () => {
    const pending = pendingProbe<AgentResult>();
    let emit!: EngineEventSink;
    let engineSignal!: AbortSignal;
    let calls = 0;
    const engine: Engine = {
      name: 'ignores-abort', run(_request, sink, signal) {
        calls += 1; emit = sink; engineSignal = signal;
        return pending.promise;
      },
    };
    const running = preflightEngine(engine, { timeoutMs: 25 });
    try {
      const winner = await Promise.race([
        running.then((result) => ({ kind: 'result' as const, result })),
        delay(500).then(() => ({ kind: 'test-bound' as const })),
      ]);
      expect(winner.kind).toBe('result');
      if (winner.kind !== 'result') return;
      expect(winner.result).toMatchObject({ ok: false, failure: 'timeout', usage: { kind: 'unknown' } });
      expect(winner.result.evidence).toBeUndefined();
      expect(engineSignal.aborted).toBe(true);
      emit({ type: 'usage', usage: terminalReceipt, model: 'late-model' });
      pending.resolve(probeResult());
      await delay(0);
      expect(winner.result.usage).toEqual({ kind: 'unknown' });
      expect(winner.result.ok).toBe(false);
      expect(winner.result.evidence).toBeUndefined();
      expect(calls).toBe(1);
    } finally {
      pending.resolve(probeResult());
      await running;
    }
  });

  it('handles a rejection after the deadline without another call', async () => {
    const pending = pendingProbe<AgentResult>();
    const rejection = setTimeout(() => pending.reject(new EngineError({
      kind: 'billing', message: 'late billing',
    })), 100);
    try {
      const result = await preflightEngine({ name: 'late-reject', run() { return pending.promise; } }, { timeoutMs: 20 });
      expect(result.failure).toBe('timeout');
      await delay(120);
      expect(result.failure).toBe('timeout');
      expect(result.evidence).toBeUndefined();
    } finally { clearTimeout(rejection); pending.resolve(probeResult()); }
  });

  it.each([false, true])('retains an already available late result without admission (incomplete=%s)', async (incomplete) => {
    const engine: Engine = {
      name: 'blocks-timer', async run() {
        const until = performance.now() + 30;
        while (performance.now() < until) { /* Deliberately prevent timer delivery. */ }
        if (incomplete) throw new EngineIncompleteResultError('late incomplete', probeResult());
        return probeResult();
      },
    };
    const result = await preflightEngine(engine, { timeoutMs: 5 });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('timeout');
    expect(result.evidence).toEqual({ kind: incomplete ? 'incomplete' : 'complete', result: probeResult() });
    expect(result.effective).toEqual(probeEffective);
    expect(result.usage).toEqual(terminalReceipt);
  });

  it('retains incomplete evidence settled synchronously by caller cancellation', async () => {
    const caller = new AbortController();
    const running = preflightEngine({ name: 'cooperative', run(_request, _emit, signal) {
      return new Promise<AgentResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(
          new EngineIncompleteResultError('cancelled with evidence', probeResult()),
        ), { once: true });
      });
    } }, { signal: caller.signal, timeoutMs: 1_000 });
    caller.abort();
    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('aborted');
    expect(result.evidence).toEqual({ kind: 'incomplete', result: probeResult() });
    expect(result.usage).toEqual(terminalReceipt);
    expect(result.effective).toEqual(probeEffective);
  });

  it('does not call an engine when the caller already aborted', async () => {
    let calls = 0;
    const result = await preflightEngine({ name: 'fixture', async run() { calls += 1; return probeResult(); } },
      { signal: AbortSignal.abort() });
    expect(calls).toBe(0);
    expect(result.failure).toBe('aborted');
    expect(result.usage).toEqual({ kind: 'unknown' });
  });

  it('returns caller cancellation without waiting for an abort-ignoring engine', async () => {
    const pending = pendingProbe<AgentResult>();
    const caller = new AbortController();
    let engineSignal!: AbortSignal;
    const running = preflightEngine({ name: 'fixture', run(_request, _emit, signal) {
      engineSignal = signal; return pending.promise;
    } }, { signal: caller.signal, timeoutMs: 1_000 });
    caller.abort();
    try {
      const winner = await Promise.race([
        running.then((result) => ({ kind: 'result' as const, result })),
        delay(500).then(() => ({ kind: 'test-bound' as const })),
      ]);
      expect(winner.kind).toBe('result');
      if (winner.kind !== 'result') return;
      expect(winner.result.failure).toBe('aborted');
      expect(engineSignal.aborted).toBe(true);
    } finally { pending.resolve(probeResult()); await running; }
  });

  it('removes the caller listener and deadline timer after completion', async () => {
    const caller = new AbortController();
    let engineSignal!: AbortSignal;
    const result = await preflightEngine({ name: 'fixture', async run(_request, _emit, signal) {
      engineSignal = signal; return probeResult();
    } }, { signal: caller.signal, timeoutMs: 30 });
    expect(result.ok).toBe(true);
    caller.abort();
    await delay(60);
    expect(engineSignal.aborted).toBe(false);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'refuses an invalid timeout %s before calling the engine', async (timeoutMs) => {
      let calls = 0;
      const result = await preflightEngine({ name: 'fixture', async run() { calls += 1; return probeResult(); } }, { timeoutMs });
      expect(calls).toBe(0);
      expect(result.failure).toBe('invalid-config');
    },
  );

  it('keeps preflight concurrent and returns results in input order', async () => {
    const a = pendingProbe<AgentResult>();
    const b = pendingProbe<AgentResult>();
    const started: string[] = [];
    const running = preflight([
      { name: 'a', run() { started.push('a'); return a.promise; } },
      { name: 'b', run() { started.push('b'); return b.promise; } },
    ], { timeoutMs: 1_000 });
    try {
      await Promise.resolve();
      expect(started).toEqual(['a', 'b']);
      b.resolve(probeResult());
      a.resolve(probeResult());
      expect((await running).map((result) => result.engine)).toEqual(['a', 'b']);
    } finally { a.resolve(probeResult()); b.resolve(probeResult()); }
  });

  it('preserves assistant-text final semantics, including empty text', async () => {
    const empty = { ...probeResult(), parts: [{ kind: 'assistant' as const, text: '', final: true }] };
    expect(await preflightEngine({ name: 'fixture', async run() { return empty; } }))
      .toMatchObject({ ok: true, detail: 'replied (empty text)' });
    const structured: AgentResult = { ...probeResult(), parts: [{ kind: 'structured', value: { ok: true }, final: true }] };
    const refused = await preflightEngine({ name: 'fixture', async run() { return structured; } });
    expect(refused.ok).toBe(false);
    expect(refused.failure).toBe('unknown');
    expect(refused.evidence).toEqual({ kind: 'complete', result: structured });
    expect(refused.usage).toEqual(terminalReceipt);
  });
});
