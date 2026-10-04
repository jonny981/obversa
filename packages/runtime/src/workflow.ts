import { createHash } from 'node:crypto';

import { modelIdentity, type TeamSeat } from '@obversa/api';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { agentJob, fnJob, RECORDED_ENGINE_USAGE, type RecordedEngineUsage } from './core/job.js';
import { approval } from './core/approval-job.js';
import { commandJob, predicate } from './core/condition.js';
import { copyJobMeta } from './core/describe.js';
import { dag } from './core/dag.js';
import { RESUME_IDENTITY } from './core/resume.js';
import { LoopError } from './core/errors.js';
import { loop } from './core/loop.js';
import { kickback, revisionFromOutcome } from './core/feedback.js';
import { reviewPanel } from './core/synthesis.js';
import { consultJudge, countBySeverity, isJudge, judgedFindings, lastRoundAnswered, productDecisionFeedback, type JudgeRound, type JudgeState, type SkippedFinding } from './core/judge.js';
import type { ConditionInput, DagConfig, Job, JobContext, Judge, Outcome } from './core/types.js';
import { checkpointInteraction, interactionDeclaration, hasSavedInteraction, humanReview, interactionIdentity, jsonSnapshot, outcomeSnapshot, requestInteraction, savedInteraction, type InteractionBinding, type InteractionResponse } from './core/interaction.js';

import { outcomeFromAgentText } from './workflow-agent-response.js';
import {
  assertDistinctSeats,
  panelReviewers,
  requireNoFiles,
  requireNonEmptyFiles,
  seatIdentity,
} from './workflow-support.js';
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
   * How many more rounds a reviewed stage or a kickback target gets: a plain
   * count, or `judge(seat)` to let a seat decide between a review's verdict
   * and the send-back. With no cap, the rounds end when the judge stops them
   * or the review passes. `judge(seat, { cap })` adds a backstop: after the
   * last review the cap allows, the judge's answer decides the outcome.
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
 */
