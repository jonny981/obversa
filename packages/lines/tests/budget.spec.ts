import { describe, expect, it } from 'vitest';

import { agentJob, loop, run } from '../src/api.ts';
import type { Engine } from '../src/api.ts';
import { Budget } from '../src/core/budget.ts';

function usageEngine(perCall = 200): Engine {
  return {
    name: 'usage-mock',
    async run(_request, onEvent) {
      const usage = {
        inputTokens: perCall / 2,
        outputTokens: perCall / 2,
      };
      onEvent({ type: 'usage', usage, model: 'usage-mock' });
      return { text: 'ok', usage, model: 'usage-mock' };
    },
  };
}

function failingAgent() {
  return agentJob({
    label: 'worker',
    prompt: 'go',
    outcome: () => ({ status: 'fail' as const }),
  });
}

describe('Budget', () => {
  it('tracks its limit and ignores invalid usage', () => {
    const budget = new Budget({ limit: 100 });
    budget.add(60);
    budget.add(-5);
    budget.add(Number.NaN);
    expect(budget.spent()).toBe(60);
    expect(budget.remaining()).toBe(40);
    expect(budget.exceeded()).toBe(false);

    budget.add(50);
    expect(budget.spent()).toBe(110);
    expect(budget.remaining()).toBe(0);
    expect(budget.exceeded()).toBe(true);
  });

  it('reserves configured headroom before the hard cap', () => {
    const budget = new Budget({ limit: 100, headroom: 30 });
    budget.add(75);
    expect(budget.exceeded()).toBe(true);
  });

  it('stops engine calls when a hard run budget is exhausted', async () => {
    const { outcome, budget } = await run(
      loop({ name: 'bounded', body: failingAgent(), max: 10 }),
      {
        engine: 'usage',
        engines: { usage: () => usageEngine() },
        budget: 500,
        onLimit: 'fail',
      },
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('BUDGET');
    expect(budget?.spent).toBeGreaterThanOrEqual(500);
  });

  it('lets a soft budget finish through the normal loop cap', async () => {
    const { outcome } = await run(
      loop({ name: 'soft', body: failingAgent(), max: 3 }),
      {
        engine: 'usage',
        engines: { usage: () => usageEngine() },
        budget: { limit: 100, soft: true },
      },
    );

    expect(outcome.status).toBe('exhausted');
  });
});
