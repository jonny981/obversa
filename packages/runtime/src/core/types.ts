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
import type { Billing, CostReceipt } from '@obversa/api';
import type { Memory, TeamSeat } from '@obversa/api';
import type { LoopError } from './errors.js';
import type { Budget } from './budget.js';
import type { EnvHandle, Environment } from '../env/environment.js';
import type { JsonObject, JsonValue, RunBrief } from '../graph/value.js';
import type {
  CallbackEvent,
  ClaimResult,
  ReleaseResult,
  SubmitResult,
} from '../callback/client.js';
import type { CallbackRequest } from '../callback/gate.js';

export type InteractionResponse = JsonObject & {
  readonly feedback: JsonValue;
  readonly prompt: string;
  readonly decision?: 'approved' | 'changes-requested';
}

export interface InteractionBinding {
  readonly id: string;
  readonly responseSchema: JsonObject;
  /** Return no answer when the page is cancelled, interrupted or times out. */
  readonly answer?: (request: CallbackRequest, signal: AbortSignal) => Promise<InteractionResponse | undefined>;
}

/**
 * The client a run's questions go through: the in-memory `CallbackClient`,
 * or the stored client (`createStoredCallbackClient`) whose questions survive
 * a process exit. Each method may answer at once or as a promise; a step
 * that asks awaits both shapes alike. Written as the awaited shape here, so
 * the core types import no storage module.
 */
export interface RunCallbacks {
  post(request: CallbackRequest): void | Promise<void>;
  listPending(): readonly CallbackRequest[] | Promise<readonly CallbackRequest[]>;
  claim(requestId: string, routerId: string): ClaimResult | Promise<ClaimResult>;
  submit(
    requestId: string,
    claimToken: string,
    routerId: string,
    requestDigest: string,
    response: JsonValue,
  ): SubmitResult | Promise<SubmitResult>;
  release(requestId: string, claimToken: string): ReleaseResult | Promise<ReleaseResult>;
  supersede(requestId: string, supersededBy: string): void | Promise<void>;
  history(requestId?: string): readonly CallbackEvent[] | Promise<readonly CallbackEvent[]>;
}

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
   * 0 — ignored). The re-run happens in execution only; the graph stays acyclic.
   * A numeric budget or a judge's `cap` bounds the re-runs; a judge with no
   * cap re-runs until it stops the rounds or the review passes. Produce one with
   * `revisionRequest({ target, findings })` or `kickback(to, reason)`.
   */
  revision?: RevisionRequest;
  /**
   * Fork branches this step deleted while they still held commits that never
   * landed, each with the sha of its last commit. Present only when such work
   * was thrown away, so the record says what was lost.
   */
  discarded?: ReadonlyArray<{ readonly branch: string; readonly sha: string }>;
  /**
   * The review findings still open when a judge let the work stand after
   * the last review its cap allows.
   */
  openFindings?: readonly FeedbackFinding[];
  /** Present on a `commandJob` outcome: the command it ran and how it ended. */
  command?: CommandRun;
}

/** One command a `commandJob` ran, pass or fail. */
export interface CommandRun {
  /** The executable, exactly as given. */
  readonly command: string;
  /** Every argument, one per entry. */
  readonly args: readonly string[];
  /** The exit code, or null when the command did not run or did not exit. */
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** True when the command ran past its timeout and was stopped. */
  readonly timedOut?: true;
}

export type RecordedStage =
  | { readonly kind: 'interrupted'; readonly startLine: number }
  | { readonly kind: 'completed'; readonly outcome: Outcome };

export interface ResumedStageRecords {
  readonly interactions: ReadonlyMap<string, { identity: string; workspace: string; data: JsonObject }>;
  readonly anchors: ReadonlyMap<string, { readonly identity: string; readonly workspace: string; readonly recordId: string }>;
  readonly stages: ReadonlyMap<string, RecordedStage>;
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
  /** Every panel reviewer who raised this finding, set when a panel synthesises its reviews. */
  raisedBy?: string[];
  /** The other reviewers' answers in a synthesising panel's cross-review round. */
  votes?: FindingVote[];
  /** Kept although the cross-review round did not settle it: a tie, a block most voters disagree with, or a finding whose dissenters do not outnumber the reviewers who raised or backed it. */
  disputed?: boolean;
  /** Why a judge sent this finding back, when a judge decided it. */
  judgeReason?: string;
  /** The finding's id in its review round (`finding-2`), set when a judge decided each finding. */
  id?: string;
}

