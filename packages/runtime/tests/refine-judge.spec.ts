import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { dag, EngineError, fnJob, judge, review, revisionRequest, run, stage, stopQuestions, withEnv, workflow } from '../src/api.ts';
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
  readonly cap?: number;
  readonly questions?: JudgeQuestions;
  readonly perFinding?: boolean;
  readonly brief?: string;
  readonly draftText?: string;
  readonly judgeEngine?: MockEngine;
}) {
  const writerCalls: AgentRequest[] = [];
  const reviewCalls: AgentRequest[] = [];
  const judgeCalls: AgentRequest[] = [];
  const writer = new MockEngine((req) => {
    writerCalls.push(req);
    writeFileSync(join(req.cwd!, 'page.md'), opts.draftText ?? `draft ${reviewCalls.length}`);
    return JSON.stringify({ status: 'pass', summary: 'wrote it' });
  });
  const reviewer = new MockEngine((req) => {
    const reply = opts.reviewerReplies[Math.min(reviewCalls.length, opts.reviewerReplies.length - 1)];
    reviewCalls.push(req);
    return JSON.stringify(reply);
  });
  const judgeEngine = opts.judgeEngine ?? new MockEngine((req) => {
    const reply = opts.judgeReplies[Math.min(judgeCalls.length, opts.judgeReplies.length - 1)];
    judgeCalls.push(req);
    return JSON.stringify(typeof reply === 'function' ? reply(req.prompt) : reply);
  });
  const job = workflow('refine-test', {
    brief: opts.brief ?? 'Use case: a reader gets a clear, short page.\n\nWrite the page.',
    roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
    stages: [
      stage('write', {
        agent: 'writer',
        writes: 'page.md',
        reviewedBy: 'reviewer',
        refine: judge(seat(judgeEngine, 'judge-mock'), {
          ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
          questions: opts.questions,
          ...(opts.perFinding !== undefined ? { perFinding: opts.perFinding } : {}),
        }),
      }),
    ],
  });
  return { job, writerCalls, reviewCalls, judgeCalls };
}

async function runTeam(job: ReturnType<typeof scriptedTeam>['job'], events: LoopEvent[]) {
  return run(job, { cwd: workDir(), onEvent: (event) => events.push(event) });
}

const REVISE = (severity: 'block' | 'should-fix' = 'should-fix') =>
  ({ status: 'revise', summary: 'one finding', findings: [{ severity, evidence: 'fix this' }] });
const PASS = { status: 'pass', summary: 'nothing to add' };

const REAL = { severity: 'should-fix', evidence: 'REAL: the page never says who it is for' } as const;
const TONE = { severity: 'nice-to-have', evidence: 'taste: prefer a warmer tone' } as const;
const TITLE = { severity: 'nice-to-have', evidence: 'taste: a shorter title reads better' } as const;
const revise = (...findings: readonly unknown[]) => ({ status: 'revise', summary: `${findings.length} findings`, findings });

/** A complete reply to the round questions: every probability a clear yes. */
function roundAnswers(choice: string): Record<string, unknown> {
  return {
    holds: { noul: 0.9 },
    worth_doing: { noul: 0.9 },
    worth_another_round: { noul: 0.9 },
    stop_reason: { choice },
  };
}

/**
 * The answer a finding's question gets, in its own shape: round 1 asks
 * `act` or `skip`, and from round 2 on a yes/no impactful-or-minor. A
 * finding marked REAL is acted on or called impactful, the rest is held
 * back, each with a reason that names the finding.
 */
function findingAnswer(question: { type: string; instructions: string }) {
  const impactful = question.instructions.includes('REAL');
  const reason = impactful ? 'a reader cannot tell who the page is for' : 'a matter of taste';
  return question.type === 'choice'
    ? { choice: impactful ? 'act' : 'skip', reason }
    : { noul: impactful ? 0.9 : 0.1, reason };
}

/**
 * A judge that answers every question it is sent. `round` overrides the
 * round answers (`roundAnswers('continue')` when not given).
 */
function perFinding(round: Record<string, unknown> = {}) {
  return (prompt: string) => {
    const { questions } = JSON.parse(prompt) as { questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> };
    const answers: Record<string, unknown> = { ...roundAnswers('continue'), ...round };
    for (const [key, question] of Object.entries(questions)) {
      if (key in answers) continue;
      answers[key] = key.startsWith('finding-')
        ? findingAnswer(question)
        : question.type === 'choice'
          ? { choice: 'continue' in question.criteria ? 'continue' : Object.keys(question.criteria)[0] }
          : question.type === 'score'
            ? { probabilities: Object.fromEntries((question.criteria as unknown as string[]).map((criterion) => [criterion, 0.9])) }
            : { noul: 0.9 };
    }
    return answers;
  };
}

/**
 * A judge that sends every finding it is asked about back: `act` on round
 * 1's choice, impactful on the yes/no from round 2 on. `round` overrides
 * the round answers.
 */
function actOn(round: Record<string, unknown> = {}) {
  return (prompt: string) => {
    const { questions } = JSON.parse(prompt) as { questions: Record<string, { type: string }> };
    const answers: Record<string, unknown> = { ...roundAnswers('continue'), ...round };
    for (const [key, question] of Object.entries(questions)) {
      if (!(key in answers) && key.startsWith('finding-')) {
        answers[key] = question.type === 'choice' ? { choice: 'act', reason: 'worth a round' } : { noul: 0.9, reason: 'worth a round' };
      }
    }
    return answers;
  };
}

/**
 * A judge that acts on a finding only through round 1's act/skip choice;
 * asked the yes/no impactful-or-minor question it calls the finding minor.
 * A round 1 that wrongly asked the yes/no question would hold the finding
 * back instead of sending it back.
 */
function actOnChoiceOnly(round: Record<string, unknown> = {}) {
  return (prompt: string) => {
    const { questions } = JSON.parse(prompt) as { questions: Record<string, { type: string }> };
    const answers: Record<string, unknown> = { ...roundAnswers('continue'), ...round };
    for (const [key, question] of Object.entries(questions)) {
      if (!(key in answers) && key.startsWith('finding-')) {
        answers[key] = question.type === 'choice' ? { choice: 'act', reason: 'worth a round' } : { noul: 0.1, reason: 'a matter of taste' };
      }
    }
    return answers;
  };
}

function findingQuestions(request: AgentRequest): string[] {
  const { questions } = JSON.parse(request.prompt) as { questions: Record<string, unknown> };
  return Object.keys(questions).filter((key) => key.startsWith('finding-'));
}

function judgeEventsOf(events: readonly LoopEvent[]) {
  return events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
}

/**
 * The request the judge was sent, recorded before its own job started —
 * a failed call still leaves what was asked.
 */
function judgeRequestBeforeCall(events: readonly LoopEvent[]) {
  const requestAt = events.findIndex((e) => e.kind === 'refine:judge-request');
  const callAt = events.findIndex((e) => e.kind === 'job:start' && e.label === 'refine:judge');
  expect(requestAt).toBeGreaterThanOrEqual(0);
  expect(callAt).toBeGreaterThanOrEqual(0);
  expect(requestAt).toBeLessThan(callAt);
  return events[requestAt] as Extract<LoopEvent, { kind: 'refine:judge-request' }>;
}

