import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCallbackClient, dag, fnJob, judge, kickback, loop, predicate, revisionRequest, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, CallbackRequest, DagNode, Job, LoopEvent, RunCallbacks, RunOptions, RunResult } from '../src/api.ts';
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
          acceptsKickbackTo: ['two'],
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

  it('keeps the refinements spent and the judge history when the worker dies after a send-back', async () => {
    let builds = 0;
    const judgeRounds: { round: number; rounds: unknown[] }[] = [];
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: {
        write: judge({
          engine: new MockEngine((request) => {
            const { state } = JSON.parse(request.prompt) as { state: { round: number; rounds: unknown[] } };
            judgeRounds.push({ round: state.round, rounds: state.rounds });
            return JSON.stringify({ stop_reason: { choice: 'continue' } });
          }),
          identity: { adapter: 'mock', provider: 'mock', modelFamily: 'judge', model: 'judge', tools: [] },
        }, { cap: 1 }),
      },
      nodes: {
        write: { job: fnJob('write', () => { builds += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', () => revisionRequest({ target: 'write', reason: 'not yet', findings: [{ evidence: 'x', severity: 'should-fix' }] })),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(builds).toBe(2);
    expect(judgeRounds.map((r) => r.round)).toEqual([1, 2]);

    // The worker dies during the review of the second build.
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const cut = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'review' && event.phase === 'start' && event.attempt === 2;
    });
    expect(cut).toBeGreaterThanOrEqual(0);
    await writeFile(path, `${lines.slice(0, cut + 1).join('\n')}\n`);

    // The resume keeps the second build, reviews it again, and the judge sees
    // the second round with the first in its history: no third build.
    judgeRounds.length = 0;
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('fail');
    expect(builds).toBe(2);
    expect(judgeRounds).toEqual([{ round: 2, rounds: [expect.objectContaining({ round: 1 })] }]);
  });

  it('consults the judge of every target again when a failed review runs again on a resume', async () => {
    let choice = 'not_converging';
    const consulted: string[] = [];
    const judgeFor = (target: string) => judge({
      engine: new MockEngine(() => {
        consulted.push(target);
        return JSON.stringify({ stop_reason: { choice } });
      }),
      identity: { adapter: 'mock', provider: 'mock', modelFamily: 'judge', model: 'judge', tools: [] },
    }, { cap: 2 });
    const reviewOf = (target: string): DagNode => ({
      needs: target, acceptsKickbackTo: [target], retrySafe: true,
      job: fnJob(`review-${target}`, () => revisionRequest({ target, reason: 'not yet', findings: [{ evidence: 'x', severity: 'should-fix' }] })),
    });
    const build = () => dag({
      name: 'rounds',
      stopOnError: false,
      maxKickbacks: { a: judgeFor('a'), b: judgeFor('b') },
      nodes: {
        a: { job: fnJob('a', () => undefined) },
        b: { job: fnJob('b', () => undefined) },
        'review-a': reviewOf('a'),
        'review-b': reviewOf('b'),
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(consulted.sort()).toEqual(['a', 'b']);

    // Both reviews failed, so both run again on the resume. Each judge is
    // asked again, and both let the work stand.
    choice = 'holds';
    consulted.length = 0;
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(consulted.sort()).toEqual(['a', 'b']);
    expect(resumed.outcome.status).toBe('pass');
  });

  it('asks about an interrupted parent step when the graph inside it saved its rounds', async () => {
    let actions = 0;
    let builds = 0;
    const inner = dag({
      name: 'rounds',
      maxKickbacks: 1,
      nodes: {
        write: { job: fnJob('write', () => { builds += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', () => revisionRequest({ target: 'write', reason: 'not yet' })),
        },
      },
    });
    const build = (retrySafe = false) => dag({
      name: 'outer',
      nodes: {
        parent: {
          retrySafe,
          job: async (ctx) => {
            actions += 1;
            return inner(ctx);
          },
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect({ actions, builds }).toEqual({ actions: 1, builds: 2 });

    // The worker dies during the review of the second build, after the
    // graph inside the parent saved its rounds.
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const cut = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'review' && event.phase === 'start' && event.attempt === 2;
    });
    expect(cut).toBeGreaterThanOrEqual(0);
    expect(lines.slice(0, cut).some((line) => (JSON.parse(line) as LoopEvent).kind === 'interaction:checkpoint')).toBe(true);
    await writeFile(path, `${lines.slice(0, cut + 1).join('\n')}\n`);

    // The parent is not retrySafe: the resume asks before its action runs again.
    const paused = await result(build(), { recordTo: path, resume: true, callbacks: createCallbackClient() });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/Did stage "parent" finish/);
    expect({ actions, builds }).toEqual({ actions: 1, builds: 2 });

    // A retrySafe parent runs again, and the graph inside it counts on from
    // its saved rounds: no third build.
    const safePath = recordTo('safe.jsonl');
    await writeFile(safePath, `${lines.slice(0, cut + 1).join('\n')}\n`);
    expect((await result(build(true), { recordTo: safePath, resume: true })).outcome.status).toBe('fail');
    expect({ actions, builds }).toEqual({ actions: 2, builds: 2 });
  });

  it('builds again on a resume when the worker dies between a send-back and the build', async () => {
    let builds = 0;
    const feedback: (string | undefined)[] = [];
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        write: { job: fnJob('write', (ctx) => { builds += 1; feedback.push(ctx.lastReview?.summary); }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', () => kickback('write', 'not yet')),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(builds).toBe(2);

    // The worker dies after the send-back, before the second build starts.
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const cut = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'write' && event.phase === 'start' && event.attempt === 2;
    });
    expect(cut).toBeGreaterThan(0);
    await writeFile(path, `${lines.slice(0, cut).join('\n')}\n`);

    // The first build's result never stands for the second: the resume
    // builds again with the send-back, and the refinement stays spent.
    builds = 0;
    feedback.length = 0;
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('fail');
    expect(builds).toBe(1);
    expect(feedback).toEqual([expect.stringContaining('not yet')]);
  });

  it('runs a failed step again on a resume after a send-back', async () => {
    const runs = { write: 0, review: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        write: { job: fnJob('write', () => { runs.write += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'],
          job: fnJob('review', () => { runs.review += 1; return runs.review === 1 ? kickback('write', 'not yet') : undefined; }),
        },
        check: {
          needs: 'review',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 2, review: 2, check: 1 });

    // The worker dies once the check's failure is saved, before the graph ended.
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const failed = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'check' && event.outcome?.status === 'fail';
    });
    expect(failed).toBeGreaterThan(0);
    const saved = JSON.parse(lines[failed + 1]!) as LoopEvent;
    expect(saved.kind === 'interaction:checkpoint' && saved.data !== null).toBe(true);
    await writeFile(path, `${lines.slice(0, failed + 2).join('\n')}\n`);

    checkFails = false;
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, review: 2, check: 2 });
  });

  it('checks a skipped step\'s condition again on a resume after a send-back', async () => {
    const runs = { write: 0, review: 0, extra: 0, check: 0 };
    let extraWanted = false;
    let checkFails = true;
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        write: { job: fnJob('write', () => { runs.write += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'],
          job: fnJob('review', () => { runs.review += 1; return runs.review === 1 ? kickback('write', 'not yet') : undefined; }),
        },
        extra: { needs: 'review', when: () => extraWanted, job: fnJob('extra', () => { runs.extra += 1; }) },
        check: {
          needs: ['review', 'extra'],
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 2, review: 2, extra: 0, check: 1 });

    // The worker dies once the check's failure is saved, after the extra
    // step was skipped.
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    const failed = lines.findIndex((line) => {
      const event = JSON.parse(line) as LoopEvent;
      return event.kind === 'dag:node' && event.node === 'check' && event.outcome?.status === 'fail';
    });
    expect(failed).toBeGreaterThan(0);
    await writeFile(path, `${lines.slice(0, failed + 2).join('\n')}\n`);

    // The resume asks the skipped step's condition again, and runs it.
    extraWanted = true;
    checkFails = false;
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, review: 2, extra: 1, check: 2 });
  });

  it('saves the rounds when an earlier step\'s data holds a date', async () => {
    let builds = 0;
    let reviews = 0;
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        lookup: { job: fnJob('lookup', () => ({ status: 'pass' as const, summary: 'found', data: { createdAt } })) },
        write: { needs: 'lookup', job: fnJob('write', () => { builds += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'],
          job: fnJob('review', () => { reviews += 1; return reviews === 1 ? kickback('write', 'not yet') : undefined; }),
        },
      },
    });
    const events: LoopEvent[] = [];
    const done = await result(build(), { onEvent: (event) => { events.push(event); } });
    expect(done.outcome.status).toBe('pass');
    expect(builds).toBe(2);

    // The saved rounds hold the date as the record writes it.
    const saved = events.find((event) => event.kind === 'interaction:checkpoint' && event.data !== null);
    expect(saved?.kind === 'interaction:checkpoint' && (saved.data?.results as Record<string, { data?: unknown }>).lookup?.data)
      .toEqual({ createdAt: createdAt.toISOString() });
  });

  it('keeps the refinements spent when the run is aborted after a send-back', async () => {
    let builds = 0;
    let reviews = 0;
    const controller = new AbortController();
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        write: { job: fnJob('write', () => { builds += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', () => {
            reviews += 1;
            if (reviews === 2) {
              controller.abort();
              return { status: 'aborted' as const, summary: 'stopped' };
            }
            return kickback('write', 'not yet');
          }),
        },
      },
    });
    const path = recordTo();
    const first = await run(build(), { cwd, signal: controller.signal, recordTo: path });
    expect(first.outcome.status).toBe('aborted');
    expect(builds).toBe(2);

    // The one refinement is spent: the resumed review's send-back is refused.
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('fail');
    expect(builds).toBe(2);
    expect(reviews).toBe(3);
  });

  it('keeps the refinements spent when a run that ran out of rounds is resumed', async () => {
    let builds = 0;
    let reviews = 0;
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        write: { job: fnJob('write', () => { builds += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', () => { reviews += 1; return kickback('write', 'not yet'); }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(builds).toBe(2);
    expect((await recordEvents(path)).some((event) => event.kind === 'dag:end')).toBe(true);

    // The whole failed record is resumed: the review runs again, and its
    // send-back is refused, because the one refinement is spent.
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('fail');
    expect(builds).toBe(2);
    expect(reviews).toBe(3);
  });

  it('starts the rounds afresh on a later loop pass after a pass that ran out of rounds', async () => {
    let builds = 0;
    const build = () => loop({
      name: 'again',
      max: 2,
      until: predicate(() => false, 'never met'),
      body: dag({
        name: 'rounds',
        maxKickbacks: { write: 1 },
        nodes: {
          write: { job: fnJob('write', () => { builds += 1; }) },
          review: {
            needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
            job: fnJob('review', () => kickback('write', 'not yet')),
          },
        },
      }),
    });
    const path = recordTo();
    await result(build(), { recordTo: path });
    expect(builds).toBe(4);

    // The first pass counts on from the saved rounds and builds nothing; the
    // second pass has its own refinement to spend.
    builds = 0;
    await result(build(), { recordTo: path, resume: true });
    expect(builds).toBe(2);
  });

  it('runs only the last round again when a reviewed stage that ran out of rounds is resumed', async () => {
    let builds = 0;
    const writer = new MockEngine((request) => {
      builds += 1;
      writeFileSync(join(request.cwd!, 'page.md'), `draft ${builds}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine(() => JSON.stringify({
      status: 'revise', summary: 'not yet', findings: [{ severity: 'should-fix', evidence: 'the page never says who it is for' }],
    }));
    const seat = (engine: MockEngine, model: string, tools: readonly string[] = []) =>
      ({ engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } });
    const build = () => workflow('rounds', {
      brief: 'Write the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', retrySafe: true, refine: 1 })],
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(builds).toBe(2);

    // The failed stage runs again from its last round: one build, its
    // review refused, and no refinement past the one allowed.
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('fail');
    expect(builds).toBe(3);
  });

  it('keeps a reviewed stage\'s judge history and skipped findings when the run is aborted between its rounds', async () => {
    const controller = new AbortController();
    const writerCalls: AgentRequest[] = [];
    const reviewCalls: AgentRequest[] = [];
    const judgeCalls: AgentRequest[] = [];
    const real = { severity: 'should-fix', evidence: 'REAL: the page never says who it is for' };
    const tone = { severity: 'nice-to-have', evidence: 'taste: prefer a warmer tone' };
    const writer = new MockEngine((request) => {
      writerCalls.push(request);
      writeFileSync(join(request.cwd!, 'page.md'), `draft ${writerCalls.length}`);
      // The run is stopped while the second build is under way.
      if (writerCalls.length === 2) controller.abort();
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine((request) => {
      reviewCalls.push(request);
      return JSON.stringify(reviewCalls.length === 1
        ? { status: 'revise', summary: 'two findings', findings: [real, tone] }
        : { status: 'revise', summary: 'one finding', findings: [{ ...real, evidence: 'REAL: the second section is empty' }] });
    });
    // Acts on a finding marked REAL and skips the rest; says continue.
    const judgeEngine = new MockEngine((request) => {
      judgeCalls.push(request);
      const { questions } = JSON.parse(request.prompt) as { questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
      const answers: Record<string, unknown> = { stop_reason: { choice: 'continue' } };
      for (const [key, question] of Object.entries(questions)) {
        if (!('act' in question.criteria)) continue;
        answers[key] = question.instructions.includes('REAL')
          ? { choice: 'act', reason: 'a reader cannot tell who the page is for' }
          : { choice: 'skip', reason: 'a matter of taste' };
      }
      return JSON.stringify(answers);
    });
    const seat = (engine: MockEngine, model: string, tools: readonly string[] = []) =>
      ({ engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } });
    const build = () => workflow('rounds', {
      brief: 'Use case: a reader gets a clear, short page.\n\nWrite the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', {
        agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', retrySafe: true,
        refine: judge(seat(judgeEngine, 'judge-mock'), { cap: 3 }),
      })],
    });
    const path = recordTo();
    const first = await run(build(), { cwd, signal: controller.signal, recordTo: path });
    expect(first.outcome.status).toBe('aborted');
    expect(judgeCalls).toHaveLength(1);

    // The resume builds the second round again with the judge's send-back.
    // Its reviewer hears what the judge skipped, and the judge reads round
    // two with round one in its history.
    writerCalls.length = 0;
    reviewCalls.length = 0;
    judgeCalls.length = 0;
    await result(build(), { recordTo: path, resume: true });
    expect(writerCalls[0]!.prompt).toContain(real.evidence);
    expect(writerCalls[0]!.prompt).not.toContain(tone.evidence);
    expect(reviewCalls[0]!.prompt).toContain(tone.evidence);
    expect(reviewCalls[0]!.prompt).toContain('a matter of taste');
    const { state } = JSON.parse(judgeCalls[0]!.prompt) as { state: { round: number; rounds: { round: number }[]; skipped?: unknown } };
    expect(state.round).toBe(2);
    expect(state.rounds.map((r) => r.round)).toEqual([1]);
    expect(state.skipped).toMatchObject([{ round: 1, finding: tone, reason: 'a matter of taste' }]);
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
