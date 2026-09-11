import { describe, it, expect } from 'vitest';

import { run, dag, fnJob, jobMeta, kickback, renderPlan } from '../src/api.ts';
import type { LoopEvent, Outcome, RunOptions } from '../src/api.ts';
import { formatEvent } from '../src/runtime/supervisor.ts';
import { MockEngine } from '../src/testing.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

type KickbackEvent = Extract<LoopEvent, { kind: 'dag:kickback' }>;
const kbEvents = (es: LoopEvent[]): KickbackEvent[] =>
  es.filter((e): e is KickbackEvent => e.kind === 'dag:kickback');

describe('dag kickback (cross-stage feedback)', () => {
  it('keeps an optional node skipped and green when a kickback reruns its dependencies', async () => {
    let optionalCalls = 0;
    let whenCalls = 0;
    let reviewCalls = 0;
    const ran: string[] = [];
    const events: LoopEvent[] = [];
    const { outcome } = await run(dag({
      name: 'skip-and-retry',
      maxKickbacks: 1,
      nodes: {
        a: fnJob('a', async () => { ran.push('a'); return { status: 'pass' }; }),
        optional: {
          needs: ['a'],
          optional: true,
          when: () => { whenCalls += 1; return false; },
          job: fnJob('optional', async () => { optionalCalls += 1; return { status: 'pass' }; }),
        },
        review: {
          needs: ['optional'],
          job: fnJob('review', async () => {
            ran.push('review');
            reviewCalls += 1;
            return reviewCalls === 1 ? kickback('a', 'revise the input') : { status: 'pass' };
          }),
        },
      },
    }), { ...mockOpts, onEvent: (event) => events.push(event) });

    expect(outcome).toMatchObject({ status: 'pass', data: { optional: { status: 'pass', data: { skipped: true } } } });
    expect(ran).toEqual(['a', 'review', 'a', 'review']);
    expect(whenCalls).toBe(2);
    expect(optionalCalls).toBe(0);
    expect(kbEvents(events)).toMatchObject([{ from: 'review', to: 'a', accepted: true }]);
    expect(events.filter((event) => event.kind === 'dag:node' && event.node === 'optional'))
      .toMatchObject([
        { phase: 'skip', attempt: 1, outcome: { status: 'pass', data: { skipped: true } } },
        { phase: 'skip', attempt: 2, outcome: { status: 'pass', data: { skipped: true } } },
      ]);
  });

  it('honours a kickback: re-runs the target and its dependents, threading the reason', async () => {
    const ran: string[] = [];
    let aSawReason: string | undefined;
    let cRuns = 0;
    const events: LoopEvent[] = [];

    const { outcome } = await run(
      dag({
        name: 'd',
        maxKickbacks: 2,
        nodes: {
          a: fnJob('a', async (ctx) => {
            ran.push('a');
            if (ctx.lastReview) aSawReason = ctx.lastReview.summary;
            return { status: 'pass' };
          }),
          b: {
            job: fnJob('b', async () => {
              ran.push('b');
              return { status: 'pass' };
            }),
            needs: ['a'],
          },
          c: {
            job: fnJob('c', async () => {
              ran.push('c');
              cRuns += 1;
              return cRuns === 1
                ? kickback('a', 'contract drifted')
                : { status: 'pass' };
            }),
            needs: ['b'],
          },
        },
      }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );

    expect(outcome.status).toBe('pass');
    // First pass, then one re-run of the whole a→b→c chain (a is the target).
    expect(ran).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
    expect(aSawReason).toContain('contract drifted');

    const kb = kbEvents(events);
    expect(kb).toHaveLength(1);
    expect(kb[0]).toMatchObject({ from: 'c', to: 'a', accepted: true });
    expect(formatEvent(kb[0]!)).toContain('kickback accepted c -> a [1/2]: contract drifted');
  });

  it('terminates when the kickback budget is exhausted (no infinite loop)', async () => {
    let cRuns = 0;
    const events: LoopEvent[] = [];

    const { outcome } = await run(
      dag({
        name: 'd',
        maxKickbacks: 2,
        nodes: {
          a: fnJob('a', async () => ({ status: 'pass' })),
          c: {
            job: fnJob('c', async () => {
              cRuns += 1;
              return kickback('a', `still wrong (run ${cRuns})`);
            }),
            needs: ['a'],
          },
        },
      }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );

    // Initial run + two budgeted re-runs, then the budget is spent.
    expect(cRuns).toBe(3);
    // The unresolved kickback leaves c failing, so the dag fails honestly.
    expect(outcome.status).toBe('fail');

    const kb = kbEvents(events);
    expect(kb.filter((e) => e.accepted)).toHaveLength(2);
    const rejected = kb.filter((e) => !e.accepted);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.note).toMatch(/budget/);
    expect(formatEvent(rejected[0]!)).toContain('kickback rejected c -> a');
  });

  it('rejects a kickback to a non-ancestor', async () => {
    let bRuns = 0;
    const events: LoopEvent[] = [];

    const { outcome } = await run(
      dag({
        name: 'd',
        maxKickbacks: 3,
        nodes: {
          a: fnJob('a', async () => ({ status: 'pass' })),
          b: fnJob('b', async () => {
            bRuns += 1;
            return kickback('a', 'want a redo'); // a is not an ancestor of b
          }),
        },
      }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );

    expect(bRuns).toBe(1); // rejected, never re-run
    const kb = kbEvents(events);
    expect(kb).toHaveLength(1);
    expect(kb[0]).toMatchObject({ accepted: false });
    expect(kb[0]!.note).toMatch(/not an ancestor/);
    expect(outcome.status).toBe('fail'); // b's own fail stands
  });

  it('respects acceptsKickbackTo: rejects a target outside the allow-list', async () => {
    let cRuns = 0;
    const events: LoopEvent[] = [];

    const { outcome } = await run(
      dag({
        name: 'd',
        maxKickbacks: 3,
        nodes: {
          a: fnJob('a', async () => ({ status: 'pass' })),
          b: {
            job: fnJob('b', async () => ({ status: 'pass' })),
            needs: ['a'],
          },
          c: {
            job: fnJob('c', async () => {
              cRuns += 1;
              return kickback('a', 'skip b, redo a');
            }),
            needs: ['b'],
            acceptsKickbackTo: ['b'], // 'a' is an ancestor but not allowed
          },
        },
      }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );

    expect(cRuns).toBe(1);
    const kb = kbEvents(events);
    expect(kb).toHaveLength(1);
    expect(kb[0]).toMatchObject({ accepted: false });
    expect(kb[0]!.note).toMatch(/does not accept/);
    expect(outcome.status).toBe('fail');
  });

  it('ignores kickbacks by default (maxKickbacks unset)', async () => {
    let cRuns = 0;
    const events: LoopEvent[] = [];

    const { outcome } = await run(
      dag({
        name: 'd',
        nodes: {
          a: fnJob('a', async () => ({ status: 'pass' })),
          c: {
            job: fnJob('c', async () => {
              cRuns += 1;
              return kickback('a', 'ignored when no budget');
            }),
            needs: ['a'],
          },
        },
      }),
      { ...mockOpts, onEvent: (e) => events.push(e) },
    );

    expect(cRuns).toBe(1); // ran once, no re-run
    expect(kbEvents(events)).toHaveLength(0);
    expect(outcome.status).toBe('fail'); // the kickback's default fail stands
  });

  it('keeps per-target budgets independent and records each target count', async () => {
    let aRuns = 0;
    let bRuns = 0;
    let reviewARuns = 0;
    let reviewBRuns = 0;
    const events: LoopEvent[] = [];
    const job = dag({
      name: 'per-target-budgets',
      maxKickbacks: { a: 1, b: 2 },
      nodes: {
        a: fnJob('a', async () => {
          aRuns += 1;
          return { status: 'pass' };
        }),
        reviewA: {
          needs: ['a'],
          job: fnJob('review-a', async () => {
            reviewARuns += 1;
            return kickback('a', `redo a (${reviewARuns})`);
          }),
        },
        b: fnJob('b', async () => {
          bRuns += 1;
          return { status: 'pass' };
        }),
        reviewB: {
          needs: ['b'],
          job: fnJob('review-b', async () => {
            reviewBRuns += 1;
            return reviewBRuns === 1 ? kickback('b', 'redo b') : { status: 'pass' };
          }),
        },
      },
    });

    const { outcome } = await run(job, { ...mockOpts, onEvent: (event) => events.push(event) });
    const kickbacks = kbEvents(events);
    const plan = renderPlan(jobMeta(job)).join('\n');

    expect(outcome.status).toBe('fail');
    expect(aRuns).toBe(2);
    expect(bRuns).toBe(2);
    expect(kickbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'reviewA', to: 'a', accepted: true, count: 1, limit: 1 }),
      expect.objectContaining({ from: 'reviewA', to: 'a', accepted: false, count: 2, limit: 1 }),
      expect.objectContaining({ from: 'reviewB', to: 'b', accepted: true, count: 1, limit: 2 }),
    ]));
    expect(plan).toContain('kickbacks: a 1, b 2');
  });

  it('routes the captured tests-review outcome to its declared target', async () => {
    let testsFirstRuns = 0;
    let testsReviewRuns = 0;
    const capturedReview: Outcome = {
      status: 'fail',
      summary: 'Review panel: 0/1 reviewer(s) cleared.\n- correctness [block]: the test assertion needs one repair',
      data: {
        findings: [{
          evidence: 'the test assertion needs one repair',
          reviewer: 'correctness',
          severity: 'block',
          scope: 'implementation',
        }],
        escalatedFindings: [],
        errors: [],
        results: [{
          kind: 'verdict',
          name: 'correctness',
          met: false,
          reason: 'Test file contains a broken assertion',
          scope: 'implementation',
          findings: [{ evidence: 'the test assertion needs one repair' }],
        }],
        passed: 0,
        required: 1,
        severityCounts: { block: 1 },
      },
      revision: {
        reason: 'Review panel: 0/1 reviewer(s) cleared.',
        target: 'tests-first',
        findings: [{
          evidence: 'the test assertion needs one repair',
          reviewer: 'correctness',
          severity: 'block',
          scope: 'implementation',
        }],
        rerun: 'target-and-dependents',
      },
    };
    const events: LoopEvent[] = [];
    const { outcome } = await run(dag({
      name: 'captured-review',
      maxKickbacks: 1,
      nodes: {
        'tests-first': fnJob('tests-first', async () => {
          testsFirstRuns += 1;
          return { status: 'pass' };
        }),
        'tests-review': {
          needs: ['tests-first'],
          job: fnJob('tests-review', async () => {
            testsReviewRuns += 1;
            return capturedReview;
          }),
        },
      },
    }), {
      ...mockOpts,
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe('fail');
    expect(testsFirstRuns).toBe(2);
    expect(testsReviewRuns).toBe(2);
    expect(kbEvents(events)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: 'tests-review',
        to: 'tests-first',
        accepted: true,
        count: 1,
        limit: 1,
      }),
      expect.objectContaining({
        from: 'tests-review',
        to: 'tests-first',
        accepted: false,
        count: 2,
        limit: 1,
      }),
    ]));
  });
});
