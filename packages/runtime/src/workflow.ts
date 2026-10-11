import { createHash } from 'node:crypto';

import { type TeamSeat } from '@obversa/api';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { agentJob, fnJob } from './core/job.js';
import { approval } from './core/approval-job.js';
import { commandJob, predicate } from './core/condition.js';
import { copyJobMeta, declareWrites } from './core/describe.js';
import { dag } from './core/dag.js';
import { TARGET_ROUNDS, type TargetRounds } from './core/context.js';
import { RESUME_IDENTITY } from './core/resume.js';
import { LoopError } from './core/errors.js';
import { loop } from './core/loop.js';
import { kickback, revisionFromOutcome } from './core/feedback.js';
import { reviewPanel } from './core/synthesis.js';
import { isJudge } from './core/judge.js';
import {
  assertDistinctSeats,
  recordedFamilyGate,
  recordRoundChange,
  refinedRounds,
  requireNoFiles,
  requireNonEmptyFiles,
  review,
  seatIdentity,
} from './core/refine.js';
import type { ConditionInput, DagConfig, Job, JobContext, Judge, Outcome } from './core/types.js';
import { checkpointInteraction, humanReview, interactionIdentity, jsonSnapshot, requestInteraction, type InteractionBinding } from './core/interaction.js';

import { goalCheckJob } from './goal.js';
import { outcomeFromAgentText, withDecisionRetry } from './workflow-agent-response.js';
import { panelReviewers } from './workflow-support.js';
import type { ReviewerSeat, TeamInput } from './workflow-support.js';

export interface BriefSource {
  readonly brief: string;
  readonly files?: readonly string[];
}

export interface PersonRole {
  readonly kind: 'person';
  readonly question: string;
  readonly interaction?: InteractionBinding;
}

export type WorkflowRole = TeamSeat | readonly TeamSeat[] | PersonRole;

export interface WorkflowStageBase {
  readonly writes?: string | readonly string[];
  readonly desc?: string;
  readonly gate?: string;
  readonly when?: ConditionInput;
  readonly optional?: boolean;
  readonly needs?: string | readonly string[];
  readonly sendsBackTo?: string;
  /**
   * How many refinements a reviewed stage or a send-back target gets: rounds
   * of rework after the first build. `refine: N` allows N refinements, so
   * N+1 builds the reviews paid for in all; `refine: 0` is one build.
   * Default 1. On a stage a panel reviews, a declared file the build left
   * missing sends the work back on a check budget instead, which can add up
   * to 3 more builds; on a stage a person reviews it spends a refinement. A
   * reviewed stage that is also a send-back target has one count: its own
   * reviews and the send-backs to it share the N refinements in a run. Or
   * `judge(seat)`
   * to let a seat decide between a review's verdict and the send-back. With
   * no cap, the rounds end when the judge stops them or the review passes.
   * `judge(seat, { cap: N })` allows at most N refinements, and the judge's
   * answer about the last build's review decides the outcome.
   */
  readonly refine?: number | Judge;
  /** An interrupted attempt may run again without a person's reconciliation. */
  readonly retrySafe?: boolean;
}

/**
 * `synthesise` merges a review panel's reviews into one before anything
 * reads them, on a `reviewedBy` panel or a `panel:` stage: a seat merges
 * the findings that name the same problem (this seat, or with `true` the
 * first reviewer's seat), then each reviewer votes once on the merged
 * findings it did not raise. A panel of one reviewer is left as it is.
 *
 * `goal` checks the brief was met before the reviews, on a stage a panel
 * reviews: each round, this seat reads the brief, the stage's `desc` and
 * `gate`, and the work, and marks each requirement met or unmet. Any unmet
 * requirement sends the round back to the builder with its evidence; the
 * reviewers do not run that round, and a judge does not decide it.
 */
export type WorkflowStage = WorkflowStageBase & {
} & (
  | { readonly agent: string; readonly reviewedBy?: string; readonly agree?: number; readonly effort?: string; readonly synthesise?: TeamSeat | true; readonly goal?: TeamSeat; readonly run?: never; readonly panel?: never; readonly input?: never; readonly fn?: never; }
  | { readonly run: string | readonly string[]; readonly synthesise?: never; readonly goal?: never; readonly agent?: never; readonly panel?: never; readonly input?: never; readonly fn?: never; }
  | { readonly panel: string; readonly agree?: number; readonly synthesise?: TeamSeat | true; readonly goal?: never; readonly agent?: never; readonly run?: never; readonly input?: never; readonly fn?: never; }
  | { readonly input: string; readonly synthesise?: never; readonly goal?: never; readonly agent?: never; readonly run?: never; readonly panel?: never; readonly fn?: never; }
  | { readonly fn: Job; readonly synthesise?: never; readonly goal?: never; readonly agent?: never; readonly run?: never; readonly panel?: never; readonly input?: never; }
);

