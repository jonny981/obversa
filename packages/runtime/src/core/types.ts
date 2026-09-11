/**
 * The core contract: one universal runnable unit and two supporting types.
 *
 *   - a `Job`       — a unit of work that runs once and returns an `Outcome`.
 *                     Any size: a single agent turn, or a whole nested loop.
 *   - a `Condition` — a question answered against the current context (a `when`).
 *   - a `Loop`      — produced by `loop()`, and is itself a `Job`.
 *
 * Because a `Loop` is a `Job`, a loop's `body`/`review`/any stage can be
 * another `loop(...)`, so loop jobs nest.
 *
 * Jenkins mapping: Job≈job/pipeline, Engine≈agent/node (where it runs),
 * `start`≈trigger, `Condition`≈`when`, `review`+`onComplete`≈`post`,
 * `retry`≈`retry`/`catchError`. The stage/DAG machinery is not imported here:
 * the primitive is the loop, not a pipeline.
 */

import type { Engine, EngineRef, UsageReceipt } from '../engines/engine.js';
import type { Memory } from '@obversa/memory';
import type { LoopError } from './errors.js';
import type { Budget } from './budget.js';
import type { EnvHandle, Environment } from '../env/environment.js';
import type { JsonValue, RunBrief } from '../graph/value.js';

/** Terminal disposition of a `Job`. */
export type OutcomeStatus =
  | 'pass' // the step achieved its goal
  | 'fail' // the step ran but did not achieve its goal (a loop can keep going)
  | 'aborted' // an early-exit signal or `stopOn` cut the work short
  | 'exhausted' // a loop hit `max` iterations without passing
  | 'paused'; // a limit stopped the run before completion

/**
 * How the run reacts to a provider rate limit, account/usage allowance, or its
 * own token budget. `auto` (the default) waits when the reset is known and
 * within `maxWaitMs`, else pauses the run.
 */
export type LimitPolicy = 'auto' | 'wait' | 'exit' | 'fail';