/** One reviewer's answer on a finding another reviewer raised. */
export interface FindingVote {
  reviewer: string;
  vote: 'agree' | 'disagree' | 'better fix';
  /** One line. */
  reason: string;
  /** The fix the reviewer would make instead, for `better fix`. */
  fix?: string;
}

/**
 * What a synthesising panel did with one finding after the merge and the
 * cross-review round. `kept` and `better fix` go on; `disputed` goes on
 * marked; `dropped` stays only in the record, with the voters' reasons.
 */
export interface PanelSynthesisEntry {
  result: 'kept' | 'better fix' | 'disputed' | 'dropped';
  finding: FeedbackFinding;
}

/** A finding a judge skipped, kept across rounds so reviewers do not raise it again. */
export interface SkippedFinding {
  /** The review round the finding was skipped in. */
  readonly round: number;
  readonly finding: FeedbackFinding;
  readonly reason: string;
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
  /** Which run of this node the DAG is executing, starting at 1. */
  attempt?: number;
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
  /**
   * The run's callbacks client: where a step posts a question for a person or
   * an outside router, and where the answer is found again on a resume. Every
   * run has one, a fresh in-memory client by default; pass `callbacks` to
   * `run` to keep questions across runs.
   */
  readonly callbacks?: RunCallbacks;
  /** @internal Save enclosing work before a deliberate interactive pause. */
  readonly interactionCheckpoint?: () => void;
  /** Wait for an outside answer, or return paused (the default). */
  readonly onCallback?: 'wait' | 'exit';
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
  /**
   * Inside a `dag` node: the outcomes of the nodes this node `needs`, by the
   * same names its config uses (`needs: ['test']` gives `ctx.needs.test`). A
   * branch's `when` reads the deciding node's outcome here, so a command can
   * choose the path the graph takes next with no agent deciding. Undefined
   * outside a dag node.
   */
  readonly needs?: Readonly<Record<string, Outcome>>;
  /** The previous body outcome in the enclosing loop (used by `review`/gates). */
  readonly lastOutcome?: Outcome;
  /** The most recent failed-review outcome, so a restart can act on it. */
  readonly lastReview?: Outcome;
  /**
   * The findings a judge skipped in earlier rounds, with its reasons. Set on
   * the review that sent the work back, and on every job inside it. An agent
   * job adds them to its prompt and asks the agent not to raise them again.
   */
  readonly skippedFindings?: readonly SkippedFinding[];
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
  /** The command a command check ran and how it ended. */
  command?: CommandRun;
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
  /** An interrupted attempt may run again on resume without a person's reconciliation. */
  retrySafe?: boolean;
}

/**
 * One question put to a judge, in the judge engine's own shape: `noul` asks
 * for a probability, `choice` asks for one of the named criteria, `score`
 * asks for a 0..1 rating per named criterion. `instructions` is what the
 * judge reads; `criteria` are the standards it answers against.
 */
export type JudgeQuestion =
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria: { readonly true: string; readonly false: string } }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

export type JudgeQuestions = Readonly<Record<string, JudgeQuestion>>;

/** One answer, in whichever of these fields its question type fills. */
export interface JudgeAnswer {
  readonly noul?: number;
  readonly probability?: number;
  readonly choice?: string;
  readonly probabilities?: Readonly<Record<string, number>>;
  /** A one-line reason, when the judge gives one with its answer. */
  readonly reason?: string;
}

/**
 * A judge, in place of a plain round count, on a `workflow()` stage's
 * `refine` or a `dag()`'s `maxKickbacks`: a seat that answers typed
 * questions about the work and the rounds so far, between a review's
 * verdict and the send-back. With no `cap`, the rounds end when the judge
 * stops them or the review passes. A `cap` is an optional backstop: after
 * the last review it allows, the judge is asked once more and its answer
 * decides the outcome. Built with `judge()`, never by hand.
 */
