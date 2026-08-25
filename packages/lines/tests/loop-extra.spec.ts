import { describe, it, expect } from 'vitest';

import { run, loop, fnJob, predicate } from '../src/api.ts';
import type {
  ConditionResult,
  Job,
  LoopEvent,
  Outcome,
  RunOptions,
} from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('loop extras', () => {
  it('stopOn aborts the loop early', async () => {
    let n = 0;
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => {
          n += 1;
          return { status: 'fail' };
        }),
        stopOn: predicate(() => n >= 2, 'n>=2'),
        max: 10,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('aborted');
    expect(n).toBe(2);
  });

  it('retry.onError "fail" ends the loop on a thrown body', async () => {
    const throwing: Job = async () => {
      throw new Error('boom');
    };
    const { outcome } = await run(
      loop({ name: 'x', body: throwing, retry: { onError: 'fail' }, max: 5 }),
      mockOpts,
    );
    expect(outcome.status).toBe('fail');
  });

  it('retry.onError "continue" tolerates errors up to maxConsecutive', async () => {
    let n = 0;
    const throwing: Job = async () => {
      n += 1;
      throw new Error('e');
    };
    const { outcome } = await run(
      loop({
        name: 'x',
        body: throwing,
        retry: { onError: 'continue', maxConsecutive: 3 },
        max: 100,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('fail');
    expect(n).toBe(3);
  });
});

describe('ctx.lastGate (the gate-feedback loop)', () => {
  it('threads the failing until verdict, with its output, to the next body', async () => {
    const seen: (ConditionResult | undefined)[] = [];
    let n = 0;
    const { outcome } = await run(
      loop({
        name: 'g',
        body: fnJob('b', async (ctx) => {
          seen.push(ctx.lastGate);
          n += 1;
          return { status: 'fail', summary: `n=${n}` };
        }),
        until: async () =>
          n >= 2
            ? { met: true, reason: 'done' }
            : { met: false, reason: 'not yet', output: 'exit: 1\n\nstdout:\nFAIL' },
        max: 5,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(seen[0]).toBeUndefined(); // first iteration — no verdict yet
    expect(seen[1]?.met).toBe(false);
    expect(seen[1]?.output).toContain('exit: 1');
  });

  it('is undefined when the loop has no explicit until', async () => {
    const seen: (ConditionResult | undefined)[] = [];
    let n = 0;
    await run(
      loop({
        name: 'nu',
        body: fnJob('b', async (ctx) => {
          seen.push(ctx.lastGate);
          n += 1;
          return { status: n >= 2 ? 'pass' : 'fail' };
        }),
        max: 5,
      }),
      mockOpts,
    );
    expect(seen).toEqual([undefined, undefined]);
  });

  it('review-reject re-entry carries lastGate (met) and lastReview together', async () => {
    const gates: (ConditionResult | undefined)[] = [];
    const reviews: (Outcome | undefined)[] = [];
    let reviewsRun = 0;
    const { outcome } = await run(
      loop({
        name: 'rr',
        body: fnJob('b', async (ctx) => {
          gates.push(ctx.lastGate);
          reviews.push(ctx.lastReview);
          return { status: 'pass' };
        }),
        until: async () => ({ met: true, reason: 'gate ok', output: 'gate diag' }),
        review: fnJob('rev', async () => {
          reviewsRun += 1;
          return {
            status: reviewsRun >= 2 ? 'pass' : 'fail',
            summary: 'needs work',
          };
        }),
        max: 5,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(gates[1]?.met).toBe(true);
    expect(gates[1]?.output).toBe('gate diag');
    expect(reviews[1]?.summary).toBe('needs work');
  });

  it('the loop:condition event carries the gate output', async () => {
    const events: LoopEvent[] = [];
    await run(
      loop({
        name: 'ev',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: async () => ({ met: false, reason: 'no', output: 'diag text' }),
        max: 1,
      }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );
    const e = events.find(
      (e) => e.kind === 'loop:condition' && e.which === 'until',
    );
    expect(e?.kind).toBe('loop:condition');
    if (e?.kind === 'loop:condition') expect(e.result.output).toBe('diag text');
  });
});
