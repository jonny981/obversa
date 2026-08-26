import { describe, expect, it } from 'vitest';

import { agentCheck, fnJob, loop, run } from '../src/api.ts';
import type { Engine } from '../src/api.ts';
import { fixtureResult } from './engine-fixture.ts';

function replyEngine(text: string): Engine {
  return {
    name: 'reply',
    async run() {
      return fixtureResult(text, { model: 'reply' });
    },
  };
}

function runDimensionCheck(text: string, threshold: number) {
  return run(
    loop({
      name: 'dimension-check',
      body: fnJob('body', async () => ({ status: 'fail' })),
      until: agentCheck({
        question: 'Is each dimension good enough?',
        threshold,
        dimensions: ['correctness', 'safety'],
      }),
      max: 2,
    }),
    { engine: 'reply', engines: { reply: () => replyEngine(text) } },
  );
}

describe('agentCheck dimensions', () => {
  it('passes on the geometric mean of all dimension scores', async () => {
    const { outcome } = await runDimensionCheck(
      JSON.stringify({
        scores: { correctness: 0.9, safety: 0.9 },
        reason: 'ok',
      }),
      0.8,
    );
    expect(outcome.status).toBe('pass');
  });

  it('lets one weak dimension pull the result below threshold', async () => {
    const { outcome } = await runDimensionCheck(
      JSON.stringify({
        scores: { correctness: 0.95, safety: 0.1 },
        reason: 'unsafe',
      }),
      0.6,
    );
    expect(outcome.status).toBe('exhausted');
  });

  it('fails closed when one dimension is missing', async () => {
    const { outcome } = await runDimensionCheck(
      JSON.stringify({ scores: { correctness: 0.95 }, reason: 'missing safety' }),
      0.5,
    );
    expect(outcome.status).toBe('exhausted');
  });
});
