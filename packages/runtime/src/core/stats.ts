/**
 * Stats collector. Subscribes to the event stream and accumulates everything
 * a host status view needs: per-loop iteration counts, review
 * pass/fail tallies, token usage by model, errors, and wall-clock timing.
 */

import type { LoopEvent, Outcome } from './types.js';

export interface LoopStat {
  path: string;
  iterations: number;
  reviewsPassed: number;
  reviewsFailed: number;
  lastStatus?: Outcome['status'];
}

export interface ModelUsage {
  model: string;
  calls: number;
  reportedCalls: number;
  unknownUsageCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ErrorEntry {
  path: string;
  code: string;
  message: string;
  ts: number;
}

export interface StatsSnapshot {
  startedAt: number;
  elapsedMs: number;
  loopRuns: LoopStat[];
  models: ModelUsage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  /**
   * What the whole run created and read from cache. The per-model breakdown
   * carried these already; the run-wide totals did not, so nothing could
   * answer "what did this run read from cache" without summing models by hand.
   */
  totalCacheCreationInputTokens: number;
  totalCacheReadInputTokens: number;
  /**
   * How many calls reported no usage at all. The per-call line says "usage
   * unknown" rather than inventing a zero; without this the aggregate quietly
   * drops those calls and a total that might be missing three of them looks
   * complete.
   */
  totalUnmeasuredCalls: number;
  agentCalls: number;
  errors: ErrorEntry[];
}

export class Stats {
  private readonly startedAt = Date.now();
  private readonly loopRuns = new Map<string, LoopStat>();
  private readonly models = new Map<string, ModelUsage>();
  private readonly errors: ErrorEntry[] = [];

  record(event: LoopEvent): void {
    const key = event.path.join(' / ') || '(root)';
    switch (event.kind) {
      case 'loop:start':
        this.loopFor(key);
        break;
      case 'loop:iteration':
        this.loopFor(key).iterations = event.iteration;
        break;
      case 'loop:review': {
        const s = this.loopFor(key);
        if (event.outcome.status === 'pass') s.reviewsPassed += 1;
        else s.reviewsFailed += 1;
        break;
      }
      case 'loop:end':
        this.loopFor(key).lastStatus = event.outcome.status;
        break;
      case 'engine:usage': {
        const m = this.modelFor(event.model);
        m.calls += 1;
        if (event.usage.kind === 'unknown') {
          m.unknownUsageCalls += 1;
          break;
        }
        m.reportedCalls += 1;
        m.inputTokens += event.usage.inputTokens;
        m.outputTokens += event.usage.outputTokens;
        if (event.usage.cacheCreationInputTokens !== undefined)
          m.cacheCreationInputTokens =
            (m.cacheCreationInputTokens ?? 0) + event.usage.cacheCreationInputTokens;
        if (event.usage.cacheReadInputTokens !== undefined)
          m.cacheReadInputTokens =
            (m.cacheReadInputTokens ?? 0) + event.usage.cacheReadInputTokens;
        break;
      }
      case 'error':
        this.errors.push({
          path: key,
          code: event.code,
          message: event.message,
          ts: event.ts,
        });
        break;
    }
  }

  snapshot(): StatsSnapshot {
    const models = [...this.models.values()];
    return {
      startedAt: this.startedAt,
      elapsedMs: Date.now() - this.startedAt,
      loopRuns: [...this.loopRuns.values()],
      models,
      totalInputTokens: models.reduce((a, m) => a + m.inputTokens, 0),
      totalOutputTokens: models.reduce((a, m) => a + m.outputTokens, 0),
      totalCacheCreationInputTokens: models.reduce((a, m) => a + (m.cacheCreationInputTokens ?? 0), 0),
      totalCacheReadInputTokens: models.reduce((a, m) => a + (m.cacheReadInputTokens ?? 0), 0),
      totalUnmeasuredCalls: models.reduce((a, m) => a + m.unknownUsageCalls, 0),
      agentCalls: models.reduce((a, m) => a + m.calls, 0),
      errors: this.errors,
    };
  }

  private loopFor(path: string): LoopStat {
    let s = this.loopRuns.get(path);
    if (!s) {
      s = { path, iterations: 0, reviewsPassed: 0, reviewsFailed: 0 };
      this.loopRuns.set(path, s);
    }
    return s;
  }

  private modelFor(model: string): ModelUsage {
    let m = this.models.get(model);
    if (!m) {
      m = {
        model,
        calls: 0,
        reportedCalls: 0,
        unknownUsageCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      this.models.set(model, m);
    }
    return m;
  }
}