describe('refine: judge()', () => {
  it('names each node a judge decides about at the start of the graph, though no review fails and no judge is asked', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({ reviewerReplies: [PASS], judgeReplies: [roundAnswers('holds')] });
    expect((await runTeam(job, events)).outcome.status).toBe('pass');
    expect(judgeCalls).toHaveLength(0);
    expect(judgeEventsOf(events)).toHaveLength(0);
    expect(events.find((e) => e.kind === 'dag:start')).toMatchObject({ path: ['refine-test'], judged: ['write'] });

    const graph: LoopEvent[] = [];
    const sendsBack = dag({
      name: 'judged-send-back',
      nodes: {
        draft: {
          refine: review({ judge: judge(seat(new MockEngine(() => JSON.stringify(roundAnswers('holds'))), 'judge-mock'), { perFinding: false }) }),
          job: fnJob('draft', () => 'drafted'),
        },
        check: { needs: 'draft', sendsBackTo: ['draft'], job: fnJob('check', () => 'checked') },
      },
    });
    expect((await run(sendsBack, { cwd: workDir(), onEvent: (event) => graph.push(event) })).outcome.status).toBe('pass');
    expect(graph.find((e) => e.kind === 'dag:start')).toMatchObject({ judged: ['draft'] });
  });

  it('stops on holds at round two', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE(), REVISE()],
      judgeReplies: [roundAnswers('continue'), roundAnswers('holds')],
      perFinding: false,
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

  it('fails at the cap with the judge still saying continue', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [roundAnswers('continue')],
      perFinding: false,
      cap: 2,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('fail');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('fail');
    // A cap of 2 is two refinements, so three builds and three
    // consultations, never more: the last one is told it is the last
    // round, and its continue fails the stage.
    expect(judgeCalls).toHaveLength(3);
    expect(JSON.parse(judgeCalls[1]!.prompt).state.when.lastRound).toBeUndefined();
    expect(JSON.parse(judgeCalls[2]!.prompt).state.when.lastRound).toBe(true);
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
      perFinding: false,
      cap: 3,
    });
    const result = await runTeam(job, events);
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('fail');
    // A cap of 3 is three refinements after the first draft, four rounds
    // in all. The old routing stopped after the first round, on
    // worth_another_round alone.
    expect(reviewCalls).toHaveLength(4);
    expect(judgeCalls).toHaveLength(4);
    const judgeEvents = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
    expect(judgeEvents.map((e) => e.route)).toEqual(['again', 'again', 'again', 'stop']);
    expect(judgeEvents[0]).toMatchObject({ reason: 'the judge chose continue', rule: 'stop_reason: continue' });
    expect(judgeEvents[0]!.status).toBeUndefined();
  });

  it('the judge event says the route, the rule and the status a stop gives the node', async () => {
    for (const [reply, rule, status] of [
      [roundAnswers('holds'), 'stop_reason: holds', 'pass'],
      [roundAnswers('not_converging'), 'stop_reason: not_converging', 'fail'],
    ] as const) {
      const events: LoopEvent[] = [];
      const { job } = scriptedTeam({ reviewerReplies: [REVISE()], judgeReplies: [reply], perFinding: false, cap: 3 });
      await runTeam(job, events);
      const judgeEvents = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
      expect(judgeEvents).toHaveLength(1);
      expect(judgeEvents[0], rule).toMatchObject({ route: 'stop', rule, status });
    }
    // A question set without `stop_reason` decides on the probabilities alone.
    const nouls: JudgeQuestions = Object.fromEntries(
      Object.entries(stopQuestions()).filter(([key]) => key !== 'stop_reason'),
    );
    const noulsEvents: LoopEvent[] = [];
    const { job: noulsJob } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{ holds: { noul: 0.1 }, worth_doing: { noul: 0.9 }, worth_another_round: { noul: 0.3 } }],
      questions: nouls,
      cap: 3,
    });
    await runTeam(noulsJob, noulsEvents);
    const noulsJudged = noulsEvents.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
    expect(noulsJudged).toHaveLength(1);
    expect(noulsJudged[0]).toMatchObject({ route: 'stop', rule: 'worth_another_round: 0.30', status: 'fail' });
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
      perFinding: false,
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
        judgeReplies: [roundAnswers(choice)],
        perFinding: false,
        cap: 5,
      });
      const result = await runTeam(job, events);
      expect(result.outcome.status, `stop_reason: ${choice}`).toBe(expectedStatus);
    }
  });

  it('uses the default question set (stopQuestions) with one per-finding question when none is given', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE(), REVISE()],
      judgeReplies: [actOn(roundAnswers('continue')), perFinding(roundAnswers('holds'))],
      cap: 2,
    });
    await runTeam(job, events);
    const sent = JSON.parse(judgeCalls[0]!.prompt) as { questions: Record<string, unknown> };
    expect(sent.questions).toMatchObject(stopQuestions('the draft'));
    const [id] = findingQuestions(judgeCalls[0]!);
    expect(Object.keys(sent.questions)).toEqual([...Object.keys(stopQuestions()), id]);
    // Round 1 keeps the act/skip choice, with its own bar and criteria.
    expect(sent.questions[id!]).toEqual({
      type: 'choice',
      instructions: 'Read this one finding. For this use case, should the builder act on it in another round, or skip it? Give a one-line reason. Finding [should-fix]: fix this',
      criteria: {
        act: 'A reader of this kind of work would stumble on, misread or distrust what this finding names, so the builder should fix it.',
        skip: 'It is taste, an edge case, or polish past the bar the use case sets, so fixing it would not change what a reader gets.',
      },
    });
    // From round 2 on the same call is asked as the yes/no impactful-or-minor
    // question.
    const later = JSON.parse(judgeCalls[1]!.prompt) as { questions: Record<string, unknown> };
    const [laterId] = findingQuestions(judgeCalls[1]!);
    expect(later.questions[laterId!]).toMatchObject({
      type: 'noul',
      instructions: expect.stringContaining('fix this'),
      criteria: {
        true: expect.stringContaining('Impactful'),
        false: expect.stringContaining('Minor'),
      },
    });
  });

  it('accepts a score answer in the shape the judge engines report', async () => {
    const events: LoopEvent[] = [];
    const { job, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{
        stop_reason: { choice: 'holds' },
        // Each shape is the only answer its question gets: Jev's rating
        // number, Jev's probabilities keyed by criterion, and the OpenAI
        // Decisions API's list of one {label, probability} per level.
        readiness: { score: 3, confidence: 0.9 },
        risk: { confidence: 0.55, probabilities: { low: 0.3, high: 0.65 } },
        finish: {
          probabilities: [
            { value: 0, label: 'Unsafe to ship', probability: 0.05 },
            { value: 1, label: 'Needs another round', probability: 0.3 },
            { value: 2, label: 'Ships clean', probability: 0.65 },
          ],
        },
      }],
      questions: {
        stop_reason: {
          type: 'choice',
          instructions: 'Does the page hold?',
          criteria: { holds: 'It holds.', continue: 'Another pass is worth it.' },
        },
        readiness: {
          type: 'score',
          instructions: 'How ready is the page?',
          criteria: ['Unsafe to ship', 'Needs another round', 'Ships clean'],
        },
        risk: {
          type: 'score',
          instructions: 'How risky is shipping it?',
          criteria: ['low', 'high'],
        },
        finish: {
          type: 'score',
          instructions: 'How finished is the page?',
          criteria: ['Unsafe to ship', 'Needs another round', 'Ships clean'],
        },
      },
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(judgeCalls).toHaveLength(1);
    expect(judgeEventsOf(events)[0]).toMatchObject({ route: 'stop', status: 'pass' });
  });
});

