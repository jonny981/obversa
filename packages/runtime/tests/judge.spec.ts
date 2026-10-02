import { describe, expect, it } from 'vitest';

import { countBySeverity, hasBlockFinding, isJudge, judge, judgeDecision, stopQuestions } from '../src/core/judge.ts';
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

  it('rejects a non-positive or non-integer cap', () => {
    expect(() => judge(seat(), { cap: 0 })).toThrow(/positive integer/);
    expect(() => judge(seat(), { cap: -1 })).toThrow(/positive integer/);
    expect(() => judge(seat(), { cap: 1.5 })).toThrow(/positive integer/);
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

describe('hasBlockFinding', () => {
  it('is true only when a finding is tagged block', () => {
    expect(hasBlockFinding(undefined)).toBe(false);
    expect(hasBlockFinding([])).toBe(false);
    expect(hasBlockFinding([{ evidence: 'x', severity: 'should-fix' }])).toBe(false);
    expect(hasBlockFinding([{ evidence: 'x', severity: 'should-fix' }, { evidence: 'y', severity: 'block' }])).toBe(true);
    // A finding with no declared severity normalises to block (feedback.ts's own default).
    expect(hasBlockFinding([{ evidence: 'x' }])).toBe(true);
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
  it('routes on the chosen stop_reason first', () => {
    expect(judgeDecision({ stop_reason: { choice: 'over_polishing' } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge chose over_polishing',
      rule: 'stop_reason: over_polishing',
    });
    expect(judgeDecision({ stop_reason: { choice: 'continue' } }).again).toBe(true);
  });

  it('runs another round on a chosen continue, whatever the probability answers say', () => {
    // The probability answers sit flat across rounds; the chosen reason is the
    // one that moves, so a chosen continue is the judge's answer.
    expect(judgeDecision({
      stop_reason: { choice: 'continue' },
      worth_another_round: { noul: 0.49 },
    })).toEqual({ again: true, reason: 'the judge chose continue', rule: 'stop_reason: continue' });
    expect(judgeDecision({
      stop_reason: { choice: 'continue' },
      holds: { noul: 0.9 },
      worth_doing: { noul: 0.1 },
    }).again).toBe(true);
  });

  it('names the rule that decided it', () => {
    expect(judgeDecision({ stop_reason: { choice: 'holds' }, holds: { noul: 0.1 } }).rule).toBe('stop_reason: holds');
    expect(judgeDecision({ holds: { noul: 0.9 } }).rule).toBe('holds: 0.90');
    expect(judgeDecision({ worth_doing: { noul: 0.1 } }).rule).toBe('worth_doing: 0.10');
    expect(judgeDecision({ worth_another_round: { noul: 0.49 } }).rule).toBe('worth_another_round: 0.49');
    expect(judgeDecision({ worth_another_round: { noul: 0.8 } }).rule).toBe('worth_another_round: 0.80');
    expect(judgeDecision({}).rule).toBe('no clear answer');
  });

  it('ships on holds or over_polishing, fails on not_converging', () => {
    // holds and over_polishing: the work is good enough as it stands, ship it.
    expect(judgeDecision({ stop_reason: { choice: 'holds' } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge chose holds',
      rule: 'stop_reason: holds',
    });
    expect(judgeDecision({ stop_reason: { choice: 'over_polishing' } }).stop).toBe('ship');
    // not_converging: another round will not fix it, the requesting side's own
    // failure stands rather than shipping silently.
    expect(judgeDecision({ stop_reason: { choice: 'not_converging' } })).toEqual({
      again: false,
      stop: 'fail',
      reason: 'the judge chose not_converging',
      rule: 'stop_reason: not_converging',
    });
  });

  it('falls back to a clear holds/worth_doing/worth_another_round answer when the choice is unknown', () => {
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

  it('defaults to another round when nothing in the reply resolves a stop', () => {
    // An empty answers object is what an unreadable judge reply becomes
    // (askJudge's own JSON.parse failure path), and it must not force a stop.
    expect(judgeDecision({})).toEqual({ again: true, reason: 'the judge says another round is worth it', rule: 'no clear answer' });
  });

  it('stops on any choice other than "continue", not just the four documented ones, but only ships on holds or over_polishing', () => {
    // judgeDecision does not validate the choice against the question's own
    // criteria keys, a custom question set can name whatever it likes, and
    // anything but "continue" (or a missing/unparsed choice) reads as a stop.
    // An unrecognised choice is not known to mean "ship", so it fails safe.
    expect(judgeDecision({ stop_reason: { choice: 'converged' } })).toEqual({
      again: false,
      stop: 'fail',
      reason: 'the judge chose converged',
      rule: 'stop_reason: converged',
    });
  });

  it('accepts the probability field as well as noul, for an engine that answers that way', () => {
    expect(judgeDecision({ holds: { probability: 0.7 } })).toEqual({
      again: false,
      stop: 'ship',
      reason: 'the judge says it holds (0.70)',
      rule: 'holds: 0.70',
    });
  });
});
