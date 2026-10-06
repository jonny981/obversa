import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  approval,
  copyJobMeta,
  createCallbackClient,
  fnJob,
  passed,
  pipeline,
  predicate,
  run,
  type ApprovalOptions,
  type CallbackRequest,
  type CheckRequirement,
  type ConditionResult,
  type Job,
  type JobContext,
  type LoopEvent,
  type Outcome,
  type PipelineStage,
} from '@obversa/runtime';

/** A review, a reviewer, a check, a judge, an approval or a goal check that a run recorded. */
export interface ClimbProtection {
  readonly kind: 'review' | 'reviewer' | 'check' | 'judge' | 'approval' | 'goal check';
  /**
   * Where it ran and what it is called: the full path of the step from the
   * run's record, then its name. An approval is named by the full path of
   * the step that asked it, its gate and the question the run put to a person.
   */
  readonly label: string;
}

/** What one run of one version of the workflow did, read from its record. */
export interface ClimbRun {
  readonly task: string;
  readonly set: 'tuning' | 'heldOut';
  readonly version: 'baseline' | 'candidate';
  /** Which run of this version on this task, from 1. */
  readonly attempt: number;
  readonly status: Outcome['status'];
  /** The run ended `pass`. */
  readonly passed: boolean;
  /** Every requirement of the last goal check met, or true when the run had no goal check. */
  readonly goalMet: boolean;
  /** One, plus one for each time a review, a check or a goal check sent the work back or ran a loop again. */
  readonly rounds: number;
  /** The dollars of the run's engine calls with a figure. */
  readonly usd: number;
  /** The run's engine calls with no cost figure, which `usd` leaves out. */
  readonly unknownCostCalls: number;
  readonly durationMs: number;
  /** Each protection the run recorded, once: the record's in the order they first ran, then the questions it put to a person. */
  readonly protections: readonly ClimbProtection[];
  readonly score: number;
  /** The run's own record. */
  readonly record: string;
  /** The workflow file that ran, with its SHA-256, as its record names it. */
  readonly source: { readonly path: string; readonly sha256: string };
}

/** The means of a set of runs of one version. */
export interface ClimbTotals {
  readonly runs: number;
  /** The share of runs that ended `pass`, 0 to 1. */
  readonly passRate: number;
  readonly meanScore: number;
  readonly meanRounds: number;
  readonly meanUsd: number;
  /** Engine calls with no cost figure, across these runs. */
  readonly unknownCostCalls: number;
  readonly meanDurationMs: number;
}

export interface ClimbTaskReport {
  readonly task: string;
  readonly set: 'tuning' | 'heldOut';
  readonly baseline: ClimbTotals;
  readonly candidate: ClimbTotals;
}

/** What the climb measured and what the numbers say. */
export interface ClimbReport {
  /** The workflow file, relative to its repository. */
  readonly file: string;
  /** The SHA-256 of the committed workflow file the baseline runs used. */
  readonly baselineSha256: string;
  /** The commit every run started from. */
  readonly commit: string;
  readonly tasks: readonly ClimbTaskReport[];
  readonly tuning: { readonly baseline: ClimbTotals; readonly candidate: ClimbTotals };
  readonly heldOut: { readonly baseline: ClimbTotals; readonly candidate: ClimbTotals };
  readonly runs: readonly ClimbRun[];
  /** Set when the budget stopped the climb before every run was done. */
  readonly budgetCut?: string;
  /**
   * Set when the change ran with less protection than the workflow as it is
   * on a task: each protection that fewer candidate runs on `task` recorded
   * than baseline runs on it did. The climb stops there, and such a change
   * is never applied.
   */
  readonly refused?: { readonly task: string; readonly missing: readonly ClimbProtection[] };
  /**
   * Set when a run could not start or end, such as a candidate file that
   * does not load. The climb stops there, keeps the runs it measured, and
   * never keeps the change.
   */
  readonly failed?: {
    readonly task: string;
    readonly set: ClimbRun['set'];
    readonly version: ClimbRun['version'];
    readonly attempt: number;
    readonly error: string;
  };
  /** The directory that holds every run's record. */
  readonly records: string;
  /** Each file the change touches, relative to the repository. */
  readonly files: readonly string[];
  /**
   * Set in `auto` mode when the change touches something the `auto` option
   * does not allow: each file or key outside it, and the rule a value
   * broke. A kept change then goes to a person, as in `attended` mode.
   */
  readonly needsPerson?: readonly string[];
  /** Whether the numbers say keep. A person still decides in `attended` mode, or when `needsPerson` is set. */
  readonly keep: boolean;
  readonly reason: string;
}

/**
 * What a value in the settings file may become: `true` for any value,
 * `{ oneOf }` for one of a list, `{ min, max }` for a number in a range.
 */
export type ClimbSettingRule =
  | true
  | { readonly oneOf: readonly unknown[] }
  | { readonly min?: number; readonly max?: number };

/**
 * What automatic mode may change without a person. Paths are relative to
 * the workflow file's folder. Anything not listed goes to a person, and so
 * does any change to the workflow file itself.
 */
export interface ClimbAuto {
  /** Globs of files the change may edit. `*` matches within one folder, `**` across folders. */
  readonly files?: readonly string[];
  readonly settings?: {
    /** The workflow's JSON settings file. */
    readonly file: string;
    /**
     * Key paths the change may set, each with its rule. Dots go between
     * keys, and `*` stands for one key of any name. A rule checks the whole
     * new value of the key it names: a rule on `prompts` checks the
     * `prompts` object, not each prompt inside it. To check each prompt,
     * name them with `prompts.*`. When several rules match a key, the
     * value each rule names must meet that rule.
     */
    readonly may?: Readonly<Record<string, ClimbSettingRule>>;
    /** Key paths the change may never set, even when a `may` rule matches. */
    readonly never?: readonly string[];
  };
}