export interface NamedStage {
  readonly name: string;
  readonly config: WorkflowStage;
}

export interface WorkflowOptions {
  readonly timeout?: string | number;
}

export interface WorkflowRecord {
  readonly outcome: Outcome;
  summary(): string;
}

export interface WorkflowPostContext {
  readonly record: WorkflowRecord;
}

export interface WorkflowConfig {
  readonly brief: string | BriefSource;
  readonly options?: WorkflowOptions;
  readonly roles: Readonly<Record<string, WorkflowRole>>;
  readonly stages: readonly NamedStage[];
  readonly post?: {
    readonly always?: (context: WorkflowPostContext) => void | Promise<void>;
  };
}

const PATH_FIELDS = new Set(['files']);

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function relativePath(value: string, label: string): string {
  const path = text(value, label);
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new TypeError(`${label} must be a relative path: ${path}`);
  }
  return path;
}

function pathList(value: unknown, label: string): string[] {
  const parsed = typeof value === 'string' && value.trim().startsWith('[')
    ? JSON.parse(value) as unknown
    : value;
  const values = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'string'
      ? parsed.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
  if (!values.length) throw new TypeError(`${label} must contain at least one path`);
  const result = values.map((item, index) => relativePath(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} must not contain duplicates`);
  return result;
}

function parseFrontMatter(source: string): BriefSource {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== '---') return { brief: source.trim() };
  const closingLine = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingLine < 0) throw new TypeError('brief front matter is not closed');
  const header = lines.slice(1, closingLine).join('\n').trim();
  const body = lines.slice(closingLine + 1).join('\n').trim();
  const values: Record<string, unknown> = {};
  for (const line of header.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 1) throw new TypeError(`invalid brief front matter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (PATH_FIELDS.has(key)) values[key] = pathList(value, key);
    else throw new TypeError(`unknown brief front matter field: ${key}`);
  }
  return {
    brief: body,
    ...(values.files === undefined ? {} : { files: values.files as string[] }),
  };
}

export function briefFromFile(path: string | URL): BriefSource {
  return parseFrontMatter(readFileSync(path, 'utf8'));
}

export function person(question: string, options: { interaction?: InteractionBinding } = {}): PersonRole {
  return { kind: 'person', question: text(question, 'person question'), ...options };
}

export function stage(name: string, config: WorkflowStage): NamedStage {
  return { name: text(name, 'stage name'), config: { ...config } };
}

function duration(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('workflow timeout must be positive');
    return value;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim());
  if (!match) throw new TypeError(`workflow timeout is not a duration: ${value}`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h'];
  const milliseconds = amount * multiplier;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) throw new TypeError('workflow timeout must be positive');
  return milliseconds;
}

function writesOf(config: WorkflowStage): string[] {
  if (config.writes === undefined) return [];
  const values = Array.isArray(config.writes) ? config.writes : [config.writes];
  const writes = values.map((file, index) => relativePath(file, `writes[${index}]`));
  if (!writes.length || new Set(writes).size !== writes.length) throw new TypeError('writes must contain unique paths');
  return writes;
}

function refineCount(refine: number | undefined, label: string): number {
  if (refine === undefined) return 0;
  if (!Number.isSafeInteger(refine) || refine < 0) throw new TypeError(`${label} must be a whole number of refinements, 0 or more`);
  return refine;
}

/** The numeric cap, whichever shape `refine` was given; none for a judge with no cap. */
function refineCap(refine: number | Judge): number | undefined {
  return isJudge(refine) ? refine.cap : refine;
}

function optionalFlag(optional: unknown): boolean | undefined {
  if (optional === undefined) return undefined;
  if (typeof optional !== 'boolean') throw new TypeError('optional must be a boolean');
  return optional;
}

function refineOf(config: WorkflowStage): number | Judge {
  if (config.refine === undefined) return 1;
  if (isJudge(config.refine)) return config.refine;
  return refineCount(config.refine, 'refine');
}

function refineForStage(config: WorkflowStage, receivesKickback: boolean): number | Judge {
  if ('reviewedBy' in config && config.reviewedBy) return refineOf(config);
  if (receivesKickback) return refineOf(config);
  if (config.refine !== undefined) {
    throw new TypeError('refine must be on a reviewed stage or a kickback target');
  }
  return 0;
}

