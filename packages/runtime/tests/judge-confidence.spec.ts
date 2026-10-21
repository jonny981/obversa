/**
 * The judge gates every action on the answer's confidence: a finding goes
 * back to the builder only at or above the send-back bar for its level, a
 * stop that would end the run only at or above the stop bar, and any answer
 * under the hand-off bar — or `none_applies` — goes to a person. Every
 * per-finding question is a `score` over ordered levels, and the runtime
 * computes the round counts and repeat findings itself; no question asks
 * the model to count or compare.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { judge, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, FeedbackFinding, InteractionBinding, JudgeAnswer, JudgeQuestions, LoopEvent, TeamSeat } from '../src/api.ts';
import {
  JUDGE_CONFIDENCE,
  findingId,
  findingQuestions,
  judgeDecision,
  judgedFindings,
  judgePacket,
  judgeState,
  repeatFindings,
  stopQuestions,
} from '../src/core/judge.ts';
import { workTree } from '../src/core/git.ts';
import { MockEngine } from '../src/testing.ts';
import { cleanupRepos, tmpRepo, write } from './git-helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  cleanupRepos();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'judge-confidence-'));
  dirs.push(dir);
  return dir;
}

function seat(engine: MockEngine, model = 'judge-mock', tools: readonly string[] = []): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}

const FINDING: FeedbackFinding = { severity: 'should-fix', evidence: 'the page never says who it is for' };
const TASTE: FeedbackFinding = { severity: 'nice-to-have', evidence: 'taste: prefer a warmer tone' };

/** A confident stop answer, so only the answer under test routes. */
const CONFIDENT_ROUND: Record<string, JudgeAnswer> = {
  product_decision: { noul: 0.05 },
  stop_reason: { choice: 'continue', confidence: 0.95 },
};

describe('the default question set', () => {
  it('asks product_decision as its own noul and stop_reason as a choice with none_applies', () => {
    const questions = stopQuestions();
    expect(questions.product_decision).toMatchObject({ type: 'noul', criteria: { true: expect.any(String), false: expect.any(String) } });
    expect(questions.stop_reason).toMatchObject({ type: 'choice' });
    expect(Object.keys(questions.stop_reason!.criteria)).toContain('none_applies');
    expect(Object.keys(questions)).toEqual(['product_decision', 'stop_reason']);
  });

  it('asks each finding as one score over ordered levels, in every round', () => {
    const questions = findingQuestions([FINDING, TASTE]);
    expect(Object.keys(questions)).toEqual(['finding-1', 'finding-2']);
    expect(questions['finding-1']).toMatchObject({ type: 'score', criteria: ['cosmetic', 'minor', 'impactful', 'blocking'] });
    expect(questions['finding-1']!.instructions).toContain(FINDING.evidence);
  });
});

