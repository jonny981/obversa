/**
 * The runner assembles a `JobContext` and executes a root `Job` (a loop, a dag,
 * or any job). It owns the engine resolver, the abort controller, the shared
 * state, and the stats collector. Hosts observe via `onEvent`.
 */

import { join } from 'node:path';

import type {
  Engine,
  EngineRef,
} from '../engines/engine.js';
import { isEngine } from '../engines/engine.js';
import { Stats, type StatsSnapshot } from '../core/stats.js';
import { costReport, type CostReport, type PriceTable } from '../core/cost.js';
import { LoopError } from '../core/errors.js';
import { Budget, type BudgetConfig } from '../core/budget.js';
import { makeRecorder } from './persist.js';
import { ensureRunSubdir } from './paths.js';
import { startSupervisor, newRunId, type Supervisor } from './supervisor.js';
import { jobMeta } from '../core/describe.js';
import { currentBranch } from '../core/git.js';
import type { Environment, EnvHandle } from '../env/environment.js';
import type { Memory } from '@obversa/memory';
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
  Workspace,
} from '../core/types.js';

/** Default ceiling on an interruptible limit-wait: 5 minutes. */
const DEFAULT_MAX_WAIT_MS = 300_000;

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
   * Cap total tokens (input + output) for the run. A bare number is the limit;
   * pass `{ limit, headroom?, soft? }` for headroom or warn-don't-refuse mode.
   * Engine call sites refuse to spend past it (see `Budget`).
   */
  budget?: number | BudgetConfig;
  /** Append every structured event as JSONL here, or auto-name one under `.obversa/records`. */
  recordTo?: string | 'auto';
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
   * caller-supplied — the library hardcodes none. `baselineModel` adds the
   * reconstructed counterfactual: the same token stream at that model's rates.
   */
  cost?: { prices: PriceTable; baselineModel?: string };
}

export interface RunResult {
  outcome: Outcome;
  stats: StatsSnapshot;
  /** Final token accounting, when a budget was set. */
  budget?: { limit: number; spent: number; remaining: number };
  /** The registry id, when the run was supervised. */
  runId?: string;
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
  const paramsInput: unknown = options.params === undefined ? {} : options.params;
  if (
    paramsInput === null
    || typeof paramsInput !== 'object'
    || Array.isArray(paramsInput)
  ) {
    throw new JsonValueError('', 'run brief must be a JSON object');
  }
  const params = cloneFrozenJson(paramsInput as RunBrief);
  const stats = new Stats();
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
  const initialState: Record<string, unknown> = options.state ?? {};

  // Persistence sinks observe the same event stream as outside readers.
  const sinks: Array<(event: LoopEvent) => void> = [];
  const recordPath =
    options.recordTo === 'auto'
      ? join(ensureRunSubdir(dir, 'records'), `${runId!}.jsonl`)
      : options.recordTo;
  if (recordPath) {
    sinks.push(makeRecorder(recordPath, { thin: options.recordTo === 'auto' }));
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

  const emit = (event: LoopEvent) => {
    stats.record(event);
    if (budget && event.kind === 'engine:usage') budget.addUsage(event.usage);
    options.onEvent?.(event);
    for (const sink of sinks) sink(event);
  };
  const resolveEngine = (ref?: EngineRef): Engine => {
    const selected = ref ?? options.engine;
    if (isEngine(selected)) return selected;
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
    return engine;
  };

  // The root workspace is the substrate the whole run reads and writes. Branch
  // resolution is best-effort: a non-git cwd just leaves `branch` undefined.
  const workspace: Workspace = {
    dir,
    branch: await currentBranch({ cwd: dir, signal: controller.signal }),
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
      supervisor?.finish(failOutcome);
      return {
        outcome: failOutcome,
        stats: stats.snapshot(),
        budget: budget
          ? {
              limit: budget.limit,
              spent: budget.spent(),
              remaining: budget.remaining(),
            }
          : undefined,
        runId: supervisor?.runId ?? runId,
        recordPath,
      };
    }
  }

  const rootCtx: JobContext = {
    engine: options.engine === undefined ? undefined : resolveEngine(options.engine),
    resolveEngine,
    signal: controller.signal,
    runId,
    fingerprintExcludePaths: uniquePaths([recordPath]),
    emit,
    params,
    state: initialState,
    memory: options.memory,
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
  }

  supervisor?.finish(outcome);

  const finalStats = stats.snapshot();
  return {
    outcome,
    stats: finalStats,
    budget: budget
      ? {
          limit: budget.limit,
          spent: budget.spent(),
          remaining: budget.remaining(),
        }
      : undefined,
    runId: supervisor?.runId ?? runId,
    recordPath,
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
