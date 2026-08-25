import { describe, it, expect } from 'vitest';

import {
  run,
  loop,
  fnJob,
  predicate,
  jobMeta,
  renderPlan,
  LoopError,
} from '../src/api.ts';
import type {
  ConditionResult,
  LoopEvent,
  Outcome,
  RunOptions,
} from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('loop primitive', () => {
  it('aborts when the start gate is not met', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'pass' })),
        start: predicate(() => false),
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('aborted');
  });

  it('stops when `until` is met', async () => {
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'count',
        body: fnJob('b', async () => {
          n += 1;
          return { status: 'fail', summary: `n=${n}` };
        }),
        until: predicate(() => n >= 3, 'n>=3'),
        max: 10,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(stats.loopRuns[0]?.iterations).toBe(3);
  });

  it('checks an already-green until gate at iteration 0 without running the body', async () => {
    let bodyRuns = 0;
    const conditionCalls: Array<{
      iteration: number;
      last: Outcome | undefined;
    }> = [];
    const events: LoopEvent[] = [];
    const { outcome, stats } = await run(
      loop({
        name: 'already-green',
        body: fnJob('b', async () => {
          bodyRuns += 1;
          return { status: 'pass' };
        }),
        until: predicate((ctx, last) => {
          conditionCalls.push({ iteration: ctx.iteration, last });
          return true;
        }, 'already green'),
        checkFirst: true,
        max: 1,
      }),
      { ...mockOpts, onEvent: (event) => events.push(event) },
    );

    expect(outcome.status).toBe('pass');
    expect(bodyRuns).toBe(0);
    expect(conditionCalls).toEqual([{ iteration: 0, last: undefined }]);
    expect(stats.loopRuns[0]?.iterations).toBe(0);
    expect(
      events.find(
        (event) =>
          event.kind === 'loop:condition' && event.which === 'until',
      ),
    ).toMatchObject({ iteration: 0, result: { met: true } });
    expect(events.some((event) => event.kind === 'loop:iteration')).toBe(false);
  });

  it('aborts checkFirst before running gates or the body when already signalled', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const { outcome, stats } = await run(
      loop({
        name: 'already-aborted',
        start: async () => {
          calls.push('start');
          return { met: true, reason: 'ready' };
        },
        body: fnJob('b', async () => {
          calls.push('body');
          return { status: 'pass' };
        }),
        until: async () => {
          calls.push('until');
          return { met: true, reason: 'green' };
        },
        checkFirst: true,
      }),
      { ...mockOpts, signal: controller.signal },
    );

    expect(outcome.status).toBe('aborted');
    expect(calls).toEqual([]);
    expect(stats.loopRuns[0]?.iterations).toBe(0);
  });

  it('does not run the iteration-0 gate when the start gate aborts the run', async () => {
    const controller = new AbortController();
    let checks = 0;
    let bodies = 0;
    const { outcome } = await run(
      loop({
        name: 'aborted-during-start',
        start: async () => {
          controller.abort();
          return { met: true, reason: 'ready' };
        },
        body: fnJob('b', async () => {
          bodies += 1;
          return { status: 'pass' };
        }),
        until: async () => {
          checks += 1;
          return { met: true, reason: 'green' };
        },
        checkFirst: true,
      }),
      { ...mockOpts, signal: controller.signal },
    );

    expect(outcome.status).toBe('aborted');
    expect(checks).toBe(0);
    expect(bodies).toBe(0);
  });

  it('aborts immediately when the signal fires during a green checkFirst gate', async () => {
    const controller = new AbortController();
    let bodies = 0;
    let reviews = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'aborted-during-precheck',
        body: fnJob('body', async () => {
          bodies += 1;
          return { status: 'pass' };
        }),
        until: async () => {
          controller.abort();
          return { met: true, reason: 'green' };
        },
        review: fnJob('review', async () => {
          reviews += 1;
          return { status: 'pass' };
        }),
        checkFirst: true,
      }),
      { ...mockOpts, signal: controller.signal },
    );

    expect(outcome.status).toBe('aborted');
    expect(bodies).toBe(0);
    expect(reviews).toBe(0);
    expect(stats.loopRuns[0]?.iterations).toBe(0);
  });

  it('aborts immediately when the signal fires during review', async () => {
    const controller = new AbortController();
    const { outcome, stats } = await run(
      loop({
        name: 'aborted-during-review',
        body: fnJob('body', async () => ({ status: 'pass' })),
        until: async () => ({ met: true, reason: 'green' }),
        review: fnJob('review', async () => {
          controller.abort();
          return { status: 'pass', summary: 'approved' };
        }),
      }),
      { ...mockOpts, signal: controller.signal },
    );

    expect(outcome.status).toBe('aborted');
    expect(stats.loopRuns[0]?.iterations).toBe(1);
  });

  it('maps an ABORTED convergence error to an aborted loop outcome', async () => {
    let bodies = 0;
    const { outcome } = await run(
      loop({
        name: 'aborted-convergence-error',
        body: fnJob('body', async () => {
          bodies += 1;
          return { status: 'pass' };
        }),
        until: async () => {
          throw new LoopError({
            code: 'ABORTED',
            phase: 'until',
            message: 'convergence check aborted',
          });
        },
        max: 1,
      }),
      mockOpts,
    );

    expect(outcome.status).toBe('aborted');
    expect(outcome.error?.code).toBe('ABORTED');
    expect(bodies).toBe(1);
  });

  it('threads a red iteration-0 precheck to the first body as lastGate', async () => {
    let checks = 0;
    let bodyRuns = 0;
    let firstGate: ConditionResult | undefined;
    const { outcome, stats } = await run(
      loop({
        name: 'precheck-feedback',
        body: fnJob('b', async (ctx) => {
          bodyRuns += 1;
          firstGate = ctx.lastGate;
          return { status: 'pass' };
        }),
        until: async () => {
          checks += 1;
          return checks === 1
            ? {
                met: false,
                reason: 'tests still fail',
                output: 'FAIL integration suite',
              }
            : { met: true, reason: 'tests pass' };
        },
        checkFirst: true,
        max: 1,
      }),
      mockOpts,
    );

    expect(outcome.status).toBe('pass');
    expect(bodyRuns).toBe(1);
    expect(checks).toBe(2);
    expect(firstGate).toMatchObject({
      met: false,
      reason: 'tests still fail',
      output: 'FAIL integration suite',
    });
    expect(stats.loopRuns[0]?.iterations).toBe(1);
  });

  it('threads an iteration-0 review rejection to the first body as lastReview', async () => {
    let bodyRuns = 0;
    let reviews = 0;
    let firstGate: ConditionResult | undefined;
    let firstReview: Outcome | undefined;
    const { outcome, stats } = await run(
      loop({
        name: 'precheck-review',
        body: fnJob('b', async (ctx) => {
          bodyRuns += 1;
          firstGate = ctx.lastGate;
          firstReview = ctx.lastReview;
          return { status: 'pass' };
        }),
        until: async () => ({ met: true, reason: 'gate passed' }),
        review: fnJob('review', async () => {
          reviews += 1;
          return reviews === 1
            ? { status: 'fail', summary: 'missing evidence' }
            : { status: 'pass', summary: 'approved' };
        }),
        checkFirst: true,
        max: 1,
      }),
      mockOpts,
    );

    expect(outcome.status).toBe('pass');
    expect(bodyRuns).toBe(1);
    expect(reviews).toBe(2);
    expect(firstGate).toMatchObject({ met: true, reason: 'gate passed' });
    expect(firstReview).toMatchObject({
      status: 'fail',
      summary: 'missing evidence',
    });
    expect(stats.loopRuns[0]?.iterations).toBe(1);
  });

  it('rejects checkFirst without an explicit until gate', () => {
    expect(() =>
      loop({
        name: 'invalid-precheck',
        body: fnJob('b', async () => ({ status: 'pass' })),
        checkFirst: true,
      }),
    ).toThrow(/checkFirst requires an explicit until gate/);
  });

  it('describes loop jobs that check convergence before the first body iteration', () => {
    const job = loop({
      name: 'prechecked',
      body: fnJob('b', async () => ({ status: 'pass' })),
      until: predicate(() => true),
      checkFirst: true,
    });

    expect(jobMeta(job)?.checkFirst).toBe(true);
    expect(renderPlan(jobMeta(job))[0]).toBe('loop "prechecked" (check first)');
  });

  it('marks the loop late when the converged body outcome is late', async () => {
    const { outcome } = await run(
      loop({
        name: 'late-body',
        body: fnJob('b', async () => ({ status: 'pass', late: true })),
        max: 1,
      }),
      mockOpts,
    );

    expect(outcome.status).toBe('pass');
    expect(outcome.late).toBe(true);
  });

  it('exhausts at max when nothing converges', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 4,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('exhausted');
  });

  it('re-enters the loop when review fails, then passes', async () => {
    let work = 0;
    let reviews = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'wr',
        body: fnJob('b', async () => {
          work += 1;
          return { status: 'pass', summary: `w${work}` };
        }),
        until: predicate(() => true),
        review: fnJob('rev', async () => {
          reviews += 1;
          return { status: reviews >= 2 ? 'pass' : 'fail' };
        }),
        max: 5,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(work).toBe(2);
    expect(reviews).toBe(2);
    expect(stats.loopRuns[0]?.reviewsFailed).toBe(1);
    expect(stats.loopRuns[0]?.reviewsPassed).toBe(1);
  });

  it('nests loop jobs within loop jobs', async () => {
    let innerRuns = 0;
    const inner = loop({
      name: 'inner',
      body: fnJob('i', async () => {
        innerRuns += 1;
        return { status: 'pass' };
      }),
      max: 1,
    });
    let outerIter = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'outer',
        body: inner,
        until: predicate(() => {
          outerIter += 1;
          return outerIter >= 3;
        }),
        max: 10,
      }),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(innerRuns).toBe(3);
    const paths = stats.loopRuns.map((l) => l.path);
    expect(paths).toContain('outer');
    expect(paths.some((p) => p.includes('inner'))).toBe(true);
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    const { outcome } = await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => {
          ac.abort();
          return { status: 'fail' };
        }),
        max: 100,
      }),
      { ...mockOpts, signal: ac.signal },
    );
    expect(outcome.status).toBe('aborted');
  });

  it('runs onComplete exactly once', async () => {
    let calls = 0;
    await run(
      loop({
        name: 'x',
        body: fnJob('b', async () => ({ status: 'pass' })),
        onComplete: () => {
          calls += 1;
        },
      }),
      mockOpts,
    );
    expect(calls).toBe(1);
  });
});
