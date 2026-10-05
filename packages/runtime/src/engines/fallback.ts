/**
 * A fallback chain over engine instances, tried in declared order.
 *
 * Default triggers are auth, billing, missing CLI, unavailable model,
 * invalid configuration and quota. An engine that reports one of these is
 * skipped for the rest of this chain's lifetime. Rate limits and transient
 * failures propagate to the caller. An explicit `on` set replaces the
 * defaults.
 *
 * Aborts never fall back. If every engine fails, the final engine error is
 * thrown. A subsequent call with every engine skipped reports no live engine.
 */

import {
  EngineError,
  EngineIncompleteResultError,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
  type EngineStreamEvent,
} from './engine.js';
import {
  classifyEngineFailure,
  LANE_DEAD_FAILURES,
  type EngineFailureKind,
} from './failure.js';

/**
 * The usage event that counts a call which failed before it reported usage:
 * the tokens its failure carried, or unknown.
 */
export function failedCallUsage(
  error: unknown,
  request: AgentRequest,
): Extract<EngineStreamEvent, { type: 'usage' }> {
  const evidence = error instanceof EngineIncompleteResultError ? error.evidence : undefined;
  return {
    type: 'usage',
    usage: evidence?.usage ?? { kind: 'unknown' },
    model: evidence?.effective.model
      ?? (error instanceof EngineError ? error.effective?.model : undefined)
      ?? request.model
      ?? '',
    ...(evidence?.cost === undefined ? {} : { cost: evidence.cost }),
    ...(evidence?.billing === undefined ? {} : { billing: evidence.billing }),
    failed: true,
  };
}

export interface FallbackInfo {
  /** The lane that just died. */
  from: string;
  /** The lane the call is moving to, when one is left. */
  to?: string;
  failure: EngineFailureKind;
  error: unknown;
}

export interface FallbackOptions {
  /** Failure kinds that trigger fallback. Default: `LANE_DEAD_FAILURES`. */
  on?: Iterable<EngineFailureKind>;
  /** Observe each reroute (log it, count it, surface it). */
  onFallback?: (info: FallbackInfo) => void;
}

/**
 * Build a fallback chain over ready-made `Engine`s, tried in order.
 *
 * ```ts
 * await run(job, { engine: fallbackEngine([claude, codex]) });
 */
export function fallbackEngine(
  engines: readonly [Engine, ...Engine[]],
  options: FallbackOptions = {},
): Engine {
  if (!engines.length) throw new RangeError('fallbackEngine needs at least one engine');
  const triggers = new Set(options.on ?? LANE_DEAD_FAILURES);
  const lanes = engines.map((engine) => ({ engine, dead: false }));
  const name = `fallback(${lanes.map((lane) => lane.engine.name).join(' -> ')})`;
  return {
    name,
    async run(
      req: AgentRequest,
      onEvent: EngineEventSink,
      signal: AbortSignal,
    ): Promise<AgentResult> {
      let lastError: unknown;
      for (let i = 0; i < lanes.length; i++) {
        const lane = lanes[i]!;
        if (lane.dead) continue;
        // A lane's usage waits for its call to end, so a failed lane's usage
        // can be marked failed.
        const usage: Extract<EngineStreamEvent, { type: 'usage' }>[] = [];
        try {
          const result = await lane.engine.run(req, (event) => {
            if (event.type === 'usage') usage.push(event);
            else onEvent(event);
          }, signal);
          for (const event of usage) onEvent(event);
          return result;
        } catch (error) {
          // Each lane's call is counted once, the failed ones included.
          if (usage.length === 0) onEvent(failedCallUsage(error, req));
          for (const event of usage) onEvent({ ...event, failed: true });
          lastError = error;
          if (signal.aborted) throw error;
          const failure = classifyEngineFailure(error);
          if (!triggers.has(failure)) throw error;
          lane.dead = true; // latched: a dead lane is not retried this run
          const next = lanes.slice(i + 1).find((candidate) => !candidate.dead);
          options.onFallback?.({
            from: lane.engine.name,
            to: next?.engine.name,
            failure,
            error,
          });
          if (!next) break;
        }
      }
      throw lastError ?? new Error(`${name}: no live engine left`);
    },
  };
}
