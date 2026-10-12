import { describe, expect, test } from 'vitest';
import {
  EngineError,
  engineSelection,
  validateAgentResult,
} from '../src/index.js';

describe('@obversa/api', () => {
  test('owns typed provider failures', () => {
    const effective = engineSelection({
      adapter: 'fixture',
      provider: 'provider-a',
      model: 'effective-model',
    });
    const error = new EngineError({
      kind: 'rate-limit',
      message: 'slow down',
      retryAfterMs: 250,
      resetAt: 1_800_000_000_000,
      resetProven: true,
      effective,
    });
    expect(error.kind).toBe('rate-limit');
    expect(error.retryAfterMs).toBe(250);
    expect(error.resetAt).toBe(1_800_000_000_000);
    expect(error.resetProven).toBe(true);
    expect(error.effective).toEqual(effective);
    // A reset reported without provenance is not marked proven.
    expect(new EngineError({ kind: 'quota', message: 'out', resetAt: 1_800_000_000_000 }).resetProven).toBeUndefined();
  });

  test('rejects a result without exactly one final part', () => {
    expect(() => validateAgentResult({
      parts: [],
      usage: { kind: 'unknown' },
      requested: {
        adapter: 'fixture', adapterVersion: null, provider: null,
        modelFamily: null, model: null, executable: null, capabilities: [],
      },
      effective: {
        adapter: 'fixture', adapterVersion: null, provider: null,
        modelFamily: null, model: null, executable: null, capabilities: [],
      },
    })).toThrow('exactly one final part');
  });
});