export interface ClimbConfig {
  /** The workflow file: an absolute path to a committed file in a git repository. */
  readonly file: string;
  /**
   * The candidate change, as a unified diff against the committed files.
   * It may touch the workflow file and the files beside it, such as its
   * settings file and its briefs.
   */
  readonly change: string;
  /**
   * Turn one version of the workflow file into the job for one task. The
   * climb calls it with the path of the file in each run's own worktree, so
   * the baseline and the candidate are different files. The climb never
   * loads code itself.
   */
  readonly load: (file: string, task: string) => Job | Promise<Job>;
  /** The task inputs, such as brief files. Every task is in one list only. */
  readonly tasks: { readonly tuning: readonly string[]; readonly heldOut: readonly string[] };
  /** Runs of each version on each task. Default 3. */
  readonly runs?: number;
  /** A run's score. Default: 1 when the run passed and met its goal check, else 0. */
  readonly score?: (run: Omit<ClimbRun, 'score'>) => number;
  /**
   * `attended` (default): a person approves a kept change. `auto`: the
   * numbers alone decide for a change inside `auto`, and a person decides
   * for any other.
   */
  readonly mode?: 'attended' | 'auto';
  /**
   * What `auto` mode may change without a person. Without it, `auto` mode
   * allows nothing, so every kept change goes to a person.
   */
  readonly auto?: ClimbAuto;
  /**
   * Answer the approval in process, when a person decides. Without it the
   * climb pauses with the question pending on the run's callbacks client.
   */
  readonly approve?: ApprovalOptions['answer'];
  /** Stop starting runs once this many have run, or once they cost this many dollars. */
  readonly budget?: { readonly runs?: number; readonly usd?: number };
}

const DEFAULT_RUNS = 3;

interface GitResult { readonly code: number; readonly stdout: string; readonly stderr: string }

function git(args: readonly string[], cwd: string, input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // Git can exit before it reads its input; its exit code then says what happened.
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

async function gitOk(args: readonly string[], cwd: string, input?: string): Promise<string> {
  const result = await git(args, cwd, input);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * One, plus one for each send-back the record shows and each round a loop
 * runs again. A loop runs again when its check or its review fails. A loop
 * records a round just before it runs that round's build, so a review or a
 * judge that ends the loop adds no round. Each
 * round after the first counts once for each time its loop starts, because
 * a rate limit makes a loop record the same round again before it runs
 * that round's build again.
 */
function roundsOf(events: readonly LoopEvent[]): number {
  let rounds = 1;
  const reached = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'dag:kickback' && event.accepted) rounds += 1;
    if (event.kind === 'loop:start') reached.set(event.path.join('/'), 1);
    if (event.kind === 'loop:iteration' && event.iteration > (reached.get(event.path.join('/')) ?? 1)) {
      rounds += 1;
      reached.set(event.path.join('/'), event.iteration);
    }
  }
  return rounds;
}

/** Every requirement of the last check of each goal check met; true with none. */
function goalMetOf(events: readonly LoopEvent[]): boolean {
  const last = new Map<string, Extract<LoopEvent, { kind: 'goal:check' }>>();
  for (const event of events) {
    if (event.kind === 'goal:check') last.set(`${event.path.join('/')}\n${event.label}`, event);
  }
  return [...last.values()].every((check) => check.requirements.every((item) => item.verdict === 'met'));
}

/** A name inside the step at `path`, or the bare name at the top of the run. */
const at = (path: readonly string[], name: string) => (path.length === 0 ? name : `${path.join('/')}: ${name}`);

/** A review panel's result names each reviewer that ran, whatever its model. */
function reviewersOf(outcome: Outcome): string[] | undefined {
  const data = outcome.data as { results?: unknown } | null | undefined;
  if (data === null || typeof data !== 'object' || !Array.isArray(data.results)) return undefined;
  const names = data.results.map((result: unknown) => {
    const { kind, name } = (result ?? {}) as { kind?: unknown; name?: unknown };
    return (kind === 'verdict' || kind === 'engine-error') && typeof name === 'string' ? name : undefined;
  });
  return names.every((name) => name !== undefined) ? names as string[] : undefined;
}

/**
 * A check's name, then each command it ran, one name per command, so a
 * check that keeps its name but runs less is another check. A combined
 * check (an array, `all`, `any`, `not`, `quorum`) also says how it requires
 * each command it was built from, also one a round did not reach: a
 * `requires` name for each command whose failure alone fails the check,
 * and, when some command's failure alone does not, one `requires` name for
 * the whole check. A check that is one command requires that command, as
 * `all` of it does. So a change from `all(test, lint)` to `any(test, lint)`,
 * or from `test` to `any(test, always)`, loses the names that require each
 * command, and a change that adds a command to an `all` loses none. A
 * command a check holds and a command it
 * ran are two names, so a check that still holds a command but no longer
 * runs it has lost the one that ran. Each argument with a space in it, or
 * none at all, is quoted, and the run's worktree is written `<worktree>`,
 * because every run has its own.
 */
