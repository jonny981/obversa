import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createStoredCallbackClient, dag, fnJob, goalCheck, judge, revisionRequest, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, LoopEvent, Outcome, TeamSeat } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.ts';

function seat(engine: MockEngine, model: string, tools: readonly string[] = []): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}

const dirs: string[] = [];
const stores: StoredRunFixture[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goal-check-'));
  dirs.push(dir);
  return dir;
}

const MET = { requirement: 'The page names who it is for', verdict: 'met', evidence: 'page.md:1 says it is for new staff' };
const UNMET = { requirement: 'The page lists the opening hours', verdict: 'unmet', evidence: 'MISSING: page.md has no opening hours' };
const allMet = { requirements: [MET] };
const oneUnmet = { requirements: [MET, UNMET] };

const PASS = { status: 'pass', summary: 'nothing to add' };
const REVISE = { status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'REVIEW: the title is vague' }] };

/** The scripted reply for this call: the last one repeats if the loop runs longer. */
function scripted(replies: readonly unknown[], calls: AgentRequest[]) {
  return (req: AgentRequest) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
    calls.push(req);
    return JSON.stringify(reply);
  };
}

/**
 * A one-stage team: a writer that writes `page.md`, a goal seat and a
 * reviewer each scripted one reply per round, and an optional judge.
 */
function scriptedTeam(opts: {
  readonly goalReplies: readonly unknown[];
  readonly reviewerReplies: readonly unknown[];
  readonly judgeReplies?: readonly unknown[];
  readonly refine?: number;
  /** The writer leaves `page.md` out in its first round. */
  readonly skipFirstWrite?: boolean;
}) {
  const writerCalls: AgentRequest[] = [];
  const goalCalls: AgentRequest[] = [];
  const reviewCalls: AgentRequest[] = [];
  const judgeCalls: AgentRequest[] = [];
  const writer = new MockEngine((req) => {
    writerCalls.push(req);
    if (!(opts.skipFirstWrite && writerCalls.length === 1)) writeFileSync(join(req.cwd!, 'page.md'), `draft ${writerCalls.length}`);
    return JSON.stringify({ status: 'pass', summary: 'wrote it' });
  });
  const goalEngine = new MockEngine(scripted(opts.goalReplies, goalCalls));
  const reviewer = new MockEngine(scripted(opts.reviewerReplies, reviewCalls));
  const judgeEngine = new MockEngine(scripted(opts.judgeReplies ?? [], judgeCalls));
  const job = workflow('goal-test', {
    brief: 'Write a welcome page. It must name who it is for and list the opening hours.',
    roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
    stages: [
      stage('write', {
        agent: 'writer',
        writes: 'page.md',
        desc: 'Write the welcome page.',
        gate: 'Every requirement in the brief is on the page.',
        goal: seat(goalEngine, 'goal-mock', ['Read']),
        reviewedBy: 'reviewer',
        refine: opts.judgeReplies ? judge(seat(judgeEngine, 'judge-mock'), { cap: opts.refine ?? 3 }) : opts.refine ?? 3,
      }),
    ],
  });
  return { job, writerCalls, goalCalls, reviewCalls, judgeCalls };
}

async function runTeam(job: ReturnType<typeof scriptedTeam>['job'], events: LoopEvent[] = []) {
  return run(job, { cwd: workDir(), onEvent: (event) => events.push(event) });
}

function goalEvents(events: readonly LoopEvent[]) {
  return events.filter((e): e is Extract<LoopEvent, { kind: 'goal:check' }> => e.kind === 'goal:check');
}

