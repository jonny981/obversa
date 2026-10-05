/**
 * Cost accounting over the run's measured token usage — the honest-receipt
 * fold. Two rules keep cost reports honest:
 *
 * 1. **Never silently $0.** A model without complete price coverage lands in
 *    `unpricedModels`, and the totals stay `undefined` rather than pretending
 *    the run was free or pricing cached input at the base input rate.
 * 2. **The baseline is labeled a reconstruction.** `baselineUsd` prices the
 *    SAME measured token stream at the baseline model's rates — "what these
 *    exact tokens would have cost on the ceiling model". It is a like-for-like
 *    counterfactual, not a measured alternative run, and consumers should say
 *    so when they print it.
 *
 * The run report's prices are supplied by the caller (a JSON file via
 * `--prices`, or a table in code). The per-call estimate on each
 * `engine:usage` event reads the table the runtime ships in `prices.json`,
 * with the run's `prices` option laid over it, and names the entry it used.
 */

import type { CostReceipt, UsageReceipt } from '@obversa/api';

import type { StatsSnapshot } from './stats.js';
import shippedPrices from './prices.json' with { type: 'json' };

export interface ModelPrice {
  /** Dollars per million input tokens. */
  inputPerMTokUsd: number;
  /** Dollars per million output tokens. */
  outputPerMTokUsd: number;
  /** Dollars per million tokens written to the cache. */
  cacheWritePerMTokUsd?: number;
  /** Dollars per million tokens read from the cache. */
  cacheReadPerMTokUsd?: number;
}

/** The price table the runtime ships, read from `prices.json`. */
export const SHIPPED_PRICES: PriceTable = shippedPrices;

/** Model id → price. The run report (`priceFor`) matches a key exactly first,
 *  then by longest prefix. The per-call estimate (`estimateCost`) matches only
 *  the exact id or the id less a release date at its end, so
 *  `"claude-sonnet-5"` covers `claude-sonnet-5-20250929` but `"gpt-5"` does
 *  not cover `gpt-5.6`. */
export type PriceTable = Record<string, ModelPrice>;

export interface ModelCost {
  model: string;
  calls: number;
  reportedCalls: number;
  unknownUsageCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Undefined when the table cannot price this model's complete usage. */
  usd?: number;
}

export interface CostReport {
  /** Measured usage priced at each model's own rate; undefined if ANY used
   *  model is unpriced (a partial total masquerading as a total is a lie). */
  spentUsd?: number;
  /** The same token stream repriced at the baseline model — a reconstruction. */
  baselineModel?: string;
  baselineUsd?: number;
  /** `baselineUsd - spentUsd` when both exist. Negative means the run cost
   *  MORE than the baseline would have. */
  savedUsd?: number;
  /** Models whose complete usage cannot be priced by the supplied table. */
  unpricedModels: string[];
  /** Models with calls whose provider reported no usage receipt. */
  unknownUsageModels: string[];
  models: ModelCost[];
}

/** Exact key first, then the longest prefix whose next char is a boundary. */
export function priceFor(
  table: PriceTable,
  model: string,
): ModelPrice | undefined {
  if (table[model]) return table[model];
  let best: { key: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table)) {
    if (!model.startsWith(key)) continue;
    const boundary = model.charAt(key.length);
    if (boundary !== '' && boundary !== '-' && boundary !== ':' && boundary !== '.')
      continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price;
}

/** A release date at the end of a model id: `-20250929` or `-2025-08-07`. */
const DATED_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

/** The entry named by the exact model id, or by the id without its release date. */
function exactEntryFor(
  table: PriceTable,
  model: string,
): { key: string; price: ModelPrice } | undefined {
  for (const key of [model, model.replace(DATED_SUFFIX, '')]) {
    if (Object.hasOwn(table, key)) return { key, price: table[key]! };
  }
  return undefined;
}

/**
 * One call's tokens priced by the table entry for its model: the entry with
 * the exact id, or with the id less a release date at its end. A model the
 * table does not list gives `unknown`, even when a listed id starts its name.
 * Input tokens include cache writes and reads, so those are taken out and
 * priced at their own rates. Cached tokens with no cache rate in the entry, or no
 * entry at all, give `unknown` rather than a guess.
 */
