import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fnJob, judge, reviewPanel, revisionRequest, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, FeedbackFinding, LoopEvent, Outcome, PanelSynthesisEntry, TeamSeat } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

function seat(engine: MockEngine, model: string, tools: readonly string[] = []): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}

interface PromptFinding { readonly id: string; readonly evidence: string }

function promptFindings(req: AgentRequest): PromptFinding[] {
  return (JSON.parse(req.prompt) as { findings: PromptFinding[] }).findings;
}

function idOf(findings: readonly PromptFinding[], evidence: string): string {
  const found = findings.find((finding) => finding.evidence === evidence);
  if (!found) throw new Error(`no finding with evidence ${evidence}`);
  return found.id;
}

/**
 * A merger that groups findings by their evidence text: each group names the
 * findings that are one problem, and which of them has the clearest evidence
 * and the clearest fix.
 */
function merger(groups: Readonly<{ same: readonly string[]; evidence?: string; fix?: string }>[] = []) {
  const calls: AgentRequest[] = [];
  const engine = new MockEngine((req) => {
    calls.push(req);
    const findings = promptFindings(req);
    return JSON.stringify({
      groups: groups.map((group) => ({
        ids: group.same.map((evidence) => idOf(findings, evidence)),
        ...(group.evidence ? { evidence: idOf(findings, group.evidence) } : {}),
        ...(group.fix ? { fix: idOf(findings, group.fix) } : {}),
      })),
    });
  });
  return { engine, calls };
}

type Vote = { readonly vote: 'agree' | 'disagree' | 'better fix'; readonly reason: string; readonly fix?: string };

/** A reviewer seat that answers the cross-review round from votes keyed by evidence. */
function voter(votes: Readonly<Record<string, Vote>> = {}) {
  const calls: AgentRequest[] = [];
  const engine = new MockEngine((req) => {
    calls.push(req);
    const findings = promptFindings(req);
    return JSON.stringify({
      votes: findings
        .filter((finding) => votes[finding.evidence] !== undefined)
        .map((finding) => ({ id: finding.id, ...votes[finding.evidence] })),
    });
  });
  return { engine, calls };
}

/** A panel reviewer: its verdict is scripted, and its seat answers the cross-review round. */
function reviewer(name: string, met: boolean, findings: FeedbackFinding[], votes: Readonly<Record<string, Vote>> = {}) {
  const seatVoter = voter(votes);
  return {
    calls: seatVoter.calls,
    target: {
      name,
      seat: seat(seatVoter.engine, `${name}-family`),
      job: fnJob(name, async (): Promise<Outcome> => met
        ? (findings.length ? revisionRequest({ reason: 'clear', findings }, { status: 'pass' }) : { status: 'pass', summary: 'clear' })
        : revisionRequest({ reason: 'needs work', findings })),
    },
  };
}

const runOpts = { engine: 'mock', engines: { mock: new MockEngine(() => '') } } as const;

function synthesisEvents(events: LoopEvent[]) {
  return events.filter((event): event is Extract<LoopEvent, { kind: 'review:synthesis' }> => event.kind === 'review:synthesis');
}

function entries(outcome: Outcome): PanelSynthesisEntry[] {
  return (outcome.data as { synthesis: PanelSynthesisEntry[] }).synthesis;
}

