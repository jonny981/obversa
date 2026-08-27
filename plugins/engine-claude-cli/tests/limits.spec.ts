import { describe, expect, it } from 'vitest';

import { classifyCliLimit, parseResetAt } from '../src/index.ts';

describe('claude-cli limit classification', () => {
  it('classifies a usage limit as QUOTA, reading a reset time', () => {
    const err = classifyCliLimit('Usage limit reached. Resets at 1700000000');
    expect(err?.kind).toBe('quota');
    expect(err?.resetAt).toBe(1700000000 * 1000); // epoch seconds → ms
  });

  it('classifies a usage limit with no reset as quota', () => {
    const err = classifyCliLimit('Usage limit reached for this account.');
    expect(err?.kind).toBe('quota');
    expect(err?.resetAt).toBeUndefined();
  });

  it('classifies Claude session limits as reset-aware QUOTA', () => {
    const err = classifyCliLimit(
      "You've hit your session limit · resets 12am (Europe/London)",
    );
    expect(err?.kind).toBe('quota');
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
});
