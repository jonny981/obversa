/**
 * The runner assembles a `JobContext` and executes a root `Job` (a loop, a dag,
 * or any job). It owns the engine resolver, the abort controller, the shared
 * state, and the stats collector. Hosts observe via `onEvent`.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Engine,
  EngineRef,
} from '../engines/engine.js';
import { isEngine } from '../engines/engine.js';
import { Stats, type StatsSnapshot } from '../core/stats.js';
import { costReport, SHIPPED_PRICES, type CostReport, type PriceTable } from '../core/cost.js';
import { LoopError } from '../core/errors.js';
import { Budget, type BudgetConfig } from '../core/budget.js';
import { makeRecorder, readResumeRecord } from './persist.js';
import { pricedEngine, RecordTotals } from './record-totals.js';

import { RESUME_RECORDED_USAGE, RESUME_STAGE_OUTCOMES } from '../core/resume.js';

/** Run-owned keys holding the workflow state read from its record. */
export { RESUME_RECORDED_USAGE, RESUME_STAGE_OUTCOMES };
import { ensureRunSubdir } from './paths.js';
import { startSupervisor, newRunId, type Supervisor } from './supervisor.js';
import { jobMeta } from '../core/describe.js';
import { currentBranch } from '../core/git.js';
import type { Environment, EnvHandle } from '../env/environment.js';
import type { Memory } from '@obversa/api';
import { createCallbackClient } from '../callback/client.js';
import { startMonitor, type RunMonitor, type StartedMonitor } from './monitor.js';
import {
  cloneFrozenJson,
  JsonValueError,
  type RunBrief,
} from '../graph/value.js';
import type {
  Job,
  JobContext,
  LimitPolicy,
  LoopEvent,
  Outcome,
  UsageTotals,
  Workspace,
  RunCallbacks,
} from '../core/types.js';

/** Default ceiling on an interruptible limit-wait: 5 minutes. */
const DEFAULT_MAX_WAIT_MS = 300_000;

/** Default interval between `heartbeat` events: 60 seconds. */
const DEFAULT_HEARTBEAT_MS = 60_000;

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Exit code for a `paused` run: EX_TEMPFAIL (sysexits.h). Distinct from `fail`
 * (1) so a wrapper can tell "paused" from "failed".
 */
export const EXIT_PAUSED = 75;

