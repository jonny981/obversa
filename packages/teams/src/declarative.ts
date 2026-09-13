import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  agentJob,
  approval,
  commandJob,
  dag,
  LoopError,
  loop,
  predicate,
  reviewPanel,
  type Job,
  type JobContext,
  type Outcome,
} from '@obversa/runtime';

import { outcomeFromAgentText } from './agent-response.js';
import {
  panelReviewers,
  requireNoFiles,
  requireNonEmptyFiles,
  seatIdentity,
} from './team-utils.js';
import type { ReviewerSeat, TeamInput, TeamSeat, TestCommand } from './types.js';

export interface BriefSource {
  readonly brief: string;
  readonly files?: readonly string[];
  readonly testFiles?: readonly string[];
  readonly test?: TestCommand;
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
  readonly sendsBackTo?: string;
  readonly retry?: number;
}

export type WorkflowStage = WorkflowStageBase & {
  readonly reviewedBy?: string;
} & (
  | { readonly agent: string; readonly run?: never; readonly panel?: never; readonly input?: never; }
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

const FRONT_MATTER_MARKER = /^---\r?\n/;
const PATH_FIELDS = new Set(['files', 'testFiles']);

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

function commandValue(value: unknown): TestCommand {
  const parsed = typeof value === 'string' && value.trim().startsWith('[')
    ? JSON.parse(value) as unknown
    : value;
  if (Array.isArray(parsed)) {
    if (!parsed.length) throw new TypeError('test command must contain a command');
    return {
      command: text(parsed[0], 'test command'),
      args: parsed.slice(1).map((arg, index) => text(arg, `test args[${index}]`)),
    };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as { command?: unknown; args?: unknown };
    return {
      command: text(record.command, 'test command'),
      args: Array.isArray(record.args)
        ? record.args.map((arg, index) => text(arg, `test args[${index}]`))
        : [],
    };
  }
  const parts = text(parsed, 'test command').split(/\s+/);
  return { command: parts[0]!, args: parts.slice(1) };
}

function parseFrontMatter(source: string): BriefSource {
  if (!FRONT_MATTER_MARKER.test(source)) return { brief: source.trim() };
  const closingOffset = source.slice(4).search(/^---\r?$/m);
  if (closingOffset < 0) throw new TypeError('brief front matter is not closed');
  const end = closingOffset + 4;
  const markerEnd = source.indexOf('\n', end);
  const header = source.slice(4, end).trim();
  const body = source.slice(markerEnd < 0 ? source.length : markerEnd + 1).trim();
  const values: Record<string, unknown> = {};
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new TypeError(`invalid brief front matter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (PATH_FIELDS.has(key)) values[key] = pathList(value, key);
    else if (key === 'test') values.test = commandValue(value);
    else throw new TypeError(`unknown brief front matter field: ${key}`);
  }
  return {
    brief: body,
    ...(values.files === undefined ? {} : { files: values.files as string[] }),
    ...(values.testFiles === undefined ? {} : { testFiles: values.testFiles as string[] }),
    ...(values.test === undefined ? {} : { test: values.test as TestCommand }),
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

function reviewRetryOf(config: WorkflowStage): number {
  const retry = retryCount(config.retry, 'retry');
  if (config.retry !== undefined && !config.reviewedBy) {
    throw new TypeError('retry needs reviewedBy');
  }
  return retry;
}

function targetRetryOf(config: WorkflowStage): number {
  return config.retry === undefined ? 1 : retryCount(config.retry, 'retry');
}

function retryForStage(config: WorkflowStage, receivesKickback: boolean): number {
  if (config.reviewedBy) return reviewRetryOf(config);
  if (receivesKickback) return targetRetryOf(config);
  if (config.retry !== undefined) {
    throw new TypeError('retry must be on a reviewed stage or a kickback target');
  }
  return 0;
}

function stageDependencies(stages: readonly NamedStage[], index: number): string[] {
  return index === 0 ? [] : [stages[index - 1]!.name];
}

function panelInput(brief: BriefSource, files: readonly string[], workspace: string): TeamInput {
  return {
    brief: brief.brief,
    workspace,
    files,
    test: brief.test ?? { command: 'true', args: [] },
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

function reviewTarget(named: NamedStage, files: readonly string[]): string {
  const writes = writesOf(named.config);
  return writes.length ? writes.join(', ') : files.join(', ');
}

function reviewerPanel(
  brief: BriefSource,
  named: NamedStage,
  seats: readonly TeamSeat[],
  files: readonly string[],
  target?: string,
  agree?: number,
): Job {
  const definitions = reviewerDefinitions(named, seats);
  return reviewPanel({
    label: named.name,
    pass: agree ?? 'all',
    target,
    reviewers: definitions.map((definition, index) => ({
      name: definition.name,
      scope: definition.scope,
      job: async (ctx) => {
        const reviewer = panelReviewers(
          definitions,
          panelInput(brief, files, ctx.workspace.dir),
          reviewTarget(named, files),
        )[index]!;
        return reviewer.job(ctx);
      },
    })),
  });
}

function briefValue(value: string | BriefSource): BriefSource {
  return typeof value === 'string' ? { brief: text(value, 'brief') } : {
    brief: text(value.brief, 'brief'),
    ...(value.files === undefined ? {} : { files: pathList(value.files, 'files') }),
    ...(value.testFiles === undefined ? {} : {
      testFiles: value.testFiles.length ? pathList(value.testFiles, 'testFiles') : [],
    }),
    ...(value.test === undefined ? {} : { test: commandValue(value.test) }),
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
  value.forEach((seat) => seatIdentity(seat));
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
): Job {
  const writes = writesOf(named.config);
  if (!writes.length) throw new TypeError(`agent stage ${named.name} must declare writes`);
  const target = named.config.sendsBackTo;
  const agent = agentJob({
    label: named.name,
    engine: seat.engine,
    model: seatIdentity(seat).model,
    consumeFeedback: target !== undefined || named.config.reviewedBy !== undefined,
    prompt: agentPrompt(brief, named, files, writes),
    outcome: (textValue) => outcomeFromAgentText(textValue, target),
  });
  return async (ctx) => {
    const required = requireNonEmptyFiles(named.name, agent, ctx.workspace.dir, writes);
    const forbidden = files.filter((file) => !writes.includes(file));
    return requireNoFiles(named.name, required, ctx.workspace.dir, forbidden)(ctx);
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
): Job {
  const config = named.config;
  if ('agent' in config && config.agent !== undefined) {
    const writes = writesOf(config);
    const guarded = guardedAgent(brief, named, seatRole(roles, config.agent), files);
    const job = config.reviewedBy === undefined
      ? guarded
      : unchangedNoteGuard(named.name, guarded, writes);
    if (config.reviewedBy === undefined) return job;
    const panel = reviewerPanel(brief, named, panelRole(roles, config.reviewedBy), files);
    const retry = reviewRetryOf(config);
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
    return commandJob(named.name, config.run, { target: config.sendsBackTo });
  }
  if ('panel' in config && config.panel !== undefined) {
    return reviewerPanel(brief, named, panelRole(roles, config.panel), files, config.sendsBackTo, config.agree);
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
    if (stageConfig.reviewedBy !== undefined && stageConfig.sendsBackTo !== undefined) {
      throw new TypeError(`stage ${stageName} cannot use both reviewedBy and sendsBackTo`);
    }
    retryForStage(stageConfig, incomingTargets.has(stageName));
    writesOf(stageConfig);
  }
  const timeoutMs = duration(config.options?.timeout);
  const maxKickbacks: Record<string, number> = {};
  for (const named of config.stages) {
    if (named.config.sendsBackTo !== undefined) {
      const target = config.stages.find((candidate) => candidate.name === named.config.sendsBackTo)!;
      maxKickbacks[named.config.sendsBackTo] = Math.max(
        maxKickbacks[named.config.sendsBackTo] ?? 0,
        targetRetryOf(target.config),
      );
    }
  }
  const nodes = Object.fromEntries(config.stages.map((named, index) => {
    const files = stageFiles(brief, config.stages, index);
    return [named.name, {
      job: stageJob(brief, named, config.roles, files),
      needs: stageDependencies(config.stages, index),
      ...(named.config.desc === undefined ? {} : { desc: named.config.desc }),
      ...(named.config.gate === undefined ? {} : { gate: named.config.gate }),
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
