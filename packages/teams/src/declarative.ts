import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  agentJob,
  approval,
  commandJob,
  copyJobMeta,
  dag,
  LoopError,
  loop,
  predicate,
  reviewPanel,
  type Job,
  type JobContext,
  type Outcome,
  type ConditionInput,
  RESUME_STAGE_OUTCOMES,
} from '@obversa/runtime';

import { outcomeFromAgentText } from './agent-response.js';
import {
  assertDistinctSeats,
  panelReviewers,
  requireNoFiles,
  requireNonEmptyFiles,
  seatIdentity,
} from './team-utils.js';
import type { ReviewerSeat, TeamInput, TeamSeat } from './types.js';

export interface BriefSource {
  readonly brief: string;
  readonly files?: readonly string[];
}

export interface PersonRole {
  readonly kind: 'person';
  readonly question: string;
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
  readonly retry?: number;
}

export type WorkflowStage = WorkflowStageBase & {
} & (
  | { readonly agent: string; readonly reviewedBy?: string; readonly run?: never; readonly panel?: never; readonly input?: never; }
  | { readonly run: string | readonly string[]; readonly agent?: never; readonly panel?: never; readonly input?: never; }
  | { readonly panel: string; readonly agree?: number; readonly agent?: never; readonly run?: never; readonly input?: never; }
  | { readonly input: string; readonly agent?: never; readonly run?: never; readonly panel?: never; }
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

export function fromFile(path: string | URL): BriefSource {
  return parseFrontMatter(readFileSync(path, 'utf8'));
}

export function person(question: string): PersonRole {
  return { kind: 'person', question: text(question, 'person question') };
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

function retryCount(retry: number | undefined, label: string): number {
  if (retry === undefined) return 0;
  if (!Number.isSafeInteger(retry) || retry < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return retry;
}

function optionalFlag(optional: unknown): boolean | undefined {
  if (optional === undefined) return undefined;
  if (typeof optional !== 'boolean') throw new TypeError('optional must be a boolean');
  return optional;
}

function retryOf(config: WorkflowStage): number {
  return config.retry === undefined ? 1 : retryCount(config.retry, 'retry');
}

function retryForStage(config: WorkflowStage, receivesKickback: boolean): number {
  if ('reviewedBy' in config && config.reviewedBy) return retryOf(config);
  if (receivesKickback) return retryOf(config);
  if (config.retry !== undefined) {
    throw new TypeError('retry must be on a reviewed stage or a kickback target');
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
    reviewers: definitions.map((definition, index) => ({
      name: definition.name,
      scope: definition.scope,
      job: async (ctx) => {
        const reviewer = panelReviewers(
          definitions,
          panelInput(brief, files, ctx.workspace.dir),
          reviewTarget(named, targetFiles),
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
  const identity = seatIdentity(seat);
  const agent = agentJob({
    label: named.name,
    engine: seat.engine,
    model: identity.model,
    tools: [...identity.tools],
    allowedTools: [...identity.tools],
    workspaceMode: 'write',
    consumeFeedback: target !== undefined || reviewedBy !== undefined,
    prompt: agentPrompt(brief, named, files, writes),
    outcome: (textValue) => outcomeFromAgentText(textValue, target),
  });
  return async (ctx) => {
    const required = requireNonEmptyFiles(named.name, agent, ctx.workspace.dir, writes);
    const forbidden = declaredFiles.filter((file) => !writes.includes(file));
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

function stageJob(
  brief: BriefSource,
  named: NamedStage,
  roles: WorkflowConfig['roles'],
  files: readonly string[],
  declaredFiles: readonly string[],
  targetFiles: readonly string[] | undefined,
): Job {
  const config = named.config;
  if ('agent' in config && config.agent !== undefined) {
    const writes = writesOf(config);
    const guarded = guardedAgent(brief, named, seatRole(roles, config.agent), files, declaredFiles);
    const job = config.reviewedBy === undefined
      ? guarded
      : unchangedNoteGuard(named.name, guarded, writes);
    if (config.reviewedBy === undefined) return job;
    const panel = reviewerPanel(brief, named, panelRole(roles, config.reviewedBy), files, declaredFiles, undefined);
    const retry = retryOf(config);
    return loop({
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
      review: panel,
      max: retry + 1,
      maxReviewRestarts: retry,
      noProgress: { window: 2, gate: true },
    });
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
    return reviewerPanel(brief, named, panelRole(roles, config.panel), files, declaredFiles, targetFiles, config.sendsBackTo, config.agree);
  }
  if ('input' in config && config.input !== undefined) {
    const personRole = inputRole(roles, config.input);
    return approval(named.name, { question: personRole.question, target: config.sendsBackTo });
  }
  throw new TypeError(`stage ${named.name} must declare agent, run, panel or input`);
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

/** A canonical, digestable view of a declared value: primitives pass
 * through, plain objects sort their keys, functions serialize as their
 * source, so a changed predicate changes the digest. */
function canonicalForDigest(value: unknown): unknown {
  if (typeof value === 'function') return `fn:${value.toString()}`;
  if (Array.isArray(value)) return value.map(canonicalForDigest);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).sort().map((key) => [
        key,
        canonicalForDigest((value as Record<string, unknown>)[key]),
      ]),
    );
  }
  return value;
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
      config: canonicalForDigest(Object.fromEntries(
        Object.entries(named.config).filter(([key]) => key !== 'engine'),
      )),
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

/** Wrap a stage job with the resume guard: a resuming run skips a stage
 * whose recorded completion carries this workflow's identity, re-runs an
 * interrupted or changed stage, and attaches the identity to its own
 * passing completion so the NEXT resume can skip it. */
function resumeGuard(job: Job, identity: string, _label: string): Job {
  return async (ctx) => {
    const resumed = ctx.state[RESUME_STAGE_OUTCOMES] as ReadonlyMap<string, Outcome> | undefined;
    if (resumed !== undefined) {
      const recorded = resumed.get(ctx.path.join('/'));
      const recordedIdentity = (recorded?.data as { resumeIdentity?: unknown } | undefined)?.resumeIdentity;
      if (recorded !== undefined && recordedIdentity === identity) {
        return recorded;
      }
      if (recorded !== undefined && recorded.status === 'paused') {
        // A paused gate stays a cheap no-op while its question is still
        // pending unanswered: exit at once, no re-post, no model call.
        const request = (recorded.data as { requestId?: string } | undefined);
        const pending = ctx.callbacks === undefined
          ? []
          : await ctx.callbacks.listPending();
        if (request?.requestId !== undefined
            && pending.some((candidate) => candidate.requestId === request.requestId)) {
          return recorded;
        }
      }
    }
    const outcome = await job(ctx);
    return outcome.status === 'pass'
      ? { ...outcome, data: { ...(outcome.data ?? {}), resumeIdentity: identity } }
      : outcome;
  };
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
    retryForStage(stageConfig, incomingTargets.has(stageName));
    optionalFlag(stageConfig.optional);
    writesOf(stageConfig);
  }
  for (const [index, named] of config.stages.entries()) {
    const stageConfig = named.config;
    if ('agent' in stageConfig && stageConfig.agent !== undefined && stageConfig.reviewedBy !== undefined) {
      assertDistinctSeats([
        seatRole(config.roles, stageConfig.agent),
        ...panelRole(config.roles, stageConfig.reviewedBy),
      ]);
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
  const maxKickbacks: Record<string, number> = {};
  for (const named of config.stages) {
    if (named.config.sendsBackTo !== undefined) {
      const target = config.stages.find((candidate) => candidate.name === named.config.sendsBackTo)!;
      maxKickbacks[named.config.sendsBackTo] = Math.max(
        maxKickbacks[named.config.sendsBackTo] ?? 0,
        retryOf(target.config),
      );
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
    const innerStage = stageJob(brief, named, config.roles, files, declaredFiles, targetFiles);
    return [named.name, {
      job: copyJobMeta(resumeGuard(innerStage, stageJobIdentity, named.name), innerStage),
      needs: stageDependencies(config.stages, index),
      ...(named.config.desc === undefined ? {} : { desc: named.config.desc }),
      ...(named.config.gate === undefined ? {} : { gate: named.config.gate }),
      ...(named.config.when === undefined ? {} : { when: named.config.when }),
      ...(named.config.optional === undefined ? {} : { optional: named.config.optional }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }];
  }));
  const graph = dag({
    name: workflowName,
    nodes,
    ...(Object.keys(maxKickbacks).length ? { maxKickbacks } : {}),
  });
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