export interface RunOptions {
  /** Default engine selected when a job or condition names none. */
  readonly engine?: EngineRef;
  /** Ready-made engines available to jobs and conditions by name. */
  readonly engines?: Readonly<Record<string, Engine>>;
  /** External abort signal. */
  signal?: AbortSignal;
  /** Root working directory the run operates in. Default: process.cwd(). */
  cwd?: string;
  /**
   * Bring an environment up for the run (the root workspace) before the job and
   * tear it down after, so the gate can test the running thing. You supply the
   * adapter; the runtime owns only the interface. Per-team environments at the
   * worktree boundary are a separate, later binding.
   */
  environment?: Environment;
  onEvent?: (event: LoopEvent) => void;
  /** Immutable run brief shared by every job. */
  params?: RunBrief;
  /** Seed the shared, mutable run state. */
  state?: Record<string, unknown>;
  /** Memory instance available to every job in the run. */
  memory?: Memory;
  /**
   * The client the run's questions go through (`approval`). Default: a fresh
   * in-memory client for this run, so a run without one forgets its questions
   * when it ends. Pass a client to keep them: the in-memory one across runs
   * in a process, the stored client (`createStoredCallbackClient`) across a
   * process exit.
   */
  callbacks?: RunCallbacks;
  /** Wait for an outside answer, or return paused (the default). */
  onCallback?: 'wait' | 'exit';
  /**
   * Serve the run's own page on a free loopback port: the declared graph with
   * each step's live state, the returns, the pending questions, the record
   * tail. Off by default; on under `supervise` unless set to false. The
   * address is one `monitor` event and one line in the record, never stdout.
   */
  monitor?: boolean;
  /**
   * Cap total tokens (input + output) for the run. A bare number is the limit;
   * pass `{ limit, headroom?, soft? }` for headroom or warn-don't-refuse mode.
   * Engine call sites refuse to spend past it (see `Budget`).
   */
  budget?: number | BudgetConfig;
  /** Append every structured event as JSONL here, or auto-name one under `.obversa/records`. */
  recordTo?: string | 'auto';
  /**
   * Resume from the record at `recordTo` instead of truncating it: stages
   * whose completion is already recorded are skipped, interrupted stages
   * re-run. Requires an explicit `recordTo` path; a missing record is a
   * fresh run, not an error. Two processes resuming one record at once is
   * out of scope.
   */
  resume?: boolean;
  /**
   * Register this run in the global registry (`~/.obversa/runs/<runId>`) and write
   * its live state there, so another process can inspect it. Off by default;
   * opt in to make a run observable from outside.
   */
  supervise?: boolean;
  /**
   * Assign the registry id instead of generating one, so an outside controller
   * knows the id before the run registers.
   * Must match the registry alphabet (`[a-z0-9][a-z0-9-]*`); only meaningful
   * with `supervise` or `recordTo: 'auto'`.
   */
  runId?: string;
  /**
   * How a loop reacts to a rate limit / quota / token budget. Default `auto`:
   * wait out a known reset within `maxWaitMs`, else pause (exit code 75).
   * `wait` waits any known reset with no ceiling; `exit` never waits; `fail` is
   * fatal
   * behaviour.
   */
  onLimit?: LimitPolicy;
  /** Ceiling on a single interruptible limit-wait, in ms. Default 300000. */
  maxWaitMs?: number;
  /**
   * Price the run's measured token usage (`RunResult.cost`). Prices are
   * caller-supplied: this report does not read the shipped price table that
   * the per-call `cost` on each `engine:usage` event uses. `baselineModel` adds the
   * reconstructed counterfactual: the same token stream at that model's rates.
   */
  cost?: { prices: PriceTable; baselineModel?: string };
  /**
   * Prices laid over the table the runtime ships, for the estimated cost on
   * each engine call. An entry here replaces the shipped entry with the same
   * name, and a new name adds an entry.
   */
  prices?: PriceTable;
  /**
   * The workflow file this run comes from: a path, or a file URL such as the
   * launcher's `import.meta.url`. `run:start` records its path and SHA-256.
   */
  source?: string | URL;
  /**
   * Milliseconds between `heartbeat` events while the run is going. Default
   * 60000; 0 writes none.
   */
  heartbeatMs?: number;
}

/** The absolute path and SHA-256 of the run's `source` file. */
function sourceRecord(source: string | URL): { path: string; sha256: string } {
  let path: string;
  try {
    path = source instanceof URL || source.startsWith('file:') ? fileURLToPath(source) : resolve(source);
  } catch (error) {
    throw new TypeError(`source must be a file path or a file URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new TypeError(`source ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The run's totals, in the shape the line formatter takes. */
function usageOf(snapshot: StatsSnapshot): UsageTotals {
  return {
    inputTokens: snapshot.totalInputTokens,
    outputTokens: snapshot.totalOutputTokens,
    cacheReadInputTokens: snapshot.totalCacheReadInputTokens,
    cacheCreationInputTokens: snapshot.totalCacheCreationInputTokens,
    unmeasuredCalls: snapshot.totalUnmeasuredCalls,
  };
}

export interface RunResult {
  outcome: Outcome;
  stats: StatsSnapshot;
  /**
   * What the whole run spent, in the shape `formatEvent` takes, so the totals
   * a run reports can be handed straight back to the line formatter. The same
   * numbers are in `stats`; this is the summary a person reads rather than the
   * per-model record.
   */
  usage: UsageTotals;
  /** Final token accounting, when a budget was set. */
  budget?: { limit: number; spent: number; remaining: number };
  /** The registry id, when the run was supervised. */
  runId?: string;
  /** The run's page, when `monitor` was on: its address, and a way to close it. */
  monitor?: RunMonitor;
  /** The JSONL event record path, when recording was enabled. */
  recordPath?: string;
  /** The priced receipt, when `RunOptions.cost` was set. */
  cost?: CostReport;
}

function uniquePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => path !== undefined))];
}