export function estimateCost(
  usage: UsageReceipt,
  model: string,
  table: PriceTable,
): CostReceipt {
  if (usage.kind !== 'reported') return { kind: 'unknown' };
  const match = exactEntryFor(table, model);
  if (!match) return { kind: 'unknown' };
  const { price } = match;
  const written = usage.cacheCreationInputTokens ?? 0;
  const read = usage.cacheReadInputTokens ?? 0;
  const fresh = usage.inputTokens - written - read;
  if (fresh < 0) return { kind: 'unknown' };
  if (written > 0 && price.cacheWritePerMTokUsd === undefined) return { kind: 'unknown' };
  if (read > 0 && price.cacheReadPerMTokUsd === undefined) return { kind: 'unknown' };
  const usd =
    (fresh * price.inputPerMTokUsd +
      written * (price.cacheWritePerMTokUsd ?? 0) +
      read * (price.cacheReadPerMTokUsd ?? 0) +
      usage.outputTokens * price.outputPerMTokUsd) /
    1_000_000;
  return { kind: 'estimated', usd: round(usd), entry: match.key };
}

function usdFor(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens * price.inputPerMTokUsd +
      outputTokens * price.outputPerMTokUsd) /
    1_000_000
  );
}

function round(usd: number): number {
  return Number(usd.toFixed(6));
}

function hasCachedInput(usage: StatsSnapshot['models'][number]): boolean {
  return (
    (usage.cacheCreationInputTokens ?? 0) > 0 ||
    (usage.cacheReadInputTokens ?? 0) > 0
  );
}

export function costReport(
  snapshot: Pick<StatsSnapshot, 'models'>,
  prices: PriceTable,
  baselineModel?: string,
): CostReport {
  const models: ModelCost[] = [];
  const unpriced: string[] = [];
  const unknownUsage: string[] = [];
  let spent = 0;
  let allPriced = true;
  const hasAnyCachedInput = snapshot.models.some(hasCachedInput);
  const hasAnyUnknownUsage = snapshot.models.some(
    (model) => model.unknownUsageCalls > 0,
  );
  for (const m of snapshot.models) {
    const price = priceFor(prices, m.model);
    const usd =
      price && !hasCachedInput(m) && m.unknownUsageCalls === 0
        ? round(usdFor(price, m.inputTokens, m.outputTokens))
        : undefined;
    if (m.unknownUsageCalls > 0) unknownUsage.push(m.model);
    if (usd === undefined) {
      allPriced = false;
      if (!price || hasCachedInput(m)) unpriced.push(m.model);
    } else {
      spent += usd;
    }
    models.push({
      model: m.model,
      calls: m.calls,
      reportedCalls: m.reportedCalls,
      unknownUsageCalls: m.unknownUsageCalls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      usd,
    });
  }

  let baselineUsd: number | undefined;
  if (
    baselineModel &&
    snapshot.models.length &&
    !hasAnyCachedInput &&
    !hasAnyUnknownUsage
  ) {
    const baselinePrice = priceFor(prices, baselineModel);
    if (baselinePrice) {
      baselineUsd = round(
        snapshot.models.reduce(
          (sum, m) => sum + usdFor(baselinePrice, m.inputTokens, m.outputTokens),
          0,
        ),
      );
    }
  }
  const spentUsd = allPriced && models.length ? round(spent) : undefined;
  return {
    spentUsd,
    baselineModel,
    baselineUsd,
    savedUsd:
      spentUsd !== undefined && baselineUsd !== undefined
        ? round(baselineUsd - spentUsd)
        : undefined,
    unpricedModels: unpriced,
    unknownUsageModels: unknownUsage,
    models,
  };
}

/** A compact receipt for the exit summary. States what is measured and what
 *  is reconstructed; names unpriced models instead of zeroing them. */
export function formatCostReport(report: CostReport): string[] {
  const lines: string[] = [];
  for (const m of report.models) {
    lines.push(
      `${m.model}: ${m.inputTokens}/${m.outputTokens} tok over ${m.calls} call(s)${
        m.unknownUsageCalls
          ? ` (usage unknown for ${m.unknownUsageCalls} call(s))`
          : m.usd !== undefined
            ? ` = $${m.usd}`
            : ' (incomplete price coverage)'
      }`,
    );
  }
  if (report.spentUsd !== undefined) {
    lines.push(`spent (measured): $${report.spentUsd}`);
  }
  if (report.unpricedModels.length) {
    lines.push(
      `no total: incomplete price coverage for model(s) ${report.unpricedModels.join(', ')}`,
    );
  }
  if (report.unknownUsageModels.length) {
    lines.push(
      `no total: usage unknown for model(s) ${report.unknownUsageModels.join(', ')}`,
    );
  }
  if (report.baselineUsd !== undefined) {
    lines.push(
      `baseline (reconstructed, same tokens on ${report.baselineModel}): $${report.baselineUsd}`,
    );
    if (report.savedUsd !== undefined) {
      lines.push(
        report.savedUsd >= 0
          ? `saved vs baseline: $${report.savedUsd}`
          : `over baseline: $${Math.abs(report.savedUsd)}`,
      );
    }
  }
  return lines;
}
