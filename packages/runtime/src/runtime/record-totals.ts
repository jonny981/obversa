/**
 * Adds what the record needs to compare runs, as each event passes through
 * the run: a cost on every engine call, the time a job or node took, and the
 * tokens and dollars of each node attempt, each loop round and the run.
 */

import { recordKey } from '../core/context.js';
import { estimateCost, type PriceTable } from '../core/cost.js';
import type { CostTotals, LoopEvent, UsageTotals } from '../core/types.js';
import { failedCallUsage } from '../engines/fallback.js';
import type { AgentResult, CostReceipt, Engine, EngineEventSink, EngineStreamEvent, UsageReceipt } from '../engines/engine.js';

type UsageEvent = Extract<LoopEvent, { kind: 'engine:usage' }>;
type UsageStreamEvent = Extract<EngineStreamEvent, { type: 'usage' }>;
/** The events of an earlier session that the totals replay on a resume. */
export type RestoredEvent = Extract<LoopEvent, { kind: 'run:start' | 'engine:usage' | 'loop:iteration' | 'workflow:start' | 'dag:start' | 'dag:node' }>;

/** The engine's own figure when it gave one, otherwise an estimate from the table. */
function resolveCost(cost: CostReceipt | undefined, usage: UsageReceipt, model: string, prices: PriceTable): CostReceipt {
  return cost !== undefined && cost.kind !== 'unknown' ? cost : estimateCost(usage, model, prices);
}

/**
 * The engine with the cost and billing of each call put on the result it
 * returns, the same figure its usage event carries into the record.
 */