function checksOf(name: string, result: ConditionResult, worktree: string): string[] {
  const ran = result.commands ?? (result.command === undefined ? [] : [result.command]);
  const requires = result.requires ?? result.command;
  if (ran.length === 0 && requires === undefined) return [name];
  const line = (command: { readonly command: string; readonly args: readonly string[] }) =>
    [command.command, ...command.args]
      .map((part) => part.split(worktree).join('<worktree>'))
      .map((part) => (/^[^\s"]+$/.test(part) ? part : JSON.stringify(part)))
      .join(' ');
  const required: string[] = [];
  let whole = false;
  // Whether a failure of this part alone fails the check, for each command in it.
  const walk = (part: CheckRequirement, alone: boolean): void => {
    if ('command' in part) {
      if (alone) required.push(`${name} requires (${line(part)})`);
      else whole = true;
    } else if ('all' in part) part.all.forEach((one) => walk(one, alone));
    else if ('any' in part) part.any.forEach((one) => walk(one, alone && part.any.length === 1));
    else if ('quorum' in part) part.of.forEach((one) => walk(one, alone && part.quorum === part.of.length));
    else if ('not' in part) walk(part.not, false);
  };
  const written = (part: CheckRequirement): string => {
    if ('command' in part) return `(${line(part)})`;
    if ('all' in part) return `all(${part.all.map(written).join(', ')})`;
    if ('any' in part) return `any(${part.any.map(written).join(', ')})`;
    if ('quorum' in part) return `quorum(${part.quorum}, ${part.of.map(written).join(', ')})`;
    if ('not' in part) return `not(${written(part.not)})`;
    return 'other';
  };
  if (requires !== undefined) walk(requires, true);
  return [...new Set([
    ...ran.map((command) => `${name} (${line(command)})`),
    ...required,
    ...(whole && requires !== undefined ? [`${name} requires ${written(requires)}`] : []),
  ])];
}

/** The protections an event of a run's record shows, named by the full path of the step it ran in. */
function protectionsOf(event: LoopEvent, worktree: string): ClimbProtection[] {
  switch (event.kind) {
    case 'loop:review': return [{ kind: 'review', label: event.path.join('/') }];
    case 'condition:result':
      return checksOf(event.label, event.result, worktree).map((check) => ({ kind: 'check' as const, label: at(event.path, check) }));
    case 'loop:condition':
      return checksOf(event.which, event.result, worktree).map((check) => ({ kind: 'check' as const, label: at(event.path, check) }));
    case 'dag:start': return (event.judged ?? []).map((node) => ({ kind: 'judge' as const, label: at(event.path, node) }));
    case 'goal:check': return [{ kind: 'goal check', label: at(event.path, event.label) }];
    case 'job:end': {
      const reviewers = reviewersOf(event.outcome);
      return [
        ...(event.asked === undefined ? [] : [{ kind: 'approval' as const, label: at(event.path, `${event.asked.gateId}: ${event.asked.question}`) }]),
        ...(reviewers === undefined ? [] : [
          { kind: 'review' as const, label: at(event.path, event.label) },
          ...reviewers.map((name) => ({ kind: 'reviewer' as const, label: at(event.path, `${event.label}/${name}`) })),
        ]),
      ];
    }
    default: return [];
  }
}

/**
 * The protections a question the run put to a person shows, named by the
 * step that asked it, its gate and its question. An approval step names
 * its question in its own `job:end`, so the climb counts it there, once for
 * each step that asked. Any other question names the full path of the
 * asking step in its input. A person's review or input adds a hash of where
 * it ran to its gate, which differs between worktrees, so the hash is left
 * out. A question that asks a person to approve a stage's work or send it
 * back is also that stage's review, as it would be from an agent.
 */
function questionOf(request: CallbackRequest): ClimbProtection[] {
  const name = `${request.gateId.replace(/:[0-9a-f]{64}$/, '')}: ${request.decisionText}`;
  const input = request.input;
  const recorded = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as { requester?: { path?: unknown } }).requester?.path
    : undefined;
  const path = Array.isArray(recorded) && recorded.every((part) => typeof part === 'string') ? recorded : [];
  const required = request.responseSchema.required;
  const review = path.length > 0 && Array.isArray(required) && required.includes('decision');
  return [
    { kind: 'approval', label: at(path, name) },
    ...(review ? [{ kind: 'review' as const, label: path.join('/') }] : []),
  ];
}

const protectionKey = (protection: ClimbProtection) => `${protection.kind}\n${protection.label}`;

/**
 * The protections the change ran without, on the runs of one task: each
 * one that fewer candidate runs recorded than baseline runs did. Both
 * versions have run the same number of times when the climb asks.
 */
function missingOf(runs: readonly ClimbRun[]): ClimbProtection[] {
  const counts = new Map<string, { protection: ClimbProtection; baseline: number; candidate: number }>();
  for (const run of runs) {
    for (const protection of run.protections) {
      const count = counts.get(protectionKey(protection)) ?? { protection, baseline: 0, candidate: 0 };
      count[run.version] += 1;
      counts.set(protectionKey(protection), count);
    }
  }
  return [...counts.values()].filter((count) => count.candidate < count.baseline).map((count) => count.protection);
}

function totalsOf(runs: readonly ClimbRun[]): ClimbTotals {
  const n = runs.length;
  const mean = (pick: (run: ClimbRun) => number) => (n === 0 ? 0 : runs.reduce((sum, run) => sum + pick(run), 0) / n);
  return {
    runs: n,
    passRate: mean((run) => (run.passed ? 1 : 0)),
    meanScore: mean((run) => run.score),
    meanRounds: mean((run) => run.rounds),
    meanUsd: mean((run) => run.usd),
    unknownCostCalls: runs.reduce((sum, run) => sum + run.unknownCostCalls, 0),
    meanDurationMs: mean((run) => run.durationMs),
  };
}

const fixed = (value: number, digits = 2) => value.toFixed(digits);

/**
 * Whether `a` beats `b`: a higher mean score; on the same score, fewer mean
 * rounds; on the same rounds, a lower mean cost when every call of both had
 * a cost figure. Returns the reason in words, or undefined when `a` does
 * not beat `b`.
 */
function beats(a: ClimbTotals, b: ClimbTotals): string | undefined {
  if (a.meanScore !== b.meanScore) {
    return a.meanScore > b.meanScore ? `a mean score of ${fixed(a.meanScore)} against ${fixed(b.meanScore)}` : undefined;
  }
  if (a.meanRounds !== b.meanRounds) {
    return a.meanRounds < b.meanRounds
      ? `the same mean score, ${fixed(a.meanScore)}, in ${fixed(a.meanRounds)} rounds against ${fixed(b.meanRounds)}`
      : undefined;
  }
  if (a.unknownCostCalls === 0 && b.unknownCostCalls === 0 && a.meanUsd < b.meanUsd) {
    return `the same mean score and rounds, at $${fixed(a.meanUsd, 4)} a run against $${fixed(b.meanUsd, 4)}`;
  }
  return undefined;
}

/** The comparison as a person reads it. */
export function formatClimbReport(report: ClimbReport): string {
  const row = (label: string, version: string, totals: ClimbTotals) => [
    label, version, String(totals.runs), `${Math.round(totals.passRate * 100)}%`, fixed(totals.meanScore),
    fixed(totals.meanRounds), `$${fixed(totals.meanUsd, 4)}`, String(totals.unknownCostCalls),
    `${(totals.meanDurationMs / 1000).toFixed(1)}s`,
  ];
  const rows = [
    ['task', 'version', 'runs', 'pass rate', 'mean score', 'mean rounds', 'mean cost', 'calls with no cost', 'mean time'],
    ...report.tasks.flatMap((task) => [
      row(`${task.set === 'tuning' ? 'tuning' : 'held out'}: ${task.task}`, 'baseline', task.baseline),
      row('', 'candidate', task.candidate),
    ]),
    row('all tuning tasks', 'baseline', report.tuning.baseline),
    row('', 'candidate', report.tuning.candidate),
    row('all held-out tasks', 'baseline', report.heldOut.baseline),
    row('', 'candidate', report.heldOut.candidate),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((cells) => cells[column]!.length)));
  const lines = rows.map((cells) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd());
  return [
    `Workflow file: ${report.file}`,
    ...lines,
    ...(report.budgetCut === undefined ? [] : [`Budget: ${report.budgetCut}`]),
    ...(report.needsPerson === undefined ? [] : [
      'A person decides, because automatic mode may not make this change:',
      ...report.needsPerson.map((reason) => `- ${reason}`),
    ]),
    report.refused === undefined ? `The numbers say: ${report.keep ? 'keep' : 'discard'}. ${report.reason}` : `Refused. ${report.reason}`,
    `Records: ${report.records}`,
  ].join('\n');
}

function validate(config: ClimbConfig): void {
  if (typeof config.file !== 'string' || !isAbsolute(config.file)) throw new TypeError('file must be an absolute path');
  if (typeof config.change !== 'string' || config.change.trim() === '') throw new TypeError('change must be a unified diff');
  if (typeof config.load !== 'function') throw new TypeError('load must be a function');
  const { tuning, heldOut } = config.tasks ?? {};
  for (const [name, list] of [['tasks.tuning', tuning], ['tasks.heldOut', heldOut]] as const) {
    if (!Array.isArray(list) || list.length === 0) throw new TypeError(`${name} must list at least one task`);
    if (list.some((task) => typeof task !== 'string' || task === '')) throw new TypeError(`${name} must list non-empty strings`);
  }
  const all = [...tuning, ...heldOut];
  if (new Set(all).size !== all.length) throw new TypeError('each task must appear once, in one list only');
  const runs = config.runs ?? DEFAULT_RUNS;
  if (!Number.isSafeInteger(runs) || runs < 1) throw new TypeError('runs must be a whole number, 1 or more');
  if (config.mode !== undefined && config.mode !== 'attended' && config.mode !== 'auto') throw new TypeError('mode must be attended or auto');
  const budget = config.budget;
  if (budget?.runs !== undefined && (!Number.isSafeInteger(budget.runs) || budget.runs < 1)) {
    throw new TypeError('budget.runs must be a whole number, 1 or more');
  }
  if (budget?.usd !== undefined && !(budget.usd > 0)) throw new TypeError('budget.usd must be more than 0');
  validateAuto(config.auto);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, name: string, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`${name}.${key} is not an option; ${name} takes ${keys.join(', ')}`);
  }
}

