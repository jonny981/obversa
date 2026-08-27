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

  it('rejects an unknown named engine without loading a provider', async () => {
    const result = await run(agentJob({
      label: 'work', engine: 'missing', prompt: 'work',
    }));

    expect(result.outcome.error).toMatchObject({
      code: 'CONFIG',
      message: expect.stringContaining('unknown engine "missing"'),
    });
  });

  it('keeps rate-limit reset hints from an engine error', async () => {
    const resetAt = Date.now() + 60_000;
    const engine: Engine = {
      name: 'limited',
      async run() {
        throw new EngineError({
          kind: 'rate-limit',
          message: 'slow down',
          retryAfterMs: 250,
          resetAt,
        });
      },
    };

    const result = await run(work(), { engine });

    expect(result.outcome.error).toMatchObject({
      code: 'RATE_LIMIT',
      retryAfterMs: 250,
      resetAt,
    });
  });
});
