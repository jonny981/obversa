import { describe, it, expect } from 'vitest';

import { formatEvent } from '../src/api.ts';
import { Stats } from '../src/core/stats.ts';
import type { LoopEvent } from '../src/api.ts';

const usage = (model: string, input: number, output: number, cache?: { created?: number; read?: number }): LoopEvent => ({
  kind: 'engine:usage',
  ts: 1,
  path: ['implement'],
  model,
  usage: {
    kind: 'reported',
    inputTokens: input,
    outputTokens: output,
    ...(cache?.created === undefined ? {} : { cacheCreationInputTokens: cache.created }),
    ...(cache?.read === undefined ? {} : { cacheReadInputTokens: cache.read }),
  },
} as LoopEvent);

describe('a person can see what a run is spending', () => {
  // The whole point of this stage, in Jonny's words: nobody trusts this
  // unless usage is transparent and visible. A per-call number alone does
  // not answer "what has this run cost me so far".
  it('puts the running total beside the call when the caller passes one', () => {
    const line = formatEvent(usage('claude-sonnet-4-5', 120, 40), {
      inputTokens: 1_200,
      outputTokens: 400,
      cacheReadInputTokens: 900,
    });
    expect(line).toContain('120/40 tok');
    expect(line).toContain('1200/400');
    expect(line).toContain('900 tok from cache');
  });

  // Creation and read are different things: one is what was paid to build the
  // cache, the other what was served from it. A line that sums them under one
  // word makes a reader guess which they are seeing.
  it('never sums cache creation into the cache figure on the line', () => {
    const line = formatEvent(usage('m', 1, 1), {
      inputTokens: 10,
      outputTokens: 2,
      cacheCreationInputTokens: 500,
      cacheReadInputTokens: 900,
    });
    expect(line).toContain('900 tok from cache');
    expect(line).not.toContain('1400');
  });

  it('prints exactly what it printed before when no total is passed', () => {
    const event = usage('claude-sonnet-4-5', 120, 40);
    expect(formatEvent(event)).toBe('implement   claude-sonnet-4-5: 120/40 tok');
  });

  it('says so rather than inventing a number when the engine reported no usage', () => {
    const unknown = { ...usage('m', 0, 0), usage: { kind: 'unknown' } } as LoopEvent;
    expect(formatEvent(unknown, { inputTokens: 10, outputTokens: 5 })).toContain('usage unknown');
  });

  it('carries a run-wide cache total, not only a per-model one', () => {
    const stats = new Stats();
    stats.record(usage('a', 100, 10, { created: 30, read: 70 }));
    stats.record(usage('b', 200, 20, { created: 5, read: 15 }));
    const snapshot = stats.snapshot();
    expect(snapshot.totalInputTokens).toBe(300);
    expect(snapshot.totalOutputTokens).toBe(30);
    // These two are what F75 adds: the per-model breakdown already had them,
    // the run-wide totals did not, so nothing could answer "what did this run
    // read from cache" without summing the models by hand.
    expect(snapshot.totalCacheCreationInputTokens).toBe(35);
    expect(snapshot.totalCacheReadInputTokens).toBe(85);
  });

  it('leaves the cache totals at zero when no engine reported any', () => {
    const stats = new Stats();
    stats.record(usage('a', 100, 10));
    const snapshot = stats.snapshot();
    expect(snapshot.totalCacheCreationInputTokens).toBe(0);
    expect(snapshot.totalCacheReadInputTokens).toBe(0);
  });
});

describe('a run reports what it spent', () => {
  // The totals come back in the shape the formatter takes, so a caller can
  // hand a run's own numbers straight back to formatEvent without reshaping
  // them. The per-model record stays on stats; this is the summary.
  it('carries the run total in the shape formatEvent accepts', async () => {
    const { run, fnJob } = await import('../src/api.ts');
    const result = await run(fnJob('nothing', async () => ({ status: 'pass', summary: 'did nothing' })));
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    expect(formatEvent(usage('m', 5, 1), result.usage)).toContain('5/1 tok');
  });
});
