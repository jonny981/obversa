import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { judge, run, stage, stopQuestions, workflow } from '../src/api.ts';
import type { AgentRequest, JudgeQuestions, LoopEvent, Outcome, TeamSeat } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

function seat(engine: MockEngine, model: string, tools: readonly string[] = []): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'refine-judge-'));
  dirs.push(dir);
  return dir;
}

/**
 * A one-stage team: a writer that writes `page.md` and always passes, a
 * reviewer scripted one reply per round (the last reply repeats if the loop
 * runs longer), and a judge scripted the same way. `reviewCalls`/`judgeCalls`
 * are every request each of them actually received, in order, so a test can
 * assert both on outcomes and on what was and was not asked.
 */
function scriptedTeam(opts: {
  readonly reviewerReplies: readonly unknown[];
  readonly judgeReplies: readonly unknown[];
  readonly cap: number;
  readonly questions?: JudgeQuestions;
  readonly brief?: string;
}) {
  const reviewCalls: AgentRequest[] = [];
  const judgeCalls: AgentRequest[] = [];
  const writer = new MockEngine((req) => {
    writeFileSync(join(req.cwd!, 'page.md'), `draft ${reviewCalls.length}`);
    return JSON.stringify({ status: 'pass', summary: 'wrote it' });
  });
  const reviewer = new MockEngine((req) => {
    const reply = opts.reviewerReplies[Math.min(reviewCalls.length, opts.reviewerReplies.length - 1)];
    reviewCalls.push(req);
    return JSON.stringify(reply);
  });
  const judgeEngine = new MockEngine((req) => {
    const reply = opts.judgeReplies[Math.min(judgeCalls.length, opts.judgeReplies.length - 1)];
    judgeCalls.push(req);
    return JSON.stringify(reply);
  });
  const job = workflow('refine-test', {
    brief: opts.brief ?? 'Use case: a reader gets a clear, short page.\n\nWrite the page.',
    roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
    stages: [
      stage('write', {
        agent: 'writer',
        writes: 'page.md',
        reviewedBy: 'reviewer',
        refine: judge(seat(judgeEngine, 'judge-mock'), { cap: opts.cap, questions: opts.questions }),
      }),
    ],
  });
  return { job, reviewCalls, judgeCalls };
}

async function runTeam(job: ReturnType<typeof scriptedTeam>['job'], events: LoopEvent[]) {
  return run(job, { cwd: workDir(), onEvent: (event) => events.push(event) });
}

const REVISE = (severity: 'block' | 'should-fix' = 'should-fix') =>
  ({ status: 'revise', summary: 'one finding', findings: [{ severity, evidence: 'fix this' }] });
const PASS = { status: 'pass', summary: 'nothing to add' };