export interface Judge {
  readonly kind: 'judge';
  readonly seat: TeamSeat;
  readonly cap?: number;
  readonly questions: JudgeQuestions;
  /**
   * Ask the judge to act on or skip each finding, and send the builder only
   * the ones it acts on. True by default; false by default for a caller's
   * own question set, which then routes on the whole round.
   */
  readonly perFinding: boolean;
  readonly interaction?: InteractionBinding;
}

export type KickbackBudget = number | Readonly<Record<string, number | Judge>>;

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

/** The token totals a run reports. */
export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  /** Calls that reported no usage, so a total can say what it is missing. */
  readonly unmeasuredCalls?: number;
}

/** The dollars a set of engine calls cost, summed from each call's `cost`. */
export interface CostTotals {
  /** Every reported and estimated figure added up. */
  readonly usd: number;
  /** The part of `usd` the engines reported. */
  readonly reportedUsd: number;
  /** The part of `usd` estimated from the price table. */
  readonly estimatedUsd: number;
  /** Calls with no figure, which `usd` leaves out. */
  readonly unknownCalls: number;
  /** The models of those calls, each named once. */
  readonly unknownModels: readonly string[];
}

/** One file a round changed, in lines added and removed. */
export interface RoundFileChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

// ── Events ──────────────────────────────────────────────────────────────────
// One discriminated union drives streaming, recorders, and the stats collector.
// Every event carries the loop `path` so consumers can
// place it in the tree.

export type ConditionKind = 'start' | 'until' | 'stopOn';