describe('reviewPanel synthesise', () => {
  it('merges two reviewers raising the same problem into one finding crediting both', async () => {
    const merge = merger([{ same: ['The query joins strings.', 'User input reaches the SQL text unescaped.'], evidence: 'User input reaches the SQL text unescaped.', fix: 'The query joins strings.' }]);
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'The query joins strings.', recommendation: 'Use a bound parameter.' }]);
    const b = reviewer('b', false, [{ severity: 'block', evidence: 'User input reaches the SQL text unescaped.', recommendation: 'Escape it.' }]);
    const events: LoopEvent[] = [];
    const { outcome } = await run(reviewPanel({
      label: 'review',
      synthesise: seat(merge.engine, 'merger-family'),
      reviewers: [a.target, b.target],
    }), { ...runOpts, onEvent: (event) => events.push(event) });

    expect(merge.calls).toHaveLength(1);
    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.findings).toEqual([
      expect.objectContaining({
        raisedBy: ['a', 'b'],
        severity: 'block',
        evidence: 'User input reaches the SQL text unescaped.',
        recommendation: 'Use a bound parameter.',
      }),
    ]);
    // Each raised the one finding, so neither has another reviewer's finding to vote on.
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
    expect(synthesisEvents(events)).toHaveLength(1);
  });

  it('drops a finding two of three reviewers disagree with and keeps their reasons', async () => {
    const a = reviewer('a', false, [
      { severity: 'should-fix', evidence: 'Rename the helper.' },
      { severity: 'should-fix', evidence: 'The retry loses the first error.' },
    ]);
    const b = reviewer('b', true, [], {
      'Rename the helper.': { vote: 'disagree', reason: 'The name matches the module.' },
      'The retry loses the first error.': { vote: 'agree', reason: 'Seen it too.' },
    });
    const c = reviewer('c', true, [], {
      'Rename the helper.': { vote: 'disagree', reason: 'Taste, not a problem.' },
      'The retry loses the first error.': { vote: 'agree', reason: 'Real.' },
    });
    const events: LoopEvent[] = [];
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target, c.target],
    }), { ...runOpts, onEvent: (event) => events.push(event) });

    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.findings?.map((finding) => finding.evidence)).toEqual(['The retry loses the first error.']);
    const dropped = entries(outcome).filter((entry) => entry.result === 'dropped');
    expect(dropped).toEqual([
      expect.objectContaining({
        finding: expect.objectContaining({
          evidence: 'Rename the helper.',
          raisedBy: ['a'],
          votes: [
            { reviewer: 'b', vote: 'disagree', reason: 'The name matches the module.' },
            { reviewer: 'c', vote: 'disagree', reason: 'Taste, not a problem.' },
          ],
        }),
      }),
    ]);
    expect(synthesisEvents(events)[0]?.entries).toEqual(entries(outcome));
    // The writer reads the summary, so a dropped point stays out of it.
    expect(outcome.summary).not.toContain('Rename the helper.');
  });

  it('keeps a finding two reviewers raised, marked disputed, when the third disagrees', async () => {
    const merge = merger([{ same: ['Retries have no backoff.', 'The retry loop never waits.'] }]);
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'Retries have no backoff.' }]);
    const b = reviewer('b', false, [{ severity: 'should-fix', evidence: 'The retry loop never waits.' }]);
    const c = reviewer('c', true, [], { 'Retries have no backoff.': { vote: 'disagree', reason: 'The caller waits.' } });
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merge.engine, 'merger-family'),
      reviewers: [a.target, b.target, c.target],
    }), runOpts);
    expect(outcome.revision?.findings).toEqual([
      expect.objectContaining({ evidence: 'Retries have no backoff.', raisedBy: ['a', 'b'], disputed: true }),
    ]);
    expect(entries(outcome).map((entry) => entry.result)).toEqual(['disputed']);
  });

  it('reads a passing reviewer\'s note with no severity as nice-to-have', async () => {
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'The retry loses the first error.' }]);
    const b = reviewer('b', true, [{ evidence: 'Mention the limit in the docstring.' }]);
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target],
    }), runOpts);
    expect(outcome.revision?.findings).toEqual([
      expect.objectContaining({ evidence: 'The retry loses the first error.', severity: 'should-fix' }),
      expect.objectContaining({ evidence: 'Mention the limit in the docstring.', severity: 'nice-to-have' }),
    ]);
  });

  it('passes a failing panel when the votes drop every finding it raised', async () => {
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'Rename the helper.' }]);
    const b = reviewer('b', true, [], { 'Rename the helper.': { vote: 'disagree', reason: 'Taste.' } });
    const c = reviewer('c', true, [], { 'Rename the helper.': { vote: 'disagree', reason: 'Fine as is.' } });
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target, c.target],
    }), runOpts);
    expect(outcome.status).toBe('pass');
    expect((outcome.data as { findings: unknown[] }).findings).toEqual([]);
  });

  it('carries the better fix a majority prefers in place of the original', async () => {
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'The cache never expires.', recommendation: 'Clear it on restart.' }]);
    const b = reviewer('b', true, [], { 'The cache never expires.': { vote: 'better fix', reason: 'Restarts are rare.', fix: 'Give each entry a ten-minute lifetime.' } });
    const c = reviewer('c', true, [], { 'The cache never expires.': { vote: 'better fix', reason: 'A lifetime bounds it.', fix: 'Expire entries after an hour.' } });
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target, c.target],
    }), runOpts);
    expect(outcome.revision?.findings).toEqual([
      expect.objectContaining({ evidence: 'The cache never expires.', recommendation: 'Give each entry a ten-minute lifetime.' }),
    ]);
    expect(entries(outcome).map((entry) => entry.result)).toEqual(['better fix']);
  });

  it('keeps a tie, marked disputed, for whoever reads the findings next', async () => {
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'Split the long function.' }]);
    const b = reviewer('b', true, [], { 'Split the long function.': { vote: 'disagree', reason: 'It reads in order.' } });
    const c = reviewer('c', true, [], { 'Split the long function.': { vote: 'agree', reason: 'Too long to hold in mind.' } });
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target, c.target],
    }), runOpts);
    expect(outcome.revision?.findings).toEqual([
      expect.objectContaining({ evidence: 'Split the long function.', disputed: true }),
    ]);
    expect(entries(outcome).map((entry) => entry.result)).toEqual(['disputed']);
  });

  it('keeps a block finding the majority disagrees with, marked disputed', async () => {
    const a = reviewer('a', false, [{ severity: 'block', evidence: 'The token is logged.' }]);
    const b = reviewer('b', true, [], { 'The token is logged.': { vote: 'disagree', reason: 'It is redacted first.' } });
    const c = reviewer('c', true, [], { 'The token is logged.': { vote: 'disagree', reason: 'The logger strips it.' } });
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target, c.target],
    }), runOpts);
    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.findings).toEqual([
      expect.objectContaining({ severity: 'block', evidence: 'The token is logged.', disputed: true }),
    ]);
  });

  it('keeps passing reviewers\' findings when the panel passes on k of n', async () => {
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'The retry loses the first error.' }], {
      'Mention the limit in the docstring.': { vote: 'agree', reason: 'Helps callers.' },
    });
    const b = reviewer('b', true, [{ severity: 'nice-to-have', evidence: 'Mention the limit in the docstring.' }], {
      'The retry loses the first error.': { vote: 'agree', reason: 'Real.' },
    });
    const c = reviewer('c', true, [], {
      'The retry loses the first error.': { vote: 'agree', reason: 'Real.' },
      'Mention the limit in the docstring.': { vote: 'agree', reason: 'Cheap.' },
    });
    const { outcome } = await run(reviewPanel({
      pass: 2,
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target, c.target],
    }), runOpts);
    expect(outcome.status).toBe('pass');
    expect((outcome.data as { findings: FeedbackFinding[] }).findings.map((finding) => finding.evidence)).toEqual([
      'The retry loses the first error.',
      'Mention the limit in the docstring.',
    ]);
  });

  it('records a merger and a voter that sent no readable reply', async () => {
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'The intro is long.' }]);
    const b = reviewer('b', false, [{ severity: 'should-fix', evidence: 'The opening runs on.' }]);
    const silent = new MockEngine(() => 'no json here');
    const events: LoopEvent[] = [];
    const { outcome } = await run(reviewPanel({
      synthesise: seat(silent, 'merger-family'),
      reviewers: [a.target, { ...b.target, seat: seat(silent, 'b-family') }],
    }), { ...runOpts, onEvent: (event) => events.push(event) });

    expect(outcome.revision?.findings).toHaveLength(2);
    expect(synthesisEvents(events)).toEqual([
      expect.objectContaining({ mergeFailed: true, noVotesFrom: ['b'] }),
    ]);
  });

  it('keeps a finding, marked disputed, when a voter shown it failed and the rest disagree', async () => {
    const a = reviewer('a', false, [{ severity: 'should-fix', evidence: 'The retry loses the first error.' }]);
    const b = reviewer('b', true, [], { 'The retry loses the first error.': { vote: 'disagree', reason: 'It is kept in the log.' } });
    const c = reviewer('c', true, []);
    const limited = new MockEngine(() => {
      throw new Error('usage limit reached');
    });
    const events: LoopEvent[] = [];
    const { outcome } = await run(reviewPanel({
      synthesise: seat(merger().engine, 'merger-family'),
      reviewers: [a.target, b.target, { ...c.target, seat: seat(limited, 'c-family') }],
    }), { ...runOpts, onEvent: (event) => events.push(event) });

    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.findings).toEqual([
      expect.objectContaining({ evidence: 'The retry loses the first error.', disputed: true }),
    ]);
    expect(synthesisEvents(events)).toEqual([expect.objectContaining({ noVotesFrom: ['c'] })]);
  });

  it('leaves a single-reviewer panel unchanged', async () => {
    const merge = merger();
    const findings: FeedbackFinding[] = [{ severity: 'should-fix', evidence: 'Rename the helper.' }];
    const plain = await run(reviewPanel({ label: 'one', reviewers: [reviewer('a', false, findings).target] }), runOpts);
    const synthesised = await run(reviewPanel({
      label: 'one',
      synthesise: seat(merge.engine, 'merger-family'),
      reviewers: [reviewer('a', false, findings).target],
    }), runOpts);
    expect(merge.calls).toHaveLength(0);
    expect(synthesised.outcome).toEqual(plain.outcome);
  });

  it('leaves a panel unchanged when synthesise is not set', async () => {
    const findings = (evidence: string): FeedbackFinding[] => [{ severity: 'should-fix', evidence }];
    const { outcome } = await run(reviewPanel({
      reviewers: [
        reviewer('a', false, findings('The query joins strings.')).target,
        reviewer('b', false, findings('The query joins strings.')).target,
        reviewer('c', true, findings('A passing note.')).target,
      ],
    }), runOpts);
    expect(outcome.revision?.findings).toEqual([
      { reviewer: 'a', severity: 'should-fix', evidence: 'The query joins strings.' },
      { reviewer: 'b', severity: 'should-fix', evidence: 'The query joins strings.' },
    ]);
    expect((outcome.data as Record<string, unknown>).synthesis).toBeUndefined();
  });

  it('refuses synthesise: true when the first reviewer names no seat', () => {
    expect(() => reviewPanel({
      synthesise: true,
      reviewers: [{ name: 'a', review: async () => ({ met: true, reason: 'ok' }) }, { name: 'b', review: async () => ({ met: true, reason: 'ok' }) }],
    })).toThrow(/synthesise needs every reviewer's seat/);
  });
});