describe('the per-finding confidence gate', () => {
  const questions = findingQuestions([FINDING]);
  const call = (answer: JudgeAnswer) =>
    judgeDecision({ ...CONFIDENT_ROUND, 'finding-1': answer }, ['finding-1'], questions, { findings: [FINDING], round: 2 });

  it('sends back a finding scored impactful at or over the send-back bar', () => {
    const decision = call({ score: 2, confidence: JUDGE_CONFIDENCE.sendBack, reason: 'a reader misses the audience' });
    expect(decision.again).toBe(true);
    expect(decision.findings).toEqual([
      { id: 'finding-1', decision: 'act', level: 'impactful', confidence: JUDGE_CONFIDENCE.sendBack, reason: 'a reader misses the audience' },
    ]);
  });

  it('holds a finding scored impactful under the send-back bar: `minorFindings`, not the builder', () => {
    const decision = call({ score: 2, confidence: JUDGE_CONFIDENCE.sendBack - 0.01, reason: 'a reader misses the audience' });
    expect(decision.again).toBe(false);
    expect(decision.findings).toEqual([
      { id: 'finding-1', decision: 'hold', level: 'impactful', confidence: JUDGE_CONFIDENCE.sendBack - 0.01, reason: 'a reader misses the audience' },
    ]);
    expect(decision.minorFindings).toEqual([
      expect.objectContaining({ evidence: FINDING.evidence, judgeLevel: 'impactful', judgeConfidence: JUDGE_CONFIDENCE.sendBack - 0.01 }),
    ]);
  });

  it('sends back a finding scored blocking over the lower blocking bar', () => {
    const decision = call({ score: 3, confidence: JUDGE_CONFIDENCE.sendBackBlocking, reason: 'data loss' });
    expect(decision.again).toBe(true);
    expect(decision.findings?.[0]).toMatchObject({ decision: 'act', level: 'blocking' });
  });

  it('never sends back a finding scored cosmetic or minor, however sure the judge is', () => {
    for (const score of [0, 1]) {
      const decision = call({ score, confidence: 0.99, reason: 'a nicety' });
      expect(decision.again).toBe(false);
      expect(decision.findings?.[0]).toMatchObject({ decision: 'hold' });
    }
  });

  it('hands a finding whose answer carries no confidence to a person: missing is uncertain', () => {
    const decision = call({ score: 3, reason: 'data loss' });
    expect(decision).toMatchObject({ again: false, stop: 'person' });
    expect(decision.findings?.[0]).toMatchObject({ decision: 'pending', level: 'blocking', confidence: 0 });
  });

  it('marks a blocking score under the hand-off bar pending: no level\'s bar goes under the floor', () => {
    const decision = call({ score: 3, confidence: JUDGE_CONFIDENCE.handOff - 0.01, reason: 'data loss' });
    expect(decision).toMatchObject({ again: false, stop: 'person' });
    expect(decision.findings?.[0]).toMatchObject({ decision: 'pending', level: 'blocking' });
    // Not a settled hold: the collected list keeps only calls the judge could make.
    expect(decision.minorFindings).toBeUndefined();
  });

  it('sends a pending finding back on the person\'s act, holds it on their hold — never onto the held list unsettled', () => {
    const decided = call({ score: 3, confidence: JUDGE_CONFIDENCE.handOff - 0.01 });
    const pending = decided.findings![0]!;
    expect(pending.decision).toBe('pending');
    // The person sent it back: the unsure call's level and confidence ride it.
    const routed = judgedFindings([FINDING], { findings: [{ ...pending, decision: 'act' }] }, [], 2);
    expect(routed.acted).toMatchObject([
      { evidence: FINDING.evidence, id: 'finding-1', judgeLevel: 'blocking', judgeConfidence: JUDGE_CONFIDENCE.handOff - 0.01 },
    ]);
    expect(routed.skipped).toEqual([]);
    // The person held it: it settles on the held list like any held finding.
    const held = judgedFindings([FINDING], { findings: [{ ...pending, decision: 'hold' }] }, [], 2);
    expect(held.acted).toEqual([]);
    expect(held.skipped).toMatchObject([{ finding: FINDING, level: 'blocking', confidence: JUDGE_CONFIDENCE.handOff - 0.01 }]);
    // A settled hold in the same round still settles.
    const mixed = judgeDecision({
      ...CONFIDENT_ROUND,
      'finding-1': { score: 3, confidence: JUDGE_CONFIDENCE.handOff - 0.01 },
      'finding-2': { score: 0, confidence: 0.95, reason: 'a nicety' },
    }, ['finding-1', 'finding-2'], findingQuestions([FINDING, TASTE]), { findings: [FINDING, TASTE], round: 2 });
    const split = judgedFindings([FINDING, TASTE], { findings: mixed.findings!.map((item) =>
      item.decision === 'pending' ? { ...item, decision: 'act' as const } : item) }, [], 2);
    expect(split.acted.map((finding) => finding.evidence)).toEqual([FINDING.evidence]);
    expect(split.skipped).toMatchObject([{ finding: TASTE, level: 'cosmetic' }]);
  });

  it('hands a continue under the stop bar to a person when no finding goes back', () => {
    const decision = judgeDecision({
      ...CONFIDENT_ROUND,
      stop_reason: { choice: 'continue', confidence: JUDGE_CONFIDENCE.stop - 0.01 },
      'finding-1': { score: 0, confidence: 0.95 },
    }, ['finding-1'], questions, { findings: [FINDING], round: 2 });
    expect(decision).toMatchObject({ again: false, stop: 'person', rule: 'findings: 0 act, 1 held' });
  });

  it('reads a score from a probability map when no single score comes back', () => {
    const decision = call({ probabilities: { cosmetic: 0.05, minor: 0.1, impactful: 0.8, blocking: 0.05 } });
    expect(decision.findings?.[0]).toMatchObject({ decision: 'act', level: 'impactful', confidence: 0.8 });
    expect(decision.again).toBe(true);
  });
});