function stageDependencies(stages: readonly NamedStage[], index: number): string[] {
  const stage = stages[index]!;
  const requested = stage.config.needs === undefined
    ? []
    : Array.isArray(stage.config.needs)
      ? [...stage.config.needs]
      : [stage.config.needs];
  const earlier = new Set(stages.slice(0, index).map((candidate) => candidate.name));
  const explicit = requested.map((name, needIndex) => text(name, `needs[${needIndex}]`));
  for (const name of explicit) {
    if (!earlier.has(name)) {
      throw new TypeError(`stage ${stage.name} needs ${name}, which is not an earlier stage`);
    }
  }
  const previous = index === 0 ? [] : [stages[index - 1]!.name];
  return [...new Set([...previous, ...explicit])];
}

function panelInput(brief: BriefSource, files: readonly string[], workspace: string): TeamInput {
  return {
    brief: brief.brief,
    workspace,
    files,
    test: { command: 'true', args: [] },
  };
}

function reviewerDefinitions(
  named: NamedStage,
  seats: readonly TeamSeat[],
): ReviewerSeat[] {
  return seats.map((seat, index) => ({
    name: `${named.name}-${index + 1}`,
    seat,
  }));
}

function reviewTarget(
  named: NamedStage,
  targetFiles?: readonly string[],
): string {
  const writes = targetFiles ?? writesOf(named.config);
  return writes.length ? writes.join(', ') : 'no declared writes';
}

function reviewerPanel(
  brief: BriefSource,
  named: NamedStage,
  seats: readonly TeamSeat[],
  files: readonly string[],
  declaredFiles: readonly string[],
  targetFiles: readonly string[] | undefined,
  target?: string,
  agree?: number,
  synthesise?: TeamSeat | true,
): Job {
  const pass = agree === undefined ? 'all' : (() => {
    if (!Number.isSafeInteger(agree) || agree < 1 || agree > seats.length) {
      throw new TypeError(`agree must be between 1 and ${seats.length}`);
    }
    return agree;
  })();
  const definitions = reviewerDefinitions(named, seats);
  return reviewPanel({
    label: named.name,
    pass,
    target,
    ...(synthesise === undefined ? {} : {
      synthesise,
      // The brief and target each reviewer's own prompt carries.
      context: [
        `Work brief: ${brief.brief}`,
        `Review target: ${reviewTarget(named, targetFiles)}.`,
        named.config.desc ? `Task: ${named.config.desc}` : undefined,
      ].filter(Boolean).join('\n'),
    }),
    reviewers: definitions.map((definition, index) => ({
      name: definition.name,
      scope: definition.scope,
      seat: definition.seat,
      job: async (ctx) => {
        const reviewer = panelReviewers(
          definitions,
          panelInput(brief, files, ctx.workspace.dir),
          reviewTarget(named, targetFiles),
          { role: 'reviewer', stage: named.name },
          named.config,
        )[index]!;
        return requireNoFiles(
          `${named.name}-${definition.name}`,
          reviewer.job,
          ctx.workspace.dir,
          declaredFiles,
        )(ctx);
      },
    })),
  });
}

function briefValue(value: string | BriefSource): BriefSource {
  return typeof value === 'string' ? { brief: text(value, 'brief') } : {
    brief: text(value.brief, 'brief'),
    ...(value.files === undefined ? {} : { files: pathList(value.files, 'files') }),
  };
}

function role(roles: WorkflowConfig['roles'], name: string): WorkflowRole {
  const value = roles[name];
  if (value === undefined) throw new TypeError(`unknown workflow role: ${name}`);
  return value;
}

function seatRole(roles: WorkflowConfig['roles'], name: string): TeamSeat {
  const value = role(roles, name);
  if (Array.isArray(value) || typeof value !== 'object' || value === null || 'kind' in value) {
    throw new TypeError(`role ${name} must be an engine seat`);
  }
  const seat = value as TeamSeat;
  seatIdentity(seat);
  return seat;
}

function panelRole(roles: WorkflowConfig['roles'], name: string): readonly TeamSeat[] {
  const value = role(roles, name);
  if (!Array.isArray(value) || !value.length) throw new TypeError(`role ${name} must be a non-empty reviewer panel`);
  value.forEach((seat) => {
    if (seatIdentity(seat).tools.length === 0) {
      throw new TypeError(`reviewer role ${name} must declare read tools`);
    }
  });
  return value;
}

function inputRole(roles: WorkflowConfig['roles'], name: string): PersonRole {
  const value = role(roles, name);
  if (Array.isArray(value) || !('kind' in value) || value.kind !== 'person') {
    throw new TypeError(`role ${name} must be a person seat`);
  }
  return value;
}

