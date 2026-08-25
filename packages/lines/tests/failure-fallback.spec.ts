import { describe, it, expect } from 'vitest';

import { classifyEngineFailure, LANE_DEAD_FAILURES } from '../src/engines/failure.ts';
import { fallbackEngine, type FallbackInfo } from '../src/engines/fallback.ts';
import { LoopError } from '../src/core/errors.ts';
import type { AgentRequest, Engine } from '../src/engines/engine.ts';

describe('classifyEngineFailure', () => {
  it('maps typed LoopError limit codes', () => {
    expect(
      classifyEngineFailure(new LoopError({ code: 'RATE_LIMIT', message: 'x' })),
    ).toBe('rate-limit');
    expect(
      classifyEngineFailure(new LoopError({ code: 'QUOTA', message: 'x' })),
    ).toBe('quota');
    expect(
      classifyEngineFailure(new LoopError({ code: 'TIMEOUT', message: 'x' })),
    ).toBe('timeout');
  });

  it('classifies the field vocabulary by message', () => {
    expect(classifyEngineFailure(new Error('Credit balance is too low'))).toBe('billing');
    expect(classifyEngineFailure(new Error('401 Unauthorized'))).toBe('auth');
    expect(classifyEngineFailure(new Error('invalid api key provided'))).toBe('auth');
    expect(classifyEngineFailure(new Error('model claude-opus-9 not found'))).toBe('model-unavailable');
    expect(classifyEngineFailure(new Error('monthly usage limit reached'))).toBe('quota');
    expect(classifyEngineFailure(new Error('429 Too Many Requests'))).toBe('rate-limit');
    expect(
      classifyEngineFailure(
        new Error("HTTP 400: Invalid value: 'max'. Supported values are: high, xhigh"),
      ),
    ).toBe('invalid-config');
    expect(classifyEngineFailure(new Error('503 Service Unavailable'))).toBe(
      'transient',
    );
    expect(classifyEngineFailure(new Error('599 upstream failure'))).toBe(
      'transient',
    );
    expect(classifyEngineFailure(new Error('request timed out after 60s'))).toBe('timeout');
    expect(classifyEngineFailure(new Error('something exploded'))).toBe('unknown');
  });

  it('classifies a missing binary via errno', () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), {
      code: 'ENOENT',
    });
    expect(classifyEngineFailure(enoent)).toBe('missing-cli');
  });

  it('keeps lane-dead separate from limits', () => {
    expect(LANE_DEAD_FAILURES.has('auth')).toBe(true);
    expect(LANE_DEAD_FAILURES.has('missing-cli')).toBe(true);
    expect(LANE_DEAD_FAILURES.has('invalid-config')).toBe(true);
    expect(LANE_DEAD_FAILURES.has('rate-limit')).toBe(false);
    expect(LANE_DEAD_FAILURES.has('quota')).toBe(false);
    expect(LANE_DEAD_FAILURES.has('transient')).toBe(false);
  });
});

function engineThat(name: string, behavior: () => Promise<string>): Engine {
  return {
    name,
    async run(req: AgentRequest, onEvent) {
      const text = await behavior();
      onEvent({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1 }, model: name });
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, model: name };
    },
  };
}

const req: AgentRequest = { prompt: 'work' };
const signal = new AbortController().signal;

describe('fallbackEngine', () => {
  it('falls over to the next lane on a lane-dead failure, and latches', async () => {
    let deadCalls = 0;
    const reroutes: FallbackInfo[] = [];
    const dead = engineThat('dead', async () => {
      deadCalls += 1;
      throw new Error('invalid api key');
    });
    const live = engineThat('live', async () => 'from the live lane');
    const engine = fallbackEngine([dead, live], {
      onFallback: (info) => reroutes.push(info),
    })({});

    const first = await engine.run(req, () => {}, signal);
    expect(first.text).toBe('from the live lane');
    expect(reroutes).toEqual([
      expect.objectContaining({ from: 'dead', to: 'live', failure: 'auth' }),
    ]);

    // Latched: the dead lane is not retried on the next call.
    await engine.run(req, () => {}, signal);
    expect(deadCalls).toBe(1);
  });

  it('does NOT swallow rate limits by default (the onLimit policy owns them)', async () => {
    const throttled = engineThat('throttled', async () => {
      throw new LoopError({ code: 'RATE_LIMIT', message: '429', retryAfterMs: 100 });
    });
    const live = engineThat('live', async () => 'never reached');
    const engine = fallbackEngine([throttled, live])({});
    await expect(engine.run(req, () => {}, signal)).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    });
  });

  it('opts into quota-hopping when asked', async () => {
    const outOfQuota = engineThat('quota', async () => {
      throw new LoopError({ code: 'QUOTA', message: 'usage limit' });
    });
    const live = engineThat('live', async () => 'hopped');
    const engine = fallbackEngine([outOfQuota, live], { on: ['quota'] })({});
    const result = await engine.run(req, () => {}, signal);
    expect(result.text).toBe('hopped');
  });

  it('fails with the last lane error when every lane is dead', async () => {
    const a = engineThat('a', async () => {
      throw new Error('invalid api key');
    });
    const b = engineThat('b', async () => {
      throw new Error('credit balance too low');
    });
    const engine = fallbackEngine([a, b])({});
    await expect(engine.run(req, () => {}, signal)).rejects.toThrow(
      'credit balance too low',
    );
    // Both latched: the next call has nowhere to go and says so.
    await expect(engine.run(req, () => {}, signal)).rejects.toThrow();
  });

  it('names the chain', () => {
    const engine = fallbackEngine(['claude-cli', 'codex'])({});
    expect(engine.name).toBe('fallback(claude-cli -> codex)');
  });
});
