import { describe, expect, it } from 'vitest';

import {
  commandSucceeds,
  dag,
  fnJob,
  gateJob,
  parallel,
  run,
  sequence,
} from '../src/api.ts';
import type { LoopEvent, Outcome, RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const runOptions: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

function pass(order: string[], name: string) {
  return fnJob(name, async () => {
    order.push(name);
    return { status: 'pass' as const };
  });
}

function fail(order: string[], name: string) {
  return fnJob(name, async () => {
    order.push(name);
    return { status: 'fail' as const };
  });
}

describe('dag', () => {
  it('runs a sequence in order and stops after a required failure', async () => {
    const order: string[] = [];

    const result = await run(
      sequence('build', pass(order, 'a'), fail(order, 'b'), pass(order, 'c')),
      runOptions,
    );

    expect(result.outcome.status).toBe('fail');
    expect(order).toEqual(['a', 'b']);
  });

  it('runs every parallel node even when one fails', async () => {
    const order: string[] = [];

    const result = await run(
      parallel('checks', {
        a: pass(order, 'a'),
        b: fail(order, 'b'),
        c: pass(order, 'c'),
      }),
      runOptions,
    );

    expect(result.outcome.status).toBe('fail');
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('marks the graph late when a child finishes late', async () => {
    const result = await run(
      dag({
        name: 'late-result',
        nodes: {
          worker: fnJob('worker', async () => ({
            status: 'pass',
            late: true,
          })),
        },
      }),
      runOptions,
    );

    expect(result.outcome).toMatchObject({ status: 'pass', late: true });
  });

  it('blocks a dependent after a required producer fails', async () => {
    const order: string[] = [];

    const result = await run(
      dag({
        name: 'required-producer',
        nodes: {
          producer: fail(order, 'producer'),
          consumer: { needs: ['producer'], job: pass(order, 'consumer') },
        },
      }),
      runOptions,
    );

    expect(result.outcome.status).toBe('fail');
    expect(order).toEqual(['producer']);
  });

  it('accepts scalar needs and records node purpose for the reviewer context', async () => {
    const events: LoopEvent[] = [];
    let graph: unknown;
    const result = await run(
      dag({
        name: 'reviewable-change',
        nodes: {
          build: pass([], 'build'),
          review: {
            needs: 'build',
            desc: 'Review the built change.',
            gate: 'The change meets the acceptance criteria.',
            job: async (ctx) => {
              graph = ctx.graph;
              return { status: 'pass' as const };
            },
          },
        },
      }),
      { ...runOptions, onEvent: (event) => events.push(event) },
    );

    expect(result.outcome.status).toBe('pass');
    expect(graph).toMatchObject({
      node: 'review',
      needs: ['build'],
      desc: 'Review the built change.',
      gate: 'The change meets the acceptance criteria.',
    });
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'dag:node',
      node: 'review',
      phase: 'start',
      needs: ['build'],
      desc: 'Review the built change.',
      gate: 'The change meets the acceptance criteria.',
    }));
  });

  it('allows a dependent to run after an optional producer fails', async () => {
    const order: string[] = [];

    const result = await run(
      dag({
        name: 'optional-producer',
        nodes: {
          producer: { optional: true, job: fail(order, 'producer') },
          consumer: { needs: ['producer'], job: pass(order, 'consumer') },
        },
      }),
      runOptions,
    );

    expect(result.outcome.status).toBe('pass');
    expect(order).toEqual(['producer', 'consumer']);
  });

  it('skips a node when its condition is not met', async () => {
    const order: string[] = [];

    const result = await run(
      dag({
        name: 'conditional-node',
        nodes: {
          skipped: {
            when: async () => false,
            job: pass(order, 'skipped'),
          },
          next: { needs: ['skipped'], job: pass(order, 'next') },
        },
      }),
      runOptions,
    );

    expect(result.outcome.status).toBe('pass');
    expect(order).toEqual(['next']);
  });

  it('rejects a cycle before it starts work', () => {
    expect(() =>
      dag({
        name: 'cycle',
        nodes: {
          a: { needs: ['b'], job: async () => ({ status: 'pass' }) },
          b: { needs: ['a'], job: async () => ({ status: 'pass' }) },
        },
      }),
    ).toThrow(/cycle/i);
  });

  it('respects an explicit concurrency cap', async () => {
    let active = 0;
    let peak = 0;
    const work = (name: string) =>
      fnJob(name, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { status: 'pass' as const };
      });

    await run(
      parallel(
        'bounded',
        { a: work('a'), b: work('b'), c: work('c'), d: work('d') },
        2,
      ),
      runOptions,
    );

    expect(peak).toBe(2);
  });

  it('caps default fan-out at four nodes', async () => {
    let active = 0;
    let peak = 0;
    const work = (name: string) =>
      fnJob(name, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { status: 'pass' as const };
      });

    await run(
      parallel('default-bound', {
        a: work('a'),
        b: work('b'),
        c: work('c'),
        d: work('d'),
        e: work('e'),
        f: work('f'),
      }),
      runOptions,
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('does not apply an agent timeout to a command condition', async () => {
    const result = await run(
      dag({
        name: 'command-timeout',
        nodes: {
          test: {
            timeoutMs: 1,
            job: gateJob(
              'slow-command',
              commandSucceeds(process.execPath, [
                '-e',
                'setTimeout(() => process.exit(0), 20)',
              ]),
            ),
          },
        },
      }),
      runOptions,
    );

    expect(result.outcome.status).toBe('pass');
  });

  it('propagates a failed optional leaf only in its own outcome', async () => {
    const outcome: Outcome = { status: 'fail', summary: 'optional failed' };
    const result = await run(
      dag({
        name: 'optional-leaf',
        nodes: {
          optional: { optional: true, job: async () => outcome },
        },
      }),
      runOptions,
    );

    expect(result.outcome.status).toBe('pass');
  });
});