export type LoopEvent =
  | {
      kind: 'run:start';
      ts: number;
      path: [];
      runId?: string;
      recordPath?: string;
      /** 1 for a fresh record, one more on each resume of it. Set when the run writes a record. */
      session?: number;
      /** The workflow file the run named as its `source`, with its SHA-256. */
      source?: { readonly path: string; readonly sha256: string };
    }
  | {
      kind: 'run:end';
      ts: number;
      path: [];
      outcome: Outcome;
      usage: UsageTotals;
      /** The dollars the run's engine calls cost, in this session and every earlier session of the record. */
      cost?: CostTotals;
      /** The tokens of the run's engine calls, in this session and every earlier session of the record. `usage` counts this session only. */
      totalUsage?: UsageTotals;
      runId?: string;
      recordPath?: string;
    }
  | {
      /** The process got SIGINT or SIGTERM while the run was going. */
      kind: 'run:abort';
      ts: number;
      path: [];
      signal: 'SIGINT' | 'SIGTERM';
    }
  /** The run is still going; written at the run's `heartbeatMs` interval. */
  | { kind: 'heartbeat'; ts: number; path: [] }
  | {
      kind: 'workflow:start';
      ts: number;
      path: string[];
      identity: string;
      workspace: string;
      recordId: string;
    }
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
      /** The tokens of this round's engine calls: the build and its review. */
      usage?: UsageTotals;
      /** The dollars of this round's engine calls. */
      cost?: CostTotals;
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
      /**
       * What the node produced, on a done or a skip. One attempt can emit this
       * twice: a gate waiting for a person records its pause before it waits, so
       * a live consumer sees a paused outcome and then, if an answer arrives, the
       * answered one. A record keeps the latest outcome emitted for the node, so
       * when a waiting run is killed the stored outcome is the pause itself,
       * which is what lets a resumed run return that same still-pending question
       * rather than treating the stage as interrupted and asking a person to
       * reconcile it.
       */
      outcome?: Outcome;
      /** Soft timeout in force for this node, when one is configured. */
      timeoutMs?: number;
      /**
       * Which run of this node this is: 1 on the first pass, incremented each time
       * a kickback re-runs it. Lets a records consumer tell a re-run's completion
       * from the original and correlate it with the revision that caused it.
       */
      attempt?: number;
      /** On a done after a start: the time from that start to the attempt's first done. */
      durationMs?: number;
      /** On a done after a start: the tokens of the node's engine calls in this attempt. */
      usage?: UsageTotals;
      /** On a done after a start: the dollars of the node's engine calls in this attempt. */
      cost?: CostTotals;
    }
  | { kind: 'dag:end'; ts: number; path: string[]; outcome: Outcome }
  /** The run's monitor page is up at `url`; emitted once, before the job starts. */
  | { kind: 'monitor'; ts: number; path: string[]; url: string }
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
      /** The configured limit for this target, including the numeric form. Absent for a judge with no cap. */
      limit?: number;
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
      /** The time since the matching `job:start`. */
      durationMs?: number;
    }
  | { kind: 'engine:text'; ts: number; path: string[]; delta: string }
  | { kind: 'engine:thinking'; ts: number; path: string[]; delta: string }
  | {
      kind: 'engine:tool';
      ts: number;
      path: string[];
      name: string;
      phase: 'use' | 'result';
      /** The file, command, URL or pattern the tool acted on, when known. */
      target?: string;
    }
  | {
      kind: 'engine:usage';
      ts: number;
      path: string[];
      model: string;
      usage: UsageReceipt;
      /** What the call cost: the engine's figure, an estimate from the price table, or unknown. */
      cost?: CostReceipt;
      /** How the call was paid for. */
      billing?: Billing;
      /** The call failed. The run's token budget counts its tokens when it reported them. */
      failed?: true;
      role?: 'writer' | 'reviewer';
      stage?: string;
    }
  | {
      // A judge's answer, between a review's verdict and the send-back: what
      // it answered and which way the runtime went. Emitted whether the
      // answer sends the work back or lets it stand.
      kind: 'refine:judge';
      ts: number;
      path: string[];
      answers: Readonly<Record<string, JudgeAnswer>>;
      reason: string;
      // `again` sends the work back for another round; `stop` ends the
      // rounds. After the last review a cap allows, every route is `stop`.
      route: 'again' | 'stop';
      // The answer that decided the route: the chosen reason
      // (`stop_reason: continue`), the probability answer it fell back to
      // (`worth_another_round: 0.49`), or `no clear answer`.
      rule: string;
      // The status a stop gives the node: `pass` when the work stands,
      // `fail` when the review's failure stands. Absent on `again`, and on
      // `stop_reason: product_decision`, which asks a person. Their answer
      // goes to the builder, and the judge is asked again once that round
      // is reviewed. After the last round a cap allows, no build round and
      // no judge call follow: the answer is recorded and the run fails.
      status?: 'pass' | 'fail';
      // When the judge decides each finding: every finding of the round, by
      // its id, with `act` (sent back to the builder) or `skip` and why.
      findings?: readonly { readonly id: string; readonly decision: 'act' | 'skip'; readonly reason: string }[];
      // The findings still open when the judge lets the work stand after
      // the last review its cap allows.
      openFindings?: readonly FeedbackFinding[];
    }
  | {
      // A review panel's synthesis: each finding after the merge and the
      // cross-review round, including the ones the votes dropped.
      kind: 'review:synthesis';
      ts: number;
      path: string[];
      label: string;
      entries: PanelSynthesisEntry[];
      /** The merger failed or sent no readable reply, so no findings were merged. */
      mergeFailed?: true;
      /** Reviewers asked to vote that failed or sent no readable reply. A finding shown to one of them is never dropped by the others' votes. */
      noVotesFrom?: string[];
    }
  | {
      // What one build round changed in a git workspace: after each build
      // round of a `workflow()` refine loop (`round` is the loop's
      // iteration), and after each node run a `dag()` kickback causes
      // (`node` is set, and `round` is the node's attempt).
      kind: 'round:change';
      ts: number;
      path: string[];
      node?: string;
      round: number;
      /** Each file that changed since the round began. A binary file counts 0 lines. */
      files: readonly RoundFileChange[];
      added: number;
      removed: number;
      /** The ids of the findings the round was sent back to answer, in the round that raised them. */
      findings: readonly string[];
    }
  | {
      kind: 'interaction:checkpoint';
      ts: number;
      path: string[];
      identity: string;
      workspace: string;
      data: import('../graph/value.js').JsonObject | null;
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