export interface Outcome {
  status: OutcomeStatus;
  /** 0..1 confidence, when the outcome was decided by an agent validator. */
  confidence?: number;
  /**
   * True when an engine finished after its soft timeout but before the hard
   * timeout/grace boundary. The result is usable, but supervisors can still
   * surface that it landed late.
   */
  late?: boolean;
  /** One-line human summary for logs and host status views. */
  summary?: string;
  /** Arbitrary payload threaded to the next step / surfaced to the caller. */
  data?: unknown;
  /** Present when `status` is driven by a failure. */
  error?: LoopError;
  /**
   * Present when a loop ended `exhausted` because its `noProgress` detector
   * tripped: the evidence that the last `window` iterations reached no state
   * the run had not already seen. Lets a supervisor distinguish a stall from a
   * hit iteration cap without parsing the summary.
   */
  stall?: StallReport;
  /**
   * Structured feedback asking an earlier unit of work for another pass, and the
   * single channel for it. When `revision.target` is set, the enclosing `dag`
   * re-runs that node and its transitive dependents with `revision.reason`
   * threaded in as `lastReview`, bounded by `DagConfig.maxKickbacks` (default
   * 0 — ignored). The re-run happens in execution only; the graph stays acyclic
   * and the re-run budget guarantees termination. Produce one with
   * `revisionRequest({ target, findings })` or `kickback(to, reason)`.
   */
  revision?: RevisionRequest;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Where a job's code lives: a working directory and (when it is a git repo) the
 * branch checked out there. Sequential jobs share one `Workspace`; concurrent
 * writers can fork into isolated worktrees. Default: the process working directory.
 */
export interface Workspace {
  /** Absolute path to the working tree this job operates in. */
  readonly dir: string;
  /** The branch checked out in `dir`, when known (undefined on detached HEAD). */
  readonly branch?: string;
}

export type FeedbackActionSeverity =
  | 'block'
  | 'should-fix'
  | 'nice-to-have'
  | 'approve';

export type FeedbackSeverity = FeedbackActionSeverity;

export type FeedbackDecision =
  | 'accepted'
  | 'rejected'
  | 'deferred'
  | 'escalated';

export interface FeedbackFinding {
  reviewer?: string;
  severity?: FeedbackSeverity;
  decision?: FeedbackDecision;
  /**
   * The ownership surface this finding belongs to. A review/fix loop may be
   * scoped to a smaller surface and escalate findings outside it instead of
   * counting them against convergence.
   */
  scope?: string;
  evidence: string;
  recommendation?: string;
}

export type RevisionRerun = 'target-and-dependents';

export interface RevisionRequest {
  target?: string;
  reason: string;
  findings?: FeedbackFinding[];
  rerun?: RevisionRerun;
  source?: string;
  decision?: FeedbackDecision;
}

export interface GraphPosition {
  dag: string;
  node: string;
  path: readonly string[];
  needs: readonly string[];
  dependents: readonly string[];
  /** One sentence describing what this node does, when declared. */
  desc?: string;
  /** The written acceptance criterion for this node, when declared. */
  gate?: string;
}

/**
 * Threaded into every `Job`. Carries the engine, the abort signal, the event
 * sink, a mutable scratchpad shared across the run, the workspace the work
 * happens in, and the position in the loop tree (used by hosts and stats).
 */
export interface JobContext {
  /** Default engine for this run, when the host supplied one. */
  readonly engine?: Engine;
  /**
   * Resolve an engine for a step. A name comes only from the host-supplied
   * map; a ready-made `Engine` passes through; no argument uses the run default.
   */
  resolveEngine(ref?: EngineRef): Engine;
  readonly signal: AbortSignal;
  /** Stable id for this run when one was assigned by the runner. */
  readonly runId?: string;
  /** Run-owned files omitted from workspace fingerprints. */
  /** @internal */
  readonly fingerprintExcludePaths?: string[];
  emit(event: LoopEvent): void;
  /** Immutable run brief shared by every job in this run. */
  readonly params: RunBrief;
  /** Shared mutable state for the whole run (e.g. accumulating notes). */
  readonly state: Record<string, unknown>;
  /** Memory available to jobs in this run, when the caller supplied it. */
  readonly memory?: Memory;
  /** Where this job's code lives — the working dir and branch (the substrate). */
  readonly workspace: Workspace;
  /** The running environment for this workspace, when one is up (gate target). */
  readonly environment?: EnvHandle;
  /**
   * Env vars pinned for this scope and everything beneath it — gate commands,
   * judge calls, and the subprocesses agent leaves spawn. Layered over
   * `ctx.environment?.env`; set via `withEnv()`.
   */
  readonly envOverlay?: Record<string, string>;
  /** 1-based iteration index within the enclosing loop; 0 outside a loop. */
  readonly iteration: number;
  /** Nesting depth (root steps are 0). */
  readonly depth: number;
  /** Loop/step names from the root down to here. */
  readonly path: readonly string[];
  /** The current DAG node position, when this job is running inside a dag node. */
  readonly graph?: GraphPosition;
  /** @internal The current DAG node's acceptance criterion, only for its reviewer. */
  readonly reviewerGate?: string | null;
  /** @internal The nearest DAG node's acceptance criterion across nested jobs. */
  readonly stageGate?: string | null;
  /**
   * Timeout inherited by jobs in this scope. A node can set it once and agent
   * leaves beneath it receive the same cap unless they override it directly.
   */
  readonly timeoutMs?: number;
  /** Extra hard-timeout window after `timeoutMs` for accepting a completed turn. */
  readonly timeoutGraceMs?: number;
  /** The previous body outcome in the enclosing loop (used by `review`/gates). */
  readonly lastOutcome?: Outcome;
  /** The most recent failed-review outcome, so a restart can act on it. */
  readonly lastReview?: Outcome;
  /**
   * The previous iteration's explicit `until`-gate evaluation (met or not),
   * including its diagnostic `output`. Undefined when the loop has no explicit
   * `until`, on the first iteration, and outside loop jobs.
   */
  readonly lastGate?: ConditionResult;
  /** The run's token budget, when one is set; engine call sites guard on it. */
  /** @internal */
  readonly budget?: Budget;
  /** How a loop reacts to a rate/quota/budget limit. Default `auto`. */
  readonly onLimit: LimitPolicy;
  /** Cap on an interruptible limit-wait under `auto`/`wait`. */
  readonly maxWaitMs: number;
  log(message: string, level?: LogLevel): void;
}

export interface NoProgressConfig {
  /** Consecutive no-progress iterations before the loop stalls out. Default 3. */
  window?: number;
  /** Confidence improvement required to count as progress. Default 0.02. */
  minConfidenceDelta?: number;
  /** Optional progress state outside the workspace. */
  signal?: (
    ctx: JobContext,
    last: Outcome | undefined,
  ) => string | number | undefined | Promise<string | number | undefined>;
  /** Read the workspace fingerprint each iteration. Default true. */
  workspace?: boolean;
  /** Fingerprint a failing deterministic gate's output. Default false. */
  gate?: boolean;
}

export type NoProgressInput = number | NoProgressConfig;

export interface StallReport {
  readonly window: number;
  readonly iterations: number[];
  readonly reason: string;
  readonly evidence: string[];
}

export type Job = (ctx: JobContext) => Promise<Outcome>;

/**
 * The introspectable shape of a `Job`, attached by the builders (`loop`, `dag`,
 * `agentJob`, ...) and read back by validation and description tools or any
 * agent that wants to inspect a loop without running it. Held in a side table
 * (see `core/describe.ts`), so the `Job` type stays a plain function. `kind`
 * names the builder; the rest is builder-specific (a loop carries its gate and
 * body, a dag carries its nodes).
 */
export interface JobMeta {
  kind: 'loop' | 'dag' | 'agent' | 'fn' | (string & {});
  name?: string;
  [key: string]: unknown;
}

export interface ConditionResult {
  met: boolean;
  /** 0..1 when an agent decided this; undefined for deterministic checks. */
  confidence?: number;
  reason: string;
  /**
   * Verbatim diagnostic output backing the verdict — the evidence, not the
   * one-line `reason` (a failing command's stdout/stderr, a judge's full
   * findings). Producers truncate and secret-scrub it. Flows into
   * `loop:condition` events and to the next loop body via `ctx.lastGate`.
   */
  output?: string;
}

/**
 * The single condition primitive. A question answered against the context and
 * the most recent body outcome. Both deterministic checks and agent validators
 * are this same type — `agentCheck(...)` simply returns one.
 */
export type Condition = (
  ctx: JobContext,
  last: Outcome | undefined,
) => Promise<ConditionResult>;

/** A bare deterministic predicate — accepted anywhere a `Condition` is. */
export type RawPredicate = (
  ctx: JobContext,
  last: Outcome | undefined,
) => boolean | Promise<boolean>;

/**
 * What a gate (`start`/`until`/`stopOn`) accepts: one item or many, freely
 * mixing deterministic predicates and agent conditions. Arrays are reduced to
 * the single `Condition` primitive by `toCondition` (default: all must hold;
 * wrap in `any(...)` for or-semantics).
 */
export type ConditionInput = Condition | RawPredicate | ConditionInput[];

export interface RetryPolicy {
  /** On a thrown error in the body: keep looping, or end the loop as failed. */
  onError: 'continue' | 'fail';
  /** Cap on consecutive errored iterations before forcing 'fail'. */
  maxConsecutive?: number;
  backoffMs?: number;
}

export interface LoopConfig {
  name: string;
  /** The work done each iteration. Pass another `loop(...)` to nest. */
  body: Job;
  /** Gate before iterating; one or many checks. Unmet => loop is `aborted`. */
  start?: ConditionInput;
  /** After each body run; one or many checks. Met => stop (then `review`). */
  until?: ConditionInput;
  /**
   * Evaluate the explicit `until` gate once at iteration 0, before the body.
   * A met gate completes immediately (after `review`, when configured); an
   * unmet verdict is exposed to the first body iteration as `ctx.lastGate`.
   * Requires `until`.
   */
  checkFirst?: boolean;
  /** Hard early-exit per iteration; one or many checks. Met => `aborted`. */
  stopOn?: ConditionInput;
  /** Iteration cap. Reached without passing => `exhausted`. */
  max?: number;
  /**
   * The third hard stop, alongside `max` and `budget`: end the loop `exhausted`
   * when this many consecutive iterations make no observable progress — no
   * workspace state the run has not already visited, no custom `signal` value
   * not already seen, no gate confidence beating its previous best. A bare
   * number is the window (`3` ⇒ three flat iterations); pass a `NoProgressConfig`
   * for the full knobs. Off by default: a polling loop legitimately makes no
   * progress until the outside world changes, so this is opt-in like `commit`.
   * The stalled outcome carries the evidence as `Outcome.stall`.
   */
  noProgress?: NoProgressInput;
  /**
   * Runs when `until` is met. If it returns `pass`, the loop completes.
   * Any other status re-enters the loop — this is the "review fails, run the
   * main loop again" behaviour, and `review` may itself be a `loop(...)`. The
   * failed review outcome is exposed to the next iteration as `ctx.lastReview`.
   */
  review?: Job;
  /**
   * Cap on consecutive failed reviews before giving up with `exhausted`.
   * Bounds the review-restart cycle independently of `max`; strongly advised
   * when `review` is set with no `max` (otherwise a worker/reviewer standoff
   * never terminates). Default: unbounded (relies on `max`).
   */
  maxReviewRestarts?: number;
  /** Delay between iterations (polling intervals). Interruptible by abort. */
  delayMs?: number;
  retry?: RetryPolicy;
  /** Side-effect hook after each iteration (logging, custom stats). */
  onIteration?: (outcome: Outcome, ctx: JobContext) => void | Promise<void>;
  /**
   * Post-action run exactly once when the loop ends, whatever the status
   * (Jenkins `post { always }`). For cleanup, notifications, final logging.
   */
  onComplete?: (outcome: Outcome, ctx: JobContext) => void | Promise<void>;
}

// ── DAG / stages ────────────────────────────────────────────────────────────
// A DAG of jobs is itself a `Job`, so it composes with `loop()` both ways: a
// node can be a loop, and a loop body can be a DAG. This is the "stages" layer,
// generalised — sequential stages, parallel stages, and arbitrary dependencies
// are all expressed as nodes + `needs`.

export interface DagNode {
  job: Job;
  /**
   * Names of nodes that must finish before this one runs; a required producer
   * must pass, a failed optional producer does not block.
   */
  needs?: string | string[];
  /** One sentence describing what this node does. */
  desc?: string;
  /** The written acceptance criterion for this node. */
  gate?: string;
  /** Gate (one or many) — when unmet the node is skipped, not failed. */
  when?: ConditionInput;
  /** A failure here does not fail the DAG, and does not block dependents. */
  optional?: boolean;
  /**
   * Run this node in its own git worktree on a fork branch (branches-as-teams).
   * Concurrent writers then never collide on files or the index, and the node's
   * committed work lands back into the parent branch on pass. Defaults to the
   * DAG's `isolation`. Opt-in: forking a worktree has a real setup cost, and a
   * read-only node never needs it.
   */
  isolate?: boolean;
  /**
   * Timeout inherited by this node's subtree. Agent leaves and agent judges use
   * it unless they set their own timeout.
   */
  timeoutMs?: number;
  /** Extra hard-timeout window after `timeoutMs` for completed-but-late leaves. */
  timeoutGraceMs?: number;
  /**
   * Restrict which upstream nodes this node may kick work back to. When set, a
   * `kickback` whose `to` is not in this list is rejected (logged, not run); when
   * unset, any ancestor is a valid target. A kickback to a non-ancestor is always
   * rejected. Only consulted when the dag's `maxKickbacks` is set.
   */
  acceptsKickbackTo?: string[];
}

export type KickbackBudget = number | Readonly<Record<string, number>>;

export interface DagConfig {
  name: string;
  /** Node name → a `DagNode`, or a bare `Job` (shorthand for no deps/gates). */
  nodes: Record<string, DagNode | Job>;
  /** Max nodes running at once. Default: 4. */
  concurrency?: number;
  /** When a required node fails, abort the rest. Default: true. */
  stopOnError?: boolean;
  /**
   * Default isolation for nodes that do not set `isolate`. `'worktree'` runs each
   * such node in its own worktree + fork branch, landed back on pass. Off by
   * default — the shared workspace.
   */
  isolation?: 'worktree';
  /**
   * Give each ISOLATED node its own environment, brought up when its worktree
   * forks and torn down when it joins — so every branch-team gets its own stage,
   * named by the provider from the workspace branch. Requires isolation; a
   * non-isolated node shares the workspace and gets no per-team env.
   */
  environment?: Environment;
  /**
   * What to do when an isolated node's land-back conflicts. `'fail'` (default)
   * fails the node. `'synthesize'` runs `mergeSynthesis`: an agent resolves the
   * conflict and writes a synthesised merge body.
   */
  onConflict?: 'fail' | 'synthesize';
  /**
   * Re-run budget for cross-stage feedback. A number keeps the graph-wide
   * counter. A map gives each target node its own counter. Default 0 means
   * kickbacks are ignored and behaviour is unchanged.
   */
  maxKickbacks?: KickbackBudget;
}

/** Per-node disposition within a DAG run. */
export type NodePhase = 'start' | 'skip' | 'done';

export type ProofKind = 'html' | 'image' | 'markdown' | 'table' | 'json';

export interface ProofArtifact {
  kind: ProofKind;
  title?: string;
  description?: string;
  mediaType?: string;
  meta?: Record<string, string | number | boolean | null>;
  path?: string;
  data?: JsonValue;
}

export interface ProofRecord {
  name: string;
  path: string[];
  artifact: ProofArtifact;
}

// ── Events ──────────────────────────────────────────────────────────────────
// One discriminated union drives streaming, recorders, and the stats collector.
// Every event carries the loop `path` so consumers can
// place it in the tree.

export type ConditionKind = 'start' | 'until' | 'stopOn';

export type LoopEvent =
  | {
      kind: 'loop:start';
      ts: number;
      path: string[];
      depth: number;
      max?: number;
    }
  | { kind: 'loop:iteration'; ts: number; path: string[]; iteration: number }
  | {
      kind: 'loop:condition';
      ts: number;
      path: string[];
      which: ConditionKind;
      /** The enclosing loop iteration; 0 for start and check-first gates. */
      iteration?: number;
      result: ConditionResult;
    }
  | {
      /** A Condition executed outside loop start/stop/until control flow. */
      kind: 'condition:result';
      ts: number;
      path: string[];
      label: string;
      iteration: number;
      result: ConditionResult;
    }
  | {
      kind: 'loop:review';
      ts: number;
      path: string[];
      outcome: Outcome;
      /**
       * Whether the loop will re-enter to act on a failing review (the review's
       * revision was accepted), vs give up because it exhausted its iterations or
       * `maxReviewRestarts`. Mirrors `dag:kickback`'s `accepted`. Only meaningful
       * for a non-pass review; a downstream consumer that omits it (e.g. a test
       * fixture) is treated as accepted.
       */
      accepted?: boolean;
    }
  | {
      kind: 'loop:end';
      ts: number;
      path: string[];
      outcome: Outcome;
      iterations: number;
    }
  | {
      // The noProgress detector tripped: `window` consecutive iterations reached
      // no state the run had not already seen. The loop ends `exhausted` with
      // the same report on `Outcome.stall`.
      kind: 'loop:stall';
      ts: number;
      path: string[];
      iteration: number;
      report: StallReport;
    }
  | {
      // A limit was hit and the policy is waiting out its reset before retrying.
      kind: 'limit:wait';
      ts: number;
      path: string[];
      code: string;
      waitMs: number;
      /** Wall-clock epoch ms the wait ends at (ts + waitMs). */
      resumeAt: number;
    }
  | {
      // A limit stopped the run.
      kind: 'limit:pause';
      ts: number;
      path: string[];
      code: string;
      reason: string;
    }
  | {
      kind: 'dag:start';
      ts: number;
      path: string[];
      depth: number;
      nodes: string[];
    }
  | {
      kind: 'dag:node';
      ts: number;
      path: string[];
      node: string;
      phase: NodePhase;
      /** The node dependencies, normalised to an array when present. */
      needs?: string[];
      /** The node's declared purpose, when present. */
      desc?: string;
      /** The node's declared acceptance criterion, when present. */
      gate?: string;
      outcome?: Outcome;
      /** Soft timeout in force for this node, when one is configured. */
      timeoutMs?: number;
      /**
       * Which run of this node this is: 1 on the first pass, incremented each time
       * a kickback re-runs it. Lets a records consumer tell a re-run's completion
       * from the original and correlate it with the revision that caused it.
       */
      attempt?: number;
    }
  | { kind: 'dag:end'; ts: number; path: string[]; outcome: Outcome }
  | {
      // A node sent work back to an earlier node. `accepted` distinguishes a
      // honoured kickback (the subgraph re-runs) from a rejected one (non-ancestor,
      // disallowed target, or budget exhausted — `note` says which).
      kind: 'dag:kickback';
      ts: number;
      path: string[];
      from: string;
      to: string;
      reason: string;
      accepted: boolean;
      /** The one-based request count for this target in this DAG run. */
      count: number;
      /** The configured limit for this target, including the numeric form. */
      limit: number;
      note?: string;
    }
  | {
      kind: 'job:start';
      ts: number;
      path: string[];
      label: string;
      /** Soft timeout in force for this job, when one is configured. */
      timeoutMs?: number;
    }
  | {
      kind: 'advisor:consult';
      ts: number;
      path: string[];
      label: string;
      call: number;
      question: string;
      reply: string;
      model?: string;
    }
  | {
      kind: 'proof';
      ts: number;
      path: string[];
      name: string;
      artifact: ProofArtifact;
    }
  | {
      kind: 'job:end';
      ts: number;
      path: string[];
      label: string;
      outcome: Outcome;
    }
  | { kind: 'engine:text'; ts: number; path: string[]; delta: string }
  | { kind: 'engine:thinking'; ts: number; path: string[]; delta: string }
  | {
      kind: 'engine:tool';
      ts: number;
      path: string[];
      name: string;
      phase: 'use' | 'result';
    }
  | {
      kind: 'engine:usage';
      ts: number;
      path: string[];
      model: string;
      usage: UsageReceipt;
    }
  | {
      kind: 'log';
      ts: number;
      path: string[];
      level: LogLevel;
      message: string;
    }
  | {
      kind: 'error';
      ts: number;
      path: string[];
      message: string;
      code: string;
    };

export type LoopEventKind = LoopEvent['kind'];