describe('workflow synthesise', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('merges a reviewedBy panel with the first reviewer\'s seat before the judge reads it', async () => {
    const mergeCalls: AgentRequest[] = [];
    const judgeCalls: AgentRequest[] = [];
    const writer = new MockEngine((req) => {
      writeFileSync(join(req.cwd!, 'page.md'), 'draft');
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const review = (evidence: string) => JSON.stringify({ status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence }] });
    const first = new MockEngine((req) => {
      if (req.prompt.startsWith('{')) {
        mergeCalls.push(req);
        const ids = promptFindings(req).map((finding) => finding.id);
        return JSON.stringify({ groups: [{ ids, evidence: ids[1], fix: ids[0] }] });
      }
      return review('The intro is long.');
    });
    const second = new MockEngine(() => review('The opening paragraph runs on.'));
    const judgeEngine = new MockEngine((req) => {
      judgeCalls.push(req);
      return JSON.stringify({ stop_reason: { choice: 'holds' } });
    });
    const dir = mkdtempSync(join(tmpdir(), 'panel-synthesis-'));
    dirs.push(dir);
    const result = await run(workflow('synthesis-test', {
      brief: 'Use case: a short page.\n\nWrite the page.',
      roles: {
        writer: seat(writer, 'writer-mock', ['Write']),
        reviewers: [seat(first, 'first-mock', ['Read']), seat(second, 'second-mock', ['Read'])],
      },
      stages: [
        stage('write', {
          agent: 'writer',
          writes: 'page.md',
          reviewedBy: 'reviewers',
          synthesise: true,
          refine: judge(seat(judgeEngine, 'judge-mock'), { cap: 2 }),
        }),
      ],
    }), { cwd: dir });

    expect(result.outcome.status).toBe('pass');
    expect(mergeCalls).toHaveLength(1);
    expect(judgeCalls).toHaveLength(1);
    const state = (JSON.parse(judgeCalls[0]!.prompt) as { state: { latestFindings: FeedbackFinding[] } }).state;
    expect(state.latestFindings).toEqual([
      expect.objectContaining({ raisedBy: ['write-1', 'write-2'], evidence: 'The opening paragraph runs on.' }),
    ]);
  });

  it('merges a panel: stage with the seat it names', async () => {
    const merge = merger([{ same: ['The intro is long.', 'The opening paragraph runs on.'], evidence: 'The opening paragraph runs on.' }]);
    const writer = new MockEngine((req) => {
      writeFileSync(join(req.cwd!, 'page.md'), 'draft');
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const review = (evidence: string) => new MockEngine(() =>
      JSON.stringify({ status: 'revise', summary: 'one finding', findings: [{ severity: 'block', evidence }] }));
    const dir = mkdtempSync(join(tmpdir(), 'panel-synthesis-'));
    dirs.push(dir);
    const result = await run(workflow('panel-stage-test', {
      brief: 'Write the page.',
      roles: {
        writer: seat(writer, 'writer-mock', ['Write']),
        reviewers: [seat(review('The intro is long.'), 'first-mock', ['Read']), seat(review('The opening paragraph runs on.'), 'second-mock', ['Read'])],
      },
      stages: [
        stage('write', { agent: 'writer', writes: 'page.md', refine: 0 }),
        stage('review', { panel: 'reviewers', synthesise: seat(merge.engine, 'merger-mock'), sendsBackTo: 'write' }),
      ],
    }), { cwd: dir });

    expect(merge.calls).toHaveLength(1);
    const panel = (result.outcome.data as Record<string, Outcome>).review!;
    expect(panel.revision?.findings).toEqual([
      expect.objectContaining({ raisedBy: ['review-1', 'review-2'], evidence: 'The opening paragraph runs on.' }),
    ]);
  });

  /** A reviewer seat: answers its review with `review`, and agrees with every finding it is asked to vote on. */
  function reviewSeat(name: string, review: Readonly<Record<string, unknown>>, votePrompts: AgentRequest[]) {
    return seat(new MockEngine((req) => {
      if (!req.prompt.startsWith('{')) return JSON.stringify(review);
      votePrompts.push(req);
      return JSON.stringify({ votes: promptFindings(req).map((finding) => ({ id: finding.id, vote: 'agree', reason: 'Real.' })) });
    }), `${name}-mock`, ['Read']);
  }

  function writePage() {
    return seat(new MockEngine((req) => {
      writeFileSync(join(req.cwd!, 'page.md'), 'draft');
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    }), 'writer-mock', ['Write']);
  }

  it('gives each voter the brief and the file under review', async () => {
    const votePrompts: AgentRequest[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'panel-synthesis-'));
    dirs.push(dir);
    await run(workflow('vote-context-test', {
      brief: 'Use case: a page for a first-time reader.\n\nWrite the page.',
      roles: {
        writer: writePage(),
        reviewers: [
          reviewSeat('first', { status: 'revise', summary: 'one', findings: [{ severity: 'should-fix', evidence: 'Add a table of options.' }] }, votePrompts),
          reviewSeat('second', { status: 'revise', summary: 'one', findings: [{ severity: 'should-fix', evidence: 'The intro is long.' }] }, votePrompts),
        ],
      },
      stages: [
        stage('write', { agent: 'writer', writes: 'page.md', refine: 0 }),
        stage('review', { panel: 'reviewers', synthesise: seat(merger().engine, 'merger-mock'), sendsBackTo: 'write' }),
      ],
    }), { cwd: dir });

    expect(votePrompts).toHaveLength(2);
    for (const req of votePrompts) {
      const context = (JSON.parse(req.prompt) as { context?: string }).context;
      expect(context).toContain('Use case: a page for a first-time reader.');
      expect(context).toContain('page.md');
    }
  });

  it('keeps the notes a passing reviewer seat sends when the panel passes on k of n', async () => {
    const votePrompts: AgentRequest[] = [];
    const events: LoopEvent[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'panel-synthesis-'));
    dirs.push(dir);
    await run(workflow('pass-notes-test', {
      brief: 'Write the page.',
      roles: {
        writer: writePage(),
        reviewers: [
          reviewSeat('first', { status: 'revise', summary: 'one', findings: [{ severity: 'should-fix', evidence: 'The intro is long.' }] }, votePrompts),
          reviewSeat('second', { status: 'pass', summary: 'fine', findings: [{ severity: 'nice-to-have', evidence: 'Link the install page.' }] }, votePrompts),
        ],
      },
      stages: [
        stage('write', { agent: 'writer', writes: 'page.md', refine: 0 }),
        stage('review', { panel: 'reviewers', agree: 1, synthesise: seat(merger().engine, 'merger-mock'), sendsBackTo: 'write' }),
      ],
    }), { cwd: dir, onEvent: (event) => events.push(event) });

    expect(synthesisEvents(events)[0]?.entries).toEqual([
      expect.objectContaining({ finding: expect.objectContaining({ evidence: 'The intro is long.', raisedBy: ['review-1'] }) }),
      expect.objectContaining({ finding: expect.objectContaining({ evidence: 'Link the install page.', raisedBy: ['review-2'] }) }),
    ]);
  });

  it('refuses synthesise on a stage no panel reviews', () => {
    const writer = seat(new MockEngine(() => ''), 'writer-mock', ['Write']);
    expect(() => workflow('bad', {
      brief: 'Write.',
      roles: { writer },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', synthesise: true })],
    })).toThrow(/synthesise is for a stage reviewed by a panel/);
  });
});