describe('refine: judge()', () => {
  it('stops on holds at round two', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE(), REVISE()],
      judgeReplies: [{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'holds' } }],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(judgeCalls).toHaveLength(2);
    const judgeEvents = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
    expect(judgeEvents).toHaveLength(2);
    expect(judgeEvents[0]!.reason).toBe('the judge chose continue');
    expect(judgeEvents[1]!.reason).toBe('the judge chose holds');
  });

  it('stops at the cap with the judge still saying continue', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{ stop_reason: { choice: 'continue' } }],
      cap: 2,
    });
    const result = await runTeam(job, events);
    // dag() does not treat a required node ending `exhausted` as a failure
    // (only `fail`/`aborted`), so the workflow's own top-level status is
    // still `pass`; the review loop's own outcome is where the cap shows.
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('exhausted');
    // The cap is the last word: exactly `cap` consultations, never more, even
    // though every one of them said "continue".
    expect(judgeCalls).toHaveLength(2);
    expect(judgeCalls.every((call) => JSON.parse(call.prompt).questions !== undefined)).toBe(true);
  });

  it('runs another round on a chosen continue even when worth_another_round is below one half, up to the cap', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls, reviewCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{
        holds: { noul: 0.2 },
        worth_doing: { noul: 0.8 },
        worth_another_round: { noul: 0.49 },
        stop_reason: { choice: 'continue' },
      }],
      cap: 3,
    });
    const result = await runTeam(job, events);
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('exhausted');
    // A cap of 3 is three rounds in all, the first draft included. The old
    // routing stopped after the first round, on worth_another_round alone.
    expect(reviewCalls).toHaveLength(3);
    expect(judgeCalls).toHaveLength(3);
    const judgeEvents = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
    expect(judgeEvents.map((e) => e.route)).toEqual(['again', 'again', 'again']);
    expect(judgeEvents[0]).toMatchObject({ reason: 'the judge chose continue', rule: 'stop_reason: continue' });
    expect(judgeEvents[0]!.status).toBeUndefined();
  });

  it('the judge event says the route, the rule and the status a stop gives the node', async () => {
    for (const [reply, rule, status] of [
      [{ stop_reason: { choice: 'holds' } }, 'stop_reason: holds', 'pass'],
      [{ stop_reason: { choice: 'not_converging' } }, 'stop_reason: not_converging', 'fail'],
      [{ worth_another_round: { noul: 0.3 } }, 'worth_another_round: 0.30', 'fail'],
    ] as const) {
      const events: LoopEvent[] = [];
      const { job } = scriptedTeam({ reviewerReplies: [REVISE()], judgeReplies: [reply], cap: 3 });
      await runTeam(job, events);
      const judgeEvents = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
      expect(judgeEvents).toHaveLength(1);
      expect(judgeEvents[0], rule).toMatchObject({ route: 'stop', rule, status });
    }
  });

  it('a block finding goes back even when the judge says stop', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE('block'), PASS],
      judgeReplies: [{ stop_reason: { choice: 'holds' } }],
      cap: 3,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    // The judge is never consulted about a block finding: it always goes
    // back on its own, so no refine:judge event should carry round one.
    expect(judgeCalls).toHaveLength(0);
    const judgeEvents = events.filter((e) => e.kind === 'refine:judge');
    expect(judgeEvents).toHaveLength(0);
  });

  it('the custom question set reaches the judge verbatim', async () => {
    // Not just for reviewing code: a caller for a different use case (a
    // trading digest) writes its own wording, but keeps the `stop_reason`
    // convention so the runtime's routing still understands it.
    const events: LoopEvent[] = [];
    const customQuestions: JudgeQuestions = {
      stop_reason: {
        type: 'choice',
        instructions: 'Has the digest converged on the day\'s read? If not, continue.',
        criteria: { holds: 'The digest holds for a trader reading it once.', continue: 'Another pass is worth it.' },
      },
    };
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{ stop_reason: { choice: 'holds' } }],
      cap: 3,
      questions: customQuestions,
    });
    await runTeam(job, events);
    expect(judgeCalls).toHaveLength(1);
    const sent = JSON.parse(judgeCalls[0]!.prompt) as { questions: unknown };
    expect(sent.questions).toEqual(customQuestions);
  });

  it('records each judge answer as an event a person can read', async () => {
    const events: LoopEvent[] = [];
    const { job } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{
        holds: { noul: 0.2 },
        worth_doing: { noul: 0.9 },
        worth_another_round: { noul: 0.8 },
        stop_reason: { choice: 'not_converging' },
      }],
      cap: 3,
    });
    const result = await runTeam(job, events);
    const judgeEvents = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
    expect(judgeEvents).toHaveLength(1);
    expect(judgeEvents[0]!.answers.stop_reason).toEqual({ choice: 'not_converging' });
    expect(judgeEvents[0]!.reason).toBe('the judge chose not_converging');
    // F141: not_converging does not ship the review's rejection as a pass.
    // Another round would not fix it, so the stage stops there and fails.
    expect(result.outcome.status).toBe('fail');
  });

  it('ships on holds, ships on over_polishing, fails on not_converging: the stage stops instead of trying again', async () => {
    for (const [choice, expectedStatus] of [
      ['holds', 'pass'],
      ['over_polishing', 'pass'],
      ['not_converging', 'fail'],
    ] as const) {
      const events: LoopEvent[] = [];
      const { job } = scriptedTeam({
        reviewerReplies: [REVISE()],
        judgeReplies: [{ stop_reason: { choice } }],
        cap: 5,
      });
      const result = await runTeam(job, events);
      expect(result.outcome.status, `stop_reason: ${choice}`).toBe(expectedStatus);
    }
  });

  it('uses the default question set (stopQuestions) reaching the judge verbatim when none is given', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{ stop_reason: { choice: 'holds' } }],
      cap: 2,
    });
    await runTeam(job, events);
    const sent = JSON.parse(judgeCalls[0]!.prompt) as { questions: unknown };
    expect(sent.questions).toEqual(stopQuestions('the draft'));
  });
});
