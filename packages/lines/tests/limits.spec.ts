/**
 * The `onLimit` policy: wait-and-continue on a known, bounded reset; otherwise
 * pause with a distinct exit code. Offline
 * and deterministic — a custom engine throws the limit signal, and waits are a
 * few ms so the suite stays fast.
 */
import { describe, it, expect } from 'vitest';

import {
  run,
  loop,
  agentJob,
  exitCodeFor,
  EXIT_PAUSED,
  LoopError,
} from '../src/api.ts';
import type { Engine, LoopEvent } from '../src/api.ts';
import {
  waitMsFor,
  retryAfterHeaderToMs,
  isLimitError,
} from '../src/core/limits.ts';
import { classifyCliLimit, parseResetAt } from '../src/engines/claude-cli.ts';
import { fixtureResult, fixtureUsage } from './engine-fixture.ts';

/**
 * An engine that throws a given LoopError on its first `n` calls, then succeeds.
 * Models a transient provider limit that clears after its reset.
 */
function limitThenOk(error: LoopError, throwTimes = 1): Engine {
  let calls = 0;
  return {
    name: 'limited',
    async run(_req, onEvent) {
      calls += 1;
      if (calls <= throwTimes) throw error;
      const usage = fixtureUsage();
      onEvent({
        type: 'usage',
        usage,
        model: 'limited',
      });
      return fixtureResult('done', { model: 'limited', usage });
    },
  };
}

const passOnText = agentJob({
  label: 'w',
  prompt: 'go',
  // The body passes once the engine returns text; a thrown limit short-circuits
  // before this runs, so the outcome is `pass` only on a clean engine call.
  outcome: (text) => ({ status: text ? 'pass' : 'fail' }),
});

describe('onLimit: auto — wait and continue', () => {
  it('waits out a known retryAfterMs then completes pass', async () => {
    const rateLimit = new LoopError({
      code: 'RATE_LIMIT',
      message: 'throttled',
      retryAfterMs: 5,
    });
    const events: LoopEvent[] = [];
    const { outcome, stats } = await run(
      loop({ name: 'x', body: passOnText, max: 5 }),
      {
        engine: 'limited',
        engines: { limited: () => limitThenOk(rateLimit, 1) },
        maxWaitMs: 10_000,
        onEvent: (e) => events.push(e),
      },
    );
    expect(outcome.status).toBe('pass');
    // The throttled attempt did not burn an iteration: it passed on iteration 1.
    expect(stats.loopRuns[0]?.iterations).toBe(1);
    const waited = events.find((e) => e.kind === 'limit:wait');
    expect(waited).toBeDefined();
    expect(waited).toMatchObject({ code: 'RATE_LIMIT', waitMs: 5 });
  });

  it('pauses when the reset exceeds maxWaitMs', async () => {
    const rateLimit = new LoopError({
      code: 'RATE_LIMIT',
      message: 'throttled long',
      retryAfterMs: 60_000,
    });
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      loop({ name: 'x', body: passOnText, max: 5 }),
      {
        engine: 'limited',
        engines: { limited: () => limitThenOk(rateLimit, 1) },
        maxWaitMs: 100,
        onEvent: (e) => events.push(e),
      },
    );
    expect(outcome.status).toBe('paused');
    expect(exitCodeFor(outcome)).toBe(EXIT_PAUSED);
    expect(EXIT_PAUSED).toBe(75);
    const paused = events.find((e) => e.kind === 'limit:pause');
    expect(paused).toMatchObject({ code: 'RATE_LIMIT' });
  });
});

describe('onLimit: auto — quota with no reset pauses', () => {
  it('a QUOTA with no reset is not auto-waitable and pauses', async () => {
    const quota = new LoopError({
      code: 'QUOTA',
      message: 'usage limit reached',
    });
    expect(quota.retryable).toBe(false); // no reset → fatal-by-default
    const { outcome } = await run(
      loop({ name: 'x', body: passOnText, max: 5 }),
      {
        engine: 'limited',
        engines: { limited: () => limitThenOk(quota, 1) },
      },
    );
    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('QUOTA');
    expect(exitCodeFor(outcome)).toBe(EXIT_PAUSED);
  });

  it('a QUOTA with a known reset waits then completes (auto)', async () => {
    const quota = new LoopError({
      code: 'QUOTA',
      message: 'usage limit, resets soon',
      resetAt: Date.now() + 5,
    });
    expect(quota.retryable).toBe(true); // a known reset makes it retryable
    const { outcome } = await run(
      loop({ name: 'x', body: passOnText, max: 5 }),
      {
        engine: 'limited',
        engines: { limited: () => limitThenOk(quota, 1) },
        maxWaitMs: 10_000,
      },
    );
    expect(outcome.status).toBe('pass');
  });
});