function validateKeyPath(name: string, path: unknown): void {
  if (typeof path !== 'string' || path.split('.').some((key) => key === '')) {
    throw new TypeError(`${name} has the key path ${JSON.stringify(path)}, which has an empty key`);
  }
}

function validateAuto(auto: unknown): void {
  if (auto === undefined) return;
  if (!isObject(auto)) throw new TypeError('auto must be an object');
  onlyKeys(auto, 'auto', ['files', 'settings']);
  const { files, settings } = auto;
  if (files !== undefined && (!Array.isArray(files) || files.some((glob) => typeof glob !== 'string' || glob === ''))) {
    throw new TypeError('auto.files must list non-empty globs');
  }
  if (settings === undefined) return;
  if (!isObject(settings)) throw new TypeError('auto.settings must be an object');
  onlyKeys(settings, 'auto.settings', ['file', 'may', 'never']);
  if (typeof settings.file !== 'string' || settings.file === '') throw new TypeError('auto.settings.file must be a path');
  if (settings.may !== undefined) {
    if (!isObject(settings.may)) throw new TypeError('auto.settings.may must be an object');
    for (const [path, rule] of Object.entries(settings.may)) {
      validateKeyPath('auto.settings.may', path);
      const name = `auto.settings.may[${JSON.stringify(path)}]`;
      if (rule === true) continue;
      if (isObject(rule) && Object.keys(rule).length === 1 && 'oneOf' in rule) {
        if (!Array.isArray(rule.oneOf) || rule.oneOf.length === 0) throw new TypeError(`${name}.oneOf must list at least one value`);
        continue;
      }
      if (isObject(rule) && Object.keys(rule).length > 0 && Object.keys(rule).every((key) => key === 'min' || key === 'max')) {
        for (const key of ['min', 'max'] as const) {
          if (rule[key] !== undefined && !Number.isFinite(rule[key])) throw new TypeError(`${name}.${key} must be a number`);
        }
        if (typeof rule.min === 'number' && typeof rule.max === 'number' && rule.min > rule.max) {
          throw new TypeError(`${name}.min, ${rule.min}, is above its max, ${rule.max}`);
        }
        continue;
      }
      throw new TypeError(`${name} must be true, { oneOf: [...] } or { min, max }`);
    }
  }
  if (settings.never !== undefined) {
    if (!Array.isArray(settings.never)) throw new TypeError('auto.settings.never must list key paths');
    for (const path of settings.never) validateKeyPath('auto.settings.never', path);
  }
}