describe('the stop answer\'s confidence gate', () => {
  it('lets a confident holds stand the work', () => {
    expect(judgeDecision({ ...CONFIDENT_ROUND, stop_reason: { choice: 'holds', confidence: 0.95 } }))
      .toMatchObject({ again: false, stop: 'ship', rule: 'stop_reason: holds' });
  });

  it('hands a stop answer under the hand-off bar to a person', () => {
    const decision = judgeDecision({ ...CONFIDENT_ROUND, stop_reason: { choice: 'holds', confidence: JUDGE_CONFIDENCE.handOff - 0.01 } });
    expect(decision).toMatchObject({ again: false, stop: 'person' });
    expect(decision.ask).toBeTruthy();
  });

  it('hands a stop answer under the stop bar but over the hand-off bar to a person', () => {
    const decision = judgeDecision({ ...CONFIDENT_ROUND, stop_reason: { choice: 'not_converging', confidence: JUDGE_CONFIDENCE.stop - 0.01 } });
    expect(decision).toMatchObject({ again: false, stop: 'person' });
  });

  it('hands none_applies to a person, however confident', () => {
    const decision = judgeDecision({ ...CONFIDENT_ROUND, stop_reason: { choice: 'none_applies', confidence: 0.99 } });
    expect(decision).toMatchObject({ again: false, stop: 'person', rule: 'stop_reason: none_applies' });
  });

  it('hands a stop answer with no confidence to a person', () => {
    const decision = judgeDecision({ product_decision: { noul: 0.05 }, stop_reason: { choice: 'holds' } });
    expect(decision).toMatchObject({ again: false, stop: 'person' });
  });

  it('still fails the run on a confident not_converging', () => {
    expect(judgeDecision({ ...CONFIDENT_ROUND, stop_reason: { choice: 'not_converging', confidence: 0.95 } }))
      .toMatchObject({ again: false, stop: 'fail' });
  });

  it('still runs another round on a confident continue', () => {
    expect(judgeDecision({ ...CONFIDENT_ROUND, stop_reason: { choice: 'continue', confidence: 0.9 } }))
      .toMatchObject({ again: true });
  });
});

describe('the product_decision question', () => {
  it('asks a person when the judge is sure one is needed', () => {
    expect(judgeDecision({ product_decision: { noul: 0.9 }, stop_reason: { choice: 'holds', confidence: 0.95 } }))
      .toMatchObject({ again: false, stop: 'product_decision' });
  });

  it('asks a person when the judge cannot say either way', () => {
    expect(judgeDecision({ product_decision: { noul: 0.5 }, stop_reason: { choice: 'holds', confidence: 0.95 } }))
      .toMatchObject({ again: false, stop: 'product_decision' });
  });

  it('leaves the route to the stop answer when the judge is sure none is needed', () => {
    expect(judgeDecision({ product_decision: { noul: 0.05 }, stop_reason: { choice: 'holds', confidence: 0.95 } }))
      .toMatchObject({ stop: 'ship' });
  });
});