function stageFiles(brief: BriefSource, stages: readonly NamedStage[], through: number): string[] {
  const fromBrief = brief.files === undefined ? [] : pathList(brief.files, 'files');
  const fromStages = stages.slice(0, through + 1).flatMap(({ config }) => writesOf(config));
  return [...new Set([...fromBrief, ...fromStages])];
}

function workflowFiles(brief: BriefSource, stages: readonly NamedStage[]): string[] {
  const fromBrief = brief.files === undefined ? [] : pathList(brief.files, 'files');
  const fromStages = stages.flatMap(({ config }) => writesOf(config));
  return [...new Set([...fromBrief, ...fromStages])];
}

function agentPrompt(
  brief: BriefSource,
  named: NamedStage,
  files: readonly string[],
  writes: readonly string[],
  again = false,
): (ctx: JobContext) => string {
  return (ctx) => [
    `Work brief:\n${brief.brief}`,
    `Stage: ${named.name}`,
    named.config.desc ? `Task: ${named.config.desc}` : undefined,
    named.config.gate ? `Gate: ${named.config.gate}` : undefined,
    `Workflow files: ${files.join(', ') || 'none'}`,
    `This stage may write only: ${writes.join(', ') || 'no files'}. Do not write any other declared workflow file.`,
    again ? 'Your previous response was not a valid decision. Return only the required JSON object.' : undefined,
    'Return one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"...","severity":"block|should-fix|nice-to-have"}]}',
  ].filter((line): line is string => line !== undefined).join('\n\n');
}

function guardedAgent(
  brief: BriefSource,
  named: NamedStage,
  seat: TeamSeat,
  files: readonly string[],
  declaredFiles: readonly string[],
): Job {
  const writes = writesOf(named.config);
  if (!writes.length) throw new TypeError(`agent stage ${named.name} must declare writes`);
  const target = named.config.sendsBackTo;
  const effort = 'effort' in named.config ? named.config.effort : undefined;
  const identity = seatIdentity(seat);
  const ask = (again: boolean) => agentJob({
    label: named.name,
    engine: seat.engine,
    model: identity.model,
    ...(effort === undefined ? {} : { effort }),
    tools: [...identity.tools],
    allowedTools: [...identity.tools],
    workspaceMode: 'write',
    writes,
    consumeFeedback: true,
    prompt: agentPrompt(brief, named, files, writes, again),
    outcome: (textValue) => outcomeFromAgentText(textValue, target),
    recordAs: { role: 'writer', stage: named.name },
  });
  // A reply in prose is not a failed round: the seat is asked once more.
  const agent = withDecisionRetry(ask(false), ask(true));
  return async (ctx) => {
    const required = requireNonEmptyFiles(named.name, agent, ctx.workspace.dir, writes);
    const forbidden = declaredFiles.filter((file) => !writes.includes(file));
    return requireNoFiles(named.name, required, ctx.workspace.dir, forbidden, 'body')(ctx);
  };
}

/**
 * A plain function between the declarative stages: regular code, not
 * another agent or command. Same write guards as `run:`; a fail with no
 * revision of its own picks up `sendsBackTo` as its target, the way
 * `commandJob`'s own `target` option does for `run:`.
 */
function guardedFn(fn: Job, named: NamedStage, declaredFiles: readonly string[]): Job {
  const writes = writesOf(named.config);
  const target = named.config.sendsBackTo;
  const body: Job = fnJob(named.name, async (ctx) => {
    const outcome = await fn(ctx);
    if (outcome.status === 'fail' && target !== undefined && revisionFromOutcome(outcome)?.target === undefined) {
      return kickback(target, outcome.summary ?? `${named.name} failed`, {
        confidence: outcome.confidence,
        data: outcome.data,
        error: outcome.error,
      });
    }
    return outcome;
  });
  const forbidden = declaredFiles.filter((file) => !writes.includes(file));
  return async (ctx) => {
    const required = writes.length ? requireNonEmptyFiles(named.name, body, ctx.workspace.dir, writes) : body;
    return requireNoFiles(named.name, required, ctx.workspace.dir, forbidden, 'body')(ctx);
  };
}

/** The brief's `Use case:` paragraph, on one line. */
function briefUseCase(brief: BriefSource): string | undefined {
  return /^Use case:\s*([\s\S]*?)\n\s*\n/m.exec(brief.brief)?.[1]?.replace(/\s+/g, ' ').trim();
}

