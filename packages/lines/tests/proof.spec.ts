import { describe, expect, it } from 'vitest';

import { prove, run } from '../src/api.ts';
import type { LoopEvent, RunOptions } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const options: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

describe('prove', () => {
  it('emits a proof event and carries the artifact on the outcome', async () => {
    const events: LoopEvent[] = [];
    const { outcome } = await run(
      prove('api-snapshot', () => ({
        kind: 'json',
        title: 'API snapshot',
        data: { ok: true },
      })),
      { ...options, onEvent: (event) => events.push(event) },
    );

    expect(outcome).toMatchObject({
      status: 'pass',
      data: {
        proof: {
          kind: 'json',
          title: 'API snapshot',
          data: { ok: true },
        },
      },
    });
    expect(events.map((event) => event.kind)).toEqual([
      'job:start',
      'proof',
      'job:end',
    ]);
  });

  it('rejects descriptors with both path and data', async () => {
    const { outcome } = await run(
      prove('bad-proof', () => ({
        kind: 'json',
        path: 'proof.json',
        data: { also: 'present' },
      })),
      options,
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('exactly one of path or data');
  });

  it.each([
    ['BigInt', { n: BigInt(1) }],
    ['Map', new Map([['ok', true]])],
  ])('rejects non-JSON %s proof data', async (_label, data) => {
    const { outcome } = await run(
      prove('bad-data', () => ({ kind: 'json', data }) as never),
      options,
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('JSON-serializable');
  });

  it('rejects a path artifact that does not exist', async () => {
    const { outcome } = await run(
      prove('missing-proof', () => ({
        kind: 'html',
        path: 'proofs/missing.html',
      })),
      options,
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('path does not exist');
  });
});