describe('refine: judge() decides each finding', () => {
  it('round 1 asks act or skip, and sends back only the findings the judge acts on, with their reason', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(REAL, TONE, TITLE), PASS],
      judgeReplies: [perFinding()],
      cap: 3,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(judgeCalls).toHaveLength(1);
    expect(findingQuestions(judgeCalls[0]!)).toHaveLength(3);
    // Round 1 keeps the act/skip question: the impactful-or-minor call
    // starts from round 2.
    const sent = JSON.parse(judgeCalls[0]!.prompt) as { questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> };
    for (const id of findingQuestions(judgeCalls[0]!)) {
      expect(sent.questions[id]).toMatchObject({ type: 'choice', criteria: { act: expect.stringContaining('stumble on'), skip: expect.any(String) } });
      expect(sent.questions[id]!.instructions).toContain('act on it in another round, or skip it?');
    }
    expect(writerCalls).toHaveLength(2);
    // Round 1 sends back only the finding the judge acts on; the two it
    // skips stay held back, recorded `skip`.
    const feedback = writerCalls[1]!.prompt;
    expect(feedback).toContain(REAL.evidence);
    expect(feedback).toContain('a reader cannot tell who the page is for');
    expect(feedback).not.toContain(TONE.evidence);
    expect(feedback).not.toContain(TITLE.evidence);
    const [event] = judgeEventsOf(events);
    expect(event).toMatchObject({ route: 'again', rule: 'findings: 1 act, 2 skip' });
    expect(event!.findings).toEqual(findingQuestions(judgeCalls[0]!).map((id, index) => ({
      id,
      decision: index === 0 ? 'act' : 'skip',
      reason: index === 0 ? 'a reader cannot tell who the page is for' : 'a matter of taste',
    })));
  });

  it('round 1: a minor acted finding still goes back', async () => {
    // Round 1 has no minor call: a taste finding the judge acts on costs a
    // round like any other. The judge answers act on round 1's choice but
    // minor on the yes/no question, so a round 1 asking the wrong question
    // holds the finding back instead.
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(TONE), PASS],
      judgeReplies: [actOnChoiceOnly()],
      cap: 3,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(2);
    expect(writerCalls[1]!.prompt).toContain(TONE.evidence);
    expect(judgeCalls).toHaveLength(1);
    const [event] = judgeEventsOf(events);
    expect(event).toMatchObject({ route: 'again', rule: 'findings: 1 act, 0 skip' });
    expect(event!.findings).toEqual([
      { id: 'finding-1', decision: 'act', reason: 'worth a round' },
    ]);
  });

  it('ships the work as a pass when the judge skips every finding in round 1, and the skips land on the list', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(TONE, TITLE)],
      judgeReplies: [perFinding()],
      cap: 3,
    });
    const result = await runTeam(job, events);
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome).toMatchObject({ status: 'pass', summary: 'the judge skipped every finding' });
    // A skip in any round is collected: the pass carries both findings on
    // the list a person reads before the work lands.
    expect(stageOutcome?.minorFindings).toMatchObject([
      { severity: 'nice-to-have', evidence: TONE.evidence, round: 1 },
      { severity: 'nice-to-have', evidence: TITLE.evidence, round: 1 },
    ]);
    expect(writerCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    expect(judgeEventsOf(events)[0]).toMatchObject({ route: 'stop', status: 'pass', rule: 'findings: 0 act, 2 skip' });
  });

  it('tells the next round\'s reviewers what was held back and why, and keeps the held-back list in the judge\'s state', async () => {
    const events: LoopEvent[] = [];
    const secondReal = { ...REAL, evidence: 'REAL: the second section is empty' };
    const { job, reviewCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(REAL, TONE), revise(secondReal, TITLE), PASS],
      judgeReplies: [perFinding()],
      cap: 4,
    });
    await runTeam(job, events);
    expect(reviewCalls).toHaveLength(3);
    expect(reviewCalls[0]!.prompt).not.toContain(TONE.evidence);
    // Round 1's skip reaches round 2's reviewers with the judge's reason.
    expect(reviewCalls[1]!.prompt).toContain(TONE.evidence);
    expect(reviewCalls[1]!.prompt).toContain('a matter of taste');
    expect(reviewCalls[1]!.prompt).not.toContain(REAL.evidence);
    expect(reviewCalls[2]!.prompt).toContain(TONE.evidence);
    expect(reviewCalls[2]!.prompt).toContain(TITLE.evidence);
    expect(judgeCalls).toHaveLength(2);
    const states = judgeCalls.map((call) => (JSON.parse(call.prompt).state.when as { skipped?: unknown }).skipped);
    expect(states[0]).toBeUndefined();
    expect(states[1]).toMatchObject([
      { round: 1, finding: TONE, reason: 'a matter of taste' },
    ]);
  });

  it('asks the judge about a block, and a block it acts on goes back with its reason', async () => {
    const events: LoopEvent[] = [];
    const block = { severity: 'block', evidence: 'REAL: the page is empty' } as const;
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(block, TITLE), PASS],
      judgeReplies: [perFinding()],
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(judgeCalls).toHaveLength(1);
    // The block keeps its severity in what the judge sees, and its question sets the higher bar.
    const sent = JSON.parse(judgeCalls[0]!.prompt) as { state: { how: { findings: { severity: string }[] } }; questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
    expect(sent.state.how.findings[0]).toMatchObject({ severity: 'block' });
    const [blockId, titleId] = findingQuestions(judgeCalls[0]!);
    expect(sent.questions[blockId!]!.instructions).toContain(`Finding [block]: ${block.evidence}`);
    // Round 1's block keeps the higher bar to skip it.
    expect(sent.questions[blockId!]!.instructions).toContain('the bar to skip it is higher. Skip it only when the case it names is outside how the work is really used');
    expect(sent.questions[titleId!]!.instructions).not.toContain('the bar to skip it');
    expect(writerCalls).toHaveLength(2);
    expect(writerCalls[1]!.prompt).toContain(block.evidence);
    expect(writerCalls[1]!.prompt).toContain('a reader cannot tell who the page is for');
    expect(writerCalls[1]!.prompt).not.toContain(TITLE.evidence);
    expect(judgeEventsOf(events)[0]).toMatchObject({ route: 'again', rule: 'findings: 1 act, 1 skip' });
  });

  it('a judge still acting on a finding past the cap does not fail the run: it pauses for a person with the open findings', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(REAL, TONE)],
      judgeReplies: [perFinding()],
      cap: 2,
    });
    const result = await runTeam(job, events);
    // One finding is acted on each round and the count never falls: the
    // spent cap asks a person instead of failing with a finding still open.
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('paused');
    expect(judgeCalls).toHaveLength(3);
    expect(writerCalls).toHaveLength(3);
    // The finding the judge calls minor never reaches the writer: round 1's
    // skip and round 2's minor stay held back alike.
    expect(writerCalls[1]!.prompt).toContain(REAL.evidence);
    expect(writerCalls[1]!.prompt).not.toContain(TONE.evidence);
    expect(writerCalls[2]!.prompt).not.toContain(TONE.evidence);
    // The question the person gets carries the round's open findings and
    // what the judge would do with each.
    const request = stageOutcome?.data as { input?: { material?: unknown } } | undefined;
    expect(request?.input?.material).toMatchObject({
      capPause: true,
      latestFindings: [{ evidence: REAL.evidence }, { evidence: TONE.evidence }],
      decided: [{ decision: 'act' }, { decision: 'minor' }],
    });
    expect(judgeEventsOf(events)[2]).toMatchObject({ route: 'stop', reason: expect.stringContaining('a person decides') });
  });

  it('a round-1 finding the judge skips is held back, recorded as a skip, and the round stands', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(TONE), PASS],
      judgeReplies: [perFinding()],
      cap: 3,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    // The judge answered skip: the finding stays with the judge, so
    // the round stands as a pass and the record keeps the call as `skip`.
    expect(writerCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const [event] = judgeEventsOf(events);
    expect(event).toMatchObject({ route: 'stop', status: 'pass', rule: 'findings: 0 act, 1 skip' });
    expect(event!.findings).toEqual([
      { id: 'finding-1', decision: 'skip', reason: 'a matter of taste' },
    ]);
  });

  it('from round 2 on, a finding the judge calls impactful goes back even when a reviewer tagged it nice-to-have', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls } = scriptedTeam({
      reviewerReplies: [revise(REAL), revise(TONE), PASS],
      judgeReplies: [perFinding(), actOn()],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(3);
    // The judge's own call routes the finding, not the reviewer's tag: the
    // nice-to-have it called impactful goes back to the writer.
    expect(writerCalls[2]!.prompt).toContain(TONE.evidence);
    expect(judgeEventsOf(events)[1]!.findings).toEqual([
      { id: 'finding-1', decision: 'act', reason: 'worth a round' },
    ]);
  });

  it('from round 2 on, a finding the judge calls minor is collected instead of sent back, and the list stays on the pass that follows', async () => {
    const events: LoopEvent[] = [];
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [
        revise(REAL),
        revise({ ...REAL, evidence: 'REAL: the second section is empty' }, TONE),
        PASS,
      ],
      judgeReplies: [perFinding()],
      cap: 5,
    });
    const result = await run(job, { cwd: dir, recordTo: record, onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(3);
    expect(writerCalls[1]!.prompt).toContain(REAL.evidence);
    // Round 2's findings: the one the judge called impactful goes back; the
    // one it called minor is collected, not sent back.
    expect(writerCalls[2]!.prompt).toContain('the second section is empty');
    expect(writerCalls[2]!.prompt).not.toContain(TONE.evidence);
    expect(judgeCalls).toHaveLength(2);
    const event = judgeEventsOf(events)[1]!;
    expect(event).toMatchObject({ route: 'again', rule: 'findings: 1 act, 0 skip, 1 minor' });
    expect(event.findings).toEqual([
      { id: 'finding-1', decision: 'act', reason: 'a reader cannot tell who the page is for' },
      { id: 'finding-2', decision: 'minor', reason: 'a matter of taste' },
    ]);
    expect(event.minorFindings).toMatchObject([
      { severity: 'nice-to-have', evidence: TONE.evidence, reviewer: expect.any(String) },
    ]);
    // Round 3's clean pass still carries the collected list: it is what a
    // person reads before the work lands, and it is in the saved record.
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.minorFindings).toMatchObject([
      { severity: 'nice-to-have', evidence: TONE.evidence, reviewer: expect.any(String), judgeReason: 'a matter of taste' },
    ]);
    const recorded = readFileSync(record, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as LoopEvent & Record<string, unknown>);
    const lastWrite = recorded.findLast((entry) => entry.kind === 'dag:node' && entry.node === 'write');
    expect((lastWrite!.outcome as Outcome).minorFindings).toMatchObject([{ evidence: TONE.evidence }]);
  });

  it('a stop answer when every finding is minor lets the work stand as a pass, with the minors listed', async () => {
    for (const choice of ['not_converging', 'over_polishing'] as const) {
      const events: LoopEvent[] = [];
      const { job, writerCalls } = scriptedTeam({
        reviewerReplies: [revise(REAL), revise(TONE)],
        judgeReplies: [perFinding(), perFinding({ stop_reason: { choice } })],
        cap: 5,
      });
      const result = await runTeam(job, events);
      const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
      expect(stageOutcome, choice).toMatchObject({ status: 'pass', summary: 'the judge found only minor findings' });
      expect(writerCalls, choice).toHaveLength(2);
      const event = judgeEventsOf(events)[1]!;
      expect(event, choice).toMatchObject({ route: 'stop', status: 'pass', rule: 'findings: 0 act, 0 skip, 1 minor' });
      expect(event.minorFindings).toMatchObject([{ severity: 'nice-to-have', evidence: TONE.evidence }]);
      expect(stageOutcome?.minorFindings).toMatchObject([{ severity: 'nice-to-have', evidence: TONE.evidence, reviewer: expect.any(String) }]);
    }
  });

  it('a stop answer still sends the work back when a finding is impactful', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls } = scriptedTeam({
      reviewerReplies: [
        revise(REAL),
        revise({ ...REAL, evidence: 'REAL: the second section is empty' }, TONE),
        PASS,
      ],
      judgeReplies: [perFinding(), perFinding({ stop_reason: { choice: 'not_converging' } })],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(3);
    expect(writerCalls[2]!.prompt).toContain('the second section is empty');
    expect(writerCalls[2]!.prompt).not.toContain(TONE.evidence);
    expect(judgeEventsOf(events)[1]).toMatchObject({ route: 'again' });
  });

  it('a finding the judge calls minor from round 2 on lands on the collected list', async () => {
    const events: LoopEvent[] = [];
    const { job } = scriptedTeam({
      reviewerReplies: [revise(REAL), revise(TONE)],
      judgeReplies: [perFinding()],
      cap: 5,
    });
    const result = await runTeam(job, events);
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome).toMatchObject({ status: 'pass', summary: 'the judge found only minor findings' });
    expect(stageOutcome?.minorFindings).toMatchObject([{ severity: 'nice-to-have', evidence: TONE.evidence, reviewer: expect.any(String) }]);
    expect(judgeEventsOf(events)[1]!.minorFindings).toMatchObject([{ evidence: TONE.evidence }]);
  });

  it('a custom question set routes on the whole round unless it opts in', async () => {
    const custom: JudgeQuestions = {
      stop_reason: {
        type: 'choice',
        instructions: 'Has the digest converged?',
        criteria: { holds: 'It holds.', continue: 'Another pass is worth it.' },
      },
    };
    const plain = scriptedTeam({
      reviewerReplies: [revise(REAL, TONE)],
      judgeReplies: [perFinding({ stop_reason: { choice: 'holds' } })],
      cap: 3,
      questions: custom,
    });
    const plainResult = await runTeam(plain.job, []);
    expect(JSON.parse(plain.judgeCalls[0]!.prompt).questions).toEqual(custom);
    expect((plainResult.outcome.data as Record<string, Outcome>).write?.status).toBe('pass');
    expect(plain.writerCalls).toHaveLength(1);

    const events: LoopEvent[] = [];
    const opted = scriptedTeam({
      reviewerReplies: [revise(REAL, TONE), PASS],
      judgeReplies: [perFinding({ stop_reason: { choice: 'holds' } })],
      cap: 3,
      questions: custom,
      perFinding: true,
    });
    await runTeam(opted.job, events);
    expect(findingQuestions(opted.judgeCalls[0]!)).toHaveLength(2);
    expect(JSON.parse(opted.judgeCalls[0]!.prompt).questions).toMatchObject(custom);
    expect(opted.writerCalls).toHaveLength(2);
    // Round 1 sends back only the finding the judge called impactful; the
    // one it called minor is held back.
    expect(opted.writerCalls[1]!.prompt).toContain(REAL.evidence);
    expect(opted.writerCalls[1]!.prompt).not.toContain(TONE.evidence);
  });

  it('a panel stage that sends work back hears what its judge held back', async () => {
    const writerCalls: AgentRequest[] = [];
    const checkCalls: AgentRequest[] = [];
    const replies = [revise(REAL, TONE), PASS];
    const writer = new MockEngine((req) => {
      writerCalls.push(req);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${writerCalls.length}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const checker = new MockEngine((req) => {
      const reply = replies[Math.min(checkCalls.length, replies.length - 1)];
      checkCalls.push(req);
      return JSON.stringify(reply);
    });
    const judgeEngine = new MockEngine((req) => JSON.stringify(perFinding()(req.prompt)));
    const job = workflow('panel-judge', {
      brief: 'Use case: a reader gets a clear, short page.\n\nWrite the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), checkers: [seat(checker, 'checker-mock', ['Read'])] },
      stages: [
        stage('write', { agent: 'writer', writes: 'page.md', refine: judge(seat(judgeEngine, 'judge-mock'), { cap: 3 }) }),
        stage('check', { needs: 'write', panel: 'checkers', sendsBackTo: 'write' }),
      ],
    });
    const result = await runTeam(job as ReturnType<typeof scriptedTeam>['job'], []);
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(2);
    expect(checkCalls).toHaveLength(2);
    expect(checkCalls[0]!.prompt).not.toContain(TONE.evidence);
    // The round-1 skip is told to the panel's next review, with its reason.
    expect(checkCalls[1]!.prompt).toContain(TONE.evidence);
    expect(checkCalls[1]!.prompt).toContain('a matter of taste');
  });
});