/** Whether a path matches a glob: `*` matches within one folder, `**` across folders. */
export function globMatches(path: string, glob: string): boolean {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    if (glob.startsWith('**/', i)) { source += '(?:[^/]*/)*'; i += 2; }
    else if (glob.startsWith('**', i)) { source += '.*'; i += 1; }
    else if (glob[i] === '*') source += '[^/]*';
    else source += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(path);
}

/**
 * Each key path whose value the change sets. An object, on either side, is
 * compared by its child keys, so an added or removed section reports each
 * key inside it; the path itself is reported too when the other side holds
 * a value that is not an object, or when an object with no keys is added or removed.
 */
function changedKeys(before: unknown, after: unknown, path: readonly string[] = []): string[][] {
  if (isDeepStrictEqual(before, after)) return [];
  const keysOf = (value: unknown) => (isObject(value) ? Object.keys(value) : []);
  const keys = [...new Set([...keysOf(before), ...keysOf(after)])];
  const replaced = keys.length === 0 || [before, after].some((value) => value !== undefined && !isObject(value));
  const child = (value: unknown, key: string) => (isObject(value) ? value[key] : undefined);
  return [
    ...(replaced ? [[...path]] : []),
    ...keys.flatMap((key) => changedKeys(child(before, key), child(after, key), [...path, key])),
  ];
}

/**
 * Whether a key path pattern matches `key` up to the pattern's own length,
 * so a pattern matches a key inside the key it names. When `cover` is set,
 * a key shorter than the pattern matches too, when it starts the pattern.
 */
function keyMatches(pattern: string, key: readonly string[], cover = false): boolean {
  const parts = pattern.split('.');
  if (parts.length > key.length && !cover) return false;
  return parts.slice(0, key.length).every((part, index) => part === '*' || part === key[index]);
}

const valueOf = (settings: unknown, key: readonly string[]) =>
  key.reduce<unknown>((value, part) => (isObject(value) ? value[part] : undefined), settings);

const written = (value: unknown) => (value === undefined ? 'removed' : JSON.stringify(value));

/** Why a settings file change needs a person, one reason for each key outside `may` or inside `never`. */
function settingsReasons(file: string, before: string | undefined, after: string | undefined, settings: NonNullable<ClimbAuto['settings']>): string[] {
  const parse = (text: string | undefined, when: string): { value: unknown } | string => {
    if (text === undefined) return { value: undefined };
    try { return { value: JSON.parse(text) as unknown }; } catch { return `${file} is not JSON ${when} the change`; }
  };
  const old = parse(before, 'before');
  const now = parse(after, 'after');
  if (typeof old === 'string' || typeof now === 'string') return [old, now].filter((one): one is string => typeof one === 'string');
  const nameOf = (key: readonly string[]) => `${file}: ${key.length === 0 ? 'the whole file' : key.join('.')}`;
  const reasons = changedKeys(old.value, now.value).flatMap((key) => {
    const never = (settings.never ?? []).find((path) => keyMatches(path, key, true));
    if (never !== undefined) return [`${nameOf(key)} is under auto.settings.never ${JSON.stringify(never)}`];
    const rules = Object.entries(settings.may ?? {}).filter(([path]) => keyMatches(path, key));
    if (rules.length === 0) return [`${nameOf(key)} is not in auto.settings.may`];
    return rules.flatMap(([path, rule]) => {
      if (rule === true) return [];
      // The rule checks the value of the key it names, at its own depth, and the reason names that key.
      const ruled = key.slice(0, path.split('.').length);
      const name = nameOf(ruled);
      const value = valueOf(now.value, ruled);
      if ('oneOf' in rule) {
        return rule.oneOf.some((one) => isDeepStrictEqual(one, value))
          ? []
          : [`${name} is ${written(value)}, and the rule ${JSON.stringify(path)} allows only ${rule.oneOf.map((one) => JSON.stringify(one)).join(', ')}`];
      }
      const inRange = typeof value === 'number' && (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);
      return inRange
        ? []
        : [`${name} is ${written(value)}, and the rule ${JSON.stringify(path)} allows a number from ${rule.min ?? 'any'} to ${rule.max ?? 'any'}`];
    });
  });
  return [...new Set(reasons)];
}

/**
 * Why the change needs a person in `auto` mode: each file outside
 * `auto.files` and the settings file, the workflow file itself, and each
 * settings key outside the rules. Empty when the change is inside `auto`.
 */
function needsPersonOf(
  auto: ClimbAuto | undefined,
  workflow: string,
  files: readonly string[],
  settings: { readonly before?: string; readonly after?: string },
): string[] {
  if (auto === undefined) return ['there is no auto option, so automatic mode changes nothing without a person'];
  const folder = posix.dirname(workflow);
  const settingsFile = auto.settings === undefined ? undefined : posix.join(folder, auto.settings.file);
  return files.flatMap((file) => {
    if (file === workflow) return [`${file} is the workflow file, which automatic mode never changes`];
    if (file === settingsFile) return settingsReasons(file, settings.before, settings.after, auto.settings!);
    const inFolder = posix.relative(folder, file);
    return !inFolder.startsWith('../') && (auto.files ?? []).some((glob) => globMatches(inFolder, glob))
      ? []
      : [`${file} is not in auto.files`];
  });
}