describe('repeats and counts the code computes', () => {
  const earlier = (round: number, finding: FeedbackFinding) => ({ round, finding });

  it('counts a repeat as the same reviewer, the same file and the same claim', () => {
    const first: FeedbackFinding = { reviewer: 'read', severity: 'should-fix', evidence: 'src/page.md:12 buries the ask under a greeting' };
    const again: FeedbackFinding = { reviewer: 'read', severity: 'block', evidence: 'src/page.md:47 buries the ask under a greeting' };
    const repeats = repeatFindings([again], [earlier(1, first)]);
    expect(repeats).toEqual([{ id: 'finding-1', sinceRound: 1, reviewer: 'read', file: 'src/page.md' }]);
  });

  it('does not count a different reviewer or a different claim as a repeat', () => {
    const first: FeedbackFinding = { reviewer: 'read', severity: 'should-fix', evidence: 'src/page.md buries the ask under a greeting' };
    const otherReviewer: FeedbackFinding = { reviewer: 'edit', severity: 'should-fix', evidence: 'src/page.md buries the ask under a greeting' };
    const otherClaim: FeedbackFinding = { reviewer: 'read', severity: 'should-fix', evidence: 'src/page.md opens with the price' };
    expect(repeatFindings([otherReviewer, otherClaim], [earlier(1, first)])).toEqual([]);
  });

  it('ignores line numbers in the claim: a moved line is still the same claim', () => {
    const first: FeedbackFinding = { reviewer: 'read', evidence: 'page.md:12 the ask is buried' };
    const again: FeedbackFinding = { reviewer: 'read', evidence: 'page.md:99 the ask is buried' };
    expect(repeatFindings([again], [earlier(1, first)])).toHaveLength(1);
  });
});

