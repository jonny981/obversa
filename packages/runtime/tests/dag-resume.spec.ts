import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCallbackClient, dag, fnJob, judge, kickback, loop, predicate, run, stage, workflow } from '../src/api.ts';
import type { CallbackRequest, DagNode, Job, LoopEvent, RunCallbacks, RunOptions, RunResult } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, cleanupRepos } from './git-helpers.ts';

// The isolation tests create real Git repositories and worktrees, so this
// file declares its own time limit; the suite default is a hang guard, not a
// speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(cleanupRepos);

let cwd: string;
const strayDirs: string[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'obversa-dag-resume-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  for (const dir of strayDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const recordTo = (name = 'record.jsonl') => join(cwd, name);

async function recordEvents(path: string): Promise<LoopEvent[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoopEvent);
}

async function result(job: Job, options: RunOptions): Promise<RunResult> {
  return run(job, { cwd, signal: new AbortController().signal, ...options });
}

function counters() {
  const counts = { one: 0, two: 0, three: 0 };
  const node = (name: keyof typeof counts, fail = false): DagNode => ({
    job: fnJob(name, () => {
      counts[name] += 1;
      return fail ? { status: 'fail' as const, summary: `${name} failed` } : undefined;
    }),
  });
  return { counts, node };
}

/** Claim a pending question and submit the answer, the way a person would. */
async function answer(client: RunCallbacks, request: CallbackRequest, approved = true) {
  const claim = await client.claim(request.requestId, 'person');
  expect(claim.ok).toBe(true);
  if (!claim.ok) throw new Error(`claim refused: ${claim.kind}`);
  const submitted = await client.submit(request.requestId, claim.claimToken, 'person', request.digest, {
    approved,
  });
  expect(submitted.ok).toBe(true);
}