export type WorkflowStage = WorkflowStageBase & {
} & (
  | { readonly agent: string; readonly reviewedBy?: string; readonly effort?: string; readonly synthesise?: TeamSeat | true; readonly run?: never; readonly panel?: never; readonly input?: never; readonly fn?: never; }
  | { readonly run: string | readonly string[]; readonly synthesise?: never; readonly agent?: never; readonly panel?: never; readonly input?: never; readonly fn?: never; }
  | { readonly panel: string; readonly agree?: number; readonly synthesise?: TeamSeat | true; readonly agent?: never; readonly run?: never; readonly input?: never; readonly fn?: never; }
  | { readonly input: string; readonly synthesise?: never; readonly agent?: never; readonly run?: never; readonly panel?: never; readonly fn?: never; }
  | { readonly fn: Job; readonly synthesise?: never; readonly agent?: never; readonly run?: never; readonly panel?: never; readonly input?: never; }
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
  if (!Number.isSafeInteger(refine) || refine < 0) throw new TypeError(`${label} must be a non-negative integer`);
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

/**
 * The family a recorded answer belongs to, read through the one derivation
 * every harness that runs other providers' models shares. A model string the
 * derivation refuses (no family, or the `unknown` placeholder) is unreadable
 * here, and an unreadable family refuses the review rather than passing it.
 */
function recordedFamilyOf(model: string): string | undefined {
  try {
    return modelIdentity(model).modelFamily;
  } catch {
    return undefined;
  }
}

function recordedUsage(ctx: JobContext): readonly RecordedEngineUsage[] {
  const value = ctx.state[RECORDED_ENGINE_USAGE];
  return Array.isArray(value) ? value as readonly RecordedEngineUsage[] : [];
}

/** Refuse a panel when a recorded answer contradicts the distinct-family
 * requirement: an answer whose recorded family equals a family it must
 * differ from, or an answer whose family cannot be read at all. Every
 * recorded answer up to the panel is read, never the first per seat. The
 * refusal names the seats, their declared families and the answers, so a
 * reader can act on it without reading source. Fail closed on identity,
 * never pass in silence. */
function assertRecordedFamilies(
  records: readonly RecordedEngineUsage[],
  opposing: readonly { readonly label: string; readonly family: string }[],
): void {
  const declared = opposing.map((seat) => `${seat.label} declares ${seat.family}`).join('; ');
  for (const record of records) {
    const family = recordedFamilyOf(record.model);
    if (family === undefined) {
      throw new LoopError({
        code: 'BODY',
        phase: 'review',
        message: `recorded model family is unknown: the answer ${record.model} carries no readable family, and ${declared}; a panel that requires distinct families refuses an unreadable answer`,
      });
    }
    const collision = opposing.find((seat) => seat.family === family);
    if (collision !== undefined) {
      throw new LoopError({
        code: 'BODY',
        phase: 'review',
        message: `recorded model family collision: the answer ${record.model} belongs to the family ${family}, and ${collision.label} declares ${collision.family}; the panel requires the recorded answers to differ from it (${declared})`,
      });
    }
  }
}

/** The gate around a panel stage: before the reviewers run, every recorded
 * answer from the stages this panel must differ from is compared against
 * the reviewers' declared families; after the reviewers run, their own
 * recorded answers are compared against the families they must differ
 * from. Tagged writer and reviewer answers are checked; untagged advisor
 * and agentCheck answers are outside this gate. An unreadable family on
 * either tagged side is a refusal, never a pass. */
function recordedFamilyGate(
  panel: Job,
  reviewers: readonly TeamSeat[],
  writerStageNames: readonly string[],
  writerFamilies: readonly string[],
  writerRunsInsidePanel: boolean,
): Job {
  const reviewerDeclarations = reviewers.map((seat) => ({
    label: `reviewer seat ${seatIdentity(seat).model}`,
    family: seatIdentity(seat).modelFamily,
  }));
  const writerDeclarations = writerStageNames.map((name, index) => ({
    label: `writer stage ${name}`,
    family: writerFamilies[index] ?? '',
  })).filter((entry) => entry.family !== '');
  return async (ctx) => {
    try {
      const all = recordedUsage(ctx);
      const beforeLength = all.length;
      const resumingInteraction = hasSavedInteraction(ctx, ctx.path);
      const writerSide = (records: readonly RecordedEngineUsage[]) => records.filter(
        (record) => record.role === 'writer'
          && record.stage !== undefined
          && writerStageNames.includes(record.stage),
      );
      const panelStage = ctx.graph?.node ?? ctx.path.at(-1) ?? 'panel';
      // Every recorded writer answer up to the panel keeps the reviewers'
      // declared difference. Records are compared by role and stage, never
      // by path.
      const beforeWriters = writerSide(all.slice(0, beforeLength));
      assertRecordedFamilies(beforeWriters, reviewerDeclarations);
      const outcome = await panel(ctx);
      if (outcome.status !== 'pass') return outcome;
      const current = recordedUsage(ctx);
      const after = current.slice(beforeLength);
      const afterWriters = writerSide(after);
      if (writerRunsInsidePanel && afterWriters.length === 0 && !resumingInteraction) {
        throw new LoopError({
          code: 'BODY',
          phase: 'review',
          message: `recorded model family missing: writer stage ${writerStageNames.join(', ')} has no recorded answer in stage ${panelStage}`,
        });
      }
      assertRecordedFamilies(afterWriters, reviewerDeclarations);
      const reviewerSide = (resumingInteraction ? current : after).filter((record) => record.role === 'reviewer' && record.stage === panelStage);
      if (reviewerSide.length === 0) {
        throw new LoopError({
          code: 'BODY',
          phase: 'review',
          message: `recorded model family missing: reviewer stage ${panelStage} has no recorded answer`,
        });
      }
      assertRecordedFamilies(reviewerSide, writerDeclarations);
      // The two recorded sides themselves must be disjoint: two declared
      // differences mean nothing when one family answered both.
      const writerAnswerFamilies = new Set(
        writerSide(current).map((record) => recordedFamilyOf(record.model)).filter(
          (family): family is string => family !== undefined,
        ),
      );
      for (const record of reviewerSide) {
        const family = recordedFamilyOf(record.model);
        if (family === undefined) {
          throw new LoopError({
            code: 'BODY',
            phase: 'review',
            message: `recorded model family is unknown: the answer ${record.model} carries no readable family, and the panel requires the two recorded sides to differ`,
          });
        }
        if (writerAnswerFamilies.has(family)) {
          throw new LoopError({
            code: 'BODY',
            phase: 'review',
            message: `recorded model family collision: the answer ${record.model} belongs to the family ${family}, and a writer stage's recorded answer belongs to the same family; the panel requires the two recorded sides to be disjoint`,
          });
        }
      }
      return outcome;
    } catch (error) {
      if (error instanceof LoopError && error.message.startsWith('recorded model family')) {
        return { status: 'fail' as const, summary: error.message, error };
      }
      throw error;
    }
  };
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
): (ctx: JobContext) => string {
  return (ctx) => [
    `Work brief:\n${brief.brief}`,
    `Stage: ${named.name}`,
    named.config.desc ? `Task: ${named.config.desc}` : undefined,
    named.config.gate ? `Gate: ${named.config.gate}` : undefined,
    `Workflow files: ${files.join(', ') || 'none'}`,
    `This stage may write only: ${writes.join(', ') || 'no files'}. Do not write any other declared workflow file.`,
    ctx.lastReview ? `Previous review:\n${ctx.lastReview.summary ?? ctx.lastReview.status}` : undefined,
    'Return one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"..."}]}',
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
  const reviewedBy = 'reviewedBy' in named.config ? named.config.reviewedBy : undefined;
  const effort = 'effort' in named.config ? named.config.effort : undefined;
  const identity = seatIdentity(seat);
  const agent = agentJob({
    label: named.name,
    engine: seat.engine,
    model: identity.model,
    ...(effort === undefined ? {} : { effort }),
    tools: [...identity.tools],
    allowedTools: [...identity.tools],
    workspaceMode: 'write',
    consumeFeedback: target !== undefined || reviewedBy !== undefined,
    prompt: agentPrompt(brief, named, files, writes),
    outcome: (textValue) => outcomeFromAgentText(textValue, target),
    recordAs: { role: 'writer', stage: named.name },
  });
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

function unchangedNoteGuard(
  label: string,
  job: Job,
  writes: readonly string[],
): Job {
  const previousHashKey = `declarativePreviousHash:${label}`;
  return async (ctx) => {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
    let currentHash: string | undefined;
    try {
      const contents = await Promise.all(
        writes.map((file) => readFile(join(ctx.workspace.dir, file))),
      );
      const hash = createHash('sha256');
      contents.forEach((content) => hash.update(content));
      currentHash = hash.digest('hex');
    } catch {
      return outcome;
    }
    const previousHash = ctx.state[previousHashKey];
    if (ctx.lastReview && typeof previousHash === 'string' && previousHash === currentHash) {
      const summary = `${label} returned the rejected note unchanged`;
      return {
        status: 'fail',
        summary,
        error: new LoopError({ code: 'VALIDATION', phase: 'body', message: summary }),
      };
    }
    ctx.state[previousHashKey] = currentHash;
    return outcome;
  };
}

/** Lines added or removed since the previous round (a set difference, not a true diff, cheap and enough to show trend). */
function lineDiffCount(before: string | undefined, after: string): number {
  if (before === undefined) return after.split('\n').length;
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  let changed = 0;
  for (const line of a) if (!b.has(line)) changed += 1;
  for (const line of b) if (!a.has(line)) changed += 1;
  return changed;
}

/**
 * Wrap a reviewer panel so a judge sits between its verdict and the
 * send-back, for every finding, a block included. After the last review
 * the cap allows, the judge's answer decides the outcome. The judge sees
 * the use case, the latest findings, the findings
 * it skipped before, every round so far, and the file being refined when
 * the stage declares one, and its answer either lets the review stand (a
 * synthesised pass) or sends it back with its reasoning folded into the
 * existing rejection. When it decides each finding, the send-back carries
 * only the findings it acts on, and the findings it skips go to the next
 * round's reviewers as `ctx.skippedFindings`.
 */
function judgedReview(brief: BriefSource, named: NamedStage, cfgJudge: Judge, panel: Job): Job {
  const config = named.config;
  const useCase = /^Use case:\s*([\s\S]*?)\n\s*\n/m.exec(brief.brief)?.[1]?.replace(/\s+/g, ' ').trim();
  const file = writesOf(config)[0];
  const history: JudgeRound[] = [];
  let skipped: readonly SkippedFinding[] = [];
  let previousDraft: string | undefined;
  let productFeedback: readonly InteractionResponse[] = [];
  const identity = interactionIdentity({ brief, config, cfgJudge });
  return async (ctx) => {
    const checkpointPath = [...ctx.path, '@judge-review'];
    let saved = savedInteraction(ctx, checkpointPath, identity);
    let draft: string | undefined;
    let changedLines: number | undefined;
    if (file !== undefined) {
      try {
        draft = await readFile(join(ctx.workspace.dir, file), 'utf8');
        changedLines = lineDiffCount(previousDraft, draft);
      } catch {
        // Not written yet (a first, failed attempt): state omits the file.
      }
      previousDraft = draft;
    }
    if (saved && (saved.state as unknown as JudgeState).draft !== draft) saved = undefined;
    if (saved) {
      history.splice(0, history.length, ...(saved.state as unknown as JudgeState).rounds);
      productFeedback = (saved.state as unknown as JudgeState).productFeedback ?? [];
      skipped = (saved.state as unknown as JudgeState).skipped ?? [];
      previousDraft = draft;
    }
    const panelOutcome: Outcome = saved ? saved.panel as unknown as Outcome : await panel({
      ...ctx,
      depth: ctx.depth + 1,
      path: [...ctx.path, 'review-panel'],
      ...(skipped.length ? { skippedFindings: skipped } : {}),
    });
    if (panelOutcome.status === 'pass') return panelOutcome;
    const findings = revisionFromOutcome(panelOutcome)?.findings ?? [];
    // The loop re-enters after a failing review only while
    // `ctx.iteration < cap` (its `maxReviewRestarts`); an iteration whose
    // review did not run also counts, so this errs towards ending.
    const lastRound = cfgJudge.cap !== undefined && ctx.iteration >= cfgJudge.cap;
    const round = history.length + 1;
    const state: JudgeState = saved ? saved.state as unknown as JudgeState : {
      ...(productFeedback.length ? { productFeedback } : {}),
      ...(useCase !== undefined ? { useCase } : {}),
      ...(file !== undefined ? { file } : {}),
      ...(draft !== undefined ? { draft } : {}),
      latestFindings: findings,
      ...(skipped.length ? { skipped } : {}),
      rounds: history,
      round,
      ...(cfgJudge.cap !== undefined ? { cap: cfgJudge.cap } : {}),
      ...(lastRound ? { lastRound: true } : {}),
    };
    const result = await consultJudge(cfgJudge, state, ctx, ctx.path, {
      identity, pending: saved !== undefined,
      save: (questionState) => checkpointInteraction(ctx, checkpointPath, identity, jsonSnapshot({ state: questionState, panel: outcomeSnapshot(panelOutcome) })),
    });
    if ('paused' in result) return result.paused;
    checkpointInteraction(ctx, checkpointPath, identity, null);
    productFeedback = result.state.productFeedback ?? [];
    history.push({
      round,
      findings,
      counts: countBySeverity(findings),
      ...(changedLines !== undefined ? { changedLines } : {}),
    });
    // A person's answer goes back to the builder as the next round; the
    // judge sees the result only after that round has been reviewed.
    if ('answer' in result) {
      // No build round is left for the answer: the stage stops here.
      if (lastRound) throw new LoopError({ code: 'VALIDATION', phase: 'review', path: ctx.path, message: lastRoundAnswered(result.state, result.answer) });
      // The judge decided each finding before asking: the answer goes with the acted ones only.
      const answered = judgedFindings(findings, { findings: result.state.decided }, result.state.skipped ?? [], round);
      skipped = answered.skipped;
      return productDecisionFeedback(result.answer, answered.acted);
    }
    const { decision } = result;
    const judged = judgedFindings(findings, decision, result.state.skipped ?? [], round);
    skipped = judged.skipped;
    if (!decision.again) {
      if (decision.stop === 'fail') {
        // Not converging, or any answer but a ship after the last round the
        // cap allows: the stage stops here, and the review's failure stands.
        throw new LoopError({ code: 'VALIDATION', phase: 'review', path: ctx.path, message: decision.reason });
      }
      return {
        status: 'pass', confidence: panelOutcome.confidence, summary: decision.reason, data: panelOutcome.data,
        ...(lastRound ? { openFindings: findings } : {}),
      };
    }
    // The panel's own summary lists every finding; when the judge decided
    // each one, the one-line reason stands in for it so the builder reads
    // only the findings it acts on.
    const revision = revisionFromOutcome(panelOutcome);
    return {
      ...panelOutcome,
      summary: `${decision.findings && revision ? revision.reason : panelOutcome.summary} (${decision.reason})`,
      ...(revision ? { revision: { ...revision, findings: judged.acted } } : {}),
    };
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
    const guarded = guardedAgent(brief, named, seatRole(roles, config.agent), files, declaredFiles);
    const job = config.reviewedBy === undefined
      ? guarded
      : unchangedNoteGuard(named.name, guarded, writes);
    if (config.reviewedBy === undefined) return job;
    const reviewRole = role(roles, config.reviewedBy);
    if (!Array.isArray(reviewRole) && 'kind' in reviewRole && reviewRole.kind === 'person') {
      if (!reviewRole.interaction) throw new TypeError('a human reviewer needs an interaction binding');
      const humanCap = refineCap(refineOf(config));
      const humanLoop = loop({
        name: `${named.name}-review`, body: job, max: humanCap === undefined ? undefined : humanCap + 1,
        review: humanReview(named.name, {
          question: reviewRole.question, interaction: reviewRole.interaction,
          input: async (ctx) => Object.fromEntries(await Promise.all(writes.map(async (file) => [file, await readFile(join(ctx.workspace.dir, file), 'utf8')]))),
        }),
      });
      return interactionDeclaration(copyJobMeta(async (ctx) => {
        const outcome = await humanLoop(ctx);
        return outcome.status === 'exhausted' ? { ...outcome, status: 'fail' as const } : outcome;
      }, humanLoop), { humanLoop });
    }
    const reviewers = panelRole(roles, config.reviewedBy);
    const panel = reviewerPanel(brief, named, reviewers, files, declaredFiles, undefined, undefined, undefined, config.synthesise);
    const refine = refineOf(config);
    const cap = refineCap(refine);
    // Review events use a child path. The jobs' role tags, not their paths,
    // separate the recorded sides. The outcome passes through. A judge
    // instead of a plain count sits between the panel's verdict and the
    // re-entry; `judgedReview` is what does that, so the plain path here
    // stays exactly what it was.
    const review: Job = isJudge(refine)
      ? judgedReview(brief, named, refine, panel)
      : async (ctx) => panel({
        ...ctx,
        depth: ctx.depth + 1,
        path: [...ctx.path, 'review-panel'],
      });
    const reviewLoop = loop({
      name: `${named.name}-review`,
      body: job,
      until: predicate(async (ctx) => {
        const writes = writesOf(config);
        for (const file of writes) {
          try {
            const details = await stat(join(ctx.workspace.dir, file));
            if (!details.isFile() || details.size === 0) return false;
          } catch {
            return false;
          }
        }
        return true;
      }, `${named.name} writes`),
      review,
      max: cap === undefined ? undefined : cap + 1,
      maxReviewRestarts: cap,
      noProgress: { window: 2, gate: true },
    });
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
    refineForStage(stageConfig, incomingTargets.has(stageName));
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
  // Per target, not per sender: `refine` lives on the target's own config, so
  // every sender to the same target resolves the exact same value here. A
  // judge is used as-is (dag() consults it); a plain count keeps the prior
  // max-of-candidates behaviour, though it is always the same number too.
  const maxKickbacks: Record<string, number | Judge> = {};
  for (const named of config.stages) {
    if (named.config.sendsBackTo !== undefined) {
      const target = config.stages.find((candidate) => candidate.name === named.config.sendsBackTo)!;
      const refine = refineOf(target.config);
      const existing = maxKickbacks[named.config.sendsBackTo];
      maxKickbacks[named.config.sendsBackTo] = isJudge(refine)
        ? refine
        : Math.max(isJudge(existing) ? 0 : (existing ?? 0), refine);
    }
  }
  const stageJobIdentity = resumeIdentity(workflowName, config);
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
    return [named.name, {
      job: innerStage,
      ...(named.config.retrySafe === undefined ? {} : { retrySafe: named.config.retrySafe }),
      needs: stageDependencies(config.stages, index),
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
    ...(Object.keys(maxKickbacks).length ? { maxKickbacks } : {}),
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
