import { describe, expect, it } from 'vitest';

import {
  createTokenBudget,
  validateAttemptBudgetPolicy,
} from '../src/runtime/budget.ts';

describe('attempt token budgets', () => {
  it('charges a child reservation to every parent and settles once', () => {
    const run = createTokenBudget(10);
    const node = run.child(6);
    const reservation = node.reserve(
      { mode: 'observed', tokens: 4 },
      { hardLimitEnforceable: false },
    );

    expect(reservation.reservationId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reservation.amount).toBe(4);
    expect(run.snapshot()).toEqual({
      limit: 10,
      spent: 0,
      reserved: 4,
      unknownUsageCalls: 0,
    });
    expect(node.snapshot().reserved).toBe(4);

    reservation.commit({
      kind: 'reported',
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(run.snapshot()).toMatchObject({ spent: 3, reserved: 0 });
    expect(node.snapshot()).toMatchObject({ spent: 3, reserved: 0 });
    expect(() => reservation.commit({ kind: 'unknown' })).toThrow('settled');
    expect(() => reservation.release()).toThrow('settled');
  });

  it('gives each accepted reservation a new id and release restores capacity', () => {
    const budget = createTokenBudget(4);
    const first = budget.reserve(
      { mode: 'observed', tokens: 4 },
      { hardLimitEnforceable: false },
    );
    first.release();
    const second = budget.reserve(
      { mode: 'observed', tokens: 4 },
      { hardLimitEnforceable: false },
    );

    expect(second.reservationId).not.toBe(first.reservationId);
    expect(budget.snapshot()).toMatchObject({ spent: 0, reserved: 4 });
  });

  it('rejects a child over-reservation without changing its parent', () => {
    const run = createTokenBudget(10);
    const node = run.child(3);
    const before = run.snapshot();

    expect(() => node.reserve(
      { mode: 'observed', tokens: 4 },
      { hardLimitEnforceable: false },
    )).toThrow('budget');
    expect(run.snapshot()).toEqual(before);
  });

  it('requires enforcement for hard limits and lets observed usage exceed once', () => {
    const hard = createTokenBudget(10);
    expect(() => hard.reserve(
      { mode: 'hard', tokens: 4 },
      { hardLimitEnforceable: false },
    )).toThrow('cannot enforce');
    expect(hard.snapshot().reserved).toBe(0);

    const observed = createTokenBudget(5);
    const reservation = observed.reserve(
      { mode: 'observed', tokens: 4 },
      { hardLimitEnforceable: false },
    );
    reservation.commit({
      kind: 'reported',
      inputTokens: 4,
      outputTokens: 3,
    });
    expect(observed.snapshot().spent).toBe(7);
    expect(() => observed.reserve(
      { mode: 'observed', tokens: 1 },
      { hardLimitEnforceable: false },
    )).toThrow('budget');
  });

  it('blocks another reservation after unknown usage', () => {
    const budget = createTokenBudget(10);
    budget.reserve(
      { mode: 'observed', tokens: 4 },
      { hardLimitEnforceable: false },
    ).commit({ kind: 'unknown' });

    expect(budget.snapshot()).toMatchObject({
      spent: 0,
      reserved: 0,
      unknownUsageCalls: 1,
    });
    expect(() => budget.reserve(
      { mode: 'observed', tokens: 1 },
      { hardLimitEnforceable: false },
    )).toThrow('usage is unknown');
  });

  it('validates and freezes the complete node budget policy', () => {
    const policy = validateAttemptBudgetPolicy({
      inputBytes: 10,
      outputBytes: 20,
      timeoutMs: 30,
      teardownGraceMs: 4,
      memoryBytes: 50,
      filesChanged: 2,
      linesChanged: 8,
      callTokens: { mode: 'hard', tokens: 6 },
    });

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.callTokens)).toBe(true);
    expect(() => validateAttemptBudgetPolicy({
      ...policy,
      memoryBytes: 1.5,
    })).toThrow('memoryBytes');
    expect(() => createTokenBudget(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'safe integer',
    );
  });

  it('allows zero for no-input, no-output, and read-only caps', () => {
    expect(validateAttemptBudgetPolicy({
      inputBytes: 0,
      outputBytes: 0,
      timeoutMs: 1,
      teardownGraceMs: 0,
      memoryBytes: 1,
      filesChanged: 0,
      linesChanged: 0,
      callTokens: null,
    })).toMatchObject({
      inputBytes: 0,
      outputBytes: 0,
      teardownGraceMs: 0,
      filesChanged: 0,
      linesChanged: 0,
      callTokens: null,
    });
  });

  it('rejects time policies that Node timers would shorten', () => {
    const maximumTimerMs = 2_147_483_647;
    const policy = {
      inputBytes: 0,
      outputBytes: 0,
      timeoutMs: maximumTimerMs,
      teardownGraceMs: 0,
      memoryBytes: 1,
      filesChanged: 0,
      linesChanged: 0,
      callTokens: null,
    } as const;

    expect(validateAttemptBudgetPolicy(policy).timeoutMs).toBe(maximumTimerMs);
    expect(() => validateAttemptBudgetPolicy({
      ...policy,
      timeoutMs: maximumTimerMs + 1,
    })).toThrow('timeoutMs');
    expect(() => validateAttemptBudgetPolicy({
      ...policy,
      teardownGraceMs: 1,
    })).toThrow('timeoutMs + teardownGraceMs');
  });
});