/** What one run of `refinedRounds` knows about a reviewed stage. */
function stageWork(brief: BriefSource, named: NamedStage): {
  readonly name: string;
  readonly brief: BriefSource;
  readonly config: WorkflowStage;
  readonly writes: readonly string[];
  readonly refine: number | Judge;
} {
  return {
    name: named.name,
    brief,
    config: named.config,
    writes: writesOf(named.config),
    refine: refineOf(named.config),
  };
}

function stageJob(
  brief: BriefSource,
  named: NamedStage,
  roles: WorkflowConfig['roles'],
  files: readonly string[],
  declaredFiles: readonly string[],
  targetFiles: readonly string[] | undefined,
  familyTargetStageNames: readonly string[],
  familyTargetFamilies: readonly string[],
): Job {
  const config = named.config;
  if ('agent' in config && config.agent !== undefined) {
    const writes = writesOf(config);
    const job = guardedAgent(brief, named, seatRole(roles, config.agent), files, declaredFiles);
    if (config.reviewedBy === undefined) return job;
    const built = recordRoundChange(job);
    const reviewRole = role(roles, config.reviewedBy);
    if (!Array.isArray(reviewRole) && 'kind' in reviewRole && reviewRole.kind === 'person') {
      if (!reviewRole.interaction) throw new TypeError('a human reviewer needs an interaction binding');
      const review = humanReview(named.name, {
        question: reviewRole.question, interaction: reviewRole.interaction,
        input: async (ctx) => Object.fromEntries(await Promise.all(writes.map(async (file) => [file, await readFile(join(ctx.workspace.dir, file), 'utf8')]))),
      });
      // `max` counts builds: the first, and one per refinement left.
      const rounds = (body: Job, stageReview: Job, max: number | undefined) => loop({ name: `${named.name}-review`, body, max, review: stageReview });
      return refinedRounds(rounds, built, stageWork(brief, named), review);
    }
    const reviewers = panelRole(roles, config.reviewedBy);
    const panel = reviewerPanel(brief, named, reviewers, files, declaredFiles, undefined, undefined, config.agree, config.synthesise);
    const missingWrites = async (dir: string): Promise<string[]> => {
      const missing: string[] = [];
      for (const file of writesOf(config)) {
        try {
          const details = await stat(join(dir, file));
          if (!details.isFile() || details.size === 0) missing.push(file);
        } catch {
          missing.push(file);
        }
      }
      return missing;
    };
    // The goal check runs first every round, a round with a missing file
    // included. An unmet requirement goes straight back to the builder: no
    // review and no judge that round. The reviewers still wait for every
    // declared file.
    const goal = config.goal === undefined ? undefined : goalCheckJob(`${named.name}-goal`, config.goal, {
      text: brief.brief,
      ...(config.desc === undefined ? {} : { desc: config.desc }),
      ...(config.gate === undefined ? {} : { gate: config.gate }),
      work: reviewTarget(named),
    }, undefined, (ctx) => ctx.iteration);
    // A declared file the build left missing or empty sends the work back
    // ahead of the panel, the way a dag() node's missing `file` does. With
    // a goal it runs after the goal check, whose verdicts already say what
    // is not there.
    const artifactGate: Job = async (ctx) => {
      const missing = await missingWrites(ctx.workspace.dir);
      return missing.length > 0
        ? { status: 'fail' as const, summary: `${named.name} did not write: ${missing.join(', ')}` }
        : { status: 'pass' as const };
    };
    const goalGate: Job = goal === undefined ? artifactGate : async (ctx) => {
      const goalCtx = { ...ctx, depth: ctx.depth + 1, path: [...ctx.path, 'goal-check'] };
      const checked = await requireNoFiles(`${named.name}-goal`, goal, ctx.workspace.dir, declaredFiles)(goalCtx);
      if (checked.status !== 'pass') return checked;
      const missing = await artifactGate(ctx);
      // The passing outcome stays the goal check's: its verdicts are the
      // evidence a judge of this stage reads.
      return missing.status === 'pass' ? checked : missing;
    };
    // Review events use a child path. The jobs' role tags, not their paths,
    // separate the recorded sides. The outcome passes through.
    const reviewed: Job = async (ctx) => panel({
      ...ctx,
      depth: ctx.depth + 1,
      path: [...ctx.path, 'review-panel'],
    });
    const rounds = (body: Job, stageReview: Job, max: number | undefined) => loop({
      name: `${named.name}-review`,
      body,
      review: stageReview,
      // A stopped body reaches the file check and the goal check when the
      // declared files are what it left missing, or when a goal check
      // stands to name what the work lacks. Any other retryable failure
      // retries the body, unanswered by the round's gates.
      until: predicate(async (ctx, last) =>
        last?.status === 'pass'
        || (last?.status === 'fail' && (config.goal !== undefined
          || (await missingWrites(ctx.workspace.dir)).length > 0)),
        `${named.name} writes`),
      max,
    });
    // The goal check runs ahead of the panel each round. With a judge, it
    // runs inside the judge's round, so a run that resumes at the judge's
    // question does not check the goal again. The stage's write files draw
    // on the same check budget a dag() node's review() gives (checkRounds,
    // 3); an unmet goal counts as a review round, as in every form.
    const reviewLoop = refinedRounds(rounds, built, stageWork(brief, named), reviewed, goalGate, 3);
    return copyJobMeta(
      recordedFamilyGate(
        reviewLoop,
        reviewers,
        [named.name],
        [seatIdentity(seatRole(roles, config.agent)).modelFamily],
        true,
      ),
      reviewLoop,
    );
  }
  if ('run' in config && config.run !== undefined) {
    const command = commandJob(named.name, config.run, { target: config.sendsBackTo });
    const writes = writesOf(config);
    const forbidden = declaredFiles.filter((file) => !writes.includes(file));
    const guarded: Job = async (ctx) => requireNoFiles(
      named.name,
      command,
      ctx.workspace.dir,
      forbidden,
      'body',
    )(ctx);
    return copyJobMeta(guarded, command);
  }
  if ('panel' in config && config.panel !== undefined) {
    const reviewers = panelRole(roles, config.panel);
    const panel = reviewerPanel(brief, named, reviewers, files, declaredFiles, targetFiles, config.sendsBackTo, config.agree, config.synthesise);
    return copyJobMeta(recordedFamilyGate(panel, reviewers, familyTargetStageNames, familyTargetFamilies, false), panel);
  }
  if ('input' in config && config.input !== undefined) {
    const personRole = inputRole(roles, config.input);
    if (!personRole.interaction) return approval(named.name, { question: personRole.question, target: config.sendsBackTo });
    return async (ctx) => {
      const identity = interactionIdentity({ brief, named, personRole });
      const checkpointPath = [...ctx.path, '@person-interaction'];
      const input = jsonSnapshot({ requester: { path: ctx.path, identity }, material: brief });
      const result = await requestInteraction(personRole.interaction!, personRole.question, input, {
        ...ctx, interactionCheckpoint() {
          ctx.interactionCheckpoint?.();
          checkpointInteraction(ctx, checkpointPath, identity, input);
        },
      });
      if ('paused' in result) return result.paused;
      checkpointInteraction(ctx, checkpointPath, identity, null);
      return { status: 'pass', summary: result.response.prompt, data: result.response };
    };
  }
  if ('fn' in config && config.fn !== undefined) {
    return guardedFn(config.fn, named, declaredFiles);
  }
  throw new TypeError(`stage ${named.name} must declare agent, run, panel, input or fn`);
}