export async function run(
  job: Job,
  options: RunOptions = {},
): Promise<RunResult> {
  if (options.onCallback !== undefined && options.onCallback !== 'wait' && options.onCallback !== 'exit') {
    throw new TypeError('onCallback must be wait or exit');
  }
  const paramsInput: unknown = options.params === undefined ? {} : options.params;
  if (
    paramsInput === null
    || typeof paramsInput !== 'object'
    || Array.isArray(paramsInput)
  ) {
    throw new JsonValueError('', 'run brief must be a JSON object');
  }
  const params = cloneFrozenJson(paramsInput as RunBrief);
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) {
    throw new TypeError('heartbeatMs must be a non-negative integer');
  }
  const source = options.source === undefined ? undefined : sourceRecord(options.source);
  const stats = new Stats();
  const prices: PriceTable = { ...SHIPPED_PRICES, ...options.prices };
  const totals = new RecordTotals(prices);
  const controller = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else
      options.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
  }

  const budget =
    options.budget != null
      ? new Budget(
          typeof options.budget === 'number'
            ? { limit: options.budget }
            : options.budget,
        )
      : undefined;
  const dir = options.cwd ?? process.cwd();
  const shape = jobMeta(job);
  const title = shape?.name ?? 'run';
  const needsRunId = options.supervise || options.recordTo === 'auto';
  if (options.runId != null && !/^[a-z0-9][a-z0-9-]*$/.test(options.runId)) {
    throw new LoopError({
      code: 'CONFIG',
      message: `runId must match [a-z0-9][a-z0-9-]*, got "${options.runId}"`,
    });
  }
  const runId = needsRunId ? (options.runId ?? newRunId(title)) : undefined;
  const callerState = options.state ?? {};
  const resumeState: Record<string, unknown> = {};
  const privateKeys = new Set([RESUME_STAGE_OUTCOMES, RESUME_RECORDED_USAGE]);
  const initialState: Record<string, unknown> = new Proxy(callerState, {
    get(target, key) {
      return typeof key === 'string' && privateKeys.has(key)
        ? resumeState[key]
        : target[key as string];
    },
    set(target, key, value) {
      if (typeof key === 'string' && privateKeys.has(key)) {
        resumeState[key] = value;
      } else {
        target[key as string] = value;
      }
      return true;
    },
  });

  // Persistence sinks observe the same event stream as outside readers.
  const sinks: Array<(event: LoopEvent) => void> = [];
  if (options.resume === true && (options.recordTo === undefined || options.recordTo === 'auto')) {
    throw new TypeError('resume requires an explicit recordTo path');
  }
  const recordPath =
    options.recordTo === 'auto'
      ? join(ensureRunSubdir(dir, 'records'), `${runId!}.jsonl`)
      : options.recordTo;
  let session: number | undefined;
  if (recordPath) {
    const resumed = options.resume === true ? readResumeRecord(recordPath) : undefined;
    session = (resumed?.sessions ?? 0) + 1;
    sinks.push(makeRecorder(recordPath, {
      thin: options.recordTo === 'auto',
      session,
      ...(resumed === undefined ? {} : { resume: true }),
    }));
    if (resumed !== undefined) {
      if (resumed.outcomes.interactions.size > 0) {
        for (const receipt of resumed.receipts) budget?.addUsage(receipt);
      }
      for (const call of resumed.calls) totals.restore(call);
      initialState[RESUME_STAGE_OUTCOMES] = resumed.outcomes;
      initialState[RESUME_RECORDED_USAGE] = resumed.usage;
    }
  }
  // A supervised run registers itself in the global registry (~/.obversa/runs) and
  // writes its live state there, so another process can list/status/tail it.
  let supervisor: Supervisor | undefined;
  if (options.supervise) {
    supervisor = startSupervisor({
      runId: runId!,
      cwd: dir,
      title,
      shape,
    });
    sinks.push(supervisor.sink);
  }

  const callbacks = options.callbacks ?? createCallbackClient();
  let started: StartedMonitor | undefined;
  if (options.monitor ?? options.supervise === true) {
    started = await startMonitor({ job, callbacks, runId: supervisor?.runId ?? runId });
    sinks.push(started.sink);
  }

  const emit = (raw: LoopEvent) => {
    const event = totals.stamp(raw);
    stats.record(event);
    // A failed call counts the tokens it reported. One with no tokens is in
    // the record but not the budget, so a rejected call does not stop the run
    // from trying a fallback.
    if (budget && event.kind === 'engine:usage' && (event.failed === undefined || event.usage.kind === 'reported')) {
      budget.addUsage(event.usage);
    }
    options.onEvent?.(event);
    for (const sink of sinks) sink(event);
  };
  const priced = new WeakMap<Engine, Engine>();
  const withCost = (engine: Engine): Engine => {
    let wrapped = priced.get(engine);
    if (wrapped === undefined) {
      wrapped = pricedEngine(engine, prices);
      priced.set(engine, wrapped);
    }
    return wrapped;
  };
  const resolveEngine = (ref?: EngineRef): Engine => {
    const selected = ref ?? options.engine;
    if (isEngine(selected)) return withCost(selected);
    if (selected === undefined) {
      throw new LoopError({
        code: 'CONFIG',
        message: 'an engine instance or named engine map entry is required',
      });
    }
    const engine = options.engines?.[selected];
    if (!isEngine(engine)) {
      throw new LoopError({
        code: 'CONFIG',
        message: `unknown engine "${selected}"`,
      });
    }
    return withCost(engine);
  };
  const rootEngine = options.engine === undefined ? undefined : resolveEngine(options.engine);

  // The root workspace is the substrate the whole run reads and writes. Branch
  // resolution is best-effort: a non-git cwd just leaves `branch` undefined.
  const workspace: Workspace = {
    dir,
    branch: await currentBranch({ cwd: dir, signal: controller.signal }),
  };

  // The page's address goes out before anything can fail, so the record
  // carries it on every path.
  if (started) emit({ kind: 'monitor', ts: Date.now(), path: [], url: started.monitor.url });

  const resultRunId = supervisor?.runId ?? runId;
  const runIdentity = {
    ...(resultRunId === undefined ? {} : { runId: resultRunId }),
    ...(recordPath === undefined ? {} : { recordPath }),
  };
  emit({
    kind: 'run:start',
    ts: Date.now(),
    path: [],
    ...runIdentity,
    ...(session === undefined ? {} : { session }),
    ...(source === undefined ? {} : { source }),
  });

  // A record that ends with neither run:end nor run:abort stopped near its
  // last heartbeat.
  const heartbeat = heartbeatMs > 0
    ? setInterval(() => emit({ kind: 'heartbeat', ts: Date.now(), path: [] }), heartbeatMs)
    : undefined;
  heartbeat?.unref();
  // On a stop signal the record says so before the process goes. This
  // listener runs first and then removes itself, so a listener that acts
  // only when it is the last one (the child-process cleanup) still acts.
  // When no listener is left at all, the signal is raised again so the
  // process stops as it would have without this run.
  const onSignal = new Map(STOP_SIGNALS.map((signal) => [signal, () => {
    emit({ kind: 'run:abort', ts: Date.now(), path: [], signal });
    process.off(signal, onSignal.get(signal)!);
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  }]));
  for (const [signal, listener] of onSignal) process.prependListener(signal, listener);
  const stopWatching = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    for (const [signal, listener] of onSignal) process.off(signal, listener);
  };

  // Bring the environment up for the run before the job, so the gate can test
  // the running thing. A failed start fails the run cleanly rather than throwing.
  let environment: EnvHandle | undefined;
  if (options.environment) {
    try {
      environment = await options.environment.up(workspace, controller.signal);
    } catch (e) {
      const error = LoopError.from(e, { code: 'CONFIG' });
      emit({
        kind: 'error',
        ts: Date.now(),
        path: [],
        message: `environment "${options.environment.name}" failed to start: ${error.message}`,
        code: error.code,
      });
      const failOutcome: Outcome = {
        status: 'fail',
        summary: `environment failed to start: ${error.message}`,
        error,
      };
      const failStats = stats.snapshot();
      const failUsage = usageOf(failStats);
      stopWatching();
      emit({
        kind: 'run:end',
        ts: Date.now(),
        path: [],
        outcome: failOutcome,
        usage: failUsage,
        cost: totals.totals(),
        totalUsage: totals.usage(),
        ...runIdentity,
      });
      supervisor?.finish(failOutcome);
      started?.finish(failOutcome);
      return {
        outcome: failOutcome,
        stats: failStats,
        usage: failUsage,
        budget: budget
          ? {
              limit: budget.limit,
              spent: budget.spent(),
              remaining: budget.remaining(),
            }
          : undefined,
        runId: resultRunId,
        recordPath,
        ...(started ? { monitor: started.monitor } : {}),
      };
    }
  }

  const rootCtx: JobContext = {
    engine: rootEngine,
    resolveEngine,
    signal: controller.signal,
    runId,
    fingerprintExcludePaths: uniquePaths([recordPath]),
    emit,
    params,
    state: initialState,
    memory: options.memory,
    callbacks,
    onCallback: options.onCallback ?? 'exit',
    workspace,
    environment,
    budget,
    onLimit: options.onLimit ?? 'auto',
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    iteration: 0,
    depth: 0,
    path: [],
    log: (message, level = 'info') =>
      emit({ kind: 'log', ts: Date.now(), path: [], level, message }),
  };

  let outcome: Outcome;
  try {
    outcome = await job(rootCtx);
  } catch (e) {
    const error = LoopError.from(e, { code: 'UNKNOWN' });
    emit({
      kind: 'error',
      ts: Date.now(),
      path: [],
      message: error.message,
      code: error.code,
    });
    outcome = { status: 'fail', summary: error.message, error };
  } finally {
    // Tear the environment down whatever happened (best-effort).
    if (environment) await environment.down(controller.signal).catch(() => {});
    stopWatching();
  }

  const finalStats = stats.snapshot();
  const finalUsage = usageOf(finalStats);
  emit({
    kind: 'run:end',
    ts: Date.now(),
    path: [],
    outcome,
    usage: finalUsage,
    cost: totals.totals(),
    totalUsage: totals.usage(),
    ...runIdentity,
  });
  supervisor?.finish(outcome);
  started?.finish(outcome);

  return {
    outcome,
    stats: finalStats,
    usage: finalUsage,
    budget: budget
      ? {
          limit: budget.limit,
          spent: budget.spent(),
          remaining: budget.remaining(),
        }
      : undefined,
    runId: resultRunId,
    recordPath,
    ...(started ? { monitor: started.monitor } : {}),
    cost: options.cost
      ? costReport(finalStats, options.cost.prices, options.cost.baselineModel)
      : undefined,
  };
}

/** Process exit code mapped from a terminal outcome. */
export function exitCodeFor(outcome: Outcome): number {
  switch (outcome.status) {
    case 'pass':
      return 0;
    case 'fail':
      return 1;
    case 'exhausted':
      return 2;
    case 'aborted':
      return 130;
    case 'paused':
      return EXIT_PAUSED;
  }
}
