/** Regression tests for the issues the reviewer panel surfaced. */
import { describe, it, expect } from 'vitest';

import {
  run,
  loop,
  fnJob,
  gateJob,
  agentCheck,
  predicate,
} from '../src/api.ts';
import type { Outcome, RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};
const replying = (text: string): RunOptions => ({
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => text) },
});

describe('review-restart is bounded and informed', () => {
  it('maxReviewRestarts caps the worker/reviewer standoff', async () => {
    let work = 0;
    let reviews = 0;
    const { outcome } = await run(
      loop({
        name: 'wr',
        body: fnJob('b', async () => {
          work += 1;
          return { status: 'pass' };
        }),
        until: predicate(() => true),
        review: fnJob('rev', async () => {
          reviews += 1;
          return { status: 'fail' };
        }),
        maxReviewRestarts: 2,
        max: 100,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('exhausted');
    expect(reviews).toBe(2);
    expect(work).toBe(2);
  });

  it('threads the failed review to the next iteration as ctx.lastReview', async () => {
    const seen: (string | undefined)[] = [];
    let reviews = 0;
    await run(
      loop({
        name: 'wr',
        body: fnJob('b', async (ctx) => {
          seen.push(ctx.lastReview?.summary);
          return { status: 'pass' };
        }),
        until: predicate(() => true),
        review: fnJob('rev', async () => {
          reviews += 1;
          return reviews >= 2
            ? { status: 'pass' }
            : { status: 'fail', summary: 'fix X' };
        }),
        max: 5,
      }),
      mockOpts,
    );
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBe('fix X');
  });
});

describe('gateJob reads the typed ctx.lastOutcome', () => {
  it('sees the enclosing loop body outcome', async () => {
    let n = 0;
    const { outcome } = await run(
      loop({
        name: 'g',
        body: fnJob('b', async () => {
          n += 1;
          return { status: 'pass', data: n >= 2 ? 'ready' : 'nope' } as Outcome;
        }),
        until: predicate(() => true),
        review: gateJob(
          'rev',
          predicate((_ctx, last) => last?.data === 'ready'),
        ),
        max: 5,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(n).toBe(2);
  });
});

describe('agentCheck robustness', () => {
  it('degrades to not-met on a malformed verdict instead of throwing', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: agentCheck({ question: '?', threshold: 0.5 }),
        max: 2,
      }),
      replying('I cannot answer in JSON, sorry.'),
    );
    expect(outcome.status).toBe('exhausted'); // never met, but did not crash
  });

  it('extracts the first balanced object from prose-wrapped multi-object replies', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: agentCheck({ question: '?', threshold: 0.8 }),
        max: 3,
      }),
      replying(
        'Restating input: {"question":"?"}. My verdict: {"verdict":"yes","confidence":0.95}',
      ),
    );
    expect(outcome.status).toBe('pass');
  });

  it('treats a "yes" with no numeric confidence as NOT met (fail-closed)', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: agentCheck({ question: '?', threshold: 0.8 }),
        max: 2,
      }),
      replying(JSON.stringify({ verdict: 'yes' })),
    );
    // Missing confidence defaults to 0, so a thresholded gate never opens: a
    // quality gate must not be talked open by an unscored "yes".
    expect(outcome.status).toBe('exhausted');
  });
});