describe('the packet the judge reads', () => {
  it('keeps a short-word requirement the finding breaks: recall over precision', async () => {
    const state = judgeState({
      work: { brief: 'Do not log keys.\nKeep the page short.' },
      draft: 'draft',
      productFeedback: [],
      latestFindings: [{ severity: 'should-fix', evidence: 'src/log.ts:12 logs the API key' }],
      skipped: [],
      rounds: [],
      round: { round: 1 },
    });
    const packet = await judgePacket(state, workDir(), 50_000);
    expect(packet.how.findings[0]!.brief).toContain('Do not log keys');
  });

  it('keeps the requirement a finding cites by number, even when another line shares a word', async () => {
    const state = judgeState({
      work: { brief: '1. Keep the API fast.\n2. Never disclose credentials.' },
      draft: 'draft',
      productFeedback: [],
      latestFindings: [{ severity: 'block', evidence: 'Rule 2: src/log.ts logs API keys' }],
      skipped: [],
      rounds: [],
      round: { round: 1 },
    });
    const packet = await judgePacket(state, workDir(), 50_000);
    expect(packet.how.findings[0]!.brief).toContain('2. Never disclose credentials.');
  });

  it('sends the whole brief when a cited requirement matches no line of it', async () => {
    const brief = '- Keep the API fast.\n- Never disclose credentials.';
    const state = judgeState({
      work: { brief },
      draft: 'draft',
      productFeedback: [],
      latestFindings: [{ severity: 'block', evidence: 'Requirement 2: src/log.ts logs API keys' }],
      skipped: [],
      rounds: [],
      round: { round: 1 },
    });
    const packet = await judgePacket(state, workDir(), 50_000);
    expect(packet.how.findings[0]!.brief).toBe(brief);
  });

  it('sends the whole brief when no line matches a finding, bounded by the packet limit', async () => {
    const brief = 'Ship on Friday.\nTell no one.';
    const state = judgeState({
      work: { brief },
      draft: 'draft',
      productFeedback: [],
      latestFindings: [FINDING],
      skipped: [],
      rounds: [],
      round: { round: 1 },
    });
    const packet = await judgePacket(state, workDir(), 50_000);
    expect(packet.how.findings[0]!.brief).toBe(brief);
    // A small limit still bounds it: cut, never dropped.
    const cut = await judgePacket(state, workDir(), 300);
    expect((cut.how.findings[0]!.brief ?? '').length).toBeLessThan(brief.length);
  });

  it('attaches every hunk a finding cites, not only the first', async () => {
    const dir = await tmpRepo();
    const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
    write(dir, 'notes.md', `${lines.join('\n')}\n`);
    const base = await workTree({ cwd: dir });
    lines[4] = 'line 5 changed';
    lines[49] = 'line 50 changed';
    write(dir, 'notes.md', `${lines.join('\n')}\n`);
    const tree = await workTree({ cwd: dir });
    const state = judgeState({
      work: { base },
      draft: 'draft',
      tree,
      productFeedback: [],
      latestFindings: [{ severity: 'should-fix', evidence: 'notes.md:5 and notes.md:50 disagree with each other' }],
      skipped: [],
      rounds: [],
      round: { round: 1 },
    });
    const packet = await judgePacket(state, dir, 50_000);
    const [finding] = packet.how.findings;
    // Both cited places come along: the line-5 hunk and the line-50 hunk.
    expect(finding!.diff).toContain('line 5 changed');
    expect(finding!.diff).toContain('line 50 changed');
  });

  it('gives each finding the brief lines it touches and its own diff hunk, not every diff', async () => {
    const dir = await tmpRepo();
    write(dir, 'page.md', 'hello\n');
    write(dir, 'notes.md', 'scratch\n');
    const base = await workTree({ cwd: dir });
    write(dir, 'page.md', 'hello world\n');
    write(dir, 'notes.md', 'scratch pad\n');
    const tree = await workTree({ cwd: dir });
    const state = judgeState({
      work: { brief: 'The page must name one audience.\nKeep it under a screen.', useCase: 'a useful page', base },
      draft: 'hello world\n',
      tree,
      productFeedback: [],
      latestFindings: [
        { severity: 'should-fix', evidence: 'page.md still does not name the audience' },
        { severity: 'nice-to-have', evidence: 'notes.md could be tidier' },
      ],
      skipped: [],
      rounds: [],
      round: { round: 1 },
    });
    const packet = await judgePacket(state, dir, 50_000);
    const [first, second] = packet.how.findings;
    expect(first).toMatchObject({ id: 'finding-1' });
    expect(first!.brief).toContain('name one audience');
    expect(first!.brief).not.toContain('under a screen');
    expect(first!.diff).toContain('page.md');
    // The hunk the finding cites is attached to it; the other file's diff is not.
    expect(first!.diff).not.toContain('notes.md');
    expect(second!.diff).toContain('notes.md');
    // And the whole brief and diff bundle are gone from the shared parts.
    expect(packet.why).not.toHaveProperty('brief');
    expect(packet.what).not.toHaveProperty('diffs');
  });

  it('sends the round counts and repeats as numbers in when, not the whole history', async () => {
    const state = judgeState({
      work: { useCase: 'a useful page' },
      draft: 'draft',
      productFeedback: [],
      latestFindings: [FINDING],
      skipped: [],
      rounds: [
        { round: 1, findings: [FINDING, TASTE], counts: { block: 0, 'should-fix': 1, 'nice-to-have': 1, approve: 0 }, judged: { reason: 'the judge acts on 1 of 2 findings', findings: [
          { id: 'finding-1', decision: 'act', level: 'impactful', confidence: 0.9, reason: 'real' },
          { id: 'finding-2', decision: 'hold', level: 'cosmetic', confidence: 0.9, reason: 'taste' },
        ] } },
        { round: 2, findings: [FINDING], counts: { block: 0, 'should-fix': 1, 'nice-to-have': 0, approve: 0 }, judged: { reason: 'the judge acts on 1 of 1 findings', findings: [
          { id: 'finding-1', decision: 'act', level: 'impactful', confidence: 0.9, reason: 'real' },
        ] } },
      ],
      round: { round: 3 },
    });
    const packet = await judgePacket(state, workDir(), 50_000);
    expect(packet.when).toMatchObject({
      round: 3,
      openFindings: 1,
      actedOnLastRound: 1,
      actedOnRoundBefore: 1,
      actedCountFalling: false,
    });
    // The finding is the same claim a reviewer already raised in rounds 1 and 2.
    expect(packet.when.repeats).toEqual([{ id: 'finding-1', sinceRound: 1 }]);
    // The earlier rounds ride along as counts, not as finding lists.
    expect(packet.when.rounds).toEqual([
      expect.objectContaining({ round: 1, acted: 1 }),
      expect.objectContaining({ round: 2, acted: 1 }),
    ]);
    expect(JSON.stringify(packet.when.rounds)).not.toContain('the page never says');
  });
});