export function pricedEngine(engine: Engine, prices: PriceTable): Engine {
  const run: Engine['run'] = async (request, onEvent, signal) => {
    const priced = (event: UsageStreamEvent): UsageStreamEvent => ({
      ...event,
      cost: resolveCost(event.cost, event.usage, event.model, prices),
      billing: event.billing ?? 'unknown',
    });
    // Usage waits for the call to end, so its event can carry a cost or
    // billing the engine gives only on its result. A call that already
    // failed inside the engine, such as one lane of a fallback chain, goes
    // to the record at once, so a stop during the next lane keeps it.
    const held: UsageStreamEvent[] = [];
    let reported = false;
    const hold: EngineEventSink = (event) => {
      if (event.type !== 'usage') onEvent(event);
      else {
        reported = true;
        if (event.failed === true) onEvent(priced(event));
        else held.push(event);
      }
    };
    let result: AgentResult;
    try {
      result = await engine.run(request, hold, signal);
    } catch (error) {
      // A call that failed before it reported usage still counts once, with
      // the tokens its failure carried or as unknown. Usage it did report is
      // marked failed.
      if (!reported) held.push(failedCallUsage(error, request));
      for (const event of held) onEvent(priced({ ...event, failed: true }));
      throw error;
    }
    // The result's own cost and billing win over its usage event's.
    const own = held.at(-1);
    const cost = result.cost !== undefined && result.cost.kind !== 'unknown'
      ? result.cost
      : own === undefined
        ? estimateCost(result.usage, result.effective.model ?? '', prices)
        : resolveCost(own.cost, own.usage, own.model, prices);
    const billing = result.billing ?? own?.billing ?? 'unknown';
    for (const event of held) onEvent(event === own ? { ...event, cost, billing } : priced(event));
    return Object.freeze({ ...result, cost, billing });
  };
  // Every other member is the engine's own, called on the engine itself.
  return new Proxy(engine, {
    get(target, key) {
      if (key === 'run') return run;
      const value = (target as unknown as Record<PropertyKey, unknown>)[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class Tally {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheCreationInputTokens = 0;
  private cacheReadInputTokens = 0;
  private unmeasuredCalls = 0;
  private reportedUsd = 0;
  private estimatedUsd = 0;
  private unknownCalls = 0;
  private readonly unknownModels = new Set<string>();

  add(event: UsageEvent): void {
    if (event.usage.kind === 'reported') {
      this.inputTokens += event.usage.inputTokens;
      this.outputTokens += event.usage.outputTokens;
      this.cacheCreationInputTokens += event.usage.cacheCreationInputTokens ?? 0;
      this.cacheReadInputTokens += event.usage.cacheReadInputTokens ?? 0;
    } else {
      this.unmeasuredCalls += 1;
    }
    const cost = event.cost ?? { kind: 'unknown' };
    if (cost.kind === 'reported') this.reportedUsd += cost.usd;
    else if (cost.kind === 'estimated') this.estimatedUsd += cost.usd;
    else {
      this.unknownCalls += 1;
      this.unknownModels.add(event.model);
    }
  }

  usage(): UsageTotals {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadInputTokens: this.cacheReadInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
      unmeasuredCalls: this.unmeasuredCalls,
    };
  }

  cost(): CostTotals {
    return {
      usd: round(this.reportedUsd + this.estimatedUsd),
      reportedUsd: round(this.reportedUsd),
      estimatedUsd: round(this.estimatedUsd),
      unknownCalls: this.unknownCalls,
      unknownModels: [...this.unknownModels],
    };
  }
}

function round(usd: number): number {
  return Number(usd.toFixed(6));
}

/** A node attempt that ended: its calls, and its time when it had a start. */
interface EndedAttempt {
  readonly tally: Tally;
  readonly durationMs: number | undefined;
  /** A pass, which a resume of the same graph skips. */
  readonly reused: boolean;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

/** The key a resume reads a node attempt by: the node's path, with the
 * round of each loop or step on it and its own attempt past the first. */
function nodeKey(event: Extract<LoopEvent, { kind: 'dag:node' }>): string {
  return recordKey([...event.path, event.node], event.rounds);
}

export class RecordTotals {
  private readonly run = new Tally();
  // On a node's scope: `resumed` while the node has not started or ended
  // since a resume picked up its graph, `last` the record key of the attempt
  // it last ended with no start since, and `skipping` the record key of a
  // start after a resume that the record still reuses.
  private readonly scopes = new Map<string, { readonly path: readonly string[]; tally: Tally; resumed?: boolean; last?: string; skipping?: string }>();
  // Each node attempt that ended, by the key a resume reads it by, so the
  // same step in two rounds keeps two attempts.
  private readonly ended = new Map<string, EndedAttempt>();
  // A stack per path and label: a job can run a nested job with the same
  // label, and each end closes the latest start.
  private readonly jobStarts = new Map<string, number[]>();
  private readonly nodeStarts = new Map<string, number>();
  // The record key each graph path last started with, in its round.
  private readonly graphKeys = new Map<string, string>();
  // The graphs the record has started, by record key, and those whose next
  // start continues the run a resume picked up rather than running every
  // node again.
  private readonly dags = new Set<string>();
  private continuing = new Set<string>();
  // The shape each graph last started with. A resume skips a graph's
  // finished nodes only when it starts with the same shape.
  private readonly shapes = new Map<string, string>();
  private readonly sameShape = new Set<string>();

  constructor(private readonly prices: PriceTable) {}

  /** The run's dollars so far, earlier sessions included. */
  totals(): CostTotals {
    return this.run.cost();
  }

  /** The run's tokens so far, earlier sessions included. */
  usage(): UsageTotals {
    return this.run.usage();
  }

  /**
   * Replay an earlier session of the record: count each call at the figure
   * it recorded, and reopen each loop round and node attempt, so a round or
   * an attempt that a resume finishes still carries the calls made before
   * the stop.
   */
  restore(event: RestoredEvent): void {
    switch (event.kind) {
      case 'run:start':
        this.continuing = new Set(this.dags);
        return;
      case 'loop:iteration':
        this.scopes.set(JSON.stringify(['loop', event.path]), { path: event.path, tally: new Tally() });
        return;
      case 'workflow:start':
        this.startGraph(event);
        return;
      case 'dag:start':
        this.openNodes(event);
        return;
      case 'dag:node':
        if (event.phase === 'start') this.startNode(event);
        else this.closeNode(event, event.durationMs);
        return;
      default:
        this.count(event);
    }
  }

  private count(event: UsageEvent): void {
    this.run.add(event);
    for (const scope of this.scopes.values()) {
      if (startsWith(event.path, scope.path)) scope.tally.add(event);
    }
  }

  private startGraph(event: Extract<LoopEvent, { kind: 'workflow:start' }>): void {
    const key = recordKey(event.path, event.rounds);
    this.graphKeys.set(JSON.stringify(event.path), key);
    const shape = JSON.stringify([event.identity, event.workspace]);
    if (this.shapes.get(key) === shape) this.sameShape.add(key);
    else this.sameShape.delete(key);
    this.shapes.set(key, shape);
  }

  // A node's tally opens with its dag, because a node's `when` check runs
  // before its start event. The first start of a dag in a round after a
  // resume, with the same shape, carries on the attempts from before the
  // stop. Any other start, such as a second run of the dag in the same
  // round, opens every node afresh.
  private openNodes(event: Extract<LoopEvent, { kind: 'dag:start' }>): void {
    const dag = this.graphKeys.get(JSON.stringify(event.path)) ?? recordKey(event.path);
    const resumed = this.continuing.delete(dag) && this.sameShape.has(dag);
    this.dags.add(dag);
    for (const node of event.nodes) {
      const key = JSON.stringify(['node', event.path, node]);
      const scope = this.scopes.get(key);
      if (resumed && scope !== undefined) {
        scope.resumed = true;
        delete scope.last;
        delete scope.skipping;
      } else {
        this.scopes.set(key, { path: [...event.path, node], tally: new Tally() });
      }
    }
  }

  // The first start after a resume of a node whose record key holds a pass
  // is a skip of that pass, unless the start is past the node's first
  // attempt. The record reader takes such a start as setting the pass aside:
  // a resume reuses a node a send-back ran again from the rounds its graph
  // saved, with no start, so the node starts only to run. A first attempt
  // that runs again in place of its pass starts a second time before it
  // runs, at attempt 2. Any start that is not a skip runs the node, so its
  // done carries only its own calls, and those of an attempt a stop cut
  // short.
  private startNode(event: Extract<LoopEvent, { kind: 'dag:node' }>): void {
    const scope = this.scopes.get(JSON.stringify(['node', event.path, event.node]));
    if (scope === undefined) return;
    const key = nodeKey(event);
    const skip = scope.resumed === true && event.attempt === 1 && this.ended.get(key)?.reused === true;
    delete scope.resumed;
    delete scope.last;
    if (skip) {
      scope.skipping = key;
    } else {
      delete scope.skipping;
      this.ended.delete(key);
    }
  }

  /**
   * The attempt a done or skip ends. A resume that skips a node repeats the
   * pass its record key holds: after a start the record still reuses, or as
   * the only line of a node its graph reuses from saved rounds. A done that
   * records a pause leaves the attempt open, because the person's answer
   * finishes it. A later done for an attempt that already ended, such as a
   * judge accepting a failed review, changes only its outcome, so it keeps
   * that attempt's calls and time and takes whether a resume skips it from
   * the new outcome.
   */
  private closeNode(event: Extract<LoopEvent, { kind: 'dag:node' }>, durationMs: number | undefined): EndedAttempt | undefined {
    const scope = this.scopes.get(JSON.stringify(['node', event.path, event.node]));
    if (scope === undefined) return undefined;
    const key = nodeKey(event);
    const prior = this.ended.get(key);
    const reused = event.outcome?.status === 'pass'
      && (event.outcome.data as { skipped?: boolean } | undefined)?.skipped !== true;
    const skipped = prior?.reused === true && reused && (scope.skipping === key || scope.resumed === true);
    const again = prior !== undefined && scope.last === key;
    delete scope.resumed;
    delete scope.skipping;
    if (skipped || again) {
      scope.last = key;
      const ended = { ...prior!, reused };
      this.ended.set(key, ended);
      return ended;
    }
    // A node that ends before its first start after a resume, such as one
    // whose `when` check threw, ends a new attempt, never the one before the
    // stop, even under the same record key.
    const ended: EndedAttempt = { tally: scope.tally, durationMs, reused };
    if (event.outcome?.status !== 'paused') {
      this.ended.set(key, ended);
      scope.last = key;
      scope.tally = new Tally();
    }
    return ended;
  }

  /** The event with the fields this module adds; other events come back as they are. */
  stamp(event: LoopEvent): LoopEvent {
    switch (event.kind) {
      case 'engine:usage': {
        const cost = resolveCost(event.cost, event.usage, event.model, this.prices);
        const stamped: UsageEvent = { ...event, cost, billing: event.billing ?? 'unknown' };
        this.count(stamped);
        return stamped;
      }
      case 'job:start': {
        const key = JSON.stringify([event.path, event.label]);
        const starts = this.jobStarts.get(key);
        if (starts === undefined) this.jobStarts.set(key, [event.ts]);
        else starts.push(event.ts);
        return event;
      }
      case 'job:end': {
        const key = JSON.stringify([event.path, event.label]);
        const starts = this.jobStarts.get(key);
        const started = starts?.pop();
        if (started === undefined) return event;
        if (starts!.length === 0) this.jobStarts.delete(key);
        return { ...event, durationMs: event.ts - started };
      }
      case 'run:start':
        this.continuing = new Set(this.dags);
        return event;
      case 'workflow:start':
        this.startGraph(event);
        return event;
      case 'dag:start':
        this.openNodes(event);
        return event;
      case 'dag:node': {
        const key = JSON.stringify(['node', event.path, event.node]);
        if (event.phase === 'start') {
          this.nodeStarts.set(key, event.ts);
          this.startNode(event);
          return event;
        }
        const started = this.nodeStarts.get(key);
        this.nodeStarts.delete(key);
        const ended = this.closeNode(event, started === undefined ? undefined : event.ts - started);
        if (ended === undefined) return event;
        if (event.phase !== 'done') return event;
        // A node whose `when` check threw is done without a start, so it has
        // totals but no duration.
        return {
          ...event,
          ...(ended.durationMs === undefined ? {} : { durationMs: ended.durationMs }),
          usage: ended.tally.usage(),
          cost: ended.tally.cost(),
        };
      }
      case 'loop:iteration':
        this.scopes.set(JSON.stringify(['loop', event.path]), { path: event.path, tally: new Tally() });
        return event;
      case 'loop:review': {
        const scope = this.scopes.get(JSON.stringify(['loop', event.path]));
        return scope === undefined ? event : { ...event, usage: scope.tally.usage(), cost: scope.tally.cost() };
      }
      default:
        return event;
    }
  }
}