describe('workflow(): goal on an agent stage', () => {
  it('sends an unmet requirement back with its evidence, and the reviewers do not run that round', async () => {
    const { job, writerCalls, goalCalls, reviewCalls } = scriptedTeam({ goalReplies: [oneUnmet, allMet], reviewerReplies: [PASS] });
    const result = await runTeam(job);
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(2);
    expect(goalCalls).toHaveLength(2);
    // Round one stopped at the goal check; only round two reached the reviewer.
    expect(reviewCalls).toHaveLength(1);
    expect(writerCalls[0]!.prompt).not.toContain('MISSING');
    expect(writerCalls[1]!.prompt).toContain('The page lists the opening hours');
    expect(writerCalls[1]!.prompt).toContain('MISSING: page.md has no opening hours');
  });

  it('gives the goal seat the brief, the task, the gate and the work, read-only', async () => {
    const { job, goalCalls } = scriptedTeam({ goalReplies: [allMet], reviewerReplies: [PASS] });
    await runTeam(job);
    const prompt = goalCalls[0]!.prompt;
    expect(prompt).toContain('list the opening hours');
    expect(prompt).toContain('Write the welcome page.');
    expect(prompt).toContain('Every requirement in the brief is on the page.');
    expect(prompt).toContain('page.md');
    expect(goalCalls[0]!.workspaceMode).toBe('read');
  });

  it('lets the reviewers run when every requirement is met', async () => {
    const { job, goalCalls, reviewCalls } = scriptedTeam({ goalReplies: [allMet], reviewerReplies: [PASS] });
    const result = await runTeam(job);
    expect(result.outcome.status).toBe('pass');
    expect(goalCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
  });

  it('does not ask the judge about unmet requirements', async () => {
    // A judge that would let any round stand: an unmet requirement must not reach it.
    const { job, writerCalls, judgeCalls, reviewCalls } = scriptedTeam({
      goalReplies: [oneUnmet, allMet],
      reviewerReplies: [REVISE],
      judgeReplies: [{ stop_reason: { choice: 'holds' } }],
    });
    const result = await runTeam(job);
    expect(result.outcome.status).toBe('pass');
    // Round one went back on the goal check alone; the judge only saw round two's review.
    expect(writerCalls).toHaveLength(2);
    expect(reviewCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]!.prompt).toContain('REVIEW: the title is vague');
    expect(judgeCalls[0]!.prompt).not.toContain('opening hours');
  });

  it('runs the goal check again in the next round, after a fix for a reviewer', async () => {
    const { job, writerCalls, goalCalls, reviewCalls } = scriptedTeam({
      goalReplies: [allMet, oneUnmet, allMet],
      reviewerReplies: [REVISE, PASS],
    });
    const result = await runTeam(job);
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(3);
    expect(goalCalls).toHaveLength(3);
    // Rounds one and three reached the reviewer; round two broke a requirement.
    expect(reviewCalls).toHaveLength(2);
    expect(writerCalls[2]!.prompt).toContain('MISSING: page.md has no opening hours');
  });

  it('records one goal:check event per round with each verdict and its evidence', async () => {
    const events: LoopEvent[] = [];
    const { job } = scriptedTeam({ goalReplies: [oneUnmet, allMet], reviewerReplies: [PASS] });
    await runTeam(job, events);
    const checks = goalEvents(events);
    expect(checks.map((event) => event.round)).toEqual([1, 2]);
    expect(checks[0]!.requirements).toEqual([MET, UNMET]);
    expect(checks[1]!.requirements).toEqual([MET]);
  });

  it('runs the goal check in a round where the builder left out a declared file', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, goalCalls, reviewCalls } = scriptedTeam({ goalReplies: [oneUnmet, allMet], reviewerReplies: [PASS], skipFirstWrite: true });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(goalCalls).toHaveLength(2);
    expect(goalEvents(events).map((event) => event.round)).toEqual([1, 2]);
    expect(reviewCalls).toHaveLength(1);
    expect(writerCalls[1]!.prompt).toContain('MISSING: page.md has no opening hours');
  });

  it('keeps the reviewers back while a declared file is missing, even when every requirement is met', async () => {
    const { job, writerCalls, goalCalls, reviewCalls } = scriptedTeam({ goalReplies: [allMet], reviewerReplies: [PASS], skipFirstWrite: true });
    const result = await runTeam(job);
    expect(result.outcome.status).toBe('pass');
    expect(goalCalls).toHaveLength(2);
    // Round one stopped at the file check; only round two reached the reviewer.
    expect(reviewCalls).toHaveLength(1);
    expect(writerCalls[1]!.prompt).toContain('page.md');
  });

  it('pauses when the goal seat twice sends no readable list, and the reviewers do not run', async () => {
    const { job, writerCalls, goalCalls, reviewCalls } = scriptedTeam({ goalReplies: ['no list here'], reviewerReplies: [PASS] });
    const result = await runTeam(job);
    expect(result.outcome.status).toBe('paused');
    expect(writerCalls).toHaveLength(1);
    expect(goalCalls).toHaveLength(2);
    expect(reviewCalls).toHaveLength(0);
  });

  it('does not run the goal check again when a run resumes at a judge question', async () => {
    const cwd = workDir();
    const recordTo = join(cwd, 'record.jsonl');
    const store = await createStoredRunFixture('goal-check');
    stores.push(store);
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    const events: LoopEvent[] = [];
    const calls = { writer: 0, goal: 0, reviewer: 0, judge: 0 };
    // Each run is a fresh worker: a fresh team over the same record.
    const resume = async (again: boolean) => {
      const team = scriptedTeam({
        goalReplies: [allMet],
        reviewerReplies: [REVISE],
        judgeReplies: [{ stop_reason: { choice: calls.judge === 0 ? 'product_decision' : 'holds' } }],
      });
      const result = await run(team.job, { cwd, recordTo, callbacks, resume: again, onEvent: (event) => events.push(event) });
      calls.writer += team.writerCalls.length;
      calls.goal += team.goalCalls.length;
      calls.reviewer += team.reviewCalls.length;
      calls.judge += team.judgeCalls.length;
      return result.outcome.status;
    };
    expect(await resume(false)).toBe('paused');
    expect(await resume(true)).toBe('paused');
    // The round waits on the judge's question: nothing before it runs again.
    expect(calls).toEqual({ writer: 1, goal: 1, reviewer: 1, judge: 1 });
    expect(goalEvents(events).map((event) => event.round)).toEqual([1]);
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('claim refused');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { feedback: {}, prompt: 'Write for new staff.' })).toMatchObject({ ok: true });
    expect(await resume(true)).toBe('pass');
    // The answer is round two: one more build, goal check, review and judge.
    expect(calls).toEqual({ writer: 2, goal: 2, reviewer: 2, judge: 2 });
    expect(goalEvents(events).map((event) => event.round)).toEqual([1, 2]);
  });

  it('refuses a goal on a stage no panel reviews', () => {
    const engine = new MockEngine(() => '{}');
    expect(() => workflow('goal-unreviewed', {
      brief: 'Write a page.',
      roles: { writer: seat(engine, 'writer-mock', ['Write']) },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', goal: seat(engine, 'goal-mock', ['Read']) })],
    })).toThrow(/goal is for an agent stage reviewed by a panel/);
  });
});