describe('a run under the gate', () => {
  function judged(opts: {
    readonly reviewerReplies: readonly unknown[];
    readonly judgeReply: (prompt: string) => Record<string, unknown>;
    readonly interaction?: InteractionBinding;
  }) {
    const calls: { writer: string[]; judge: string[]; reviewer: number } = { writer: [], judge: [], reviewer: 0 };
    const writer = new MockEngine((req: AgentRequest) => {
      calls.writer.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${calls.writer.length}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine((req: AgentRequest) => {
      void req;
      return JSON.stringify(opts.reviewerReplies[Math.min(calls.reviewer++, opts.reviewerReplies.length - 1)]);
    });
    const judgeEngine = new MockEngine((req: AgentRequest) => {
      calls.judge.push(req.prompt);
      return JSON.stringify(opts.judgeReply(req.prompt));
    });
    const job = workflow('confidence', {
      brief: 'Use case: a reader gets a clear, short page.\n\nWrite the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', {
        agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer',
        refine: judge(seat(judgeEngine), opts.interaction === undefined ? {} : { interaction: opts.interaction }),
      })],
    });
    return { job, calls };
  }

  /** Answer every asked question; `over` sets the answers under test. */
  function answering(over: Record<string, unknown>) {
    return (prompt: string) => {
      const { questions } = JSON.parse(prompt) as { questions: JudgeQuestions };
      const answers: Record<string, unknown> = { ...CONFIDENT_ROUND, ...over };
      for (const [key, question] of Object.entries(questions)) {
        if (key in answers || !key.startsWith('finding-')) continue;
        answers[key] = { score: 0, confidence: 0.95, reason: 'a nicety' };
      }
      return answers;
    };
  }

  it('asks the per-finding questions first, then the round questions with this round\'s acted count', async () => {
    const { job, calls } = judged({
      reviewerReplies: [
        { status: 'revise', summary: 'two findings', findings: [FINDING, TASTE] },
        { status: 'pass', summary: 'fine' },
      ],
      judgeReply: (prompt) => {
        const { questions } = JSON.parse(prompt) as { questions: JudgeQuestions };
        const answers: Record<string, unknown> = { ...CONFIDENT_ROUND };
        for (const key of Object.keys(questions)) {
          if (!key.startsWith('finding-')) continue;
          answers[key] = key === 'finding-1'
            ? { score: 2, confidence: 0.95, reason: 'a reader misses the audience' }
            : { score: 0, confidence: 0.95, reason: 'a nicety' };
        }
        return answers;
      },
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('pass');
    // Round 1 is two asks: every finding's score first, then the round
    // questions carrying what those answers decided.
    const first = JSON.parse(calls.judge[0]!) as { questions: Record<string, unknown> };
    expect(Object.keys(first.questions)).toEqual(['finding-1', 'finding-2']);
    const second = JSON.parse(calls.judge[1]!) as {
      questions: Record<string, unknown>;
      state: { when: Record<string, unknown> };
    };
    expect(Object.keys(second.questions)).toEqual(Object.keys(stopQuestions()));
    expect(second.state.when).toMatchObject({ openFindings: 2, actedOnThisRound: 1 });
  });

  it('keeps each call\'s answers to the questions it asked: a stray finding answer in the round call never overwrites a score', async () => {
    const { job, calls } = judged({
      reviewerReplies: [
        { status: 'revise', summary: 'one finding', findings: [FINDING] },
        { status: 'pass', summary: 'fine' },
      ],
      judgeReply: (prompt) => {
        const { questions } = JSON.parse(prompt) as { questions: JudgeQuestions };
        // The findings call scores finding-1 impactful; the round call
        // carries a cosmetic answer for it that nobody asked for.
        return 'finding-1' in questions
          ? { 'finding-1': { score: 2, confidence: 0.95, reason: 'a reader misses the audience' } }
          : { ...CONFIDENT_ROUND, 'finding-1': { score: 0, confidence: 0.95, reason: 'a nicety' } };
      },
    });
    const events: LoopEvent[] = [];
    const result = await run(job, { cwd: workDir(), onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    expect(calls.writer).toHaveLength(2);
    const judgedEvent = events.find((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
    expect(judgedEvent?.findings).toEqual([
      { id: 'finding-1', decision: 'act', level: 'impactful', confidence: 0.95, reason: 'a reader misses the audience' },
    ]);
  });

  it('never sends a minor finding back: the run stands and `minorFindings` carries it', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [TASTE] }],
      judgeReply: answering({}),
    });
    const events: LoopEvent[] = [];
    const result = await run(job, { cwd: workDir(), onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    expect(calls.writer).toHaveLength(1);
    const judgedEvent = events.find((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
    expect(judgedEvent?.findings).toEqual([
      { id: 'finding-1', decision: 'hold', level: 'cosmetic', confidence: 0.95, reason: 'a nicety' },
    ]);
    const data = result.outcome.data as Record<string, { minorFindings?: unknown[] }>;
    expect(data.write?.minorFindings).toEqual([
      expect.objectContaining({ evidence: TASTE.evidence, judgeLevel: 'cosmetic', judgeConfidence: 0.95 }),
    ]);
  });

  it('puts an impactful finding under the send-back bar on `minorFindings`, not back to the builder', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
      judgeReply: answering({
        'finding-1': { score: 2, confidence: JUDGE_CONFIDENCE.sendBack - 0.01, reason: 'a reader misses the audience' },
      }),
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('pass');
    expect(calls.writer).toHaveLength(1);
  });

  it('pauses the run for a person on a stop answer under the bar', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
      judgeReply: answering({ stop_reason: { choice: 'holds', confidence: 0.5 } }),
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('paused');
    const data = result.outcome.data as Record<string, { status: string; data?: { decisionText?: string } }>;
    expect(data.write?.status).toBe('paused');
    expect(data.write?.data?.decisionText).toContain('holds');
    expect(calls.writer).toHaveLength(1);
  });

  it('pauses the run for a person on none_applies', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
      judgeReply: answering({ stop_reason: { choice: 'none_applies', confidence: 0.99 } }),
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('paused');
    expect(calls.writer).toHaveLength(1);
  });

  it('pauses the run for a person on a continue under the stop bar with nothing to send back', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
      judgeReply: answering({ stop_reason: { choice: 'continue', confidence: JUDGE_CONFIDENCE.stop - 0.01 } }),
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('paused');
    expect(calls.writer).toHaveLength(1);
  });

  it('sends a pending finding back on the person\'s "act" call: its evidence reaches the builder, and it never joins the held list', async () => {
    const { job, calls } = judged({
      reviewerReplies: [
        { status: 'revise', summary: 'one finding', findings: [FINDING] },
        { status: 'revise', summary: 'a taste note', findings: [TASTE] },
      ],
      judgeReply: (prompt) => {
        const { state, questions } = JSON.parse(prompt) as { state: { when: { round: number } }; questions: JudgeQuestions };
        const answers: Record<string, unknown> = { ...CONFIDENT_ROUND };
        for (const key of Object.keys(questions)) {
          if (!key.startsWith('finding-')) continue;
          // Round 1's finding is blocking under the hand-off floor: pending.
          answers[key] = state.when.round === 1
            ? { score: 3, confidence: JUDGE_CONFIDENCE.handOff - 0.01, reason: 'data loss' }
            : { score: 0, confidence: 0.95, reason: 'a nicety' };
        }
        return answers;
      },
      interaction: {
        id: 'hand-off',
        responseSchema: {},
        answer: async () => ({ feedback: { findings: { 'finding-1': 'act' } }, prompt: 'Send finding-1 back.' }),
      },
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('pass');
    // The person's "act" went to the builder with the pending finding's evidence.
    expect(calls.writer).toHaveLength(2);
    expect(calls.writer[1]).toContain('Send finding-1 back.');
    expect(calls.writer[1]).toContain(FINDING.evidence);
    // It never settled as a hold: the next round's judge packet names no skipped finding.
    const next = JSON.parse(calls.judge[2]!) as { state: { when: { skipped?: unknown[] } } };
    expect(next.state.when.skipped).toBeUndefined();
  });

  it('honours a person\'s "hold": nothing goes back, the run ends as a pass, and `minorFindings` carries the held finding', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
      judgeReply: answering({
        'finding-1': { score: 3, confidence: JUDGE_CONFIDENCE.handOff - 0.01, reason: 'data loss' },
      }),
      interaction: {
        id: 'hand-off',
        responseSchema: {},
        answer: async () => ({ feedback: { findings: { 'finding-1': 'hold' } }, prompt: 'Hold finding-1; ship it as it stands.' }),
      },
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('pass');
    // No finding went back, so the person bought no build: the work stands.
    expect(calls.writer).toHaveLength(1);
    const data = result.outcome.data as Record<string, { minorFindings?: unknown[] }>;
    expect(data.write?.minorFindings).toEqual([
      expect.objectContaining({ evidence: FINDING.evidence, judgeLevel: 'blocking', judgeConfidence: JUDGE_CONFIDENCE.handOff - 0.01 }),
    ]);
  });

  it('honours a person\'s "ship it" on an undecidable round: the work stands, with no extra build', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
      judgeReply: answering({ stop_reason: { choice: 'none_applies', confidence: 0.9 } }),
      interaction: {
        id: 'hand-off',
        responseSchema: {},
        answer: async () => ({ feedback: { ruling: 'ship' }, prompt: 'Ship it as it stands.' }),
      },
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('pass');
    // The person's answer ended the run: nothing went back to the builder.
    expect(calls.writer).toHaveLength(1);
    const data = result.outcome.data as Record<string, { minorFindings?: unknown[] }>;
    expect(data.write?.minorFindings).toEqual([
      expect.objectContaining({ evidence: FINDING.evidence, judgeLevel: 'cosmetic' }),
    ]);
  });

  it('holds a pending finding the person never named: an unnamed pending finding never goes back', async () => {
    const { job, calls } = judged({
      reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
      judgeReply: answering({
        stop_reason: { choice: 'none_applies', confidence: 0.9 },
        'finding-1': { score: 3, confidence: JUDGE_CONFIDENCE.handOff - 0.01, reason: 'data loss' },
      }),
      interaction: {
        id: 'hand-off',
        responseSchema: {},
        // "Ship it" names no finding: the pending one is held, not sent back.
        answer: async () => ({ feedback: { ruling: 'ship' }, prompt: 'Ship it as it stands.' }),
      },
    });
    const result = await run(job, { cwd: workDir(), onEvent: () => {} });
    expect(result.outcome.status).toBe('pass');
    expect(calls.writer).toHaveLength(1);
    const data = result.outcome.data as Record<string, { minorFindings?: unknown[] }>;
    expect(data.write?.minorFindings).toEqual([
      expect.objectContaining({ evidence: FINDING.evidence, judgeLevel: 'blocking', judgeConfidence: JUDGE_CONFIDENCE.handOff - 0.01 }),
    ]);
  });

  it('asks hold/act for each pending finding on every pause, whatever the stop reason', async () => {
    for (const over of [
      { product_decision: { noul: 0.95 } },
      { stop_reason: { choice: 'none_applies', confidence: 0.9 } },
      { stop_reason: { choice: 'holds', confidence: JUDGE_CONFIDENCE.stop - 0.01 } },
    ]) {
      const { job, calls } = judged({
        reviewerReplies: [{ status: 'revise', summary: 'one finding', findings: [FINDING] }],
        judgeReply: answering({
          ...over,
          'finding-1': { score: 3, confidence: JUDGE_CONFIDENCE.handOff - 0.01, reason: 'data loss' },
        }),
      });
      const result = await run(job, { cwd: workDir(), onEvent: () => {} });
      expect(result.outcome.status).toBe('paused');
      const data = result.outcome.data as Record<string, { data?: { decisionText?: string } }>;
      // The pause asks about the pending finding itself, not only the round.
      expect(data.write?.data?.decisionText).toContain('finding-1');
      expect(data.write?.data?.decisionText).toContain('hold');
      expect(calls.writer).toHaveLength(1);
    }
  });
});

describe('findingQuestions ids', () => {
  it('keys each question finding-1, finding-2 in order', () => {
    expect(findingId(0)).toBe('finding-1');
    const questions = findingQuestions([FINDING, TASTE]);
    expect(Object.keys(questions)).toEqual(['finding-1', 'finding-2']);
  });
});