/**
 * The files the change touches, both sides of a rename, and the settings
 * file before and after it, read in a worktree of their own at `commit`.
 */
async function readChange(
  config: ClimbConfig,
  repo: Repo,
  dir: string,
  commit: string,
): Promise<{ files: string[]; settings: { before?: string; after?: string } }> {
  const worktree = join(dir, 'worktree-change');
  await gitOk(['worktree', 'add', '--detach', worktree, commit], repo.root);
  try {
    const settingsFile = config.auto?.settings === undefined
      ? undefined
      : join(worktree, dirname(repo.file), config.auto.settings.file);
    const read = async () => (settingsFile !== undefined && existsSync(settingsFile) ? readFile(settingsFile, 'utf8') : undefined);
    const before = await read();
    await gitOk(['apply', '--index', '-'], worktree, config.change);
    const files = (await gitOk(['diff', '--cached', '--no-renames', '--name-only', '-z'], worktree)).split('\0').filter((file) => file !== '');
    const after = await read();
    return { files, settings: { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) } };
  } finally {
    await git(['worktree', 'remove', '--force', worktree], repo.root);
  }
}

const defaultScore = (run: Omit<ClimbRun, 'score'>) => (run.passed && run.goalMet ? 1 : 0);

interface Repo { readonly root: string; readonly file: string }

async function repoOf(file: string): Promise<Repo> {
  const real = await realpath(file);
  const root = await realpath((await gitOk(['rev-parse', '--show-toplevel'], dirname(real))).trim());
  return { root, file: relative(root, real) };
}

/** Run one version of the workflow on one task, in a worktree of its own. */
async function runOnce(
  ctx: JobContext,
  config: ClimbConfig,
  repo: Repo,
  dir: string,
  task: string,
  set: ClimbRun['set'],
  version: ClimbRun['version'],
  attempt: number,
  taskNumber: number,
  runNumber: number,
  commit: string,
): Promise<Omit<ClimbRun, 'score'>> {
  const worktree = join(dir, `worktree-${runNumber}`);
  const record = join(dir, `${set === 'tuning' ? 'tuning' : 'held-out'}-${taskNumber}-${version}-${attempt}.jsonl`);
  await gitOk(['worktree', 'add', '--detach', worktree, commit], repo.root);
  try {
    if (version === 'candidate') await gitOk(['apply', '-'], worktree, config.change);
    const file = join(worktree, repo.file);
    const events: LoopEvent[] = [];
    const approvals = new Set<string>();
    const protections = new Map<string, ClimbProtection>();
    const add = (protection: ClimbProtection) => {
      if (!protections.has(protectionKey(protection))) protections.set(protectionKey(protection), protection);
    };
    // Every question the run puts to a person goes through this client.
    const callbacks = createCallbackClient();
    const job = await config.load(file, task);
    await run(job, {
      cwd: worktree,
      recordTo: record,
      source: file,
      signal: ctx.signal,
      callbacks,
      onEvent: (event) => {
        events.push(event);
        if (event.kind === 'job:end' && event.asked !== undefined) approvals.add(event.asked.requestId);
        for (const protection of protectionsOf(event, worktree)) add(protection);
      },
    });
    for (const event of await callbacks.history()) {
      if (event.kind === 'callback-requested' && !approvals.has(event.request.requestId)) {
        for (const protection of questionOf(event.request)) add(protection);
      }
    }
    const start = events.find((event) => event.kind === 'run:start');
    const end = events.find((event) => event.kind === 'run:end');
    const usage = events.flatMap((event) => (event.kind === 'engine:usage' ? [event] : []));
    if (start?.kind !== 'run:start' || end?.kind !== 'run:end' || start.source === undefined) {
      throw new Error(`the run of ${version} on "${task}" left no start or end in its record`);
    }
    return {
      task,
      set,
      version,
      attempt,
      status: end.outcome.status,
      passed: end.outcome.status === 'pass',
      goalMet: goalMetOf(events),
      rounds: roundsOf(events),
      usd: usage.reduce((sum, call) => sum + (call.cost !== undefined && call.cost.kind !== 'unknown' ? call.cost.usd : 0), 0),
      unknownCostCalls: usage.filter((call) => call.cost === undefined || call.cost.kind === 'unknown').length,
      durationMs: end.ts - start.ts,
      protections: [...protections.values()],
      record,
      source: start.source,
    };
  } finally {
    const removed = await git(['worktree', 'remove', '--force', worktree], repo.root);
    if (removed.code !== 0) ctx.log(`could not remove the worktree ${worktree}: ${removed.stderr.trim()}`, 'warn');
  }
}

