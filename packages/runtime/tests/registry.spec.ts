import { describe, it, expect } from 'vitest';

import { EngineError } from '@obversa/engine';
import { agentJob, run } from '../src/api.ts';
import type { Engine } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const work = () => agentJob({ label: 'work', prompt: 'work' });

describe('runtime engine resolution', () => {
  it('runs a directly supplied engine without registration', async () => {
    const engine = new MockEngine(() => 'ready');

    const result = await run(work(), { engine });

    expect(result.outcome.status).toBe('pass');
  });

  it('runs a named engine from the supplied instance map', async () => {
    const engine = new MockEngine(() => 'ready');

    const result = await run(work(), {
      engine: 'worker',
      engines: { worker: engine },
    });

    expect(result.outcome.status).toBe('pass');
  });

  it('fails the job with CONFIG for an unknown named engine', async () => {
    const result = await run(agentJob({
      label: 'work', engine: 'missing', prompt: 'work',
    }));

    expect(result.outcome).toMatchObject({
      status: 'fail',
      error: {
        code: 'CONFIG',
        message: expect.stringContaining('unknown engine "missing"'),
      },
    });
  });

  it.each([
    ['rate-limit', 'RATE_LIMIT'],
    ['quota', 'QUOTA'],
    ['timeout', 'TIMEOUT'],
    ['aborted', 'ABORTED'],
  ] as const)('keeps %s timing hints from an engine error', async (kind, code) => {
    const resetAt = Date.now() + 60_000;
    const engine: Engine = {
      name: `${kind}-engine`,
      async run() {
        throw new EngineError({
          kind,
          message: `${kind} failure`,
          retryAfterMs: 250,
          resetAt,
        });
      },
    };

    const result = await run(work(), { engine });

    expect(result.outcome).toMatchObject({
      status: 'fail',
      error: { code, retryAfterMs: 250, resetAt },
    });
  });
});
