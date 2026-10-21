import { describe, expect, it } from 'vitest';

import { countBySeverity, findingQuestions, isJudge, judge, judgeDecision, stopQuestions } from '../src/core/judge.ts';
import { MockEngine } from '../src/testing.ts';
import type { FeedbackFinding, TeamSeat } from '../src/api.ts';

function seat(): TeamSeat {
  return {
    engine: new MockEngine(() => ''),
    identity: { adapter: 'mock', provider: 'mock', modelFamily: 'mock', model: 'mock', tools: [] },
  };
}

describe('judge()', () => {
  it('defaults questions to stopQuestions() and validates cap', () => {
    const j = judge(seat(), { cap: 3 });
    expect(j).toMatchObject({ kind: 'judge', cap: 3 });
    expect(j.questions).toEqual(stopQuestions());
  });

  it('keeps a caller\'s own question set unchanged', () => {
    const questions = { holds: { type: 'noul' as const, instructions: 'x', criteria: { true: 'a', false: 'b' } } };
    const j = judge(seat(), { cap: 1, questions });
    expect(j.questions).toBe(questions);
  });

  it('decides each finding by default, and for a caller\'s own question set only when it opts in', () => {
    const questions = { holds: { type: 'noul' as const, instructions: 'x', criteria: { true: 'a', false: 'b' } } };
    expect(judge(seat(), { cap: 1 }).perFinding).toBe(true);
    expect(judge(seat(), { cap: 1, questions }).perFinding).toBe(false);
    expect(judge(seat(), { cap: 1, questions, perFinding: true }).perFinding).toBe(true);
    expect(judge(seat(), { cap: 1, perFinding: false }).perFinding).toBe(false);
  });

  it('needs no cap', () => {
    const j = judge(seat());
    expect(j).toMatchObject({ kind: 'judge', perFinding: true });
    expect(j.cap).toBeUndefined();
    expect('cap' in j).toBe(false);
    const questions = { holds: { type: 'noul' as const, instructions: 'x', criteria: { true: 'a', false: 'b' } } };
    expect(judge(seat(), { questions, perFinding: true })).toMatchObject({ questions, perFinding: true });
    expect(judge(seat(), { cap: undefined }).cap).toBeUndefined();
  });

  it('rejects a non-positive or non-integer cap', () => {
    expect(() => judge(seat(), { cap: 0 })).toThrow(/whole number of refinements, 1 or more/);
    expect(() => judge(seat(), { cap: -1 })).toThrow(/whole number of refinements, 1 or more/);
    expect(() => judge(seat(), { cap: 1.5 })).toThrow(/whole number of refinements, 1 or more/);
  });
});

describe('isJudge', () => {
  it('recognises a built judge and rejects a plain number', () => {
    expect(isJudge(judge(seat(), { cap: 1 }))).toBe(true);
    expect(isJudge(3)).toBe(false);
    expect(isJudge(undefined)).toBe(false);
    expect(isJudge({ kind: 'not-a-judge' })).toBe(false);
  });
});

describe('countBySeverity', () => {
  it('counts every severity, including the ones with none', () => {
    const findings: FeedbackFinding[] = [
      { evidence: 'a', severity: 'block' },
      { evidence: 'b', severity: 'should-fix' },
      { evidence: 'c', severity: 'should-fix' },
    ];
    expect(countBySeverity(findings)).toEqual({ block: 1, 'should-fix': 2, 'nice-to-have': 0, approve: 0 });
  });
});