function decide(
  report: Omit<ClimbReport, 'keep' | 'reason'>,
  unfinished: string | undefined,
): { keep: boolean; reason: string } {
  if (report.refused !== undefined) {
    const missing = report.refused.missing.map(({ kind, label }) => `the ${kind} "${label}"`).join(', ');
    return {
      keep: false,
      reason: `On "${report.refused.task}" the workflow as it is ran ${missing}, and a run of the change ran without ${report.refused.missing.length === 1 ? 'it' : 'them'}, so the change is never applied.`,
    };
  }
  if (unfinished !== undefined) return { keep: false, reason: `The comparison is unfinished: ${unfinished}.` };
  const tuning = beats(report.tuning.candidate, report.tuning.baseline);
  if (tuning === undefined) {
    return {
      keep: false,
      reason: `On the tuning tasks the change does not beat the baseline: a mean score of ${fixed(report.tuning.candidate.meanScore)} against ${fixed(report.tuning.baseline.meanScore)}, in ${fixed(report.tuning.candidate.meanRounds)} rounds against ${fixed(report.tuning.baseline.meanRounds)}.`,
    };
  }
  for (const task of report.tasks) {
    const worse = task.set === 'heldOut' ? beats(task.baseline, task.candidate) : undefined;
    if (worse !== undefined) {
      return {
        keep: false,
        reason: `The change wins on the tuning tasks but does worse on the held-out task "${task.task}": without the change it has ${worse}.`,
      };
    }
  }
  return { keep: true, reason: `On the tuning tasks the change has ${tuning}, and it does no worse on any held-out task.` };
}

async function measure(ctx: JobContext, config: ClimbConfig): Promise<Outcome> {
  const repo = await repoOf(config.file);
  const commit = (await gitOk(['rev-parse', 'HEAD'], repo.root)).trim();
  const dirty = await gitOk(['status', '--porcelain', '--', repo.file], repo.root);
  if (dirty.trim() !== '') {
    throw new Error(`${repo.file} has changes that are not committed; commit them first, so the climb measures the file a kept change is applied to`);
  }
  const committed = await readFile(join(repo.root, repo.file));

  const base = join(repo.root, '.obversa');
  await mkdir(join(base, 'climb'), { recursive: true });
  if (!existsSync(join(base, '.gitignore'))) await writeFile(join(base, '.gitignore'), '*\n');
  const dir = await mkdtemp(join(base, 'climb', 'climb-'));

  // Sort the change before any run: what it touches, and whether automatic mode may make it.
  const change = await readChange(config, repo, dir, commit);
  const touchedDirty = await gitOk(['status', '--porcelain', '--', ...change.files], repo.root);
  if (touchedDirty.trim() !== '') {
    throw new Error(`${touchedDirty.trimEnd().split('\n').map((line) => line.slice(3)).join(', ')} has changes that are not committed; commit them first, so the climb measures the files a kept change is applied to`);
  }
  const needsPerson = config.mode === 'auto' ? needsPersonOf(config.auto, repo.file, change.files, change.settings) : [];
  if (needsPerson.length > 0) ctx.log(`a person decides on a kept change: ${needsPerson.join('; ')}`);

  const tasks = [
    ...config.tasks.tuning.map((task) => ({ task, set: 'tuning' as const })),
    ...config.tasks.heldOut.map((task) => ({ task, set: 'heldOut' as const })),
  ];
  const runsPerTask = config.runs ?? DEFAULT_RUNS;
  const planned = tasks.length * runsPerTask * 2;
  const score = config.score ?? defaultScore;
  const runs: ClimbRun[] = [];
  let usd = 0;
  let budgetCut: string | undefined;
  let unfinished: string | undefined;
  let refused: ClimbReport['refused'];
  let failed: ClimbReport['failed'];

  climb: for (const [index, { task, set }] of tasks.entries()) {
    runs: for (let attempt = 1; attempt <= runsPerTask; attempt += 1) {
      for (const version of ['baseline', 'candidate'] as const) {
        if (config.budget?.runs !== undefined && runs.length >= config.budget.runs) {
          budgetCut = `stopped after ${runs.length} of ${planned} runs: the budget allows ${config.budget.runs} runs`;
        } else if (config.budget?.usd !== undefined && usd >= config.budget.usd) {
          budgetCut = `stopped after ${runs.length} of ${planned} runs: they cost $${fixed(usd, 4)}, and the budget allows $${fixed(config.budget.usd, 4)}`;
        }
        if (budgetCut !== undefined) { unfinished ??= budgetCut; break runs; }
        if (ctx.signal.aborted) { unfinished ??= `the climb was stopped after ${runs.length} of ${planned} runs`; break runs; }
        let facts: Omit<ClimbRun, 'score'>;
        try {
          facts = await runOnce(ctx, config, repo, dir, task, set, version, attempt, index + 1, runs.length + 1, commit);
        } catch (error) {
          failed = { task, set, version, attempt, error: String(error) };
          unfinished ??= `the ${version} run ${attempt} on "${task}" could not run: ${failed.error}`;
          ctx.log(`the ${version} run ${attempt} on "${task}" could not run: ${failed.error}`, 'warn');
          break runs;
        }
        const scored: ClimbRun = { ...facts, score: score(facts) };
        runs.push(scored);
        usd += scored.usd;
        ctx.log(`${version} on "${task}", run ${attempt}: ${scored.status}, score ${scored.score}, ${scored.rounds} round(s), $${fixed(scored.usd, 4)}, record ${scored.record}`);
        // A paused or aborted baseline run still has its candidate run, so the guard can compare the two.
        if (scored.status === 'paused' || scored.status === 'aborted') {
          unfinished ??= `the ${version} run ${attempt} on "${task}" ended ${scored.status}`;
        }
      }
      if (unfinished !== undefined) break runs;
    }
    // A change that ran with less protection than the workflow as it is is never kept, so nothing more needs to run.
    // Only runs of an attempt where both versions ran are compared.
    const ofTask = runs.filter((run) => run.task === task);
    const paired = ofTask.filter((run) => ofTask.some((other) => other.attempt === run.attempt && other.version !== run.version));
    const missing = missingOf(paired);
    if (missing.length > 0) { refused = { task, missing }; break climb; }
    if (unfinished !== undefined) break climb;
  }

  const of = (filter: (run: ClimbRun) => boolean) => totalsOf(runs.filter(filter));
  const measured = {
    file: repo.file,
    baselineSha256: sha256(committed),
    commit,
    tasks: tasks.map(({ task, set }) => ({
      task,
      set,
      baseline: of((run) => run.task === task && run.version === 'baseline'),
      candidate: of((run) => run.task === task && run.version === 'candidate'),
    })),
    tuning: {
      baseline: of((run) => run.set === 'tuning' && run.version === 'baseline'),
      candidate: of((run) => run.set === 'tuning' && run.version === 'candidate'),
    },
    heldOut: {
      baseline: of((run) => run.set === 'heldOut' && run.version === 'baseline'),
      candidate: of((run) => run.set === 'heldOut' && run.version === 'candidate'),
    },
    runs,
    ...(budgetCut === undefined ? {} : { budgetCut }),
    ...(refused === undefined ? {} : { refused }),
    ...(failed === undefined ? {} : { failed }),
    records: dir,
    files: change.files,
    ...(needsPerson.length === 0 ? {} : { needsPerson }),
  };
  const report: ClimbReport = { ...measured, ...decide(measured, unfinished) };
  ctx.log(formatClimbReport(report));
  return {
    status: 'pass',
    summary: `${report.keep ? 'keep' : 'discard'}: ${report.reason}`,
    data: report as unknown as Outcome['data'],
  };
}