describe('onLimit: budget exhaustion under auto', () => {
  it('a BUDGET hit pauses instead of becoming a hard failure', async () => {
    const usageEngine: Engine = {
      name: 'um',
      async run(_req, onEvent) {
        const usage = fixtureUsage(100, 100);
        onEvent({
          type: 'usage',
          usage,
          model: 'um',
        });
        return fixtureResult('ok', { model: 'um', usage });
      },
    };
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      loop({
        name: 'x',
        body: agentJob({
          label: 'w',
          prompt: 'go',
          outcome: () => ({ status: 'fail' as const }),
        }),
        max: 10,
      }),
      {
        engine: 'um',
        engines: { um: () => usageEngine },
        budget: 150,
        onEvent: (e) => events.push(e),
      },
    );
    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('BUDGET');
    const paused = events.find((e) => e.kind === 'limit:pause');
    expect(paused).toMatchObject({ code: 'BUDGET' });
  });
});

describe('onLimit: explicit policies', () => {
  it("'fail' opts out of the limit policy (no pause, no wait)", async () => {
    // A QUOTA with no reset is non-retryable. Under the default policy it would
    // pause; under 'fail' it follows the ordinary fatal-error path instead.
    const quota = new LoopError({ code: 'QUOTA', message: 'usage limit' });
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      loop({
        name: 'x',
        body: agentJob({
          label: 'w',
          prompt: 'go',
          // Return (not throw) the limit so the fatal-on-non-retryable path runs.
          outcome: () => ({ status: 'fail' as const, error: quota }),
        }),
        max: 5,
      }),
      {
        engine: 'limited',
        engines: { limited: () => limitThenOk(quota, 0) },
        onLimit: 'fail',
        onEvent: (e) => events.push(e),
      },
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('QUOTA');
    expect(events.some((e) => e.kind === 'limit:pause')).toBe(false);
    expect(events.some((e) => e.kind === 'limit:wait')).toBe(false);
  });

  it("'exit' never waits, even within maxWaitMs", async () => {
    const rateLimit = new LoopError({
      code: 'RATE_LIMIT',
      message: 'throttled',
      retryAfterMs: 5,
    });
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      loop({ name: 'x', body: passOnText, max: 5 }),
      {
        engine: 'limited',
        engines: { limited: () => limitThenOk(rateLimit, 1) },
        onLimit: 'exit',
        maxWaitMs: 10_000,
        onEvent: (e) => events.push(e),
      },
    );
    expect(outcome.status).toBe('paused');
    expect(events.some((e) => e.kind === 'limit:wait')).toBe(false);
  });

  it("'wait' waits a known reset beyond maxWaitMs", async () => {
    const rateLimit = new LoopError({
      code: 'RATE_LIMIT',
      message: 'throttled',
      retryAfterMs: 5,
    });
    const { outcome } = await run(
      loop({ name: 'x', body: passOnText, max: 5 }),
      {
        engine: 'limited',
        engines: { limited: () => limitThenOk(rateLimit, 1) },
        onLimit: 'wait',
        maxWaitMs: 1, // below the 5ms reset, but 'wait' ignores the ceiling
      },
    );
    expect(outcome.status).toBe('pass');
  });
});

describe('error taxonomy', () => {
  it('RATE_LIMIT defaults retryable, QUOTA only with a known reset', () => {
    expect(new LoopError({ code: 'RATE_LIMIT', message: 'x' }).retryable).toBe(
      true,
    );
    expect(new LoopError({ code: 'QUOTA', message: 'x' }).retryable).toBe(false);
    expect(
      new LoopError({ code: 'QUOTA', message: 'x', resetAt: Date.now() })
        .retryable,
    ).toBe(true);
    expect(
      new LoopError({ code: 'QUOTA', message: 'x', retryAfterMs: 1000 })
        .retryable,
    ).toBe(true);
    // BUDGET never refreshes within a run.
    expect(
      new LoopError({ code: 'BUDGET', message: 'x', resetAt: Date.now() })
        .retryable,
    ).toBe(false);
  });

  it('toJSON carries retryAfterMs and resetAt', () => {
    const reset = Date.now() + 1000;
    const json = new LoopError({
      code: 'RATE_LIMIT',
      message: 'x',
      retryAfterMs: 500,
      resetAt: reset,
    }).toJSON();
    expect(json.retryAfterMs).toBe(500);
    expect(json.resetAt).toBe(reset);
  });
});