describe('judgeDecision', () => {
  it('routes on the chosen stop_reason first, when its confidence clears the bar', () => {
    expect(judgeDecision({ stop_reason: { choice: 'over_polishing', confidence: 0.95 } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge chose over_polishing',
      rule: 'stop_reason: over_polishing',
    });
    expect(judgeDecision({ stop_reason: { choice: 'continue', confidence: 0.95 } }).again).toBe(true);
  });

  it('runs another round on a confident continue, whatever the probability answers say', () => {
    // The probability answers sit flat across rounds; the chosen reason is the
    // one that moves, so a chosen continue is the judge's answer.
    expect(judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      worth_another_round: { noul: 0.49 },
    })).toEqual({ again: true, reason: 'the judge chose continue', rule: 'stop_reason: continue' });
    expect(judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      holds: { noul: 0.9 },
      worth_doing: { noul: 0.1 },
    }).again).toBe(true);
  });

  it('names the rule that decided it', () => {
    expect(judgeDecision({ stop_reason: { choice: 'holds', confidence: 0.95 }, holds: { noul: 0.1 } }).rule).toBe('stop_reason: holds');
    expect(judgeDecision({ holds: { noul: 0.9 } }).rule).toBe('holds: 0.90');
    expect(judgeDecision({ worth_doing: { noul: 0.1 } }).rule).toBe('worth_doing: 0.10');
    expect(judgeDecision({ worth_another_round: { noul: 0.7 } }).rule).toBe('worth_another_round: 0.70');
    expect(judgeDecision({ worth_another_round: { noul: 0.8 } }).rule).toBe('worth_another_round: 0.80');
    expect(judgeDecision({}).rule).toBe('no clear answer');
  });

  it('ships on holds or over_polishing, fails on not_converging, each over the stop bar', () => {
    // holds and over_polishing: the work is good enough as it stands, ship it.
    expect(judgeDecision({ stop_reason: { choice: 'holds', confidence: 0.95 } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge chose holds',
      rule: 'stop_reason: holds',
    });
    expect(judgeDecision({ stop_reason: { choice: 'over_polishing', confidence: 0.95 } }).stop).toBe('ship');
    // not_converging: another round will not fix it, the requesting side's own
    // failure stands rather than shipping silently.
    expect(judgeDecision({ stop_reason: { choice: 'not_converging', confidence: 0.95 } })).toEqual({
      again: false,
      stop: 'fail',
      reason: 'the judge chose not_converging',
      rule: 'stop_reason: not_converging',
    });
  });

  it('hands a stop answer under the stop bar to a person instead of ending the run', () => {
    // 0.7 is over the hand-off floor but under the bar an ending needs.
    expect(judgeDecision({ stop_reason: { choice: 'holds', confidence: 0.7 } })).toMatchObject({
      again: false,
      stop: 'person',
      rule: 'stop_reason: holds',
    });
    expect(judgeDecision({ stop_reason: { choice: 'not_converging', confidence: 0.7 } })).toMatchObject({ stop: 'person' });
  });

  it('hands a stop answer under the hand-off floor, and a none_applies, to a person', () => {
    expect(judgeDecision({ stop_reason: { choice: 'holds', confidence: 0.4 } })).toMatchObject({ stop: 'person' });
    // No confidence at all reads as zero: missing confidence is uncertain.
    expect(judgeDecision({ stop_reason: { choice: 'holds' } })).toMatchObject({ stop: 'person' });
    expect(judgeDecision({ stop_reason: { choice: 'none_applies', confidence: 0.99 } })).toMatchObject({ stop: 'person' });
  });

  it('falls back to a clear holds/worth_doing/worth_another_round answer when the set has no stop_reason', () => {
    expect(judgeDecision({ holds: { noul: 0.9 } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge says it holds (0.90)',
      rule: 'holds: 0.90',
    });
    expect(judgeDecision({ worth_doing: { noul: 0.1 } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge says the findings are not worth doing (0.10)',
      rule: 'worth_doing: 0.10',
    });
    // worth_another_round alone cannot tell over-polishing from a stall (its
    // own criteria blend both), so the conservative fallback is fail, not ship.
    expect(judgeDecision({ worth_another_round: { noul: 0.1 } })).toEqual({
      again: false,
      stop: 'fail',
      reason: 'the judge says another round is not worth it (0.10)',
      rule: 'worth_another_round: 0.10',
    });
  });

  it('hands the round to a person when nothing in the reply resolves a route: fail closed', () => {
    // An empty answers object resolves no route: a person decides.
    expect(judgeDecision({})).toMatchObject({ again: false, stop: 'person', rule: 'no clear answer' });
    // Named answers under every bar go the same way.
    expect(judgeDecision({ holds: { noul: 0.5 }, worth_another_round: { noul: 0.5 } })).toMatchObject({ stop: 'person' });
  });

  it('stops on any confident choice other than "continue", not just the documented ones, but only ships on holds or over_polishing', () => {
    // judgeDecision does not validate the choice against the question's own
    // criteria keys, a custom question set can name whatever it likes, and
    // anything but "continue" (or a missing/unparsed choice) reads as a stop.
    // An unrecognised choice is not known to mean "ship", so it fails safe.
    expect(judgeDecision({ stop_reason: { choice: 'converged', confidence: 0.95 } })).toEqual({
      again: false,
      stop: 'fail',
      reason: 'the judge chose converged',
      rule: 'stop_reason: converged',
    });
  });

  it('accepts the probability field as well as noul, for an engine that answers that way', () => {
    expect(judgeDecision({ holds: { probability: 0.9 } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge says it holds (0.90)',
      rule: 'holds: 0.90',
    });
  });

  it('asks a person on a product_decision the judge is sure of or cannot rule out', () => {
    expect(judgeDecision({ product_decision: { noul: 0.9 } })).toMatchObject({ again: false, stop: 'product_decision', rule: 'product_decision: 0.90' });
    expect(judgeDecision({ product_decision: { noul: 0.5 } })).toMatchObject({ stop: 'product_decision', rule: 'product_decision: 0.50' });
    // A clear no is not a product decision.
    expect(judgeDecision({ product_decision: { noul: 0.05 }, stop_reason: { choice: 'continue', confidence: 0.95 } }).again).toBe(true);
  });
});

describe('judgeDecision for each finding', () => {
  const ids = ['finding-a', 'finding-b'];
  /** The score question each finding is asked, over the ordered levels. */
  const scores = {
    'finding-a': { type: 'score' as const, instructions: 'x', criteria: ['cosmetic', 'minor', 'impactful', 'blocking'] },
    'finding-b': { type: 'score' as const, instructions: 'x', criteria: ['cosmetic', 'minor', 'impactful', 'blocking'] },
  };

  it('runs another round with only the findings scored impactful, whatever the round answer says', () => {
    const decision = judgeDecision({
      stop_reason: { choice: 'holds', confidence: 0.95 },
      'finding-a': { score: 2, confidence: 0.95, reason: 'a reader would misread it' },
      'finding-b': { score: 0, confidence: 0.95 },
    }, ids, scores);
    expect(decision).toMatchObject({ again: true, rule: 'findings: 1 act, 1 held' });
    expect(decision.findings).toEqual([
      { id: 'finding-a', decision: 'act', level: 'impactful', confidence: 0.95, reason: 'a reader would misread it' },
      { id: 'finding-b', decision: 'hold', level: 'cosmetic', confidence: 0.95, reason: expect.stringMatching(/^Cosmetic/) },
    ]);
  });

  it('a score with a reason records it; without one, the level it landed on', () => {
    const findings = [
      { reviewer: 'r', severity: 'nice-to-have' as const, evidence: 'REAL: a crash on open' },
      { reviewer: 'r', severity: 'block' as const, evidence: 'a rare edge case' },
    ];
    const judged = { findings, round: 2 };
    const decision = judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      'finding-a': { score: 2, confidence: 0.95 },
      'finding-b': { score: 0, confidence: 0.95 },
    }, ids, scores, judged);
    expect(decision).toMatchObject({ again: true, rule: 'findings: 1 act, 1 held' });
    expect(decision.findings).toEqual([
      { id: 'finding-a', decision: 'act', level: 'impactful', confidence: 0.95, reason: expect.stringMatching(/^Impactful/) },
      { id: 'finding-b', decision: 'hold', level: 'cosmetic', confidence: 0.95, reason: expect.stringMatching(/^Cosmetic/) },
    ]);
    expect(decision.minorFindings).toMatchObject([
      { evidence: 'a rare edge case', id: 'finding-b', judgeLevel: 'cosmetic', judgeConfidence: 0.95 },
    ]);
    // All held back: even a confident not_converging lets the work stand
    // as a pass, the held list attached, rather than ending the run short.
    expect(judgeDecision({
      stop_reason: { choice: 'not_converging', confidence: 0.95 },
      'finding-a': { score: 0, confidence: 0.95 },
      'finding-b': { score: 1, confidence: 0.95 },
    }, ids, scores, judged)).toMatchObject({ again: false, stop: 'ship', rule: 'findings: 0 act, 2 held', minorFindings: [{ id: 'finding-a' }, { id: 'finding-b' }] });
    expect(judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      'finding-a': { score: 0, confidence: 0.95 },
      'finding-b': { score: 1, confidence: 0.95 },
    }, ids, scores, judged)).toMatchObject({ again: false, stop: 'ship', reason: 'the judge held every finding back', rule: 'findings: 0 act, 2 held' });
  });

  it('an impactful score under its send-back bar is held, and a blocking score clears a lower bar', () => {
    const findings = [
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'one' },
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'two' },
    ];
    const decision = judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      'finding-a': { score: 2, confidence: 0.6 },
      'finding-b': { score: 3, confidence: 0.65 },
    }, ids, scores, { findings, round: 2 });
    // The impactful score at 0.6 is under the 0.7 send-back bar, so it is
    // held; the blocking score at 0.65 clears the lower 0.6 blocking bar.
    expect(decision).toMatchObject({ again: true, rule: 'findings: 1 act, 1 held' });
    expect(decision.findings).toEqual([
      { id: 'finding-a', decision: 'hold', level: 'impactful', confidence: 0.6, reason: expect.stringMatching(/^Impactful/) },
      { id: 'finding-b', decision: 'act', level: 'blocking', confidence: 0.65, reason: expect.stringMatching(/^Blocking/) },
    ]);
    expect(decision.minorFindings).toMatchObject([{ evidence: 'one', judgeLevel: 'impactful', judgeConfidence: 0.6 }]);
  });

  it('hands a finding answer under the hand-off floor to a person, instead of routing it either way', () => {
    const findings = [
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'one' },
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'two' },
    ];
    const judged = { findings, round: 2 };
    // A blocking score under the floor: its level's lower bar cannot save
    // it, and it cannot sit on the held list either — a person decides.
    const decision = judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      'finding-a': { score: 3, confidence: 0.55 },
      'finding-b': { score: 0, confidence: 0.95 },
    }, ids, scores, judged);
    expect(decision).toMatchObject({ again: false, stop: 'person', rule: 'findings: 0 act, 1 held, 1 pending' });
    expect(decision.findings).toMatchObject([
      { id: 'finding-a', decision: 'pending', level: 'blocking', confidence: 0.55 },
      { id: 'finding-b', decision: 'hold', level: 'cosmetic', confidence: 0.95 },
    ]);
    expect(decision.ask).toContain('finding-a');
    // A missing confidence reads 0: under the floor, so no held route either.
    expect(judgeDecision({
      stop_reason: { choice: 'holds', confidence: 0.95 },
      'finding-a': { score: 2 },
      'finding-b': { score: 0, confidence: 0.95 },
    }, ids, scores, judged)).toMatchObject({ again: false, stop: 'person' });
    // The same under-floor answer pauses for a person even when another
    // finding's answer is sure enough to send back on its own.
    expect(judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      'finding-a': { score: 2, confidence: 0.9 },
      'finding-b': { score: 0, confidence: 0.3 },
    }, ids, scores, judged)).toMatchObject({ again: false, stop: 'person', rule: 'findings: 1 act, 0 held, 1 pending' });
  });

  it('keeps a required pause for a person over an acted finding: a hand-off is never traded for another round', () => {
    const findings = [
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'one' },
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'two' },
    ];
    const judged = { findings, round: 2 };
    const acted = { 'finding-a': { score: 2, confidence: 0.9 }, 'finding-b': { score: 0, confidence: 0.95 } };
    // none_applies asks a person; the acted finding rides in the decision.
    const onNone = judgeDecision({ ...acted, product_decision: { noul: 0.05 }, stop_reason: { choice: 'none_applies', confidence: 0.95 } }, ids, scores, judged);
    expect(onNone).toMatchObject({ again: false, stop: 'person', rule: 'stop_reason: none_applies' });
    expect(onNone.findings).toMatchObject([
      { id: 'finding-a', decision: 'act', level: 'impactful', confidence: 0.9 },
      { id: 'finding-b', decision: 'hold', level: 'cosmetic', confidence: 0.95 },
    ]);
    // A stop answer under its bar asks a person the same way, over the acted finding.
    expect(judgeDecision({ ...acted, stop_reason: { choice: 'holds', confidence: 0.5 } }, ids, scores, judged))
      .toMatchObject({ again: false, stop: 'person' });
  });

  it('a score can arrive as a probability per level, with the top share as its confidence', () => {
    const decision = judgeDecision({
      'finding-a': { probabilities: { cosmetic: 0, minor: 0.1, impactful: 0.8, blocking: 0.1 } },
      'finding-b': { probabilities: [{ label: 'cosmetic', probability: 0.9 }, { label: 'minor', probability: 0.1 }, { label: 'impactful', probability: 0 }, { label: 'blocking', probability: 0 }] },
    }, ids, scores);
    expect(decision.findings).toEqual([
      { id: 'finding-a', decision: 'act', level: 'impactful', confidence: 0.8, reason: expect.stringMatching(/^Impactful/) },
      { id: 'finding-b', decision: 'hold', level: 'cosmetic', confidence: 0.9, reason: expect.stringMatching(/^Cosmetic/) },
    ]);
  });

  it('ships as a pass when every finding is held back, even on a confident continue', () => {
    const held = { 'finding-a': { score: 0, confidence: 0.95 }, 'finding-b': { score: 1, confidence: 0.95 } };
    const findings = [
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'a style nit' },
      { reviewer: 'r', severity: 'nice-to-have' as const, evidence: 'a shorter name' },
    ];
    expect(judgeDecision({
      stop_reason: { choice: 'continue', confidence: 0.95 },
      ...held,
    }, ids, scores, { findings, round: 2 })).toMatchObject({ again: false, stop: 'ship', reason: 'the judge held every finding back', rule: 'findings: 0 act, 2 held' });
  });

  it('a finding the judge did not answer follows the round answer', () => {
    const decision = judgeDecision({ stop_reason: { choice: 'continue', confidence: 0.95 }, 'finding-a': { score: 0, confidence: 0.95 } }, ids, scores);
    expect(decision.again).toBe(true);
    expect(decision.findings)
      .toMatchObject([{ id: 'finding-a', decision: 'hold' }, { id: 'finding-b', decision: 'act', reason: 'no answer for this finding; the judge chose continue' }]);
    expect(judgeDecision({ stop_reason: { choice: 'holds', confidence: 0.95 } }, ids, scores)).toMatchObject({ again: false, stop: 'ship' });
  });

  it('answers naming no finding at all let the round answer route alone', () => {
    const decision = judgeDecision({ stop_reason: { choice: 'continue', confidence: 0.95 } }, ids, scores);
    expect(decision).toMatchObject({ again: true, reason: 'the judge chose continue' });
    expect(decision.findings).toBeUndefined();
  });

  it('still asks a person on product_decision, with the per-finding calls attached', () => {
    const decided = judgeDecision({
      product_decision: { noul: 0.9 },
      stop_reason: { choice: 'continue', confidence: 0.95 },
      'finding-a': { score: 2, confidence: 0.95 },
      'finding-b': { score: 0, confidence: 0.95 },
    }, ids, scores);
    expect(decided).toMatchObject({ again: false, stop: 'product_decision' });
    expect(decided.findings).toMatchObject([{ id: 'finding-a', decision: 'act' }, { id: 'finding-b', decision: 'hold' }]);
  });

  it('a stop that would fail the round does not override the answers for each finding', () => {
    const findings = [
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'one' },
      { reviewer: 'r', severity: 'should-fix' as const, evidence: 'two' },
    ];
    const round2 = { findings, round: 2 };
    const held = { 'finding-a': { score: 0, confidence: 0.95 }, 'finding-b': { score: 1, confidence: 0.95 } };
    const acted = { 'finding-a': { score: 2, confidence: 0.95 }, 'finding-b': { score: 0, confidence: 0.95 } };
    // Every finding held back ships, even on a confident not_converging or
    // a low worth_another_round.
    expect(judgeDecision({ ...held, stop_reason: { choice: 'not_converging', confidence: 0.95 } }, ids, scores, round2))
      .toMatchObject({ again: false, stop: 'ship', rule: 'findings: 0 act, 2 held' });
    expect(judgeDecision({ ...held, worth_another_round: { noul: 0.1 } }, ids, scores, round2))
      .toMatchObject({ again: false, stop: 'ship', rule: 'findings: 0 act, 2 held' });
    // And on a confident holds it ships.
    expect(judgeDecision({ ...held, stop_reason: { choice: 'holds', confidence: 0.95 } }, ids, scores, round2))
      .toMatchObject({ again: false, stop: 'ship', rule: 'stop_reason: holds' });
    // An acted finding goes back, even on not_converging; the cap still ends the rounds.
    expect(judgeDecision({ ...acted, stop_reason: { choice: 'not_converging', confidence: 0.95 } }, ids, scores, round2))
      .toMatchObject({ again: true, rule: 'findings: 1 act, 1 held' });
  });
});