const branchExists = async (repo: string, branch: string) =>
  (await execa('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: repo, reject: false })).exitCode === 0;

const anchors = async (path: string) =>
  (await recordEvents(path))
    .filter((event): event is Extract<LoopEvent, { kind: 'workflow:start' }> =>
      event.kind === 'workflow:start' && event.path.join('/') === 'trio');

/** Cut a record right after `node`'s first start, as if the worker died there. */
async function cutAfterStart(path: string, node: string): Promise<string> {
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  const cut = lines.findIndex((line) => {
    const event = JSON.parse(line) as LoopEvent;
    return event.kind === 'dag:node' && event.node === node && event.phase === 'start';
  });
  expect(cut).toBeGreaterThanOrEqual(0);
  return `${lines.slice(0, cut + 1).join('\n')}\n`;
}

describe('dag resume', () => {
  it('reuses finished nodes on resume', async () => {
    const { counts, node } = counters();
    const build = (threeFails = false) => dag({
      name: 'trio',
      nodes: {
        one: node('one'),
        two: { ...node('two'), needs: 'one' },
        three: { ...node('three', threeFails), needs: 'two' },
      },
    });
    const path = recordTo();

    const first = await result(build(true), { recordTo: path });
    expect(first.outcome.status).toBe('fail');

    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 1, two: 1, three: 2 });

    const events = await recordEvents(path);
    const isAnchor = (event: LoopEvent): event is Extract<LoopEvent, { kind: 'workflow:start' }> =>
      event.kind === 'workflow:start' && event.path.join('/') === 'trio';
    const anchors = events.filter(isAnchor);
    const runStarts = events.filter((event) => event.kind === 'run:start');
    expect(anchors.length).toBe(runStarts.length);
    expect(new Set(anchors.map((event) => event.identity)).size).toBe(1);
    expect(new Set(anchors.map((event) => event.recordId)).size).toBe(1);

    // The counters see real runs: a fresh run without resume runs everything.
    const fresh = await result(build(), { recordTo: recordTo('fresh.jsonl') });
    expect(fresh.outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 2, two: 2, three: 3 });
  });

  it('restarts from the top when a declared `when` changes', async () => {
    const { counts, node } = counters();
    const build = (when?: () => boolean) => dag({
      name: 'trio',
      nodes: {
        one: node('one'),
        two: { ...node('two'), needs: 'one' },
        three: { ...node('three', true), needs: 'two', ...(when ? { when } : {}) },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');

    const changed = await result(build(() => true), { recordTo: path, resume: true });
    expect(changed.outcome.status).toBe('fail');
    expect(counts.one).toBe(2);

    const events = await recordEvents(path);
    const isAnchor = (event: LoopEvent): event is Extract<LoopEvent, { kind: 'workflow:start' }> =>
      event.kind === 'workflow:start' && event.path.join('/') === 'trio';
    expect(new Set(events.filter(isAnchor).map((event) => event.identity)).size).toBe(2);
  });

  it('pauses on an interrupted node unless it is retrySafe', async () => {
    const { counts, node } = counters();
    const build = (retrySafe = false) => dag({
      name: 'trio',
      nodes: {
        one: node('one'),
        two: { ...node('two'), needs: 'one', retrySafe },
        three: { ...node('three'), needs: 'two' },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 1, two: 1, three: 1 });

    // The worker died right after two's start: drop everything that followed.
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const cut = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'two' && event.phase === 'start';
    });
    expect(cut).toBeGreaterThanOrEqual(0);
    await writeFile(path, `${lines.slice(0, cut + 1).join('\n')}\n`);

    const callbacks = createCallbackClient();
    const paused = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/Did stage "two" finish/);
    const [request] = await callbacks.listPending();
    expect((request?.input as { stage?: string })?.stage).toBe('two');
    expect(counts.two).toBe(1);

    // The same truncated record (a paused resume appends to the log it
    // answered): retrySafe runs the interrupted node again instead of asking.
    const safePath = recordTo('safe.jsonl');
    await writeFile(safePath, `${lines.slice(0, cut + 1).join('\n')}\n`);
    const safe = await result(build(true), { recordTo: safePath, resume: true });
    expect(safe.outcome.status).toBe('pass');
    expect(counts.two).toBe(2);
  });

  it('treats a completed-then-interrupted node as interrupted, never reused', async () => {
    const { counts, node } = counters();
    let sendBack = true;
    const build = (retrySafe = false) => dag({
      name: 'trio',
      maxKickbacks: { two: 2 },
      nodes: {
        one: node('one'),
        two: { ...node('two'), needs: 'one', retrySafe },
        three: {
          job: fnJob('three', () => {
            counts.three += 1;
            if (sendBack) {
              sendBack = false;
              return kickback('two', 'redo');
            }
            return { status: 'pass', summary: 'done' };
          }),
          needs: 'two',
        },
      },
    });
    const path = recordTo();

    // Run 1: two passes, three kicks back, two starts attempt 2 — then the
    // worker died (the record is cut right after that start).
    const first = await result(build(), { recordTo: path });
    expect(first.outcome.status).toBe('pass');
    expect(counts.two).toBe(2);
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    let cut = -1;
    for (const [index, line] of lines.entries()) {
      const event = JSON.parse(line) as LoopEvent;
      if (event.kind === 'dag:node' && event.node === 'two' && event.phase === 'start' && event.attempt === 2) {
        cut = index;
      }
    }
    expect(cut).toBeGreaterThanOrEqual(0);
    await writeFile(path, `${lines.slice(0, cut + 1).join('\n')}\n`);

    counts.two = 0;
    sendBack = false;
    const callbacks = createCallbackClient();
    const paused = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/Did stage "two" finish/);
    expect(counts.two).toBe(0);

    const safePath = recordTo('safe.jsonl');
    await writeFile(safePath, `${lines.slice(0, cut + 1).join('\n')}\n`);
    const safe = await result(build(true), { recordTo: safePath, resume: true });
    expect(safe.outcome.status).toBe('pass');
    expect(counts.two).toBe(1);
  });

  it('keeps the shared-workspace question for an interrupted non-isolated node', async () => {
    const { counts, node } = counters();
    const build = () => dag({
      name: 'trio',
      nodes: {
        one: node('one'),
        two: { ...node('two'), needs: 'one' },
        three: { ...node('three'), needs: 'two' },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    const truncated = await cutAfterStart(path, 'two');

    // Approve: the work is already in the shared workspace, so two does not
    // run again and the run carries on.
    await writeFile(path, truncated);
    const callbacks = createCallbackClient();
    const paused = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/Did stage "two" finish\? Approve to continue without running it again/);
    const [request] = await callbacks.listPending();
    await answer(callbacks, request!);
    const approved = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(approved.outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 1, two: 1, three: 2 });

    // Refuse: two did not finish, so it runs again.
    const refusedPath = recordTo('refused.jsonl');
    await writeFile(refusedPath, truncated);
    const refusedCallbacks = createCallbackClient();
    expect((await result(build(), { recordTo: refusedPath, resume: true, callbacks: refusedCallbacks })).outcome.status)
      .toBe('paused');
    const [refusedRequest] = await refusedCallbacks.listPending();
    await answer(refusedCallbacks, refusedRequest!, false);
    const rerun = await result(build(), { recordTo: refusedPath, resume: true, callbacks: refusedCallbacks });
    expect(rerun.outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 1, two: 2, three: 3 });
  });

  it('never lands the leftover fork of an interrupted isolated node', async () => {
    cwd = await tmpRepo();
    const { stdout: preSha } = await execa('git', ['rev-parse', 'HEAD'], { cwd });
    const { counts, node } = counters();
    const build = () => dag({
      name: 'trio',
      nodes: {
        one: node('one'),
        two: {
          needs: 'one',
          isolate: true,
          job: fnJob('two', async (ctx) => {
            counts.two += 1;
            await writeFile(join(ctx.workspace.dir, 'out.txt'), 'new');
          }),
        },
        three: { ...node('three'), needs: 'two' },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 1, two: 1, three: 1 });
    const truncated = await cutAfterStart(path, 'two');

    // What the dead attempt left behind: its fork branch, checked out in its
    // own worktree, with work committed on it. The base is back to before the run.
    const leftover = async () => {
      await execa('git', ['reset', '--hard', preSha], { cwd });
      await execa('git', ['worktree', 'prune'], { cwd });
      for (const dir of strayDirs.splice(0)) {
        await execa('git', ['worktree', 'remove', '--force', dir], { cwd, reject: false });
        await rm(dir, { recursive: true, force: true });
      }
      const { stdout: forks } = await execa('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/lines/'], { cwd });
      for (const fork of forks.split('\n').filter(Boolean)) {
        await execa('git', ['branch', '-D', fork], { cwd });
      }
      const wtDir = await mkdtemp(join(tmpdir(), 'obversa-leftover-'));
      strayDirs.push(wtDir);
      await execa('git', ['worktree', 'add', '-b', 'lines/trio-two-1', wtDir, 'HEAD'], { cwd });
      await writeFile(join(wtDir, 'out.txt'), 'old');
      await execa('git', ['add', '-A'], { cwd: wtDir });
      await execa('git', ['commit', '-m', 'old attempt'], { cwd: wtDir });
    };
    const leftoverLanded = async () =>
      (await execa('git', ['merge-base', '--is-ancestor', 'lines/trio-two-1', 'HEAD'], { cwd, reject: false })).exitCode === 0;
    const isolatedQuestion = /Stage "two" was interrupted\. It ran in its own worktree, and none of its work landed\. Approve to run it again from the start; refuse to stop the run/;

    // Approve: two runs again in a fresh fork and the base gets its new output.
    await writeFile(path, truncated);
    await leftover();
    const callbacks = createCallbackClient();
    const paused = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(isolatedQuestion);
    // The question comes before any new fork exists.
    expect(await branchExists(cwd, 'lines/trio-two-2')).toBe(false);
    const [request] = await callbacks.listPending();
    expect((request?.input as { stage?: string })?.stage).toBe('two');
    await answer(callbacks, request!);

    const approved = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(approved.outcome.status).toBe('pass');
    expect(counts.two).toBe(2);
    expect(counts.three).toBe(2);
    expect(await readFile(join(cwd, 'out.txt'), 'utf8')).toBe('new');
    const { stdout: mergeSubject } = await execa('git', ['log', '-1', '--format=%s'], { cwd });
    expect(mergeSubject).toBe('merge lines/trio-two-2 (node two)');
    expect(await leftoverLanded()).toBe(false);
    expect(await branchExists(cwd, 'lines/trio-two-1')).toBe(true);

    // Refuse: the run stops with two unresolved and the base untouched.
    const refusedPath = recordTo('refused.jsonl');
    await writeFile(refusedPath, truncated);
    await leftover();
    const refusedCallbacks = createCallbackClient();
    const refusedPause = await result(build(), { recordTo: refusedPath, resume: true, callbacks: refusedCallbacks });
    expect(refusedPause.outcome.status).toBe('paused');
    expect(refusedPause.outcome.summary).toMatch(isolatedQuestion);
    const [refusedRequest] = await refusedCallbacks.listPending();
    await answer(refusedCallbacks, refusedRequest!, false);

    const stopped = await result(build(), { recordTo: refusedPath, resume: true, callbacks: refusedCallbacks });
    expect(stopped.outcome.status).toBe('fail');
    expect(counts.two).toBe(2);
    expect(counts.three).toBe(2);
    expect((await execa('git', ['rev-parse', 'HEAD'], { cwd })).stdout).toBe(preSha);
    await expect(readFile(join(cwd, 'out.txt'), 'utf8')).rejects.toThrow();
    expect(await leftoverLanded()).toBe(false);
    expect(await branchExists(cwd, 'lines/trio-two-1')).toBe(true);
    expect(await branchExists(cwd, 'lines/trio-two-2')).toBe(false);
  });

  it('reuses the record only on the first pass of a loop around the dag', async () => {
    const { counts, node } = counters();
    const build = () => loop({
      name: 'again',
      max: 2,
      until: predicate(() => false, 'never met'),
      body: dag({
        name: 'trio',
        nodes: {
          one: node('one'),
          two: { ...node('two'), needs: 'one' },
          three: { ...node('three'), needs: 'two' },
        },
      }),
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('exhausted');
    expect(counts).toEqual({ one: 2, two: 2, three: 2 });

    // The first pass reuses the record; the second pass does new work.
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('exhausted');
    expect(counts).toEqual({ one: 3, two: 3, three: 3 });
  });

  it('puts effective isolation in the identity', async () => {
    cwd = await tmpRepo();
    const { counts, node } = counters();
    const build = (isolation?: 'worktree') => dag({
      name: 'trio',
      ...(isolation === undefined ? {} : { isolation }),
      nodes: {
        one: node('one'),
        two: { ...node('two'), needs: 'one' },
        three: { ...node('three'), needs: 'two' },
      },
    });
    const path = recordTo();

    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 1, two: 1, three: 1 });

    // A changed default isolation is a different declared shape: no reuse.
    const changed = await result(build('worktree'), { recordTo: path, resume: true });
    expect(changed.outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 2, two: 2, three: 2 });
    const identities = (await anchors(path)).map((event) => event.identity);
    expect(identities).toHaveLength(2);
    expect(identities[1]).not.toBe(identities[0]);

    // The same shape resumes cleanly: the third anchor matches the second
    // and nothing runs again.
    const again = await result(build('worktree'), { recordTo: path, resume: true });
    expect(again.outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 2, two: 2, three: 2 });
    const after = (await anchors(path)).map((event) => event.identity);
    expect(after).toHaveLength(3);
    expect(after[2]).toBe(after[1]);
  });

  it('puts a node-level isolate change in the identity', async () => {
    cwd = await tmpRepo();
    const { counts, node } = counters();
    const build = (isolate: boolean) => dag({
      name: 'trio',
      nodes: {
        one: node('one'),
        two: { ...node('two'), needs: 'one', isolate },
        three: { ...node('three'), needs: 'two' },
      },
    });
    const path = recordTo();

    expect((await result(build(false), { recordTo: path })).outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 1, two: 1, three: 1 });

    // The dag's own isolation stays unset; only one node's isolate flips.
    const changed = await result(build(true), { recordTo: path, resume: true });
    expect(changed.outcome.status).toBe('pass');
    expect(counts).toEqual({ one: 2, two: 2, three: 2 });
    const identities = (await anchors(path)).map((event) => event.identity);
    expect(identities).toHaveLength(2);
    expect(identities[1]).not.toBe(identities[0]);
  });

  it('keeps the brief in a workflow send-back checkpoint', async () => {
    let targetRuns = 0;
    const build = (brief: string) => workflow('draft', {
      brief,
      roles: {},
      stages: [
        stage('target', {
          fn: async () => {
            targetRuns += 1;
            return { status: 'pass' as const };
          },
          refine: judge({
            engine: new MockEngine(() => JSON.stringify({ stop_reason: { choice: 'product_decision' } })),
            identity: { adapter: 'mock', provider: 'mock', modelFamily: 'judge-mock', model: 'judge-mock', tools: [] },
          }, { cap: 2 }),
        }),
        stage('check', {
          needs: 'target',
          sendsBackTo: 'target',
          fn: async () => ({ status: 'fail' as const, summary: 'choose an audience' }),
        }),
      ],
    });
    const callbacks = createCallbackClient();
    const path = recordTo();

    const first = await result(build('Write for one audience.'), { recordTo: path, callbacks });
    expect(first.outcome.status).toBe('paused');
    expect(targetRuns).toBe(1);

    // A changed brief is a different workflow: the saved send-back state from
    // the first brief must not stand in for running its stages.
    await result(build('Write for a different audience.'), { recordTo: path, resume: true, callbacks });
    expect(targetRuns).toBe(2);
  });
});
