import { describe, expect, it } from 'vitest';

import {
  pick,
  PICK_QUESTION_VERSION,
  type MemoryCandidate,
  type PickAnswer,
  type PickBatch,
  type PickDecide,
} from '../src/index.js';

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: `text of ${overrides.sourceId}/${overrides.id}`,
    signals: { score: 0 },
    ...overrides,
  };
}

function answered(probability: number): PickAnswer {
  return { status: 'answered', probability };
}

function stubDecide(
  handler: (batch: PickBatch, call: number) => Record<string, PickAnswer>,
): { decide: PickDecide; calls: PickBatch[]; signals: AbortSignal[] } {
  const calls: PickBatch[] = [];
  const signals: AbortSignal[] = [];
  return {
    calls,
    signals,
    decide: async (batch, signal) => {
      calls.push(batch);
      signals.push(signal);
      return handler(batch, calls.length);
    },
  };
}

function allAnswered(batch: PickBatch, probability: number): Record<string, PickAnswer> {
  return Object.fromEntries(batch.questions.map((question) => [question.key, answered(probability)]));
}

describe('pick', () => {
  it('ranks candidates inside a source and selects those at or above the threshold', async () => {
    const candidates = [
      candidate({ sourceId: 'notes', id: 'low', signals: { score: 1 } }),
      candidate({ sourceId: 'notes', id: 'high', signals: { score: 9 } }),
      candidate({ sourceId: 'notes', id: 'mid', signals: { score: 5 } }),
    ];
    const { decide, calls } = stubDecide((batch) =>
      Object.fromEntries(batch.questions.map((question) => [
        question.key,
        answered(question.id === 'low' ? 0.2 : 0.9),
      ])));

    const result = await pick(candidates, { task: 'fix the flaky test', decide });

    expect(result.selected.map((item) => item.id)).toEqual(['high', 'mid']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.questions.map((question) => question.id)).toEqual(['high', 'mid', 'low']);
    expect(result.record.questionVersion).toBe(PICK_QUESTION_VERSION);
    expect(result.record.thresholds).toEqual({ reference: 0.6, rule: 0.6, linkedPathBar: 0.4 });
    expect(result.record.limits).toEqual({ maxPerBatch: 150, maxQuestionText: 700 });
    expect(result.record.candidates.map((entry) => [entry.id, entry.priority])).toEqual([
      ['low', 2],
      ['high', 0],
      ['mid', 1],
    ]);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'rejected', 'selected', 'selected',
    ]);
    expect(result.record.rulesCoverage).toBe('complete');
  });

  it('shares the budget across reference sources so a large source cannot crowd out a small one', async () => {
    const commits = Array.from({ length: 500 }, (_, index) =>
      candidate({ sourceId: 'commits', id: `c${index}`, signals: { score: 1000 - index } }));
    const handbook = Array.from({ length: 5 }, (_, index) =>
      candidate({ sourceId: 'handbook', id: `h${index}`, signals: { score: index } }));
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.1));

    const result = await pick([...commits, ...handbook], {
      task: 'plan the release',
      decide,
      limits: { maxCandidates: 10, maxPerBatch: 10 },
    });

    const askedIds = calls.flatMap((batch) => batch.questions.map((question) => question.sourceId));
    expect(askedIds.filter((sourceId) => sourceId === 'handbook')).toHaveLength(5);
    expect(askedIds.filter((sourceId) => sourceId === 'commits')).toHaveLength(5);
    const unassessed = result.record.candidates.filter((entry) => entry.status === 'unassessed');
    expect(unassessed).toHaveLength(495);
    expect(unassessed.every((entry) => entry.status === 'unassessed' && entry.reason === 'limits')).toBe(true);
  });

  it('marks remaining candidates unassessed with reason cancelled when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}`, signals: { score: 5 - index } }));
    const { decide, calls, signals } = stubDecide((batch, call) => {
      if (call === 1) controller.abort();
      return allAnswered(batch, 0.9);
    });

    const result = await pick(candidates, {
      task: 'write the report',
      decide,
      limits: { maxPerBatch: 2 },
      signal: controller.signal,
    });

    expect(calls).toHaveLength(1);
    expect(signals[0]).toBe(controller.signal);
    expect(signals[0]!.aborted).toBe(true);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'selected', 'selected', 'unassessed', 'unassessed', 'unassessed',
    ]);
    expect(result.record.candidates.slice(2).every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'cancelled')).toBe(true);
  });

  it('keeps asking after a batch that selects nothing', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}`, signals: { score: 6 - index } }));
    const { decide, calls } = stubDecide((batch, call) =>
      allAnswered(batch, call === 2 ? 0.1 : 0.9));

    const result = await pick(candidates, {
      task: 'triage the bug',
      decide,
      limits: { maxPerBatch: 2 },
    });

    expect(calls).toHaveLength(3);
    expect(result.selected.map((item) => item.id)).toEqual(['n0', 'n1', 'n4', 'n5']);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'selected', 'selected', 'rejected', 'rejected', 'selected', 'selected',
    ]);
  });

  it('asks and records two candidates that share a relative path in different sources', async () => {
    const candidates = [
      candidate({ sourceId: 'left', id: 'docs/todo.md' }),
      candidate({ sourceId: 'right', id: 'docs/todo.md' }),
    ];
    const { decide, calls } = stubDecide((batch) => {
      const answers: Record<string, PickAnswer> = {};
      for (const question of batch.questions) {
        if (question.sourceId === 'left') answers[question.key] = answered(0.9);
      }
      return answers;
    });

    const result = await pick(candidates, { task: 'review the list', decide });

    const questions = calls.flatMap((batch) => batch.questions);
    expect(questions.map((question) => question.sourceId)).toEqual(['left', 'right']);
    expect(new Set(questions.map((question) => question.key)).size).toBe(2);
    expect(result.selected.map((item) => item.sourceId)).toEqual(['left']);
    expect(result.record.candidates.map((entry) => [entry.sourceId, entry.status])).toEqual([
      ['left', 'selected'],
      ['right', 'unanswered'],
    ]);
  });

  it('records a missing key, a refusal and an out-of-range probability as unanswered', async () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}` }));
    const { decide } = stubDecide((batch) => ({
      [batch.questions[0]!.key]: answered(0.9),
      [batch.questions[2]!.key]: { status: 'refused', detail: 'no opinion' },
      [batch.questions[3]!.key]: answered(1.5),
    }));

    const result = await pick(candidates, { task: 'pick a fix', decide });

    expect(result.selected.map((item) => item.id)).toEqual(['n0']);
    const statuses = result.record.candidates;
    expect(statuses[1]).toMatchObject({ status: 'unanswered', answer: 'missing' });
    expect(statuses[2]).toMatchObject({ status: 'unanswered', answer: 'refused', detail: 'no opinion' });
    expect(statuses[3]).toMatchObject({ status: 'unanswered', answer: 'error' });
    expect(statuses.some((entry) => entry.status === 'rejected')).toBe(false);
  });

  it('stops when a decide call stays pending past the elapsed limit', async () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      candidate({ sourceId: 'notes', id: `n${index}` }));
    let received: AbortSignal | undefined;
    const decide: PickDecide = (_batch, signal) => {
      received = signal;
      return new Promise<Record<string, PickAnswer>>(() => {});
    };

    const result = await pick(candidates, {
      task: 'triage the queue',
      decide,
      limits: { maxPerBatch: 2, maxElapsedMs: 25 },
    });

    expect(received?.aborted).toBe(true);
    expect(result.record.candidates.map((entry) => entry.status)).toEqual([
      'unanswered', 'unanswered', 'unassessed', 'unassessed',
    ]);
    expect(result.record.candidates.slice(0, 2).every((entry) =>
      entry.status === 'unanswered' && entry.answer === 'error')).toBe(true);
    expect(result.record.candidates.slice(2).every((entry) =>
      entry.status === 'unassessed' && entry.reason === 'time')).toBe(true);
  });

  it('marks an in-flight batch as unanswered when the decide call fails', async () => {
    const candidates = [
      candidate({ sourceId: 'notes', id: 'a' }),
      candidate({ sourceId: 'notes', id: 'b' }),
    ];
    const { decide } = stubDecide(() => {
      throw new Error('engine down');
    });

    const result = await pick(candidates, { task: 'fix it', decide });

    expect(result.record.candidates.every((entry) =>
      entry.status === 'unanswered' && entry.answer === 'error')).toBe(true);
  });

  it('reports incomplete rule coverage when limits stop before the last rule', async () => {
    const rules = Array.from({ length: 3 }, (_, index) =>
      candidate({ sourceId: 'rules', id: `r${index}`, role: 'rule', signals: { score: index } }));
    const limited = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(rules, {
      task: 'change the schema',
      decide: limited.decide,
      limits: { maxBatches: 1, maxPerBatch: 2 },
    });

    expect(result.record.rulesCoverage).toBe('incomplete');
    expect(result.record.candidates.find((entry) => entry.status === 'unassessed'))
      .toMatchObject({ id: 'r0', reason: 'limits' });

    const room = stubDecide((batch) => allAnswered(batch, 0.9));
    const complete = await pick(rules, {
      task: 'change the schema',
      decide: room.decide,
      limits: { maxPerBatch: 2 },
    });
    expect(complete.record.rulesCoverage).toBe('complete');
    expect(complete.selected).toHaveLength(3);
  });

  it('treats an unanswered rule as incomplete coverage', async () => {
    const rules = [
      candidate({ sourceId: 'rules', id: 'r0', role: 'rule' }),
      candidate({ sourceId: 'rules', id: 'r1', role: 'rule' }),
    ];
    const { decide } = stubDecide((batch) => ({
      [batch.questions[0]!.key]: answered(0.9),
      [batch.questions[1]!.key]: { status: 'refused' },
    }));

    const result = await pick(rules, { task: 'migrate the data', decide });

    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('selects an applies-always rule without asking and still checks the rest', async () => {
    const rules = [
      candidate({ sourceId: 'rules', id: 'always', role: 'rule', applies: 'always' }),
      candidate({ sourceId: 'rules', id: 'maybe', role: 'rule' }),
    ];
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(rules, { task: 'ship it', decide });

    expect(calls.flatMap((batch) => batch.questions.map((question) => question.id))).toEqual(['maybe']);
    expect(result.selected.map((item) => item.id)).toEqual(['always', 'maybe']);
    expect(result.record.candidates[0]).toMatchObject({ status: 'selected', asked: false });
    expect(result.record.rulesCoverage).toBe('complete');
  });

  it('cuts question text to maxQuestionText and flags the candidate as truncated', async () => {
    const long = candidate({ sourceId: 'notes', id: 'long', text: 'x'.repeat(1000) });
    const short = candidate({ sourceId: 'notes', id: 'short', text: 'tiny' });
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick([long, short], {
      task: 'summarise',
      decide,
      limits: { maxQuestionText: 10 },
    });

    const shown = calls.flatMap((batch) => batch.questions);
    expect(shown.find((question) => question.id === 'long')?.text).toBe('x'.repeat(10));
    expect(shown.find((question) => question.id === 'short')?.text).toBe('tiny');
    expect(result.record.candidates.map((entry) => entry.truncated)).toEqual([true, false]);
  });

  it('carries changedPaths into the record when a candidate has them', async () => {
    const candidates = [
      candidate({ sourceId: 'commits', id: 'c1', changedPaths: ['src/a.ts', 'docs/b.md'] }),
      candidate({ sourceId: 'commits', id: 'c2' }),
    ];
    const { decide } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(candidates, { task: 'ship it', decide });

    expect(result.record.candidates[0]).toMatchObject({ changedPaths: ['src/a.ts', 'docs/b.md'] });
    expect(result.record.candidates[1]).not.toHaveProperty('changedPaths');
  });

  it('reports incomplete rule coverage when the rule source could not enumerate, even with every rule answered', async () => {
    const rules = [
      candidate({ sourceId: 'rules', id: 'r0', role: 'rule' }),
      candidate({ sourceId: 'rules', id: 'r1', role: 'rule' }),
    ];
    const { decide } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick(rules, {
      task: 'change the schema',
      decide,
      rulesEnumerationComplete: false,
    });

    expect(result.record.candidates.every((entry) => entry.status === 'selected')).toBe(true);
    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('asks the rule question to rules and the evidence question to references', async () => {
    const candidates = [
      candidate({ sourceId: 'rules', id: 'r', role: 'rule' }),
      candidate({ sourceId: 'notes', id: 'n' }),
    ];
    const { decide, calls } = stubDecide((batch) => allAnswered(batch, 0.9));

    await pick(candidates, { task: 'do the thing', decide });

    const questions = calls.flatMap((batch) => batch.questions);
    expect(questions[0]).toMatchObject({
      id: 'r',
      question: 'Does this rule apply to this task?',
    });
    expect(questions[1]).toMatchObject({
      id: 'n',
      question: 'Does this item supply useful evidence, a constraint or a decision for this task?',
    });
    expect(questions.every((question) =>
      typeof question.trueCriterion === 'string' && typeof question.falseCriterion === 'string')).toBe(true);
  });
});

describe('the changed-path link', () => {
  const FULL_SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const commit = () => candidate({
    sourceId: 'commits',
    id: 'commit a1b2c3d',
    contentRef: FULL_SHA,
    repository: 'repo-1',
    changedPaths: ['docs/ops.md'],
  });
  const opsNote = () => candidate({
    sourceId: 'notes', id: 'ops', repository: 'repo-1', path: 'docs/ops.md',
  });
  const otherNote = () => candidate({
    sourceId: 'notes', id: 'other', repository: 'repo-1', path: 'docs/other.md',
  });

  function byId(answers: Record<string, PickAnswer>) {
    return (batch: PickBatch) => Object.fromEntries(
      batch.questions.map((question) => [question.key, answers[question.id] ?? answered(0.5)]),
    );
  }

  it('selects a note below the threshold when a selected commit changed its path', async () => {
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), ops: answered(0.45), other: answered(0.45) })(batch));

    const result = await pick([commit(), opsNote(), otherNote()], { task: 'fix the ops doc', decide });

    expect(result.selected.map((item) => item.id).sort()).toEqual(['commit a1b2c3d', 'ops']);
    const byEntry = new Map(result.record.candidates.map((entry) => [entry.id, entry]));
    expect(byEntry.get('ops')).toMatchObject({
      status: 'selected',
      path: 'docs/ops.md',
      repository: 'repo-1',
      link: { sourceId: 'commits', id: 'commit a1b2c3d' },
    });
    // The carrier's saved entry keeps the full commit SHA: the short
    // one in `id` is display text, not the identity a record resolves.
    expect(byEntry.get('commit a1b2c3d')).toMatchObject({
      status: 'selected',
      contentRef: FULL_SHA,
    });
    expect(byEntry.get('commit a1b2c3d')).not.toHaveProperty('link');
    expect(byEntry.get('other')).toMatchObject({ status: 'rejected' });
    expect(result.record.thresholds).toEqual({ reference: 0.6, rule: 0.6, linkedPathBar: 0.4 });
  });

  it('holds the bar exactly: 0.39 does not link, 0.4 does', async () => {
    const wide = () => candidate({
      sourceId: 'commits',
      id: 'commit a1b2c3d',
      repository: 'repo-1',
      changedPaths: ['docs/ops.md', 'docs/low.md'],
    });
    const low = () => candidate({
      sourceId: 'notes', id: 'low', repository: 'repo-1', path: 'docs/low.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), ops: answered(0.4), low: answered(0.39) })(batch));

    const result = await pick([wide(), opsNote(), low()], { task: 'fix the docs', decide });

    expect(result.selected.map((item) => item.id).sort()).toEqual(['commit a1b2c3d', 'ops']);
    expect(result.record.candidates.find((entry) => entry.id === 'low'))
      .toMatchObject({ status: 'rejected', probability: 0.39 });
  });

  it('honours a linkedPathBar override and never lowers the reference threshold', async () => {
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), ops: answered(0.45) })(batch));

    const result = await pick([commit(), opsNote()], {
      task: 'fix the ops doc',
      decide,
      thresholds: { linkedPathBar: 0.5 },
    });

    expect(result.selected.map((item) => item.id)).toEqual(['commit a1b2c3d']);
    expect(result.record.candidates.find((entry) => entry.id === 'ops'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
    expect(result.record.thresholds.linkedPathBar).toBe(0.5);
    expect(result.record.thresholds.reference).toBe(0.6);
  });

  it('never links across repositories', async () => {
    const foreign = () => candidate({
      sourceId: 'notes', id: 'foreign', repository: 'repo-2', path: 'docs/ops.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), foreign: answered(0.45) })(batch));

    const result = await pick([commit(), foreign()], { task: 'fix the ops doc', decide });

    expect(result.record.candidates.find((entry) => entry.id === 'foreign'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
  });

  it('never lets a linked candidate carry another over', async () => {
    // The mid candidate links in through the commit and itself touches
    // the deep note's path; it was not threshold-selected, so the deep
    // note must stay rejected.
    const mid = () => candidate({
      sourceId: 'notes',
      id: 'mid',
      repository: 'repo-1',
      path: 'docs/ops.md',
      changedPaths: ['docs/deep.md'],
    });
    const deep = () => candidate({
      sourceId: 'notes', id: 'deep', repository: 'repo-1', path: 'docs/deep.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({
        'commit a1b2c3d': answered(0.9),
        mid: answered(0.45),
        deep: answered(0.45),
      })(batch));

    const result = await pick([commit(), mid(), deep()], { task: 'fix the docs', decide });

    expect(result.selected.map((item) => item.id).sort()).toEqual(['commit a1b2c3d', 'mid']);
    expect(result.record.candidates.find((entry) => entry.id === 'deep'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
  });

  it('never links a rule candidate', async () => {
    const rule = () => candidate({
      sourceId: 'rules', id: 'rule', role: 'rule', repository: 'repo-1', path: 'docs/ops.md',
    });
    const { decide } = stubDecide((batch) =>
      byId({ 'commit a1b2c3d': answered(0.9), rule: answered(0.45) })(batch));

    const result = await pick([commit(), rule()], { task: 'fix the ops doc', decide });

    expect(result.record.candidates.find((entry) => entry.id === 'rule'))
      .toMatchObject({ status: 'rejected', probability: 0.45 });
  });

  it('never links a candidate that did not answer over the bar', async () => {
    for (const answer of [
      { status: 'refused' as const },
      { status: 'error' as const, detail: 'decide broke' },
    ]) {
      const { decide } = stubDecide((batch) =>
        byId({ 'commit a1b2c3d': answered(0.9), ops: answer })(batch));

      const result = await pick([commit(), opsNote()], { task: 'fix the ops doc', decide });

      const entry = result.record.candidates.find((item) => item.id === 'ops');
      expect(entry!.status).toBe('unanswered');
      expect(entry!).not.toHaveProperty('link');
    }
    // A missing answer and an unassessed candidate behave the same way.
    const { decide: missing } = stubDecide((batch) =>
      Object.fromEntries(batch.questions
        .filter((question) => question.id !== 'ops')
        .map((question) => [question.key, answered(0.9)])));
    const missingResult = await pick([commit(), opsNote()], { task: 'x', decide: missing });
    expect(missingResult.record.candidates.find((entry) => entry.id === 'ops')!.status)
      .toBe('unanswered');

    const { decide: one } = stubDecide((batch) => allAnswered(batch, 0.9));
    const shortResult = await pick([commit(), opsNote()], {
      task: 'fix the ops doc',
      decide: one,
      limits: { maxCandidates: 1 },
    });
    const entry = shortResult.record.candidates.find((item) => item.id === 'ops');
    expect(entry).toMatchObject({ status: 'unassessed', reason: 'limits' });
    expect(entry).not.toHaveProperty('link');
  });

  it('leaves an ordinary above-threshold selection without a link field', async () => {
    const { decide } = stubDecide((batch) => allAnswered(batch, 0.9));

    const result = await pick([commit(), opsNote()], { task: 'fix the ops doc', decide });

    const entry = result.record.candidates.find((item) => item.id === 'ops');
    expect(entry).toMatchObject({ status: 'selected' });
    expect(entry).not.toHaveProperty('link');
  });
});
