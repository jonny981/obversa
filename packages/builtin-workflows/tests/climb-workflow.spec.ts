import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentJob,
  all,
  always,
  any,
  approval,
  commandJob,
  commandSucceeds,
  dag,
  fnJob,
  goalCheck,
  judge,
  loop,
  LoopError,
  person,
  pipeline,
  run,
  stage,
  workflow,
  type AgentResult,
  type CallbackRequest,
  type Engine,
  type Job,
  type LoopEvent,
} from '@obversa/runtime';

import { MockEngine } from '@obversa/runtime/testing';

import { globMatches } from '../src/climb-workflow.js';
import { climbWorkflow, formatClimbReport, type ClimbAuto, type ClimbConfig, type ClimbReport } from '../src/index.js';

// Each test makes a git repository and runs the workflow in fresh worktrees, which is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const BASELINE = 'Work out the sum.';
const CANDIDATE = 'Reply with the number only.';
const TUNING = ['2 + 3', '4 + 4'];
const HELD_OUT = ['10 + 7'];

const repos: string[] = [];
afterEach(async () => {
  for (const repo of repos.splice(0)) await rm(repo, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const workflowText = (instructions: string, extra = '') =>
  `export const instructions = '${instructions}';\n${extra}export const team = 'sums';\n`;

/** A repository with the files `before` committed, and the change to the files `after` as a diff. */
async function repoWithFiles(before: Record<string, string>, after: Record<string, string>): Promise<{ root: string; change: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-climb-')));
  repos.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
  };
  await write(before);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the workflow');
  await write(after);
  git(root, 'add', '-A');
  const change = git(root, 'diff', '--cached');
  git(root, 'reset', '-q', '--hard');
  return { root, change };
}

/** A repository with the workflow file committed, and the change as a diff. */
async function repoWith(before: string, after: string): Promise<{ root: string; file: string; change: string }> {
  const { root, change } = await repoWithFiles({ 'team.ts': before }, { 'team.ts': after });
  return { root, file: join(root, 'team.ts'), change };
}

/**
 * Recorded answers: for each version of the instructions, what the stand-in
 * replies to each task, call by call, and what each call costs, when the
 * engine reports a figure.
 */
type Answers = Record<string, { readonly usd?: number; readonly replies: Record<string, readonly string[]> }>;

function standIn(answers: Answers): Engine & { readonly prompts: string[] } {
  const prompts: string[] = [];
  const calls = new Map<string, number>();
  const selection = {
    adapter: 'stand-in', adapterVersion: '1.0.0', provider: 'local', modelFamily: 'stand-in',
    model: 'stand-in', executable: null, capabilities: [],
  } as const;
  return {
    name: 'stand-in',
    prompts,
    async run(request, onEvent): Promise<AgentResult> {
      prompts.push(request.prompt);
      const [instructions = '', task = ''] = request.prompt.split('\n\n');
      const recorded = answers[instructions];
      if (recorded === undefined) throw new Error(`no recorded answers for "${instructions}"`);
      const replies = recorded.replies[task] ?? [];
      const key = `${instructions}\n${task}`;
      const n = (calls.get(key) ?? 0) + 1;
      calls.set(key, n);
      const text = replies[(n - 1) % replies.length] ?? '';
      const usage = { kind: 'reported', inputTokens: 10, outputTokens: 2 } as const;
      const cost = recorded.usd === undefined ? ({ kind: 'unknown' } as const) : ({ kind: 'reported', usd: recorded.usd } as const);
      onEvent({ type: 'usage', usage, model: 'stand-in', cost });
      return { parts: [{ kind: 'assistant', text, final: true }], usage, cost, requested: selection, effective: selection };
    },
  };
}

const sum = (task: string) => task.split('+').reduce((total, part) => total + Number(part), 0);

/** The workflow a version of the file describes: an answer, then a check of it. */
function loader(engine: Engine, loaded: string[] = []): ClimbConfig['load'] {
  return async (file, task) => {
    loaded.push(file);
    const instructions = /instructions = '(.*)'/.exec(await readFile(file, 'utf8'))![1]!;
    return pipeline('sums', [
      { name: 'answer', job: agentJob({ label: 'answer', engine, prompt: `${instructions}\n\n${task}` }) },
      {
        name: 'check',
        job: fnJob('check', (ctx) => {
          const reply = String(ctx.needs?.answer?.data ?? '').trim();
          return reply === String(sum(task))
            ? `${task} = ${reply}`
            : { status: 'fail', summary: `"${reply}" is not ${sum(task)}` };
        }),
      },
    ]);
  };
}

/** Every task answered right, or with the words around the number. */
const right = (tasks: readonly string[]) => Object.fromEntries(tasks.map((task) => [task, [String(sum(task))]]));
const wordy = (tasks: readonly string[]) => Object.fromEntries(tasks.map((task) => [task, [`The sum is ${sum(task)}.`]]));

async function climb(config: ClimbConfig, recordTo?: string) {
  const result = await run(climbWorkflow(config), recordTo === undefined ? {} : { recordTo });
  const data = result.outcome.data as Record<string, { status: string; data?: unknown }>;
  return { result, report: data.measure!.data as ClimbReport, data };
}

/** This repository's own commit message rule, as its commit-msg hook runs it. */
const COMMIT_POLICY = fileURLToPath(new URL('../../../scripts/check-commit-policy.mjs', import.meta.url));

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const commits = (root: string) => git(root, 'rev-list', '--count', 'HEAD').trim();

describe('climbWorkflow', () => {
  it('keeps a candidate that passes more tasks, commits it alone, and records every run and the decision', async () => {
    const before = workflowText(BASELINE);
    const after = workflowText(CANDIDATE);
    const { root, file, change } = await repoWith(before, after);
    await writeFile(join(root, 'notes.md'), 'a file the person is still writing\n');
    const hook = join(root, '.git', 'hooks', 'commit-msg');
    await writeFile(hook, `#!/bin/sh\nexec node ${JSON.stringify(COMMIT_POLICY)} --message "$1"\n`);
    await chmod(hook, 0o755);
    const engine = standIn({
      [BASELINE]: { usd: 0.01, replies: wordy([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0.01, replies: right([...TUNING, ...HELD_OUT]) },
    });
    const loaded: string[] = [];
    const record = join(root, 'climb.jsonl');
    const { result, report, data } = await climb({
      file, change, load: loader(engine, loaded), tasks: { tuning: TUNING, heldOut: HELD_OUT }, approve: () => ({ approved: true }),
    }, record);

    expect(result.outcome.status).toBe('pass');
    expect(report.keep).toBe(true);
    expect(report.runs).toHaveLength(3 * 3 * 2);
    expect(report.tuning.baseline).toMatchObject({ runs: 6, passRate: 0, meanScore: 0, meanRounds: 1 });
    expect(report.tuning.candidate).toMatchObject({ runs: 6, passRate: 1, meanScore: 1, meanRounds: 1, unknownCostCalls: 0 });
    expect(report.tuning.candidate.meanUsd).toBeCloseTo(0.01);
    expect(report.heldOut.candidate.passRate).toBe(1);

    // Each run ran its own copy of the file, and its record names that version.
    expect(new Set(loaded).size).toBe(18);
    for (const one of report.runs) {
      expect(existsSync(one.record)).toBe(true);
      expect(one.source.sha256).toBe(sha256(one.version === 'baseline' ? before : after));
      const start = JSON.parse((await readFile(one.record, 'utf8')).split('\n')[0]!) as LoopEvent;
      expect(start).toMatchObject({ kind: 'run:start', source: one.source });
    }
    expect(existsSync(join(root, '.obversa', 'climb'))).toBe(true);
    expect(git(root, 'worktree', 'list').trim().split('\n')).toHaveLength(1);

    // The change is one commit that touches the workflow file alone.
    expect(await readFile(file, 'utf8')).toBe(after);
    expect(commits(root)).toBe('2');
    expect(git(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('team.ts');
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('feat(workflow): improve team.ts, tuning score 0.00 to 1.00');
    expect(git(root, 'status', '--porcelain')).toBe('?? climb.jsonl\n?? notes.md\n');
    expect(data.apply).toMatchObject({ status: 'pass', data: { commit: git(root, 'rev-parse', 'HEAD').trim() } });

    // The climb's own record holds every run and the decision.
    const events = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as LoopEvent);
    const measured = events.find((event) => event.kind === 'dag:node' && event.node === 'measure' && event.phase === 'done');
    const recorded = (measured as Extract<LoopEvent, { kind: 'dag:node' }>).outcome!.data as unknown as ClimbReport;
    expect(recorded.runs.map((one) => one.record)).toEqual(report.runs.map((one) => one.record));
    expect(recorded.keep).toBe(true);
    expect(events.some((event) => event.kind === 'log' && event.message.includes('The numbers say: keep.'))).toBe(true);
  });

  it('discards a candidate that ties on the tuning tasks and loses a held-out task', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0.01, replies: right([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0.01, replies: { ...right(TUNING), ...wordy(HELD_OUT) } },
    });
    const { report } = await climb({
      file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 2, mode: 'auto',
    });

    expect(report.keep).toBe(false);
    expect(report.tuning.candidate.meanScore).toBe(report.tuning.baseline.meanScore);
    expect(report.heldOut.candidate.meanScore).toBeLessThan(report.heldOut.baseline.meanScore);
    expect(report.reason).toContain('does not beat the baseline');
    expect(commits(root)).toBe('1');
    expect(await readFile(file, 'utf8')).toBe(workflowText(BASELINE));
  });

  it('discards a candidate that wins the tuning tasks but loses a held-out task', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0.01, replies: { ...wordy(TUNING), ...right(HELD_OUT) } },
      [CANDIDATE]: { usd: 0.01, replies: { ...right(TUNING), ...wordy(HELD_OUT) } },
    });
    const { report } = await climb({
      file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 2, mode: 'auto',
    });

    expect(report.tuning.candidate.meanScore).toBeGreaterThan(report.tuning.baseline.meanScore);
    expect(report.keep).toBe(false);
    expect(report.reason).toContain('does worse on the held-out task "10 + 7"');
    expect(commits(root)).toBe('1');
  });

  it('discards a candidate that wins the tuning tasks but costs more on a held-out task', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0.01, replies: { ...wordy(TUNING), ...right(HELD_OUT) } },
      [CANDIDATE]: { usd: 0.05, replies: right([...TUNING, ...HELD_OUT]) },
    });
    const { report } = await climb({
      file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 2, mode: 'auto',
    });

    expect(report.tuning.candidate.meanScore).toBeGreaterThan(report.tuning.baseline.meanScore);
    expect(report.heldOut.candidate).toMatchObject({ meanScore: report.heldOut.baseline.meanScore, meanRounds: report.heldOut.baseline.meanRounds });
    expect(report.keep).toBe(false);
    expect(report.reason).toContain('does worse on the held-out task "10 + 7"');
    expect(report.reason).toContain('at $0.0100 a run against $0.0500');
    expect(commits(root)).toBe('1');
  });

  it('discards a candidate that wins the tuning tasks but takes more rounds on a held-out task', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const load: ClimbConfig['load'] = async (path, task): Promise<Job> => {
      const candidate = (await readFile(path, 'utf8')).includes(CANDIDATE);
      let answers = 0;
      return pipeline('rounds', [
        { name: 'answer', job: fnJob('answer', () => { answers += 1; }) },
        {
          name: 'check',
          acceptsKickbackTo: ['answer'],
          job: fnJob('check', () => {
            if (TUNING.includes(task)) return candidate ? 'right' : { status: 'fail', summary: 'wrong' };
            if (candidate && answers === 1) return { status: 'fail', summary: 'once more', revision: { target: 'answer', reason: 'once more' } };
            return 'right';
          }),
        },
      ], { maxKickbacks: 1 });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, mode: 'auto' });

    expect(report.tuning.candidate.meanScore).toBeGreaterThan(report.tuning.baseline.meanScore);
    expect(report.heldOut.candidate).toMatchObject({ meanScore: 1, meanRounds: 2 });
    expect(report.heldOut.baseline).toMatchObject({ meanScore: 1, meanRounds: 1 });
    expect(report.keep).toBe(false);
    expect(report.reason).toContain('does worse on the held-out task "10 + 7"');
    expect(commits(root)).toBe('1');
  });

  it('discards a cheaper candidate that passes less often', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0.05, replies: right([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0.01, replies: { '2 + 3': ['5', 'five'], '4 + 4': ['8'], ...right(HELD_OUT) } },
    });
    const { report } = await climb({
      file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 2, mode: 'auto',
    });

    expect(report.tuning.candidate.meanUsd).toBeLessThan(report.tuning.baseline.meanUsd);
    expect(report.tuning.candidate.passRate).toBe(0.75);
    expect(report.keep).toBe(false);
    expect(commits(root)).toBe('1');
  });

  it('keeps a cheaper candidate that passes as often, when every call has a cost', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0.05, replies: right([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0.01, replies: right([...TUNING, ...HELD_OUT]) },
    });
    const { report } = await climb({
      file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, approve: () => ({ approved: true }),
    });

    expect(report.keep).toBe(true);
    expect(report.reason).toContain('at $0.0100 a run against $0.0500');
    expect(commits(root)).toBe('2');
  });

  it('counts the calls with no cost figure, and never keeps a change on cost when one is missing', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0.05, replies: right([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { replies: right([...TUNING, ...HELD_OUT]) },
    });
    const { report } = await climb({
      file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, mode: 'auto',
    });

    expect(report.tuning.baseline).toMatchObject({ meanUsd: 0.05, unknownCostCalls: 0 });
    expect(report.tuning.candidate).toMatchObject({ meanUsd: 0, unknownCostCalls: 2 });
    expect(report.keep).toBe(false);
    expect(commits(root)).toBe('1');
  });

  describe('the auto option', () => {
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    const SETTINGS = { builder: { model: 'model-a', effort: 'low', timeLimitMinutes: 30 }, reviewer: { model: 'model-b' }, maxRounds: 3 };
    /** A workflow folder: the workflow file, its settings file and the brief its answer step reads. */
    const FOLDER: Record<string, string> = {
      'flows/team.ts': workflowText(BASELINE),
      'flows/settings.json': json(SETTINGS),
      'flows/briefs/answer.md': 'Work out the sum.\n',
    };
    const AUTO: ClimbAuto = {
      files: ['briefs/*.md'],
      settings: {
        file: 'settings.json',
        may: { 'builder.effort': { oneOf: ['medium', 'high'] }, '*.timeLimitMinutes': { min: 10, max: 90 }, '*.model': true },
        never: ['reviewer'],
      },
    };
    const settingsWith = (change: (settings: Record<string, any>) => void) => {
      const settings: Record<string, any> = structuredClone(SETTINGS);
      change(settings);
      return json(settings);
    };

    /** The workflow the folder describes: its answer is the number alone when any file of the folder differs from the committed one. */
    const load: ClimbConfig['load'] = async (file, task) => {
      const folder = dirname(dirname(file));
      const changed = (await Promise.all(Object.entries(FOLDER).map(async ([path, text]) => (await readFile(join(folder, path), 'utf8')) !== text)))
        .some(Boolean);
      const engine = new MockEngine(() => (changed ? String(sum(task)) : `The sum is ${sum(task)}.`));
      return pipeline('sums', [
        { name: 'answer', job: agentJob({ label: 'answer', engine, prompt: task }) },
        {
          name: 'check',
          job: fnJob('check', (ctx) => (String(ctx.needs?.answer?.data ?? '').trim() === String(sum(task))
            ? 'right'
            : { status: 'fail', summary: 'not the number' })),
        },
      ]);
    };

    /** Climb in auto mode with the folder changed to `after`; a person who is asked says no. */
    async function climbFolder(after: Record<string, string>, auto: ClimbAuto | undefined) {
      const { root, change } = await repoWithFiles(FOLDER, { ...FOLDER, ...after });
      const asked: CallbackRequest[] = [];
      const { report, data } = await climb({
        file: join(root, 'flows', 'team.ts'), change, load, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, mode: 'auto',
        ...(auto === undefined ? {} : { auto }),
        approve: (request) => { asked.push(request); return { approved: false }; },
      });
      expect(report.keep).toBe(true);
      return { root, report, data, asked };
    }

    it('applies a change to a brief inside auto.files without asking', async () => {
      const { root, report, data, asked } = await climbFolder({ 'flows/briefs/answer.md': 'Reply with the number only.\n' }, AUTO);

      expect(report.files).toEqual(['flows/briefs/answer.md']);
      expect(report.needsPerson).toBeUndefined();
      expect(asked).toEqual([]);
      expect(data.approve).toMatchObject({ status: 'pass', data: { skipped: true } });
      expect(commits(root)).toBe('2');
      expect(git(root, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('flows/briefs/answer.md');
    });

    it('applies a settings change to a value its rule allows without asking', async () => {
      const { root, report, asked } = await climbFolder({ 'flows/settings.json': settingsWith((settings) => { settings.builder.effort = 'high'; }) }, AUTO);

      expect(report.needsPerson).toBeUndefined();
      expect(asked).toEqual([]);
      expect(commits(root)).toBe('2');
      expect(JSON.parse(await readFile(join(root, 'flows', 'settings.json'), 'utf8'))).toMatchObject({ builder: { effort: 'high' } });
    });

    it('applies a new settings section without asking when its rules allow each key inside it', async () => {
      const auto: ClimbAuto = { settings: { file: 'settings.json', may: { 'planner.effort': { oneOf: ['medium', 'high'] } } } };
      const { root, report, asked } = await climbFolder({ 'flows/settings.json': settingsWith((settings) => { settings.planner = { effort: 'high' }; }) }, auto);

      expect(report.needsPerson).toBeUndefined();
      expect(asked).toEqual([]);
      expect(commits(root)).toBe('2');
    });

    it('counts a settings file reformatted with no value changed as no settings change', async () => {
      const { root, report, asked } = await climbFolder({ 'flows/settings.json': `${JSON.stringify(SETTINGS)}\n` }, AUTO);

      expect(report.files).toEqual(['flows/settings.json']);
      expect(report.needsPerson).toBeUndefined();
      expect(asked).toEqual([]);
      expect(commits(root)).toBe('2');
    });

    it.each([
      [
        'an effort outside its oneOf',
        { 'flows/settings.json': settingsWith((settings) => { settings.builder.effort = 'max'; }) },
        AUTO,
        ['flows/settings.json: builder.effort is "max", and the rule "builder.effort" allows only "medium", "high"'],
      ],
      [
        'a number above its max',
        { 'flows/settings.json': settingsWith((settings) => { settings.builder.timeLimitMinutes = 120; }) },
        AUTO,
        ['flows/settings.json: builder.timeLimitMinutes is 120, and the rule "*.timeLimitMinutes" allows a number from 10 to 90'],
      ],
      [
        'a key a may wildcard matches and never names',
        { 'flows/settings.json': settingsWith((settings) => { settings.reviewer.model = 'model-a'; }) },
        AUTO,
        ['flows/settings.json: reviewer.model is under auto.settings.never "reviewer"'],
      ],
      [
        'a key added and a key removed',
        { 'flows/settings.json': settingsWith((settings) => { settings.builder.extra = 1; delete settings.maxRounds; }) },
        AUTO,
        ['flows/settings.json: builder.extra is not in auto.settings.may', 'flows/settings.json: maxRounds is not in auto.settings.may'],
      ],
      [
        'a key inside a new settings section that breaks its rule, though a rule allows the section',
        { 'flows/settings.json': settingsWith((settings) => { settings.planner = { effort: 'max' }; }) },
        { settings: { file: 'settings.json', may: { planner: true, 'planner.effort': { oneOf: ['medium', 'high'] } } } },
        ['flows/settings.json: planner.effort is "max", and the rule "planner.effort" allows only "medium", "high"'],
      ],
      [
        'a key a wildcard rule matches that breaks the rule',
        { 'flows/settings.json': settingsWith((settings) => { settings.planner = { effort: 'max' }; }) },
        { settings: { file: 'settings.json', may: { 'planner.*': { oneOf: ['medium', 'high'] } } } },
        ['flows/settings.json: planner.effort is "max", and the rule "planner.*" allows only "medium", "high"'],
      ],
      [
        'a number a wildcard rule matches that is above its max',
        { 'flows/settings.json': settingsWith((settings) => { settings.planner = { timeLimitMinutes: 120 }; }) },
        { settings: { file: 'settings.json', may: { 'planner.*': true, 'planner.timeLimitMinutes': { min: 10, max: 90 } } } },
        ['flows/settings.json: planner.timeLimitMinutes is 120, and the rule "planner.timeLimitMinutes" allows a number from 10 to 90'],
      ],
      [
        'keys inside the key a rule names, once, by the key the rule names',
        { 'flows/settings.json': settingsWith((settings) => { settings.planner = { effort: { level: 'high', note: 'x' } }; }) },
        { settings: { file: 'settings.json', may: { 'planner.*': { oneOf: ['medium', 'high'] } } } },
        ['flows/settings.json: planner.effort is {"level":"high","note":"x"}, and the rule "planner.*" allows only "medium", "high"'],
      ],
      [
        'the workflow file, though a glob matches it',
        { 'flows/team.ts': workflowText(CANDIDATE) },
        { ...AUTO, files: ['*.ts', 'briefs/*.md'] },
        ['flows/team.ts is the workflow file, which automatic mode never changes'],
      ],
      [
        'a brief, when there is no auto option',
        { 'flows/briefs/answer.md': 'Reply with the number only.\n' },
        undefined,
        ['there is no auto option, so automatic mode changes nothing without a person'],
      ],
    ] as const)('asks a person about %s, with the reason', async (_, after, auto, reasons) => {
      const { root, report, data, asked } = await climbFolder(after, auto);

      expect(report.needsPerson).toEqual(reasons);
      expect(asked).toHaveLength(1);
      const comparison = (asked[0]!.input as { comparison: string }).comparison;
      for (const reason of reasons) expect(comparison).toContain(`- ${reason}`);
      expect(data.approve!.status).toBe('fail');
      expect(commits(root)).toBe('1');
    });

    it('pauses when nobody answers, as an attended climb does', async () => {
      const { root, change } = await repoWithFiles(FOLDER, { ...FOLDER, 'flows/team.ts': workflowText(CANDIDATE) });
      const { result, report } = await climb({
        file: join(root, 'flows', 'team.ts'), change, load, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, mode: 'auto', auto: AUTO,
      });

      expect(report.needsPerson).toEqual(['flows/team.ts is the workflow file, which automatic mode never changes']);
      expect(result.outcome.status).toBe('paused');
      expect(commits(root)).toBe('1');
    });

    it.each([
      [{ files: 'briefs/*.md' }, 'auto.files must list non-empty globs'],
      [{ allow: ['briefs/*.md'] }, 'auto.allow is not an option'],
      [{ settings: { file: 'settings.json', allow: {} } }, 'auto.settings.allow is not an option'],
      [{ settings: { file: 'settings.json', may: { 'builder.effort': { oneOf: [] } } } }, 'auto.settings.may["builder.effort"].oneOf must list at least one value'],
      [{ settings: { file: 'settings.json', may: { maxRounds: { min: 6, max: 2 } } } }, 'auto.settings.may["maxRounds"].min, 6, is above its max, 2'],
      [{ settings: { file: 'settings.json', may: { maxRounds: { between: [2, 6] } } } }, 'auto.settings.may["maxRounds"] must be true, { oneOf: [...] } or { min, max }'],
      [{ settings: { file: 'settings.json', may: { 'builder..effort': true } } }, 'auto.settings.may has the key path "builder..effort", which has an empty key'],
      [{ settings: { file: 'settings.json', never: ['reviewer.'] } }, 'auto.settings.never has the key path "reviewer.", which has an empty key'],
    ])('refuses the malformed auto option %j, naming the key', (auto, message) => {
      expect(() => climbWorkflow({
        file: '/repo/team.ts', change: 'diff', load: () => fnJob('x', () => undefined), tasks: { tuning: TUNING, heldOut: HELD_OUT },
        mode: 'auto', auto: auto as unknown as ClimbAuto,
      })).toThrow(message);
    });

    it('matches a glob: * within one folder, ** across folders', () => {
      expect(globMatches('briefs/a.md', 'briefs/*.md')).toBe(true);
      expect(globMatches('briefs/x/a.md', 'briefs/*.md')).toBe(false);
      expect(globMatches('briefs/x/a.md', 'briefs/**/*.md')).toBe(true);
      expect(globMatches('briefs/a.md', 'briefs/**/*.md')).toBe(true);
      expect(globMatches('briefs/a.mdx', 'briefs/*.md')).toBe(false);
      expect(globMatches('notesXmd', 'notes.md')).toBe(false);
      expect(globMatches('a.md', 'a.md')).toBe(true);
      expect(globMatches('a/b/c', '**')).toBe(true);
    });
  });

  it('asks a person in attended mode, with the comparison and the diff, and applies only on a yes', async () => {
    for (const approved of [false, true]) {
      const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
      const engine = standIn({
        [BASELINE]: { usd: 0, replies: wordy([...TUNING, ...HELD_OUT]) },
        [CANDIDATE]: { usd: 0, replies: right([...TUNING, ...HELD_OUT]) },
      });
      const asked: CallbackRequest[] = [];
      const { result, data } = await climb({
        file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1,
        approve: (request) => { asked.push(request); return approved ? { approved } : { approved, note: 'not yet' }; },
      });

      expect(asked).toHaveLength(1);
      expect(asked[0]!.decisionText).toBe('Keep this change to the workflow file?');
      const input = asked[0]!.input as { comparison: string; change: string };
      expect(input.change).toBe(change);
      expect(input.comparison).toContain('all tuning tasks');
      expect(input.comparison).toContain('The numbers say: keep.');
      expect(result.outcome.status).toBe('pass');
      expect(data.approve!.status).toBe(approved ? 'pass' : 'fail');
      expect(commits(root)).toBe(approved ? '2' : '1');
    }
  });

  it('pauses in attended mode when nobody answers, and changes nothing', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0, replies: wordy([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0, replies: right([...TUNING, ...HELD_OUT]) },
    });
    const { result } = await climb({ file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1 });

    expect(result.outcome.status).toBe('paused');
    expect(commits(root)).toBe('1');
    expect(await readFile(file, 'utf8')).toBe(workflowText(BASELINE));
  });

  it('never keeps a change when the budget cuts the climb short', async () => {
    for (const budget of [{ runs: 4 }, { usd: 0.03 }]) {
      const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
      const engine = standIn({
        [BASELINE]: { usd: 0.01, replies: wordy([...TUNING, ...HELD_OUT]) },
        [CANDIDATE]: { usd: 0.01, replies: right([...TUNING, ...HELD_OUT]) },
      });
      const { report, data } = await climb({
        file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 2, mode: 'auto', budget,
      });

      // The candidate was winning every run it had: only the cut stops it.
      expect(report.tuning.candidate.meanScore).toBeGreaterThan(report.tuning.baseline.meanScore);
      expect(report.runs).toHaveLength(budget.runs ?? 3);
      expect(report.budgetCut).toContain(`stopped after ${report.runs.length} of 12 runs`);
      expect(report.keep).toBe(false);
      expect(report.reason).toContain('unfinished');
      expect(data.apply!.status).toBe('pass');
      expect(commits(root)).toBe('1');
    }
  });

  describe('the guard', () => {
    const seat = (model: string, tools: string[], reply: (cwd: string) => unknown) => ({
      engine: new MockEngine((request) => JSON.stringify(reply(request.cwd!))),
      identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools },
    });
    const answer = fnJob('answer', () => 'done');
    /** The node that runs the check commands, which a check's label names. */
    const NODE = process.execPath;
    // Each protection fails or is unmet, so the workflow scores better without it.
    const protections = {
      test: commandJob('test', [process.execPath, '-e', 'process.exit(1)']),
      signOff: approval('sign-off', { question: 'Ship it?', answer: () => ({ approved: false }) }),
      goal: fnJob('goal', (ctx) => {
        ctx.emit({
          kind: 'goal:check', ts: Date.now(), path: [...ctx.path], label: 'goal', round: 1,
          requirements: [{ requirement: 'The sum is right', verdict: 'unmet', evidence: 'answer' }],
        });
        return 'checked';
      }),
    };

    /**
     * The climb never loads code, and neither does this loader: it reads
     * which version of the file it was given and builds the job that
     * version describes.
     */
    const versions = (after: string, build: (candidate: boolean) => Job): ClimbConfig['load'] =>
      async (file) => build((await readFile(file, 'utf8')) === after);

    const climbIn = (file: string, change: string, load: ClimbConfig['load']) =>
      climb({ file, change, load, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, mode: 'auto' });

    it('refuses a candidate that swaps an imported reviewer for no reviewer, though it scores better', async () => {
      const team = (name: string) => [
        `import { ${name} as audit } from './reviewers.mjs';`,
        '',
        "export default (kit) => kit.loop({ name: 'answer', body: kit.answer, until: kit.always, max: 2, review: audit(kit) });",
        '',
      ].join('\n');
      const { root, file, change } = await repoWith(team('reviewer'), team('none'));
      const review = fnJob('review', () => ({ status: 'fail', summary: 'the answer is wrong' }));
      const { report } = await climbIn(file, change, versions(team('none'), (candidate) =>
        loop({ name: 'answer', body: answer, until: always, max: 2, ...(candidate ? {} : { review }) })));

      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'review', label: 'answer' }] });
      expect(report.reason).toContain('review "answer"');
      expect(report.runs.find((one) => one.version === 'baseline')!.protections).toEqual([
        { kind: 'check', label: 'answer: until' }, { kind: 'review', label: 'answer' },
      ]);
      expect(report.runs.find((one) => one.version === 'candidate')!.protections).toEqual([{ kind: 'check', label: 'answer: until' }]);
      // The climb stops at the first task that shows the loss.
      expect(report.runs).toHaveLength(2);
      expect(commits(root)).toBe('1');
    });

    /** A pipeline whose steps are declared on their own, with one line before the return. */
    const steps = (step: string, before = '') => [
      'export default (kit) => {',
      '  const steps = [',
      "    { name: 'answer', job: kit.answer },",
      `    { name: 'last', job: kit.${step} },`,
      '  ];',
      `${before}  return kit.pipeline('sums', steps);`,
      '};',
      '',
    ].join('\n');

    it.each([
      ['a check command', 'test', [{ kind: 'check', label: `sums/last: test (${NODE} -e process.exit(1))` }, { kind: 'check', label: `sums/last: test requires (${NODE} -e process.exit(1))` }]],
      ['an approval', 'signOff', [{ kind: 'approval', label: 'sums/last: sign-off: Ship it?' }]],
      ['a goal check', 'goal', [{ kind: 'goal check', label: 'sums/last: goal' }]],
    ] as const)('refuses a candidate that drops %s through steps.pop(), though it scores better', async (_, step, missing) => {
      const after = steps(step, '  steps.pop();\n');
      const { root, file, change } = await repoWith(steps(step), after);
      const { report } = await climbIn(file, change, versions(after, (candidate) =>
        pipeline('sums', [{ name: 'answer', job: answer }, ...(candidate ? [] : [{ name: 'last', job: protections[step] }])])));

      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing });
      const ran = missing.map(({ kind, label }) => `the ${kind} "${label}"`).join(', ');
      expect(formatClimbReport(report)).toContain(
        `Refused. On "2 + 3" the workflow as it is ran ${ran}, and a run of the change ran without ${missing.length === 1 ? 'it' : 'them'}, so the change is never applied.`,
      );
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that keeps the check\'s label but runs a smaller command, though it scores better', async () => {
      const text = (suite: string) => `export const test = ['node', '--test', ${suite}];\n`;
      const { root, file, change } = await repoWith(text("'a.test.mjs', 'b.test.mjs'"), text("'a.test.mjs'"));
      const smaller = commandJob('test', [process.execPath, '-e', 'process.exit(0)']);
      const { report } = await climbIn(file, change, versions(text("'a.test.mjs'"), (candidate) =>
        pipeline('sums', [{ name: 'answer', job: answer }, { name: 'last', job: candidate ? smaller : protections.test }])));

      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'check', label: `sums/last: test (${NODE} -e process.exit(1))` }, { kind: 'check', label: `sums/last: test requires (${NODE} -e process.exit(1))` }] });
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that keeps a loop\'s checks but swaps the command among them, though it scores better', async () => {
      const text = (code: string) => `export const until = [['node', '-e', '${code}'], 'always'];\n`;
      const { root, file, change } = await repoWith(text('process.exit(1)'), text(''));
      const { report } = await climbIn(file, change, versions(text(''), (candidate) => loop({
        name: 'answer', body: answer, max: 2,
        until: [commandSucceeds(process.execPath, ['-e', candidate ? '' : 'process.exit(1)']), always],
      })));

      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [
        { kind: 'check', label: `answer: until (${NODE} -e process.exit(1))` },
        { kind: 'check', label: `answer: until requires (${NODE} -e process.exit(1))` },
      ] });
      expect(report.runs.find((one) => one.version === 'candidate')!.protections).toEqual([
        { kind: 'check', label: `answer: until (${NODE} -e "")` },
        { kind: 'check', label: `answer: until requires (${NODE} -e "")` },
      ]);
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that swaps a loop\'s check command the baseline never reached', async () => {
      const text = (code: string) => `export const until = [['node', '-e', 'process.exit(1)'], ${code}];\n`;
      const { root, file, change } = await repoWith(text("['node', '-e', 'process.exit(2)']"), text("'always'"));
      const { report } = await climbIn(file, change, versions(text("'always'"), (candidate) => loop({
        name: 'answer', body: answer, max: 2,
        until: [commandSucceeds(process.execPath, ['-e', 'process.exit(1)']), candidate ? always : commandSucceeds(process.execPath, ['-e', 'process.exit(2)'])],
      })));

      // The first command fails every round, so no baseline run ran the second.
      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'check', label: `answer: until requires (${NODE} -e process.exit(2))` }] });
      expect(report.keep).toBe(false);
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate whose check still holds the command but no longer runs it, though it scores better', async () => {
      const text = (combine: string) => `export const until = ${combine};\n`;
      const { root, file, change } = await repoWith(text("all(['node', '-e', 'process.exit(1)'])"), text("any('always', ['node', '-e', 'process.exit(1)'])"));
      const check = commandSucceeds(process.execPath, ['-e', 'process.exit(1)']);
      const { report } = await climbIn(file, change, versions(text("any('always', ['node', '-e', 'process.exit(1)'])"), (candidate) => loop({
        name: 'answer', body: answer, max: 2, until: candidate ? any(always, check) : all(check),
      })));

      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [
        { kind: 'check', label: `answer: until (${NODE} -e process.exit(1))` },
        { kind: 'check', label: `answer: until requires (${NODE} -e process.exit(1))` },
      ] });
      expect(report.runs.find((one) => one.version === 'candidate')!.protections).toEqual([
        { kind: 'check', label: `answer: until requires any(other, (${NODE} -e process.exit(1)))` },
      ]);
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that turns all(test, lint) into any(test, lint), though it runs both and scores better', async () => {
      const text = (combine: string) => `export const until = ${combine}(['node', '-e', 'process.exit(1)'], ['node', '-e', '']);\n`;
      const { root, file, change } = await repoWith(text('all'), text('any'));
      // The test fails and the lint passes, so `any` accepts the failed test.
      const test = commandSucceeds(process.execPath, ['-e', 'process.exit(1)']);
      const lint = commandSucceeds(process.execPath, ['-e', '']);
      const { report } = await climbIn(file, change, versions(text('any'), (candidate) => loop({
        name: 'answer', body: answer, max: 2, until: candidate ? any(test, lint) : all(test, lint),
      })));

      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [
        { kind: 'check', label: `answer: until requires (${NODE} -e process.exit(1))` },
        { kind: 'check', label: `answer: until requires (${NODE} -e "")` },
      ] });
      expect(report.runs.find((one) => one.version === 'candidate')!.protections).toEqual([
        { kind: 'check', label: `answer: until (${NODE} -e process.exit(1))` },
        { kind: 'check', label: `answer: until (${NODE} -e "")` },
        { kind: 'check', label: `answer: until requires any((${NODE} -e process.exit(1)), (${NODE} -e ""))` },
      ]);
      expect(commits(root)).toBe('1');
    });

    it('lets a candidate through that adds a command its all() check requires', async () => {
      const text = (extra: string) => `export const until = all(['node', '-e', ''], 'always'${extra});\n`;
      const { root, file, change } = await repoWith(text(''), text(", ['node', '-e', 'process.exit(0)']"));
      const test = commandSucceeds(process.execPath, ['-e', '']);
      const lint = commandSucceeds(process.execPath, ['-e', 'process.exit(0)']);
      const { report } = await climbIn(file, change, versions(text(", ['node', '-e', 'process.exit(0)']"), (candidate) => loop({
        name: 'answer', body: answer, max: 2, until: candidate ? all(test, always, lint) : all(test, always),
      })));

      expect(report.refused).toBeUndefined();
      expect(report.runs.find((one) => one.version === 'baseline')!.protections).toEqual([
        { kind: 'check', label: `answer: until (${NODE} -e "")` },
        { kind: 'check', label: `answer: until requires (${NODE} -e "")` },
      ]);
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that turns a lone command into any(command, always), though it runs the command and scores better', async () => {
      const text = (combine: string) => `export const until = ${combine};\n`;
      const { root, file, change } = await repoWith(text("['node', '-e', 'process.exit(1)']"), text("any(['node', '-e', 'process.exit(1)'], 'always')"));
      const test = commandSucceeds(process.execPath, ['-e', 'process.exit(1)']);
      const { report } = await climbIn(file, change, versions(text("any(['node', '-e', 'process.exit(1)'], 'always')"), (candidate) => loop({
        name: 'answer', body: answer, max: 2, until: candidate ? any(test, always) : test,
      })));

      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'check', label: `answer: until requires (${NODE} -e process.exit(1))` }] });
      expect(report.runs.find((one) => one.version === 'baseline')!.protections).toEqual([
        { kind: 'check', label: `answer: until (${NODE} -e process.exit(1))` },
        { kind: 'check', label: `answer: until requires (${NODE} -e process.exit(1))` },
      ]);
      expect(commits(root)).toBe('1');
    });

    it('lets a candidate through that swaps all(command) for the lone command, which requires it as much', async () => {
      const text = (combine: string) => `export const until = ${combine};\n`;
      const { file, change } = await repoWith(text("all(['node', '-e', ''])"), text("['node', '-e', '']"));
      const check = commandSucceeds(process.execPath, ['-e', '']);
      const { report } = await climbIn(file, change, versions(text("['node', '-e', '']"), (candidate) => loop({
        name: 'answer', body: answer, max: 2, until: candidate ? check : all(check),
      })));

      expect(report.refused).toBeUndefined();
      expect(report.runs.find((one) => one.version === 'candidate')!.protections).toEqual([
        { kind: 'check', label: `answer: until (${NODE} -e "")` },
        { kind: 'check', label: `answer: until requires (${NODE} -e "")` },
      ]);
    });

    it('refuses a candidate that skips a check in only some of its runs, though it scores better', async () => {
      const after = steps('test', '  if (Math.random() < 0.5) steps.pop();\n');
      const { root, file, change } = await repoWith(steps('test'), after);
      // The candidate runs the check on its first run and skips it on the others.
      let candidateRuns = 0;
      const { report } = await climb({
        file, change, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 3, mode: 'auto',
        load: versions(after, (candidate) => {
          const skip = candidate && ++candidateRuns > 1;
          return pipeline('sums', [{ name: 'answer', job: answer }, ...(skip ? [] : [{ name: 'last', job: protections.test }])]);
        }),
      });

      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'check', label: `sums/last: test (${NODE} -e process.exit(1))` }, { kind: 'check', label: `sums/last: test requires (${NODE} -e process.exit(1))` }] });
      expect(report.keep).toBe(false);
      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      expect(report.runs.filter((one) => one.version === 'candidate').map((one) => one.protections)).toEqual([
        [{ kind: 'check', label: `sums/last: test (${NODE} -e process.exit(1))` }, { kind: 'check', label: `sums/last: test requires (${NODE} -e process.exit(1))` }], [], [],
      ]);
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that runs a check in fewer runs than the baseline, though it scores better', async () => {
      const after = steps('test', '  if (Math.random() < 0.5) steps.pop();\n');
      const { root, file, change } = await repoWith(steps('test'), after);
      // The baseline runs the check on two of its three runs; the candidate on one.
      const started = { baseline: 0, candidate: 0 };
      const { report } = await climb({
        file, change, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 3, mode: 'auto',
        load: versions(after, (candidate) => {
          const n = ++started[candidate ? 'candidate' : 'baseline'];
          const check = n <= (candidate ? 1 : 2);
          return pipeline('sums', [{ name: 'answer', job: answer }, ...(check ? [{ name: 'last', job: protections.test }] : [])]);
        }),
      });

      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'check', label: `sums/last: test (${NODE} -e process.exit(1))` }, { kind: 'check', label: `sums/last: test requires (${NODE} -e process.exit(1))` }] });
      expect(report.keep).toBe(false);
      expect(report.tasks[0]!.candidate.meanScore).toBeGreaterThan(report.tasks[0]!.baseline.meanScore);
      const ran = (version: string) => report.runs.filter((one) => one.version === version).map((one) => one.protections.length);
      expect(ran('baseline')).toEqual([2, 2, 0]);
      expect(ran('candidate')).toEqual([2, 0, 0]);
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that drops one of two checks with the same name in different nested workflows', async () => {
      const passes = commandJob('test', [process.execPath, '-e', '']);
      const nested = (name: string, check: boolean) => pipeline(name, [
        { name: 'answer', job: answer }, ...(check ? [{ name: 'check', job: passes }] : []),
      ]);
      const text = (second: string) => `export const checks = ['first', '${second}'];\n`;
      const { root, file, change } = await repoWith(text('second'), text(''));
      const { report } = await climbIn(file, change, versions(text(''), (candidate) => pipeline('sums', [
        { name: 'first', job: nested('first', true) },
        { name: 'second', job: nested('second', !candidate) },
      ])));

      expect(report.refused).toEqual({ task: '2 + 3', missing: [
        { kind: 'check', label: `sums/second/second/check: test (${NODE} -e "")` },
        { kind: 'check', label: `sums/second/second/check: test requires (${NODE} -e "")` },
      ] });
      expect(report.keep).toBe(false);
      expect(report.runs.find((one) => one.version === 'baseline')!.protections).toEqual([
        { kind: 'check', label: `sums/first/first/check: test (${NODE} -e "")` },
        { kind: 'check', label: `sums/first/first/check: test requires (${NODE} -e "")` },
        { kind: 'check', label: `sums/second/second/check: test (${NODE} -e "")` },
        { kind: 'check', label: `sums/second/second/check: test requires (${NODE} -e "")` },
      ]);
      expect(commits(root)).toBe('1');
    });

    it('lets a candidate through that drops a step whose result merely looks like an answer to a person', async () => {
      const text = (steps: string) => `export const steps = [${steps}];\n`;
      const { file, change } = await repoWith(text("'answer', 'note'"), text("'answer'"));
      const note = fnJob('note', () => ({ status: 'pass', summary: 'noted', data: { approved: true, decisionText: 'noted' } }));
      const { report } = await climbIn(file, change, versions(text("'answer'"), (candidate) =>
        pipeline('sums', [{ name: 'answer', job: answer }, ...(candidate ? [] : [{ name: 'note', job: note }])])));

      expect(report.refused).toBeUndefined();
      expect(report.runs.every((one) => one.protections.length === 0)).toBe(true);
    });

    /** A writer reviewed by a panel, with a judge when one is given. */
    const reviewed = (panel: readonly string[], desc = 'Write the note.', refine = '') => [
      "export default ({ workflow, stage, writer, reviewer, judge, judgeSeat }) => workflow('note', {",
      "  brief: 'Write note.md.',",
      `  roles: { write: writer, review: [${panel.map((model) => `reviewer('${model}')`).join(', ')}] },`,
      `  stages: [stage('write', { agent: 'write', writes: 'note.md', desc: '${desc}', reviewedBy: 'review'${refine} })],`,
      '});',
      '',
    ].join('\n');
    const JUDGED = ', refine: judge(judgeSeat, { cap: 2, perFinding: false })';

    /** The job a version of `reviewed` describes. */
    const reviewedJob = (
      panel: readonly string[],
      desc: string,
      refine: 2 | 'judge' | undefined,
      verdict: () => unknown = () => ({ status: 'pass', summary: 'reads well' }),
    ) => workflow('note', {
      brief: 'Write note.md.',
      roles: {
        write: seat('writer', ['Write'], (cwd) => {
          execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
          return { status: 'pass', summary: 'wrote' };
        }),
        review: panel.map((model) => seat(model, ['Read'], verdict)),
      },
      stages: [stage('write', {
        agent: 'write', writes: 'note.md', desc, reviewedBy: 'review',
        ...(refine === undefined ? {} : {
          refine: refine === 2 ? 2 : judge(seat('judge', [], () => ({ stop_reason: { choice: 'continue' } })), { cap: 2, perFinding: false }),
        }),
      })],
    });

    it.each([
      ['adds a reviewer', ['first'], ['first', 'second'], 'Write the note.'],
      ['changes only a prompt', ['first'], ['first'], 'Write the note in one line.'],
    ])('lets a candidate that %s through the guard, to be scored', async (_, before, after, desc) => {
      const { file, change } = await repoWith(reviewed(before), reviewed(after, desc));
      const { report } = await climbIn(file, change, versions(reviewed(after, desc), (candidate) =>
        candidate ? reviewedJob(after, desc, undefined) : reviewedJob(before, 'Write the note.', undefined)));

      expect(report.refused).toBeUndefined();
      expect(report.runs).toHaveLength(6);
      expect(report.runs.find((one) => one.version === 'baseline')!.protections).toEqual([
        { kind: 'check', label: 'note/write/write-review: until' },
        { kind: 'review', label: 'note/write/write-review/review-panel: write' },
        { kind: 'reviewer', label: 'note/write/write-review/review-panel: write/write-1' },
        { kind: 'review', label: 'note/write/write-review' },
      ]);
      expect(report.reason).toContain('does not beat the baseline');
    });

    it('refuses a candidate that drops a reviewer from the panel', async () => {
      const { file, change } = await repoWith(reviewed(['first', 'second']), reviewed(['first']));
      const { report } = await climbIn(file, change, versions(reviewed(['first']), (candidate) =>
        reviewedJob(candidate ? ['first'] : ['first', 'second'], 'Write the note.', undefined)));

      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'reviewer', label: 'note/write/write-review/review-panel: write/write-2' }] });
    });

    it('refuses a candidate that drops one of two reviewers with the same model', async () => {
      // Each seat needs its own model family; the two reviewers share the model.
      const sameModel = (family: string) => ({
        ...seat(family, ['Read'], () => ({ status: 'pass', summary: 'reads well' })),
        identity: { adapter: 'mock', provider: 'mock', modelFamily: family, model: 'same', tools: ['Read'] },
      });
      const { file, change } = await repoWith(reviewed(['one', 'two']), reviewed(['one']));
      const { report } = await climbIn(file, change, versions(reviewed(['one']), (candidate) => workflow('note', {
        brief: 'Write note.md.',
        roles: {
          write: seat('writer', ['Write'], (cwd) => {
            execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: candidate ? [sameModel('one')] : [sameModel('one'), sameModel('two')],
        },
        stages: [stage('write', { agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review' })],
      })));

      expect(report.keep).toBe(false);
      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'reviewer', label: 'note/write/write-review/review-panel: write/write-2' }] });
    });

    it('refuses a candidate that swaps the person who reviews for an agent reviewer', async () => {
      const text = (reviewer: string) => `export const reviewedBy = '${reviewer}';\n`;
      const { file, change } = await repoWith(text('a person'), text('an agent'));
      const signOff = person('Ship it?', {
        interaction: { id: 'sign-off', responseSchema: {}, answer: async () => ({ feedback: {}, prompt: '', decision: 'approved' }) },
      });
      const { report } = await climbIn(file, change, versions(text('an agent'), (candidate) => workflow('note', {
        brief: 'Write note.md.',
        roles: {
          write: seat('writer', ['Write'], (cwd) => {
            execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: candidate ? [seat('first', ['Read'], () => ({ status: 'pass', summary: 'reads well' }))] : signOff,
        },
        stages: [stage('write', { agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review' })],
      })));

      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'approval', label: 'note/write/write-review: sign-off: Ship it?' }] });
      expect(report.keep).toBe(false);
    });

    it('refuses a candidate that drops one of two approvals with the same gate and question in different steps', async () => {
      const signOff = approval('sign-off', { question: 'Ship it?', answer: () => ({ approved: true }) });
      // Both steps ask about the same work, so they share one request and its answer.
      const nested = (name: string, ask: boolean) => pipeline(name, [
        { name: 'answer', job: answer }, ...(ask ? [{ name: 'approve', job: signOff }] : []),
      ]);
      const text = (second: string) => `export const approvals = ['first', '${second}'];\n`;
      const { root, file, change } = await repoWith(text('second'), text(''));
      const { report } = await climbIn(file, change, versions(text(''), (candidate) => pipeline('sums', [
        { name: 'first', job: nested('first', true) },
        { name: 'second', job: nested('second', !candidate) },
      ])));

      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'approval', label: 'sums/second/second/approve: sign-off: Ship it?' }] });
      expect(report.keep).toBe(false);
      expect(commits(root)).toBe('1');
    });

    it('refuses a candidate that swaps the second of two look-alike approvals for an ordinary step labelled the same', async () => {
      // The same question about the same input: the second step finds the first step's answer.
      const signOff = approval('sign-off', { question: 'Ship it?', input: { release: '1.0' }, answer: () => ({ approved: true }) });
      const text = (second: string) => `export const second = '${second}';\n`;
      const { root, file, change } = await repoWith(text('approval'), text('job'));
      const { report } = await climbIn(file, change, versions(text('job'), (candidate) => pipeline('sums', [
        { name: 'first', job: signOff },
        { name: 'second', job: candidate ? fnJob('sign-off', () => 'approved') : signOff },
      ])));

      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'approval', label: 'sums/second: sign-off: Ship it?' }] });
      expect(report.keep).toBe(false);
      expect(commits(root)).toBe('1');
    });

    describe('when the workflow asks a question nobody answers, so every run ends paused', () => {
      const ask = (question: string) => approval('sign-off', { question });
      const text = (check: string, question: string) => `export const check = '${check}';\nexport const question = '${question}';\n`;

      it('refuses a candidate that drops the check before the question', async () => {
        const { root, file, change } = await repoWith(text('test', 'Ship it?'), text('', 'Ship it?'));
        const { report } = await climbIn(file, change, versions(text('', 'Ship it?'), (candidate) => pipeline('sums', [
          { name: 'answer', job: answer },
          ...(candidate ? [] : [{ name: 'test', job: commandJob('test', [process.execPath, '-e', '']) }]),
          { name: 'ask', job: ask('Ship it?') },
        ])));

        expect(report.runs.map((one) => [one.version, one.status])).toEqual([['baseline', 'paused'], ['candidate', 'paused']]);
        expect(report.refused).toEqual({ task: '2 + 3', missing: [
          { kind: 'check', label: `sums/test: test (${NODE} -e "")` },
          { kind: 'check', label: `sums/test: test requires (${NODE} -e "")` },
        ] });
        expect(report.keep).toBe(false);
        expect(report.reason).toContain(`the check "sums/test: test (${NODE} -e "")"`);
        expect(commits(root)).toBe('1');
      });

      it('refuses a candidate that rewrites the question, so the old approval goes missing', async () => {
        const { file, change } = await repoWith(text('', 'Ship it?'), text('', 'Looks fine?'));
        const { report } = await climbIn(file, change, versions(text('', 'Looks fine?'), (candidate) => pipeline('sums', [
          { name: 'answer', job: answer },
          { name: 'ask', job: ask(candidate ? 'Looks fine?' : 'Ship it?') },
        ])));

        expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'approval', label: 'sums/ask: sign-off: Ship it?' }] });
        expect(report.keep).toBe(false);
      });

      it('reports the comparison unfinished when the candidate keeps every protection', async () => {
        const { file, change } = await repoWith(text('test', 'Ship it?'), text('test', 'Ship it?') + '// a comment\n');
        const { report } = await climbIn(file, change, () => Promise.resolve(pipeline('sums', [
          { name: 'answer', job: answer },
          { name: 'ask', job: ask('Ship it?') },
        ])));

        expect(report.runs).toHaveLength(2);
        expect(report.refused).toBeUndefined();
        expect(report.keep).toBe(false);
        expect(report.reason).toBe('The comparison is unfinished: the baseline run 1 on "2 + 3" ended paused.');
      });
    });

    it('refuses a candidate that drops one of two steps that put the same question to the same person', async () => {
      const text = (second: string) => `export const asks = ['first', '${second}'];\n`;
      const { root, file, change } = await repoWith(text('second'), text(''));
      const editor = person('Ship it?', {
        interaction: { id: 'sign-off', responseSchema: {}, answer: async () => ({ feedback: {}, prompt: 'Ship it.' }) },
      });
      const { report } = await climbIn(file, change, versions(text(''), (candidate) => workflow('note', {
        brief: 'Write note.md.',
        roles: { editor },
        stages: [stage('first', { input: 'editor' }), ...(candidate ? [] : [stage('second', { input: 'editor' })])],
      })));

      expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'approval', label: 'note/second: sign-off: Ship it?' }] });
      expect(report.keep).toBe(false);
      expect(commits(root)).toBe('1');
    });

    it('records the question a person is asked to review a stage as a review of that stage', async () => {
      const text = (desc: string) => `export const desc = '${desc}';\n`;
      const { root, file, change } = await repoWith(text('Write the note.'), text('Write the note in full.'));
      // No answer in process: the review waits for a person, so the run pauses.
      const signOff = person('Ship it?', { interaction: { id: 'sign-off', responseSchema: {} } });
      const { report } = await climbIn(file, change, versions(text('Write the note in full.'), () => workflow('note', {
        brief: 'Write note.md.',
        roles: {
          write: seat('writer', ['Write'], (cwd) => {
            execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: signOff,
        },
        stages: [stage('write', { agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review' })],
      })));

      const [baseline] = report.runs;
      expect(baseline!.status).toBe('paused');
      expect(baseline!.protections).toContainEqual({ kind: 'review', label: 'note/write/write-review' });
      expect(baseline!.protections).toContainEqual({ kind: 'approval', label: 'note/write/write-review: sign-off: Ship it?' });
      expect(report.keep).toBe(false);
      expect(report.reason).toContain('unfinished');
      expect(commits(root)).toBe('1');
    });

    describe('a judge', () => {
      /** The reviewer sends the first draft back; then it reads well. */
      const firstDraftSentBack = () => {
        let reviews = 0;
        return () => (++reviews % 2 === 1
          ? { status: 'revise', summary: 'again', findings: [{ severity: 'block', evidence: 'too short' }] }
          : { status: 'pass', summary: 'reads well' });
      };

      it('keeps a candidate that keeps the judge, though its reviews pass so the judge never decides', async () => {
        const after = reviewed(['first'], 'Write the note in full.', JUDGED);
        const { root, file, change } = await repoWith(reviewed(['first'], 'Write the note.', JUDGED), after);
        // The baseline's first draft is sent back; the candidate's is not.
        const sentBack = firstDraftSentBack();
        const { report } = await climb({
          file, change, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, approve: () => ({ approved: true }),
          load: versions(after, (candidate) => candidate
            ? reviewedJob(['first'], 'Write the note in full.', 'judge')
            : reviewedJob(['first'], 'Write the note.', 'judge', sentBack)),
        });

        const baseline = report.runs.find((one) => one.version === 'baseline')!;
        expect(baseline.protections).toContainEqual({ kind: 'judge', label: 'note: write' });
        expect(report.refused).toBeUndefined();
        expect(report.tuning.candidate.meanRounds).toBeLessThan(report.tuning.baseline.meanRounds);
        expect(report.keep).toBe(true);
        expect(commits(root)).toBe('2');
      });

      it('refuses a candidate that drops the judge, though its reviews pass and it takes fewer rounds', async () => {
        const after = reviewed(['first'], 'Write the note in full.');
        const { root, file, change } = await repoWith(reviewed(['first'], 'Write the note.', JUDGED), after);
        const sentBack = firstDraftSentBack();
        const { report } = await climbIn(file, change, versions(after, (candidate) => candidate
          ? reviewedJob(['first'], 'Write the note in full.', undefined)
          : reviewedJob(['first'], 'Write the note.', 'judge', sentBack)));

        // On the numbers it wins: the same score in fewer rounds.
        expect(report.tasks[0]!.candidate.meanScore).toBe(report.tasks[0]!.baseline.meanScore);
        expect(report.tasks[0]!.candidate.meanRounds).toBeLessThan(report.tasks[0]!.baseline.meanRounds);
        expect(report.keep).toBe(false);
        expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'judge', label: 'note: write' }] });
        expect(commits(root)).toBe('1');
      });

      it('refuses a candidate that drops a judge that never decided, because every review passed', async () => {
        const after = reviewed(['first'], 'Write the note.');
        const { root, file, change } = await repoWith(reviewed(['first'], 'Write the note.', JUDGED), after);
        const { report } = await climbIn(file, change, versions(after, (candidate) =>
          reviewedJob(['first'], 'Write the note.', candidate ? undefined : 'judge')));

        expect(report.runs.every((one) => one.passed && one.rounds === 1)).toBe(true);
        expect(report.keep).toBe(false);
        expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'judge', label: 'note: write' }] });
        expect(commits(root)).toBe('1');
      });

      it('refuses a candidate whose review fails with no judge to decide', async () => {
        const after = reviewed(['first'], 'Write the note.', ', refine: 2');
        const { file, change } = await repoWith(reviewed(['first'], 'Write the note.', JUDGED), after);
        const sentBack = firstDraftSentBack();
        const { report } = await climbIn(file, change, versions(after, (candidate) =>
          reviewedJob(['first'], 'Write the note.', candidate ? 2 : 'judge', sentBack)));

        expect(report.keep).toBe(false);
        expect(report.refused).toEqual({ task: '2 + 3', missing: [{ kind: 'judge', label: 'note: write' }] });
      });

      it('counts every judge the workflow has, whether or not a review failed at its stage', async () => {
        const text = (stage: string) => `export const sentBackAt = '${stage}';\n`;
        const { file, change } = await repoWith(text('one'), text('two'));
        const passes = () => ({ status: 'pass', summary: 'reads well' });
        const writer = (name: string, note: string) => seat(name, ['Write'], (cwd) => {
          execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, note))}`]);
          return { status: 'pass', summary: 'wrote' };
        });
        const judged = (name: string) => judge(seat(name, [], () => ({ stop_reason: { choice: 'continue' } })), { cap: 2, perFinding: false });
        // The baseline's first stage sends its first draft back; the candidate's second stage does.
        const { report } = await climbIn(file, change, versions(text('two'), (candidate) => workflow('note', {
          brief: 'Write one.md, then two.md.',
          roles: {
            writeOne: writer('writer-one', 'one.md'),
            writeTwo: writer('writer-two', 'two.md'),
            reviewOne: [seat('first', ['Read'], candidate ? passes : firstDraftSentBack())],
            reviewTwo: [seat('second', ['Read'], candidate ? firstDraftSentBack() : passes)],
          },
          stages: [
            stage('one', { agent: 'writeOne', writes: 'one.md', desc: 'Write one.', reviewedBy: 'reviewOne', refine: judged('judge-one') }),
            stage('two', { agent: 'writeTwo', writes: 'two.md', desc: 'Write two.', reviewedBy: 'reviewTwo', refine: judged('judge-two') }),
          ],
        })));

        for (const one of report.runs) {
          expect(one.protections).toContainEqual({ kind: 'judge', label: 'note: one' });
          expect(one.protections).toContainEqual({ kind: 'judge', label: 'note: two' });
        }
        expect(report.refused).toBeUndefined();
        expect(report.runs).toHaveLength(6);
      });
    });
  });

  it('runs every version from the commit the climb started at, and applies nothing after a new commit', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const started = git(root, 'rev-parse', 'HEAD').trim();
    const engine = standIn({
      [BASELINE]: { usd: 0, replies: wordy([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0, replies: right([...TUNING, ...HELD_OUT]) },
    });
    const sawLater: boolean[] = [];
    const load: ClimbConfig['load'] = async (path, task) => {
      if (sawLater.length === 0) {
        await writeFile(join(root, 'later.txt'), 'committed while the climb runs\n');
        git(root, 'add', 'later.txt');
        git(root, 'commit', '-q', '-m', 'a later commit');
      }
      sawLater.push(existsSync(join(dirname(path), 'later.txt')));
      return loader(engine)(path, task);
    };
    const { result, report, data } = await climb({ file, change, load, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, approve: () => ({ approved: true }) });

    expect(report.commit).toBe(started);
    expect(sawLater).toEqual([false, false, false, false, false, false]);
    expect(report.keep).toBe(true);
    expect(data.apply!.status).toBe('fail');
    expect(JSON.stringify(result.outcome.data)).toContain('has new commits');
    expect(commits(root)).toBe('2');
    expect(await readFile(file, 'utf8')).toBe(workflowText(BASELINE));
  });

  it('puts the workflow file back when the commit of a kept change fails', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const engine = standIn({
      [BASELINE]: { usd: 0, replies: wordy([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0, replies: right([...TUNING, ...HELD_OUT]) },
    });
    const { report, data } = await climb({ file, change, load: loader(engine), tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 1, approve: () => ({ approved: true }) });

    expect(report.keep).toBe(true);
    expect(data.apply!.status).toBe('fail');
    expect(commits(root)).toBe('1');
    expect(await readFile(file, 'utf8')).toBe(workflowText(BASELINE));
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('reads each goal check and each send-back from the run\'s events', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const load: ClimbConfig['load'] = async (path): Promise<Job> => {
      const candidate = (await readFile(path, 'utf8')).includes(CANDIDATE);
      let checks = 0;
      // The baseline's work never meets the goal; the change's meets it on its second round.
      const goal = new MockEngine(() => {
        checks += 1;
        const verdict = candidate && checks > 1 ? 'met' : 'unmet';
        return JSON.stringify({ requirements: [{ requirement: 'The sum is right', verdict, evidence: 'answer.md:1' }] });
      });
      return dag({
        name: 'goal',
        maxKickbacks: 1,
        nodes: {
          answer: { job: fnJob('answer', () => 'done') },
          check: {
            needs: 'answer',
            acceptsKickbackTo: ['answer'],
            job: goalCheck(
              { engine: goal, identity: { adapter: 'mock', provider: 'mock', modelFamily: 'goal', model: 'goal', tools: ['Read'] } },
              { target: 'answer', text: 'Answer the sum.' },
            ),
          },
        },
      });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: ['a'], heldOut: ['b'] }, runs: 1, mode: 'auto' });

    const baseline = report.runs.find((one) => one.version === 'baseline')!;
    const candidate = report.runs.find((one) => one.version === 'candidate')!;
    expect(baseline).toMatchObject({ passed: false, goalMet: false, score: 0, rounds: 2 });
    expect(candidate).toMatchObject({ passed: true, goalMet: true, score: 1, rounds: 2 });
    expect(baseline.protections).toContainEqual({ kind: 'goal check', label: 'goal/check: goal-check' });
  });

  it('counts each round a review sends back in a workflow()', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const load: ClimbConfig['load'] = async (path): Promise<Job> => {
      const candidate = (await readFile(path, 'utf8')).includes(CANDIDATE);
      let reviews = 0;
      const seat = (model: string, tools: string[], reply: (cwd: string) => unknown) => ({
        engine: new MockEngine((request) => JSON.stringify(reply(request.cwd!))),
        identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools },
      });
      return workflow('note', {
        brief: 'Write note.md.',
        roles: {
          write: seat('writer', ['Write'], (cwd) => {
            execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: [seat('reviewer', ['Read'], () => {
            reviews += 1;
            return !candidate && reviews === 1
              ? { status: 'revise', summary: 'again', findings: [{ severity: 'block', evidence: 'too short' }] }
              : { status: 'pass', summary: 'reads well' };
          })],
        },
        stages: [stage('write', { agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review', refine: 3 })],
      });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: ['a'], heldOut: ['b'] }, runs: 1, mode: 'auto' });

    expect(report.runs.map((one) => [one.version, one.status, one.rounds])).toEqual([
      ['baseline', 'pass', 2], ['candidate', 'pass', 1], ['baseline', 'pass', 2], ['candidate', 'pass', 1],
    ]);
    expect(report.keep).toBe(true);
  });

  it('counts each round a loop runs again because its check failed, in a workflow()', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const load: ClimbConfig['load'] = async (path): Promise<Job> => {
      const candidate = (await readFile(path, 'utf8')).includes(CANDIDATE);
      let builds = 0;
      const seat = (model: string, tools: string[], reply: (cwd: string) => unknown) => ({
        engine: new MockEngine((request) => JSON.stringify(reply(request.cwd!))),
        identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools },
      });
      return workflow('note', {
        brief: 'Write note.md.',
        roles: {
          // Without the change, the writer writes the file only on its third build.
          write: seat('writer', ['Write'], (cwd) => {
            builds += 1;
            if (candidate || builds === 3) execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: [seat('reviewer', ['Read'], () => ({ status: 'pass', summary: 'reads well' }))],
        },
        stages: [stage('write', { agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review', refine: 3 })],
      });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: ['a'], heldOut: ['b'] }, runs: 1, mode: 'auto' });

    expect(report.runs.map((one) => [one.version, one.status, one.rounds])).toEqual([
      ['baseline', 'pass', 3], ['candidate', 'pass', 1], ['baseline', 'pass', 3], ['candidate', 'pass', 1],
    ]);
    expect(report.keep).toBe(true);
  });

  it('counts each round a goal check sends back in a workflow()', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const load: ClimbConfig['load'] = async (path): Promise<Job> => {
      const candidate = (await readFile(path, 'utf8')).includes(CANDIDATE);
      let checks = 0;
      const seat = (model: string, tools: string[], reply: (cwd: string) => unknown) => ({
        engine: new MockEngine((request) => JSON.stringify(reply(request.cwd!))),
        identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools },
      });
      return workflow('note', {
        brief: 'Write note.md.',
        roles: {
          write: seat('writer', ['Write'], (cwd) => {
            execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: [seat('reviewer', ['Read'], () => ({ status: 'pass', summary: 'reads well' }))],
        },
        stages: [stage('write', {
          agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review', refine: 3,
          // Without the change, the goal is met only on the third round.
          goal: seat('goal', ['Read'], () => {
            checks += 1;
            const verdict = candidate || checks === 3 ? 'met' : 'unmet';
            return { requirements: [{ requirement: 'The note exists', verdict, evidence: 'note.md:1' }] };
          }),
        })],
      });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: ['a'], heldOut: ['b'] }, runs: 1, mode: 'auto' });

    expect(report.runs.map((one) => [one.version, one.status, one.rounds])).toEqual([
      ['baseline', 'pass', 3], ['candidate', 'pass', 1], ['baseline', 'pass', 3], ['candidate', 'pass', 1],
    ]);
  });

  it('counts a round once when a rate limit makes its build wait and run again', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    let throttled = 0;
    const load: ClimbConfig['load'] = async () => {
      let builds = 0;
      // The first round fails. The second round's build is throttled; the
      // loop waits, then runs the second round's build again, and it passes.
      const body: Job = async () => {
        builds += 1;
        if (builds === 1) return { status: 'fail', summary: 'not yet' };
        if (builds > 2) return { status: 'pass', summary: 'done' };
        throttled += 1;
        return { status: 'fail', summary: 'throttled', error: new LoopError({ code: 'RATE_LIMIT', message: 'throttled', retryAfterMs: 5 }) };
      };
      return loop({ name: 'answer', body, max: 3 });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: ['a'], heldOut: ['b'] }, runs: 1, mode: 'auto' });

    expect(throttled).toBe(4);
    expect(report.runs.map((one) => [one.status, one.rounds])).toEqual([['pass', 2], ['pass', 2], ['pass', 2], ['pass', 2]]);
  });

  it('counts one round when a judge stops the first round', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const load: ClimbConfig['load'] = async () => {
      const seat = (model: string, tools: string[], reply: (cwd: string) => unknown) => ({
        engine: new MockEngine((request) => JSON.stringify(reply(request.cwd!))),
        identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools },
      });
      return workflow('note', {
        brief: 'Write note.md.',
        roles: {
          write: seat('writer', ['Write'], (cwd) => {
            execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: [seat('reviewer', ['Read'], () => ({ status: 'revise', summary: 'again', findings: [{ severity: 'block', evidence: 'too short' }] }))],
        },
        stages: [stage('write', {
          agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review',
          refine: judge(seat('judge', [], () => ({ stop_reason: { choice: 'stuck' } })), { cap: 2, perFinding: false }),
        })],
      });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: ['a'], heldOut: ['b'] }, runs: 1, mode: 'auto' });

    expect(report.runs.map((one) => [one.status, one.rounds])).toEqual([['fail', 1], ['fail', 1], ['fail', 1], ['fail', 1]]);
  });

  it('counts the rounds whose build ran when a judge stops a later round', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const builds: number[] = [];
    const load: ClimbConfig['load'] = async () => {
      const seat = (model: string, tools: string[], reply: (cwd: string) => unknown) => ({
        engine: new MockEngine((request) => JSON.stringify(reply(request.cwd!))),
        identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools },
      });
      let decisions = 0;
      builds.push(0);
      return workflow('note', {
        brief: 'Write note.md.',
        roles: {
          write: seat('writer', ['Write'], (cwd) => {
            builds[builds.length - 1]! += 1;
            execFileSync('sh', ['-c', `echo draft >> ${JSON.stringify(join(cwd, 'note.md'))}`]);
            return { status: 'pass', summary: 'wrote' };
          }),
          review: [seat('reviewer', ['Read'], () => ({ status: 'revise', summary: 'again', findings: [{ severity: 'block', evidence: 'too short' }] }))],
        },
        stages: [stage('write', {
          agent: 'write', writes: 'note.md', desc: 'Write the note.', reviewedBy: 'review',
          // The judge sends the first round back, then stops the second.
          refine: judge(seat('judge', [], () => ({ stop_reason: { choice: (decisions += 1) === 1 ? 'continue' : 'stuck' } })), { cap: 3, perFinding: false }),
        })],
      });
    };
    const { report } = await climb({ file, change, load, tasks: { tuning: ['a'], heldOut: ['b'] }, runs: 1, mode: 'auto' });

    expect(builds).toEqual([2, 2, 2, 2]);
    expect(report.runs.map((one) => [one.status, one.rounds])).toEqual([['fail', 2], ['fail', 2], ['fail', 2], ['fail', 2]]);
  });

  it('keeps the runs it measured and never keeps a change whose file does not load', async () => {
    const { root, file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    const engine = standIn({
      [BASELINE]: { usd: 0.01, replies: wordy([...TUNING, ...HELD_OUT]) },
      [CANDIDATE]: { usd: 0.01, replies: right([...TUNING, ...HELD_OUT]) },
    });
    // The candidate loads on its first run, then its import breaks.
    let candidateLoads = 0;
    const load: ClimbConfig['load'] = async (one, task) => {
      if ((await readFile(one, 'utf8')) === workflowText(CANDIDATE) && ++candidateLoads > 1) {
        throw new SyntaxError("Cannot find module './reviewers.mjs'");
      }
      return loader(engine)(one, task);
    };
    const record = join(root, 'climb.jsonl');
    const { result, report } = await climb({ file, change, load, tasks: { tuning: TUNING, heldOut: HELD_OUT }, runs: 2, mode: 'auto' }, record);

    expect(result.outcome.status).toBe('pass');
    expect(report.runs.map((one) => [one.version, one.attempt, one.score])).toEqual([
      ['baseline', 1, 0], ['candidate', 1, 1], ['baseline', 2, 0],
    ]);
    expect(report.failed).toEqual({
      task: '2 + 3', set: 'tuning', version: 'candidate', attempt: 2,
      error: "SyntaxError: Cannot find module './reviewers.mjs'",
    });
    expect(report.keep).toBe(false);
    expect(report.reason).toBe(
      "The comparison is unfinished: the candidate run 2 on \"2 + 3\" could not run: SyntaxError: Cannot find module './reviewers.mjs'.",
    );
    expect(formatClimbReport(report)).toContain('The numbers say: discard. The comparison is unfinished');
    expect(git(root, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    const events = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as LoopEvent);
    const measured = events.find((event) => event.kind === 'job:end' && event.label === 'measure');
    expect(JSON.stringify(measured)).toContain('Cannot find module');
    expect(commits(root)).toBe('1');
  });

  it('refuses a workflow file with changes that are not committed', async () => {
    const { file, change } = await repoWith(workflowText(BASELINE), workflowText(CANDIDATE));
    await writeFile(file, workflowText('Something else.'));
    const { result } = await climb({ file, change, load: loader(standIn({})), tasks: { tuning: TUNING, heldOut: HELD_OUT }, mode: 'auto' });

    expect(result.outcome.status).toBe('fail');
    expect(JSON.stringify(result.outcome.data)).toContain('has changes that are not committed');
  });

  it('refuses a task set without held-out tasks', () => {
    expect(() => climbWorkflow({
      file: '/repo/team.ts', change: 'diff', load: () => fnJob('x', () => undefined), tasks: { tuning: TUNING, heldOut: [] },
    })).toThrow('tasks.heldOut must list at least one task');
  });
});