describe('goalCheck(): the dag() helper', () => {
  it('sends unmet requirements back to its target as a revision, and passes once they are met', async () => {
    const goalCalls: AgentRequest[] = [];
    const goalEngine = new MockEngine(scripted([oneUnmet, allMet], goalCalls));
    const builds: (Outcome | undefined)[] = [];
    let reviews = 0;
    const events: LoopEvent[] = [];
    const graph = dag({
      name: 'goal-dag',
      maxKickbacks: 1,
      nodes: {
        build: { job: fnJob('build', (ctx) => { builds.push(ctx.lastReview); return 'built'; }) },
        goal: {
          needs: 'build',
          job: goalCheck(seat(goalEngine, 'goal-mock', ['Read']), {
            target: 'build',
            text: 'Write a welcome page that lists the opening hours.',
          }),
        },
        review: { needs: 'goal', job: fnJob('review', () => { reviews += 1; return 'read it'; }) },
      },
    });
    const result = await run(graph, { cwd: workDir(), onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    expect(builds).toHaveLength(2);
    expect(builds[0]).toBeUndefined();
    expect(builds[1]?.revision?.target).toBe('build');
    expect(builds[1]?.revision?.findings?.map((finding) => finding.evidence).join('\n')).toContain('MISSING: page.md has no opening hours');
    expect(reviews).toBe(1);
    expect(goalCalls[0]!.prompt).toContain('lists the opening hours');
    expect(goalEvents(events).map((event) => event.round)).toEqual([1, 2]);
  });

  it('sends unmet requirements back past a judge on the target, which still decides the review', async () => {
    const goalCalls: AgentRequest[] = [];
    const judgeCalls: AgentRequest[] = [];
    const goalEngine = new MockEngine(scripted([oneUnmet, allMet], goalCalls));
    // A judge that would let any round stand: an unmet requirement must not reach it.
    const judgeEngine = new MockEngine(scripted([{ stop_reason: { choice: 'holds' } }], judgeCalls));
    let builds = 0;
    let reviews = 0;
    const graph = dag({
      name: 'goal-dag-judged',
      maxKickbacks: { build: judge(seat(judgeEngine, 'judge-mock'), { cap: 2 }) },
      nodes: {
        build: { job: fnJob('build', () => { builds += 1; return 'built'; }) },
        goal: {
          needs: 'build',
          job: goalCheck(seat(goalEngine, 'goal-mock', ['Read']), {
            target: 'build',
            text: 'Write a welcome page that lists the opening hours.',
          }),
        },
        review: { needs: 'goal', job: async () => { reviews += 1; return revisionRequest({ target: 'build', findings: [{ severity: 'should-fix', evidence: 'REVIEW: the title is vague' }] }); } },
      },
    });
    const result = await run(graph, { cwd: workDir() });
    expect(result.outcome.status).toBe('pass');
    // Round one went back on the goal check alone; the judge only saw the review.
    expect(builds).toBe(2);
    expect(goalCalls).toHaveLength(2);
    expect(reviews).toBe(1);
    expect(judgeCalls).toHaveLength(1);
    expect(judgeCalls[0]!.prompt).toContain('REVIEW: the title is vague');
    expect(judgeCalls[0]!.prompt).not.toContain('opening hours');
  });
});