describe('refine: judge() with no cap', () => {
  it('runs until the judge stops it: continue twice, then holds, is three builds and a pass', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [roundAnswers('continue'), roundAnswers('continue'), roundAnswers('holds')],
      perFinding: false,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect((result.outcome.data as Record<string, Outcome>).write).toMatchObject({ status: 'pass', summary: 'the judge chose holds' });
    expect(writerCalls).toHaveLength(3);
    expect(judgeCalls).toHaveLength(3);
    const state = JSON.parse(judgeCalls[0]!.prompt).state.when as Record<string, unknown>;
    expect('cap' in state).toBe(false);
    expect(state.limit).toBe('No round limit: the rounds end when you stop them or the review passes.');
  });

  it('fails when the judge says not_converging', async () => {
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [roundAnswers('continue'), roundAnswers('not_converging')],
      perFinding: false,
    });
    const result = await runTeam(job, []);
    expect(result.outcome.status).toBe('fail');
    expect((result.outcome.data as Record<string, Outcome>).write?.status).toBe('fail');
    expect(writerCalls).toHaveLength(2);
    expect(judgeCalls).toHaveLength(2);
  });

  it('stops a reviewer that blocks every round on a new rare case when the judge calls the blocks minor', async () => {
    const events: LoopEvent[] = [];
    const rare = (what: string) => ({ severity: 'block', evidence: `rare: ${what}` }) as const;
    const real = { severity: 'block', evidence: 'REAL: the page never says who it is for' } as const;
    const { job, writerCalls, reviewCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [
        revise(real, rare('a field limited to a list of values')),
        revise(rare('a schema nested in allOf')),
        revise(rare('a schema nested in anyOf')),
        revise(rare('anyOf inside allOf')),
        revise(rare('a schema nested in oneOf')),
        PASS,
      ],
      judgeReplies: [perFinding()],
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome).toMatchObject({ status: 'pass', summary: 'the judge found only minor findings' });
    expect(stageOutcome?.minorFindings).toMatchObject([
      { evidence: 'rare: a field limited to a list of values', round: 1 },
      { evidence: 'rare: a schema nested in allOf', round: 2 },
    ]);
    expect(writerCalls).toHaveLength(2);
    expect(reviewCalls).toHaveLength(2);
    expect(judgeCalls).toHaveLength(2);
    // Round 1's skip stayed with the judge: the writer sees only the block
    // called impactful, and the next round's reviewers are told which block
    // was held back, and why. The new round-2 block the judge called minor
    // did not go back either, and the run stood.
    expect(writerCalls[1]!.prompt).not.toContain('rare: a field limited to a list of values');
    expect(reviewCalls[1]!.prompt).toContain('rare: a field limited to a list of values');
    expect(reviewCalls[1]!.prompt).toContain('a matter of taste');
    const judgeEvents = judgeEventsOf(events);
    expect(judgeEvents.map((e) => e.rule)).toEqual(['findings: 1 act, 1 skip', 'findings: 0 act, 0 skip, 1 minor']);
    expect(judgeEvents[0]!.findings).toEqual([
      { id: 'finding-1', decision: 'act', reason: 'a reader cannot tell who the page is for' },
      { id: 'finding-2', decision: 'skip', reason: 'a matter of taste' },
    ]);
    expect(judgeEvents[1]).toMatchObject({ route: 'stop', status: 'pass', findings: [{ id: 'finding-1', decision: 'minor', reason: 'a matter of taste' }] });
  });
});