describe('limit helpers', () => {
  it('isLimitError matches rate/quota/budget only', () => {
    expect(isLimitError(new LoopError({ code: 'RATE_LIMIT', message: 'x' }))).toBe(
      true,
    );
    expect(isLimitError(new LoopError({ code: 'QUOTA', message: 'x' }))).toBe(
      true,
    );
    expect(isLimitError(new LoopError({ code: 'BUDGET', message: 'x' }))).toBe(
      true,
    );
    expect(isLimitError(new LoopError({ code: 'ENGINE', message: 'x' }))).toBe(
      false,
    );
    expect(isLimitError(undefined)).toBe(false);
  });

  it('waitMsFor prefers retryAfterMs, falls back to resetAt - now, floors at 0', () => {
    const now = 1_000_000;
    expect(
      waitMsFor(
        new LoopError({ code: 'RATE_LIMIT', message: 'x', retryAfterMs: 500 }),
        now,
      ),
    ).toBe(500);
    expect(
      waitMsFor(
        new LoopError({ code: 'QUOTA', message: 'x', resetAt: now + 2000 }),
        now,
      ),
    ).toBe(2000);
    // an already-passed reset waits nothing, not a negative duration.
    expect(
      waitMsFor(
        new LoopError({ code: 'QUOTA', message: 'x', resetAt: now - 5000 }),
        now,
      ),
    ).toBe(0);
    // no reset hint → not auto-waitable.
    expect(
      waitMsFor(new LoopError({ code: 'QUOTA', message: 'x' }), now),
    ).toBeUndefined();
    // BUDGET never yields a wait, even with a (nonsensical) reset.
    expect(
      waitMsFor(
        new LoopError({ code: 'BUDGET', message: 'x', resetAt: now + 1000 }),
        now,
      ),
    ).toBeUndefined();
  });

  it('retryAfterHeaderToMs parses seconds and HTTP-dates', () => {
    expect(retryAfterHeaderToMs('30')).toBe(30_000);
    expect(retryAfterHeaderToMs(null)).toBeUndefined();
    expect(retryAfterHeaderToMs('')).toBeUndefined();
    expect(retryAfterHeaderToMs('not-a-number')).toBeUndefined();
    const now = Date.UTC(2030, 0, 1, 0, 0, 0);
    const date = new Date(now + 10_000).toUTCString();
    expect(retryAfterHeaderToMs(date, now)).toBe(10_000);
  });
});

describe('claude-cli limit classification', () => {
  it('classifies a usage limit as QUOTA, reading a reset time', () => {
    const err = classifyCliLimit('Usage limit reached. Resets at 1700000000');
    expect(err?.code).toBe('QUOTA');
    expect(err?.resetAt).toBe(1700000000 * 1000); // epoch seconds → ms
    expect(err?.retryable).toBe(true); // a known reset makes it auto-waitable
  });

  it('classifies a usage limit with no reset as a non-retryable QUOTA', () => {
    const err = classifyCliLimit('Usage limit reached for this account.');
    expect(err?.code).toBe('QUOTA');
    expect(err?.resetAt).toBeUndefined();
    expect(err?.retryable).toBe(false);
  });

  it('classifies Claude session limits as reset-aware QUOTA', () => {
    const err = classifyCliLimit(
      "You've hit your session limit · resets 12am (Europe/London)",
    );
    expect(err?.code).toBe('QUOTA');
    expect(err?.resetAt).toBeGreaterThan(Date.now());
    expect(err?.retryable).toBe(true);
  });

  it('classifies a plain rate limit as RATE_LIMIT', () => {
    const err = classifyCliLimit('Error: rate limit exceeded (429)');
    expect(err?.code).toBe('RATE_LIMIT');
    expect(err?.retryable).toBe(true);
  });

  it('returns undefined for an unrelated failure', () => {
    expect(classifyCliLimit('command not found')).toBeUndefined();
  });

  it('parses claude wall-clock reset text with an IANA timezone', () => {
    const now = Date.parse('2026-07-05T15:30:00+01:00');
    const reset = parseResetAt('Usage limit reached, resets 4:50pm (Europe/London)', now);
    expect(reset).toBe(Date.parse('2026-07-05T16:50:00+01:00'));
  });
});
