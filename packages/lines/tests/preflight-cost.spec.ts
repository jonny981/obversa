import { describe, it, expect } from 'vitest';

import { preflight, preflightEngine, formatPreflight } from '../src/engines/preflight.ts';
import { MockEngine } from '../src/engines/mock.ts';
import { costReport, formatCostReport, priceFor, type PriceTable } from '../src/core/cost.ts';
import { Stats } from '../src/core/stats.ts';
import type { Engine } from '../src/engines/engine.ts';

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
          { model: 'claude-sonnet-5-20250929', calls: 10, inputTokens: 2_000_000, outputTokens: 100_000 },
          { model: 'claude-haiku-4-5', calls: 20, inputTokens: 1_000_000, outputTokens: 50_000 },
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
          { model: 'claude-haiku-4-5', calls: 1, inputTokens: 1_000_000, outputTokens: 0 },
          { model: 'gpt-5.2', calls: 1, inputTokens: 1_000_000, outputTokens: 0 },
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

  it('reconstructs the baseline on the SAME token stream and reports savings', () => {
    const report = costReport(
      {
        models: [
          { model: 'claude-haiku-4-5', calls: 5, inputTokens: 2_000_000, outputTokens: 200_000 },
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
          { model: 'claude-opus-4-8', calls: 1, inputTokens: 1_000_000, outputTokens: 0 },
        ],
      },
      PRICES,
      'claude-haiku-4-5',
    );
    expect(report.savedUsd).toBe(-14);
    expect(formatCostReport(report).join('\n')).toContain('over baseline: $14');
  });
});