describe('refine: judge() at its cap', () => {
  it('asks the judge about the last review, and holds makes the stage pass with the open findings recorded', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(TONE)],
      judgeReplies: [roundAnswers('continue'), roundAnswers('holds')],
      cap: 1,
      perFinding: false,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect((result.outcome.data as Record<string, Outcome>).write).toMatchObject({
      status: 'pass', summary: 'the judge chose holds', openFindings: [{ ...TONE, reviewer: expect.any(String) }],
    });
    // A cap of 1 is one refinement: two builds, and the judge reads both reviews.
    expect(writerCalls).toHaveLength(2);
    expect(judgeCalls).toHaveLength(2);
    expect(JSON.parse(judgeCalls[0]!.prompt).state.when.lastRound).toBeUndefined();
    const state = JSON.parse(judgeCalls[1]!.prompt).state.when as Record<string, unknown>;
    expect(state).toMatchObject({ round: 2, cap: 1, lastRound: true });
    expect(state.limit).toBe('This is the last round the cap of 1 allows (1 refinement after the first build): a product decision buys exactly one more round for the person\'s answer; every other answer decides how this ends.');
    const event = judgeEventsOf(events)[1];
    expect(event).toMatchObject({ route: 'stop', status: 'pass', openFindings: [{ ...TONE, reviewer: expect.any(String) }] });
  });

  it('fails with the cap named when the judge says continue after the last review', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [roundAnswers('continue')],
      perFinding: false,
      cap: 1,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('fail');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('fail');
    expect(stageOutcome?.summary).toContain('the cap of 1');
    expect(writerCalls).toHaveLength(2);
    expect(judgeCalls).toHaveLength(2);
    expect(judgeEventsOf(events)[1]).toMatchObject({ route: 'stop', status: 'fail', reason: expect.stringContaining('the cap of 1') });
  });

  it('asks the judge about a block in the last round, and calling it minor lets the work stand with it recorded as open', async () => {
    const events: LoopEvent[] = [];
    const block = { severity: 'block', evidence: 'rare: a schema nested in anyOf' } as const;
    const { job, writerCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [revise(REAL), revise(block)],
      judgeReplies: [perFinding()],
      cap: 1,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('pass');
    expect((result.outcome.data as Record<string, Outcome>).write).toMatchObject({
      status: 'pass',
      summary: 'the judge found only minor findings',
      openFindings: [{ ...block, reviewer: expect.any(String) }],
      minorFindings: [{ ...block, reviewer: expect.any(String) }],
    });
    expect(writerCalls).toHaveLength(2);
    expect(judgeCalls).toHaveLength(2);
    expect(JSON.parse(judgeCalls[1]!.prompt).state.when).toMatchObject({ cap: 1, lastRound: true });
    expect(judgeEventsOf(events)[1]).toMatchObject({
      route: 'stop', status: 'pass', findings: [{ decision: 'minor', reason: 'a matter of taste' }], openFindings: [{ ...block, reviewer: expect.any(String) }],
    });
  });

});