function workflowRecord(outcome: Outcome): WorkflowRecord {
  return {
    outcome,
    summary: () => outcome.summary ?? outcome.status,
  };
}

function precedingAgent(stages: readonly NamedStage[], index: number): NamedStage | undefined {
  return [...stages.slice(0, index)]
    .reverse()
    .find((candidate) => 'agent' in candidate.config && candidate.config.agent !== undefined);
}

function panelTarget(stages: readonly NamedStage[], index: number): NamedStage | undefined {
  const config = stages[index]!.config;
  if (!('panel' in config) || config.panel === undefined) return undefined;
  if (config.sendsBackTo !== undefined) {
    return stages.find((candidate) => candidate.name === config.sendsBackTo);
  }
  return precedingAgent(stages, index);
}

function panelReviewFiles(stages: readonly NamedStage[], index: number): string[] {
  const target = panelTarget(stages, index);
  const preceding = precedingAgent(stages, index);
  const targetWrites = target === undefined ? [] : writesOf(target.config);
  return targetWrites.length
    ? targetWrites
    : preceding === undefined
      ? []
      : writesOf(preceding.config);
}

/** The workflow's resume identity: one digest over everything a change to
 * which means the recorded completions no longer describe this workflow.
 * Restart-from-the-top on any change is the honest default. The digest
 * covers only the DECLARED shape: the brief, the stage list with each
 * stage's declared fields, and each role's declared identity. Engine
 * instances are excluded because they carry mutable call state, and a
 * digest that changes between two runs of the same workflow cannot match
 * anything. */
