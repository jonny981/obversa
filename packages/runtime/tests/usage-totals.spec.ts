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

  // The optional argument has one sharp edge: passing the function by
  // reference to something that supplies a second argument of its own. map
  // hands it the index, which is a number where totals belong. The compiler
  // refuses it, and this says so in a test so the reason survives.
  it('is not passed by reference to map, which would supply the index as totals', () => {
    const events = [usage('m', 1, 2), usage('m', 3, 4)];
    const lines = events.map((event) => formatEvent(event));
    expect(lines.every((line) => !line.includes('(run '))).toBe(true);
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
      // A run with no engine calls has nothing unmeasured, and says so with a
      // number rather than by leaving the field out.
      unmeasuredCalls: 0,
    });
    // Assert the RUN TOTAL, not the per-call figure. '5/1 tok' is what the
    // call prints whether or not the second argument is read at all, so an
    // assertion on it passes with the parameter ignored entirely: it proves
    // the shape and not the wiring. This is the only part that fails if the
    // argument is dropped.
    const busy = await run(fnJob('spend', async () => ({ status: 'pass', summary: 'done' })));
    const line = formatEvent(usage('m', 5, 1), { ...busy.usage, inputTokens: 1234, outputTokens: 567 });
    expect(line).toContain('run 1234/567 tok');
  });
});

describe('a total that might be missing calls says so', () => {
  // The per-call line is honest: an engine that reported nothing prints
  // "usage unknown" rather than a zero. The aggregate was not, so three
  // unmeasured calls vanished into a total that looked complete. For a stage
  // whose whole reason is that nobody trusts us unless usage is visible, a
  // number that might be missing calls and does not say so is the worst kind.
  it('counts the calls that reported nothing', () => {
    const stats = new Stats();
    stats.record(usage('a', 100, 10));
    stats.record({ ...usage('b', 0, 0), usage: { kind: 'unknown' } } as LoopEvent);
    stats.record({ ...usage('c', 0, 0), usage: { kind: 'unknown' } } as LoopEvent);
    expect(stats.snapshot().totalUnmeasuredCalls).toBe(2);
  });

  it('shows the unmeasured count on the line only when there is one', () => {
    const complete = formatEvent(usage('m', 1, 1), { inputTokens: 9, outputTokens: 3, unmeasuredCalls: 0 });
    expect(complete).not.toContain('unmeasured');
    const incomplete = formatEvent(usage('m', 1, 1), { inputTokens: 9, outputTokens: 3, unmeasuredCalls: 2 });
    // The same words a single call prints, so a reader learns the phrase once.
    expect(incomplete).toContain('usage unknown on 2 calls');
    const one = formatEvent(usage('m', 1, 1), { inputTokens: 9, outputTokens: 3, unmeasuredCalls: 1 });
    expect(one).toContain('usage unknown on 1 call');
  });
});
