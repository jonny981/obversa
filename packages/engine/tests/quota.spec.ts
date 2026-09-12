import { describe, expect, it } from 'vitest';
import {
  EngineError,
  LANE_DEAD_FAILURES,
  classifyEngineFailure,
} from '../src/index.ts';

describe('quota text classification', () => {
  it.each([
    ['monthly usage limit reached', 'quota'],
    ['monthly quota exhausted', 'quota'],
    ['monthly allowance exhausted', 'quota'],
    ['out of credits', 'quota'],
    ['out of available credits', 'quota'],
    ['insufficient credits', 'quota'],
    ['quota allowance reached', 'rate-limit'],
    ['Usage limit reached for this account.', 'rate-limit'],
    ["You've hit your session limit", 'rate-limit'],
    ['429 usage limit reached', 'rate-limit'],
    ['allowance exceeded; resets at 1700000000', 'rate-limit'],
    ['credit report unavailable', 'unknown'],
    ['402 payment required: exhausted credit balance', 'billing'],
    ['401 unauthorized: usage limit reached', 'auth'],
    ["usage limit; HTTP 400: Invalid value: 'max'. Supported values are: high, xhigh", 'invalid-config'],
  ] as const)('classifies %s as %s', (text, kind) => {
    expect(classifyEngineFailure(new Error(text))).toBe(kind);
  });

  it('keeps typed failures ahead of ambiguous or conflicting text', () => {
    expect(classifyEngineFailure(new EngineError({
      kind: 'quota', message: 'usage limit',
    }))).toBe('quota');
    expect(classifyEngineFailure(new EngineError({
      kind: 'rate-limit', message: 'monthly quota exhausted',
    }))).toBe('rate-limit');
    expect(classifyEngineFailure(Object.assign(new Error('session limit'), {
      code: 'QUOTA',
    }))).toBe('quota');
  });

  it('includes lasting quota, but excludes ambiguous throttles, in default fallback', () => {
    expect(LANE_DEAD_FAILURES.has('quota')).toBe(true);
    expect(LANE_DEAD_FAILURES.has('rate-limit')).toBe(false);
    expect(LANE_DEAD_FAILURES.has('transient')).toBe(false);
  });
});