describe('refine: a plain number', () => {
  it('sends a block finding back without a judge', async () => {
    const writerCalls: AgentRequest[] = [];
    const replies = [REVISE('block'), PASS];
    let reviews = 0;
    const writer = new MockEngine((req) => {
      writerCalls.push(req);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${writerCalls.length}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine(() => JSON.stringify(replies[Math.min(reviews++, replies.length - 1)]));
    const job = workflow('refine-number', {
      brief: 'Use case: a reader gets a clear, short page.\n\nWrite the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine: 2 })],
    });
    const events: LoopEvent[] = [];
    const result = await runTeam(job as ReturnType<typeof scriptedTeam>['job'], events);
    expect(result.outcome.status).toBe('pass');
    expect(writerCalls).toHaveLength(2);
    expect(writerCalls[1]!.prompt).toContain('fix this');
    expect(judgeEventsOf(events)).toHaveLength(0);
  });
});

describe('refine: a failed judge stops the rounds', () => {
  it('a judge whose own call fails pauses the stage with the engine error it kept, and spends no build on it', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, reviewCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [() => {
        throw new EngineError({ kind: 'billing', message: 'HTTP 402: no credits left on the account' });
      }],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('paused');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('paused');
    expect(stageOutcome?.error?.code).toBe('ENGINE');
    expect(stageOutcome?.error?.message).toContain('402');
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const event = judgeEventsOf(events)[0]!;
    expect(event).toMatchObject({ route: 'stop', status: 'paused', rule: 'call failed' });
    expect(event.failure).toMatchObject({ code: 'ENGINE', message: expect.stringContaining('402') });
    const request = judgeRequestBeforeCall(events);
    expect(Object.keys(request.questions)).toEqual([...Object.keys(stopQuestions()), 'finding-1']);
  });

  it('a reply that does not parse pauses the stage with a validation error, and spends no build on it', async () => {
    const events: LoopEvent[] = [];
    const judgeCalls: AgentRequest[] = [];
    const { job, writerCalls, reviewCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [],
      judgeEngine: new MockEngine((req) => {
        judgeCalls.push(req);
        return { text: 'prose is not a JSON answers object' };
      }),
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('paused');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('paused');
    expect(stageOutcome?.error?.code).toBe('VALIDATION');
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const event = judgeEventsOf(events)[0]!;
    expect(event).toMatchObject({ route: 'stop', status: 'paused', rule: 'unreadable reply' });
    expect(event.failure?.code).toBe('VALIDATION');
    expect(event.effective?.model).toBe('judge-mock');
    const request = judgeRequestBeforeCall(events);
    expect(Object.keys(request.questions)).toEqual([...Object.keys(stopQuestions()), 'finding-1']);
  });

  it('a reply that holds none of the required answers pauses the stage and names the questions it was asked', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, reviewCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{}],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('paused');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('paused');
    expect(stageOutcome?.error?.code).toBe('VALIDATION');
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const event = judgeEventsOf(events)[0]!;
    expect(event).toMatchObject({ route: 'stop', status: 'paused', rule: 'missing answers' });
    expect(event.failure?.message).toContain('stop_reason');
    expect(event.failure?.message).toContain('finding-1');
    expect(event.effective?.model).toBe('judge-mock');
    const request = judgeRequestBeforeCall(events);
    expect(Object.keys(request.questions)).toEqual([...Object.keys(stopQuestions()), 'finding-1']);
  });

  it('a reply that answers only some questions pauses the stage, naming the ones it missed', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, reviewCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{ worth_doing: { noul: 0.8 }, 'finding-1': { choice: 'act', reason: 'real' } }],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('paused');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('paused');
    expect(stageOutcome?.error?.code).toBe('VALIDATION');
    // A partial reply is not a decision: no build and no review followed it.
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const event = judgeEventsOf(events)[0]!;
    expect(event).toMatchObject({ route: 'stop', status: 'paused', rule: 'missing answers' });
    for (const key of ['holds', 'worth_another_round', 'stop_reason']) {
      expect(event.failure?.message).toContain(key);
    }
    expect(event.failure?.message).not.toContain('finding-1');
    expect(judgeRequestBeforeCall(events)).toBeDefined();
  });

  it('a reply that answers every round question but not the generated finding question pauses the stage', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, reviewCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [roundAnswers('holds')],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('paused');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('paused');
    expect(stageOutcome?.error?.code).toBe('VALIDATION');
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const event = judgeEventsOf(events)[0]!;
    expect(event).toMatchObject({ route: 'stop', status: 'paused', rule: 'missing answers' });
    expect(event.failure?.message).toContain('finding-1');
    expect(event.failure?.message).not.toContain('stop_reason');
    expect(judgeRequestBeforeCall(events)).toBeDefined();
  });

  it('a reply whose answer does not fit its question pauses the stage instead of routing on it', async () => {
    const events: LoopEvent[] = [];
    const { job, writerCalls, reviewCalls, judgeCalls } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [{
        ...roundAnswers('holds'),
        holds: { probability: 'high' },
        'finding-1': { choice: 'maybe' },
      }],
      cap: 5,
    });
    const result = await runTeam(job, events);
    expect(result.outcome.status).toBe('paused');
    const stageOutcome = (result.outcome.data as Record<string, Outcome>).write;
    expect(stageOutcome?.status).toBe('paused');
    expect(stageOutcome?.error?.code).toBe('VALIDATION');
    expect(writerCalls).toHaveLength(1);
    expect(reviewCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const event = judgeEventsOf(events)[0]!;
    expect(event).toMatchObject({ route: 'stop', status: 'paused', rule: 'missing answers' });
    expect(event.failure?.message).toContain('holds');
    expect(event.failure?.message).toContain('finding-1');
    expect(judgeRequestBeforeCall(events)).toBeDefined();
  });

  it('the record holds what the judge was asked before the call: packet, every question, the seat model', async () => {
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    const { job } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [perFinding({ stop_reason: { choice: 'holds' } })],
      cap: 5,
    });
    const result = await run(job, { cwd: dir, recordTo: record });
    expect(result.outcome.status).toBe('pass');
    const events = readFileSync(record, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as LoopEvent & Record<string, unknown>);
    const request = events.find((e) => e.kind === 'refine:judge-request');
    expect(request).toBeDefined();
    const judgeStart = events.findIndex((e) => e.kind === 'job:start' && e.label === 'refine:judge');
    expect(events.indexOf(request!)).toBeLessThan(judgeStart);
    expect((request!.packet as { when: { round: number } }).when.round).toBe(1);
    expect(Object.keys(request!.questions as object).sort()).toEqual(
      [...Object.keys(stopQuestions()), 'finding-1'].sort());
    expect((request!.seat as { model: string }).model).toBe('judge-mock');
    expect(request!.identity).toMatch(/^[0-9a-f]{64}$/);
    const judged = events.find((e) => e.kind === 'refine:judge') as
      (Extract<LoopEvent, { kind: 'refine:judge' }> & { effective?: { model?: string } }) | undefined;
    expect(judged?.effective?.model).toBe('judge-mock');
  });

  it('the request identity is the question set\'s: two asks of the same questions under the same rules share it, whatever the brief', async () => {
    const identityOf = async (brief: string) => {
      const events: LoopEvent[] = [];
      const { job } = scriptedTeam({
        reviewerReplies: [REVISE()],
        judgeReplies: [perFinding({ stop_reason: { choice: 'holds' } })],
        cap: 5,
        brief,
      });
      await runTeam(job, events);
      return events.find((e) => e.kind === 'refine:judge-request')!.identity;
    };
    const a = await identityOf('Use case: a reader gets a short page.\n\nWrite the page.');
    const b = await identityOf('Use case: a different brief entirely, one that rambles on at length.\n\nWrite the page.');
    expect(a).toBe(b);
  });

  it('a resume after a paused judge failure re-asks the judge at the same round over the same panel, and builds nothing first', async () => {
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    const failing = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [() => {
        throw new EngineError({ kind: 'billing', message: 'HTTP 402: no credits left on the account' });
      }],
      cap: 5,
    });
    const first = await run(failing.job, { cwd: dir, recordTo: record });
    expect(first.outcome.status).toBe('paused');
    expect(failing.writerCalls).toHaveLength(1);
    expect(failing.reviewCalls).toHaveLength(1);
    expect(failing.judgeCalls).toHaveLength(1);

    const repaired = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [perFinding({ stop_reason: { choice: 'holds' } })],
      cap: 5,
    });
    const second = await run(repaired.job, { cwd: dir, recordTo: record, resume: true });
    expect(second.outcome.status).toBe('pass');
    // The completed review panel stands; nothing builds or re-reviews
    // before the judge is re-asked for the same round.
    expect(repaired.writerCalls).toHaveLength(0);
    expect(repaired.reviewCalls).toHaveLength(0);
    expect(repaired.judgeCalls).toHaveLength(1);
    expect(JSON.parse(repaired.judgeCalls[0]!.prompt).state.when.round).toBe(1);

    const events = readFileSync(record, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as LoopEvent & Record<string, unknown>);
    const lastStart = events.map((e, i) => [e, i] as const)
      .filter(([e]) => e.kind === 'run:start').at(-1)![1];
    const calls = events.slice(lastStart).filter((e) => e.kind === 'engine:usage');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((e) => (e as { model?: string }).model === 'judge-mock')).toBe(true);
  });

  it('a send-back whose judge call fails pauses the graph, and the resume re-asks the judge for the same send-back without re-running a node', async () => {
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    let builds = 0;
    let checks = 0;
    let closes = 0;
    const build = (judgeEngine: MockEngine) => dag({
      name: 'send-back-judge',
      nodes: {
        write: {
          refine: review({ judge: judge(seat(judgeEngine, 'judge-mock'), { perFinding: false }) }),
          job: fnJob('write', () => { builds += 1; return 'wrote'; }),
        },
        check: {
          needs: 'write',
          sendsBackTo: ['write'],
          job: fnJob('check', () => {
            checks += 1;
            return revisionRequest({ target: 'write', reason: 'not yet', findings: [{ severity: 'should-fix', evidence: 'fix this' }] });
          }),
        },
        close: { needs: 'check', job: fnJob('close', () => { closes += 1; return 'closed'; }) },
      },
    });
    const failing = new MockEngine(() => {
      throw new EngineError({ kind: 'billing', message: 'HTTP 402: no credits left on the account' });
    });
    const first = await run(build(failing), { cwd: dir, recordTo: record });
    expect(first.outcome.status).toBe('paused');
    const checkOutcome = (first.outcome.data as Record<string, Outcome>).check;
    expect(checkOutcome?.error?.code).toBe('ENGINE');
    expect(checkOutcome?.error?.message).toContain('402');
    // The failed judge spent no build and no extra review.
    expect(builds).toBe(1);
    expect(checks).toBe(1);
    expect(closes).toBe(0);

    const judgeCalls: AgentRequest[] = [];
    const repaired = new MockEngine((req) => {
      judgeCalls.push(req);
      return JSON.stringify(roundAnswers('holds'));
    });
    const second = await run(build(repaired), { cwd: dir, recordTo: record, resume: true });
    expect(second.outcome.status).toBe('pass');
    // The judge is asked again for the same send-back round; nothing builds
    // or re-checks before it answers, and its holds lets the work stand.
    expect(judgeCalls).toHaveLength(1);
    expect(JSON.parse(judgeCalls[0]!.prompt).state.when.round).toBe(1);
    expect(builds).toBe(1);
    expect(checks).toBe(1);
    expect(closes).toBe(1);
  });

  it('a finished step\'s data survives a judge pause: the dependent step receives it unchanged on resume', async () => {
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    const email = 'dev@example.com';
    const ran = { writes: 0, checks: 0, closes: 0 };
    let received: unknown;
    const build = (judgeEngine: MockEngine) => dag({
      name: 'send-back-data',
      nodes: {
        write: {
          refine: review({ judge: judge(seat(judgeEngine, 'judge-mock'), { perFinding: false }) }),
          job: fnJob('write', () => { ran.writes += 1; return { status: 'pass', data: email }; }),
        },
        check: {
          needs: 'write',
          sendsBackTo: ['write'],
          job: fnJob('check', () => {
            ran.checks += 1;
            return revisionRequest({ target: 'write', reason: 'not yet', findings: [{ severity: 'should-fix', evidence: 'fix this' }] });
          }),
        },
        close: {
          needs: ['write', 'check'],
          job: fnJob('close', (ctx) => { ran.closes += 1; received = ctx.needs?.write?.data; }),
        },
      },
    });
    const failing = new MockEngine(() => {
      throw new EngineError({ kind: 'billing', message: 'HTTP 402: no credits left on the account' });
    });
    const first = await run(build(failing), { cwd: dir, recordTo: record });
    expect(first.outcome.status).toBe('paused');
    expect(ran).toEqual({ writes: 1, checks: 1, closes: 0 });

    const repaired = new MockEngine(() => JSON.stringify(roundAnswers('holds')));
    const second = await run(build(repaired), { cwd: dir, recordTo: record, resume: true });
    expect(second.outcome.status).toBe('pass');
    expect(ran).toEqual({ writes: 1, checks: 1, closes: 1 });
    expect(received).toBe(email);
  });

  it('a raw finding from a function step reaches every re-asked judge whole and stays out of every recorded request', async () => {
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    const email = 'dev@example.com';
    const token = 'sk-live-secret123xyz';
    const prompts: string[] = [];
    // A function step's finding is never scrubbed on capture, so only a scrub
    // of the saved rounds could change what a re-asked judge reads.
    const build = (judgeEngine: MockEngine) => dag({
      name: 'send-back-secret',
      nodes: {
        write: {
          refine: review({ judge: judge(seat(judgeEngine, 'judge-mock'), { perFinding: false }) }),
          job: fnJob('write', () => ({ status: 'pass', data: 'draft' })),
        },
        check: {
          needs: 'write',
          sendsBackTo: ['write'],
          job: fnJob('check', () => revisionRequest({ target: 'write', reason: 'not yet', findings: [{ severity: 'should-fix', evidence: `mail ${email} with ${token}` }] })),
        },
      },
    });
    const failing = () => new MockEngine((req) => {
      prompts.push(req.prompt);
      throw new EngineError({ kind: 'billing', message: 'HTTP 402: no credits left on the account' });
    });
    expect((await run(build(failing()), { cwd: dir, recordTo: record })).outcome.status).toBe('paused');
    expect((await run(build(failing()), { cwd: dir, recordTo: record, resume: true })).outcome.status).toBe('paused');
    const repaired = new MockEngine((req) => { prompts.push(req.prompt); return JSON.stringify(roundAnswers('holds')); });
    expect((await run(build(repaired), { cwd: dir, recordTo: record, resume: true })).outcome.status).toBe('pass');

    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain(email);
      expect(prompt).toContain(token);
    }
    const requests = readFileSync(record, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.kind === 'refine:judge-request');
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const kept = JSON.stringify(request);
      expect(kept).not.toContain(email);
      expect(kept).not.toContain(token);
    }
  });

  it('the recorded request scrubs an injected env value and a secret shape out of the packet it keeps', async () => {
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    const { job } = scriptedTeam({
      reviewerReplies: [REVISE()],
      judgeReplies: [perFinding(roundAnswers('holds'))],
      cap: 5,
      brief: 'Use case: deploy with key supersecretvalue and token sk-ant-secret123xyz.',
    });
    const result = await run(withEnv({ JUDGE_API_KEY: 'supersecretvalue' }, job), { cwd: dir, recordTo: record });
    expect(result.outcome.status).toBe('pass');
    const events = readFileSync(record, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const request = events.find((e) => e.kind === 'refine:judge-request')!;
    const kept = JSON.stringify(request);
    expect(kept).not.toContain('supersecretvalue');
    expect(kept).not.toContain('sk-ant-secret123xyz');
    expect((request.packet as { why: { brief: string } }).why.brief).toContain('[redacted]');
  });

  it('a secret in the work survives a paused judge and stays out of every recorded request', async () => {
    const dir = workDir();
    const record = join(dir, 'record.jsonl');
    const email = 'dev@example.com';
    const token = 'sk-live-secret123xyz';
    const draftText = `the draft quotes ${email} and ${token}`;
    const finding = { severity: 'should-fix', evidence: `mail ${email} with ${token}` } as const;
    const team = (judgeReplies: readonly unknown[]) => scriptedTeam({
      reviewerReplies: [revise(finding)],
      judgeReplies,
      draftText,
      cap: 5,
    });
    const fails = (): never => {
      throw new EngineError({ kind: 'billing', message: 'HTTP 402: no credits left on the account' });
    };
    const first = team([fails]);
    const one = await run(first.job, { cwd: dir, recordTo: record });
    expect(one.outcome.status).toBe('paused');
    expect(first.writerCalls).toHaveLength(1);
    expect(first.reviewCalls).toHaveLength(1);
    expect(first.judgeCalls).toHaveLength(1);

    const second = team([fails]);
    const two = await run(second.job, { cwd: dir, recordTo: record, resume: true });
    expect(two.outcome.status).toBe('paused');
    // The saved panel stands: nothing builds or re-reviews, and the judge
    // is asked again at the same round.
    expect(second.writerCalls).toHaveLength(0);
    expect(second.reviewCalls).toHaveLength(0);
    expect(second.judgeCalls).toHaveLength(1);

    const third = team([perFinding({ stop_reason: { choice: 'holds' } })]);
    const three = await run(third.job, { cwd: dir, recordTo: record, resume: true });
    expect(three.outcome.status).toBe('pass');
    expect(third.writerCalls).toHaveLength(0);
    expect(third.reviewCalls).toHaveLength(0);
    expect(third.judgeCalls).toHaveLength(1);

    // Each re-ask went over the state the first call read: the second and
    // third requests are the first's, draft and finding unchanged.
    expect(second.judgeCalls[0]!.prompt).toBe(first.judgeCalls[0]!.prompt);
    expect(third.judgeCalls[0]!.prompt).toBe(first.judgeCalls[0]!.prompt);
    const sent = JSON.parse(first.judgeCalls[0]!.prompt).state as {
      when: { round: number }; what: { draft: string };
      how: { findings: readonly { evidence: string }[] };
    };
    expect(sent.when.round).toBe(1);
    expect(sent.what.draft).toBe(draftText);
    // The reviewer's reply is scrubbed when it is captured, so the finding
    // the judge reads is the one the record keeps.
    expect(sent.how.findings[0]!.evidence).toBe('mail [redacted] with [redacted]');

    // Three asks, three recorded requests, and no request event holds
    // either secret.
    const requests = readFileSync(record, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.kind === 'refine:judge-request');
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const kept = JSON.stringify(request);
      expect(kept).not.toContain(email);
      expect(kept).not.toContain(token);
    }
  });
});
