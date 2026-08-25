import { describe, it, expect } from 'vitest';

import { run, dag, fnJob, kickback } from '../src/api.ts';
import type { LoopEvent, RunOptions } from '../src/api.ts';
import { formatEvent } from '../src/runtime/supervisor.ts';
import { MockEngine } from '../src/testing.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

type KickbackEvent = Extract<LoopEvent, { kind: 'dag:kickback' }>;
const kbEvents = (es: LoopEvent[]): KickbackEvent[] =>
  es.filter((e): e is KickbackEvent => e.kind === 'dag:kickback');

describe('dag kickback (cross-stage feedback)', () => {
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
    expect(formatEvent(kb[0]!)).toContain('kickback accepted c -> a: contract drifted');
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
});