const reportOf = (ctx: JobContext): ClimbReport | undefined =>
  ctx.needs?.measure?.data as unknown as ClimbReport | undefined;

/** Apply the kept change and commit the files it touches alone. */
async function apply(ctx: JobContext, config: ClimbConfig): Promise<Outcome> {
  const report = reportOf(ctx)!;
  const repo = await repoOf(config.file);
  const head = (await gitOk(['rev-parse', 'HEAD'], repo.root)).trim();
  if (head !== report.commit) {
    throw new Error(`the repository has new commits since the climb started at ${report.commit}, so the change is not applied`);
  }
  const before = await readFile(join(repo.root, repo.file));
  if (sha256(before) !== report.baselineSha256) {
    throw new Error(`${repo.file} changed after it was measured, so the change is not applied`);
  }
  const dirty = await gitOk(['status', '--porcelain', '--', ...report.files], repo.root);
  if (dirty.trim() !== '') throw new Error(`a file the change touches has changes that are not committed, so the change is not applied`);
  await gitOk(['apply', '--index', '-'], repo.root, config.change);
  const { tuning, heldOut } = report;
  const message = [
    `feat(workflow): improve ${repo.file}, tuning score ${fixed(tuning.baseline.meanScore)} to ${fixed(tuning.candidate.meanScore)}`,
    '',
    report.reason,
    '',
    `Tuning tasks: pass rate ${Math.round(tuning.baseline.passRate * 100)}% to ${Math.round(tuning.candidate.passRate * 100)}%, mean rounds ${fixed(tuning.baseline.meanRounds)} to ${fixed(tuning.candidate.meanRounds)}, ${tuning.candidate.runs} runs of each version.`,
    `Held-out tasks: pass rate ${Math.round(heldOut.baseline.passRate * 100)}% to ${Math.round(heldOut.candidate.passRate * 100)}%, mean score ${fixed(heldOut.baseline.meanScore)} to ${fixed(heldOut.candidate.meanScore)}, ${heldOut.candidate.runs} runs of each version.`,
    `Records: ${report.records}`,
    '',
  ].join('\n');
  const committed = await git(['commit', '-F', '-', '--', ...report.files], repo.root, message);
  if (committed.code !== 0) {
    await gitOk(['apply', '-R', '--index', '-'], repo.root, config.change);
    throw new Error(`the commit of the change failed, so ${report.files.join(', ')} ${report.files.length === 1 ? 'is' : 'are'} put back: ${(committed.stderr || committed.stdout).trim()}`);
  }
  const commit = (await gitOk(['rev-parse', 'HEAD'], repo.root)).trim();
  return { status: 'pass', summary: `committed the change to ${report.files.join(', ')} as ${commit}`, data: { commit } };
}

/**
 * Score a change to a workflow file before keeping it. The workflow runs on
 * each tuning and held-out task, as it is and with the change, `runs` times
 * each, every run in its own worktree with its own record. The change is
 * kept only when it beats the baseline on the tuning tasks, does no worse
 * on any held-out task, and its runs recorded every protection the
 * baseline's runs did. A person then approves it, unless the mode is
 * `auto` and the change is inside the `auto` option. A kept change is
 * committed on its own.
 */
export function climbWorkflow(config: ClimbConfig): Job {
  validate(config);
  const keeps = predicate((ctx) => reportOf(ctx)?.keep === true, 'the numbers say keep');
  const attended = (config.mode ?? 'attended') === 'attended';
  const asks = predicate((ctx) => attended || reportOf(ctx)?.needsPerson !== undefined, 'a person decides');
  // The person sees the comparison and the diff, which exist only once
  // `measure` has run, so the question is built when the step runs.
  const ask = (input?: { comparison: string; change: string }) => approval('approve', {
    question: 'Keep this change to the workflow file?',
    ...(input === undefined ? {} : { input }),
    ...(config.approve === undefined ? {} : { answer: config.approve }),
  });
  const approve: Job = (ctx) => ask({ comparison: formatClimbReport(reportOf(ctx)!), change: config.change })(ctx);
  const stages: PipelineStage[] = [
    { name: 'measure', job: fnJob('measure', (ctx) => measure(ctx, config)) },
    { name: 'approve', job: copyJobMeta(approve, ask()), when: [keeps, asks], optional: true },
    // A skipped approval counts as passed, so a change nobody had to approve applies.
    {
      name: 'apply',
      job: fnJob('apply', (ctx) => apply(ctx, config)),
      needs: ['measure', 'approve'],
      when: [keeps, passed('approve')],
    },
  ];
  return pipeline('climb-workflow', stages);
}