function resumeIdentity(name: string, config: WorkflowConfig): string {
  const declared = {
    name,
    brief: config.brief,
    stages: config.stages.map((named) => ({
      name: named.name,
      config: interactionIdentity(named.config),
    })),
    roles: Object.fromEntries(Object.entries(config.roles).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((seat) => seatIdentity(seat))
        : typeof value === 'object' && value !== null && 'kind' in value
          ? value
          : seatIdentity(value as TeamSeat),
    ])),
  };
  return createHash('sha256').update(JSON.stringify(declared)).digest('hex');
}

export function workflow(name: string, config: WorkflowConfig): Job {
  const workflowName = text(name, 'workflow name');
  const brief = briefValue(config.brief);
  if (!Array.isArray(config.stages) || !config.stages.length) throw new TypeError('workflow needs at least one stage');
  const names = new Set<string>();
  const incomingTargets = new Set<string>();
  for (const named of config.stages) {
    if (named.config.sendsBackTo !== undefined) incomingTargets.add(named.config.sendsBackTo);
  }
  for (const named of config.stages) {
    const stageName = text(named.name, 'stage name');
    if (names.has(stageName)) throw new TypeError(`workflow stage is duplicated: ${stageName}`);
    names.add(stageName);
    const stageConfig = named.config;
    const sendsBackTo = stageConfig.sendsBackTo;
    if (sendsBackTo === stageName) {
      throw new TypeError(`stage ${stageName} cannot send back to itself; use reviewedBy`);
    }
    if (sendsBackTo !== undefined) {
      const targetIndex = config.stages.findIndex((item) => item.name === sendsBackTo);
      if (targetIndex < 0) throw new TypeError(`stage ${stageName} sends back to unknown stage ${sendsBackTo}`);
      if (targetIndex >= config.stages.indexOf(named)) {
        throw new TypeError(`stage ${stageName} sends back to ${sendsBackTo}, which is not an earlier stage`);
      }
    }
    const reviewedBy = 'reviewedBy' in stageConfig ? stageConfig.reviewedBy : undefined;
    if (reviewedBy !== undefined && !('agent' in stageConfig)) {
      throw new TypeError(`reviewedBy is for agent stages: ${stageName}`);
    }
    if (reviewedBy !== undefined && stageConfig.sendsBackTo !== undefined) {
      throw new TypeError(`stage ${stageName} cannot use both reviewedBy and sendsBackTo`);
    }
    if ('agent' in stageConfig && stageConfig.agree !== undefined
      && (reviewedBy === undefined || !Array.isArray(role(config.roles, reviewedBy)))) {
      throw new TypeError(`agree is for a stage reviewed by a panel or a panel stage: ${stageName}`);
    }
    refineForStage(stageConfig, incomingTargets.has(stageName));
    if (stageConfig.goal !== undefined) {
      const reviewRole = reviewedBy === undefined ? undefined : role(config.roles, reviewedBy);
      if (!('agent' in stageConfig) || !Array.isArray(reviewRole)) {
        throw new TypeError(`goal is for an agent stage reviewed by a panel: ${stageName}`);
      }
      if (seatIdentity(stageConfig.goal).tools.length === 0) {
        throw new TypeError(`the goal seat on ${stageName} must declare read tools`);
      }
    }
    if (stageConfig.synthesise !== undefined) {
      const panelStage = 'panel' in stageConfig && stageConfig.panel !== undefined;
      const reviewRole = reviewedBy === undefined ? undefined : role(config.roles, reviewedBy);
      if (!panelStage && !Array.isArray(reviewRole)) {
        throw new TypeError(`synthesise is for a stage reviewed by a panel or a panel stage: ${stageName}`);
      }
      if (stageConfig.synthesise !== true) seatIdentity(stageConfig.synthesise);
    }
    optionalFlag(stageConfig.optional);
    if (stageConfig.retrySafe !== undefined && typeof stageConfig.retrySafe !== 'boolean') {
      throw new TypeError('retrySafe must be a boolean');
    }
    writesOf(stageConfig);
  }
  for (const [index, named] of config.stages.entries()) {
    const stageConfig = named.config;
    if ('agent' in stageConfig && stageConfig.agent !== undefined && stageConfig.reviewedBy !== undefined) {
      const reviewer = role(config.roles, stageConfig.reviewedBy);
      if (Array.isArray(reviewer)) assertDistinctSeats([
        seatRole(config.roles, stageConfig.agent),
        ...panelRole(config.roles, stageConfig.reviewedBy),
      ]);
      else if (!('kind' in reviewer) || reviewer.kind !== 'person') throw new TypeError('reviewedBy must name a reviewer panel or person');
    }
    if ('panel' in stageConfig && stageConfig.panel !== undefined) {
      const preceding = precedingAgent(config.stages, index);
      const target = panelTarget(config.stages, index);
      const familyTargets = [preceding, target]
        .filter((candidate): candidate is NamedStage => candidate !== undefined)
        .filter((candidate, targetIndex, candidates) =>
          candidates.findIndex((other) => other.name === candidate.name) === targetIndex,
        );
      const targetSeats = familyTargets.filter(
        (candidate): candidate is NamedStage & { config: { agent: string } } =>
          'agent' in candidate.config && candidate.config.agent !== undefined,
      );
      if (targetSeats.length) {
        const reviewers = panelRole(config.roles, stageConfig.panel);
        for (const targetSeat of targetSeats) {
          assertDistinctSeats([
            seatRole(config.roles, targetSeat.config.agent),
            ...reviewers,
          ]);
        }
      }
    }
  }
  const timeoutMs = duration(config.options?.timeout);
  const stageJobIdentity = resumeIdentity(workflowName, config);
  const useCase = briefUseCase(brief);
  const declaredFiles = workflowFiles(brief, config.stages);
  const nodes = Object.fromEntries(config.stages.map((named, index) => {
    const files = stageFiles(brief, config.stages, index);
    const stageConfig = named.config;
    const targetFiles =
      'panel' in stageConfig && stageConfig.panel !== undefined
        ? panelReviewFiles(config.stages, index)
        : undefined;
    const panelFamilyTargets = ('panel' in stageConfig && stageConfig.panel !== undefined)
      ? (() => {
        const preceding = precedingAgent(config.stages, index);
        const target = panelTarget(config.stages, index);
        return [preceding, target]
          .filter((candidate): candidate is NamedStage => candidate !== undefined)
          .filter((candidate, targetIndex, candidates) =>
            candidates.findIndex((other) => other.name === candidate.name) === targetIndex,
          )
          .filter((candidate): candidate is NamedStage & { config: { agent: string } } =>
            'agent' in candidate.config && candidate.config.agent !== undefined,
          );
      })()
      : [];
    const innerStage = stageJob(
      brief,
      named,
      config.roles,
      files,
      declaredFiles,
      targetFiles,
      panelFamilyTargets.map((candidate) => candidate.name),
      panelFamilyTargets.map((candidate) => seatIdentity(seatRole(config.roles, candidate.config.agent)).modelFamily),
    );
    const file = writesOf(stageConfig)[0];
    // The stage's own `refine` rides onto its node as the send-back policy:
    // a reviewed stage's own reviews run inside its job, and the node-level
    // refine governs the send-backs later stages declare to it. A judge on
    // it is used as-is (the dag consults it); a plain count is the rounds.
    // Only a reviewed stage or a send-back target declares one.
    const reviewed = 'reviewedBy' in stageConfig && stageConfig.reviewedBy !== undefined;
    const hasRefine = reviewed || incomingTargets.has(named.name);
    const refine = hasRefine ? refineOf(stageConfig) : undefined;
    return [named.name, {
      job: declareWrites(innerStage, writesOf(stageConfig)),
      ...(file === undefined ? {} : { file }),
      ...(named.config.retrySafe === undefined ? {} : { retrySafe: named.config.retrySafe }),
      needs: stageDependencies(config.stages, index),
      ...(named.config.sendsBackTo === undefined ? {} : { sendsBackTo: named.config.sendsBackTo }),
      ...(refine === undefined ? {} : {
        refine: isJudge(refine) ? review({ judge: refine }) : review({ rounds: refine }),
      }),
      ...(named.config.desc === undefined ? {} : { desc: named.config.desc }),
      ...(named.config.gate === undefined ? {} : { gate: named.config.gate }),
      ...(named.config.when === undefined ? {} : { when: named.config.when }),
      ...(named.config.optional === undefined ? {} : { optional: named.config.optional }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }];
  }));
  const graphConfig: DagConfig & { [RESUME_IDENTITY]: string } = {
    name: workflowName,
    nodes,
    [RESUME_IDENTITY]: stageJobIdentity,
    brief: brief.brief,
    ...(useCase === undefined ? {} : { useCase }),
  };
  const graph = dag(graphConfig);
  const always = config.post?.always;
  if (!always) return graph;
  return loop({
    name: `${workflowName}-post`,
    body: graph,
    until: predicate(() => true, 'workflow complete'),
    max: 1,
    onComplete: async (outcome, ctx) => {
      try {
        await always({ record: workflowRecord(outcome) });
      } catch (error) {
        ctx.log(`workflow post.always failed: ${error instanceof Error ? error.message : String(error)}`, 'warn');
      }
    },
  });
}
