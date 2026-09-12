import { describe, expect, it } from 'vitest';

import { classifyCliLimit, parseResetAt } from '../src/index.ts';

describe('claude-cli limit classification', () => {
  it('classifies ambiguous usage text as rate-limit and keeps its reset', () => {
    const err = classifyCliLimit('Usage limit reached. Resets at 1700000000');
    expect(err?.kind).toBe('rate-limit');
    expect(err?.resetAt).toBe(1700000000 * 1000); // epoch seconds → ms
  });

  it('classifies ambiguous usage text without inventing a reset', () => {
    const err = classifyCliLimit('Usage limit reached for this account.');
    expect(err?.kind).toBe('rate-limit');
    expect(err?.resetAt).toBeUndefined();
  });

  it('keeps a parsed session reset without inferring quota', () => {
    const err = classifyCliLimit(
      "You've hit your session limit · resets 12am (Europe/London)",
    );
    expect(err?.kind).toBe('rate-limit');
    expect(err?.resetAt).toBeGreaterThan(Date.now());
  });

  it('classifies a plain rate limit as RATE_LIMIT', () => {
    const err = classifyCliLimit('Error: rate limit exceeded (429)');
    expect(err?.kind).toBe('rate-limit');
  });

  it('returns undefined for an unrelated failure', () => {
    expect(classifyCliLimit('command not found')).toBeUndefined();
  });

  it('parses claude wall-clock reset text with an IANA timezone', () => {
    const now = Date.parse('2026-07-05T15:30:00+01:00');
    const reset = parseResetAt(
      'Usage limit reached, resets 4:50pm (Europe/London)',
      now,
    );
    expect(reset).toBe(Date.parse('2026-07-05T16:50:00+01:00'));
  });

  it.each([
    ['monthly usage limit reached', 'quota'],
    ['monthly quota exhausted', 'quota'],
    ['monthly allowance exhausted', 'quota'],
    ['out of credits', 'quota'],
    ['insufficient credits', 'quota'],
    ['billing payment required', 'quota'],
    ['quota allowance reached', 'rate-limit'],
  ] as const)('classifies %s without inventing a reset', (text, kind) => {
    const error = classifyCliLimit(text);
    expect(error?.kind).toBe(kind);
    expect(error?.resetAt).toBeUndefined();
  });

  it.each(['401 unauthorized', 'invalid configuration', 'credit report unavailable'])(
    'leaves unrelated %s to the existing error path', (text) => {
      expect(classifyCliLimit(text)).toBeUndefined();
    },
  );
});
