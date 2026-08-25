/** Regression tests for the chaos-panel findings (concurrency + naive + abuse). */
import { describe, it, expect } from 'vitest';

import {
  run,
  loop,
  dag,
  parallel,
  fnJob,
  agentJob,
  LoopError,
} from '../src/api.ts';
import type { Engine, LoopEvent, Outcome, RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('guarded user code (concurrency HIGH)', () => {
  it('a throwing until gate fails the loop, still emits loop:end + runs onComplete', async () => {
    const kinds: string[] = [];
    let completed = false;
    const { outcome } = await run(
      loop({
        name: 'g',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: () => {
          throw new Error('boom');
        },
        onComplete: () => {
          completed = true;
        },
        max: 5,
      }),
      { ...mockOpts, onEvent: (e: LoopEvent) => kinds.push(e.kind) },
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.phase).toBe('until');
    expect(kinds).toContain('loop:end');
    expect(completed).toBe(true);
  });

  it('a throwing when gate records the node and still reaches dag:end', async () => {
    const kinds: string[] = [];
    const { outcome } = await run(
      dag({
        name: 'd',
        nodes: {
          a: fnJob('a', async () => ({ status: 'pass' })),
          bad: {
            job: fnJob('x', async () => ({ status: 'pass' })),
            when: () => {
              throw new Error('gate boom');
            },
            optional: true,
          },
        },
      }),
      { ...mockOpts, onEvent: (e: LoopEvent) => kinds.push(e.kind) },
    );
    expect(kinds).toContain('dag:end'); // did not crash the whole job
    expect(outcome.status).toBe('pass'); // the throwing node is optional
  });
});

describe('error classification (naive)', () => {
  it('a non-retryable engine error fails fast instead of looping to exhausted', async () => {
    const badEngine: Engine = {
      name: 'bad',
      async run() {
        throw new LoopError({
          code: 'CONFIG',
          message: 'no key',
          retryable: false,
        });
      },
    };
    const { outcome, stats } = await run(
      loop({
        name: 'x',
        body: agentJob({ label: 'w', engine: 'bad', prompt: 'hi' }),
        max: 10,
      }),
      { engine: 'bad', engines: { bad: badEngine } },
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('CONFIG');
    expect(stats.loopRuns[0]?.iterations).toBe(1); // failed fast, did not exhaust 10
  });

  it('a body returning an Outcome with no status fails with VALIDATION', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: (async () => ({
          summary: 'forgot status',
        })) as unknown as () => Promise<Outcome>,
        max: 3,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('VALIDATION');
  });
});

describe('sibling isolation (concurrency MEDIUM)', () => {
  it('concurrent same-named sibling loop jobs get distinct stats entries', async () => {
    const a = loop({
      name: 'worker',
      body: fnJob('b', async () => ({ status: 'pass' })),
      max: 1,
    });
    const b = loop({
      name: 'worker',
      body: fnJob('b', async () => ({ status: 'pass' })),
      max: 1,
    });
    const { stats } = await run(parallel('par', [a, b]), mockOpts);
    const workerEntries = stats.loopRuns
      .map((l) => l.path)
      .filter((p) => p.includes('worker'));
    expect(workerEntries.length).toBe(2); // not collapsed into one path
  });
});

describe('construction validation (naive SEV-4)', () => {
  it('loop() requires a name', () => {
    expect(() =>
      loop({ name: '', body: fnJob('b', async () => ({ status: 'pass' })) }),
    ).toThrow(/name/);
  });
  it('dag() requires a name', () => {
    expect(() => dag({ name: '', nodes: {} })).toThrow(/name/);
  });
});
