import type { UsageReceipt } from '../engines/engine.js';
import {
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type Sha256Digest,
} from '../graph/value.js';

export type TokenLimitMode = 'hard' | 'observed';

export interface TokenAllowance extends JsonObject {
  readonly mode: TokenLimitMode;
  readonly tokens: number;
}

export interface AttemptBudgetPolicy extends JsonObject {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly timeoutMs: number;
  readonly teardownGraceMs: number;
  readonly memoryBytes: number;
  readonly filesChanged: number;
  readonly linesChanged: number;
  readonly callTokens: TokenAllowance | null;
}

export interface TokenBudgetSnapshot {
  readonly limit: number;
  readonly spent: number;
  readonly reserved: number;
  readonly unknownUsageCalls: number;
}

export interface BudgetReservation {
  readonly reservationId: Sha256Digest;
  readonly amount: number;
  commit(usage: UsageReceipt): void;
  release(): void;
}

export interface TokenBudget {
  child(limit: number): TokenBudget;
  reserve(
    allowance: TokenAllowance,
    capabilities: { readonly hardLimitEnforceable: boolean },
  ): BudgetReservation;
  snapshot(): TokenBudgetSnapshot;
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function safeAdd(left: number, right: number, field: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${field} must remain a safe integer`);
  }
  return value;
}

function validateAllowance(value: TokenAllowance): TokenAllowance {
  if (value.mode !== 'hard' && value.mode !== 'observed') {
    throw new TypeError('callTokens.mode must be hard or observed');
  }
  return cloneFrozenJson({
    mode: value.mode,
    tokens: positiveSafeInteger(value.tokens, 'callTokens.tokens'),
  });
}

function reportedTokens(usage: UsageReceipt): number | null {
  if (usage.kind === 'unknown') return null;
  if (usage.kind !== 'reported') {
    throw new TypeError('usage.kind must be unknown or reported');
  }
  return safeAdd(
    nonNegativeSafeInteger(usage.inputTokens, 'usage.inputTokens'),
    nonNegativeSafeInteger(usage.outputTokens, 'usage.outputTokens'),
    'reported token usage',
  );
}

class TokenBudgetState implements TokenBudget {
  readonly limit: number;
  readonly parent: TokenBudgetState | undefined;
  private spent = 0;
  private reserved = 0;
  private unknownUsageCalls = 0;
  private nextReservation = 1;

  constructor(limit: number, parent?: TokenBudgetState) {
    this.limit = positiveSafeInteger(limit, 'token budget limit');
    this.parent = parent;
  }

  child(limit: number): TokenBudget {
    return new TokenBudgetState(limit, this);
  }

  reserve(
    rawAllowance: TokenAllowance,
    capabilities: { readonly hardLimitEnforceable: boolean },
  ): BudgetReservation {
    const allowance = validateAllowance(rawAllowance);
    if (typeof capabilities.hardLimitEnforceable !== 'boolean') {
      throw new TypeError('hardLimitEnforceable must be a boolean');
    }
    if (allowance.mode === 'hard' && !capabilities.hardLimitEnforceable) {
      throw new TypeError('engine cannot enforce a hard token allowance');
    }

    const lineage = this.lineage();
    for (const budget of lineage) {
      if (budget.unknownUsageCalls > 0) {
        throw new TypeError('token budget cannot continue because usage is unknown');
      }
      const committedAndHeld = safeAdd(
        budget.spent,
        budget.reserved,
        'token budget accounting',
      );
      if (committedAndHeld > budget.limit - allowance.tokens) {
        throw new TypeError('token budget does not have enough remaining tokens');
      }
    }

    const root = lineage.at(-1)!;
    const sequence = root.nextReservation;
    const nextSequence = safeAdd(
      root.nextReservation,
      1,
      'token reservation sequence',
    );

    for (const budget of lineage) {
      budget.reserved = safeAdd(
        budget.reserved,
        allowance.tokens,
        'token budget reservations',
      );
    }
    root.nextReservation = nextSequence;
    const reservationId = digestJson({
      schemaVersion: 1,
      sequence,
      lineage: lineage.map((budget) => budget.limit),
      allowance,
    });

    let settled = false;
    const assertUnsettled = (): void => {
      if (settled) throw new TypeError('token reservation is already settled');
    };
    const releaseReservation = (): void => {
      for (const budget of lineage) {
        budget.reserved -= allowance.tokens;
      }
    };

    return Object.freeze({
      reservationId,
      amount: allowance.tokens,
      commit: (usage: UsageReceipt): void => {
        assertUnsettled();
        const tokens = reportedTokens(usage);
        const nextSpent =
          tokens === null
            ? undefined
            : lineage.map((budget) =>
                safeAdd(budget.spent, tokens, 'token budget spent'),
              );
        const nextUnknown =
          tokens === null
            ? lineage.map((budget) =>
                safeAdd(
                  budget.unknownUsageCalls,
                  1,
                  'unknown usage call count',
                ),
              )
            : undefined;

        releaseReservation();
        if (tokens === null) {
          for (const [index, budget] of lineage.entries()) {
            budget.unknownUsageCalls = nextUnknown![index]!;
          }
        } else {
          for (const [index, budget] of lineage.entries()) {
            budget.spent = nextSpent![index]!;
          }
        }
        settled = true;

        if (
          tokens !== null &&
          allowance.mode === 'hard' &&
          tokens > allowance.tokens
        ) {
          throw new TypeError('reported usage exceeded the enforced hard token allowance');
        }
      },
      release: (): void => {
        assertUnsettled();
        releaseReservation();
        settled = true;
      },
    });
  }

  snapshot(): TokenBudgetSnapshot {
    return Object.freeze({
      limit: this.limit,
      spent: this.spent,
      reserved: this.reserved,
      unknownUsageCalls: this.unknownUsageCalls,
    });
  }

  private lineage(): TokenBudgetState[] {
    const lineage: TokenBudgetState[] = [];
    let budget: TokenBudgetState | undefined = this;
    while (budget) {
      lineage.push(budget);
      budget = budget.parent;
    }
    return lineage;
  }
}

export function createTokenBudget(limit: number): TokenBudget {
  return new TokenBudgetState(limit);
}

export function validateAttemptBudgetPolicy(
  value: AttemptBudgetPolicy,
): AttemptBudgetPolicy {
  return cloneFrozenJson({
    inputBytes: nonNegativeSafeInteger(value.inputBytes, 'inputBytes'),
    outputBytes: nonNegativeSafeInteger(value.outputBytes, 'outputBytes'),
    timeoutMs: positiveSafeInteger(value.timeoutMs, 'timeoutMs'),
    teardownGraceMs: nonNegativeSafeInteger(
      value.teardownGraceMs,
      'teardownGraceMs',
    ),
    memoryBytes: positiveSafeInteger(value.memoryBytes, 'memoryBytes'),
    filesChanged: nonNegativeSafeInteger(value.filesChanged, 'filesChanged'),
    linesChanged: nonNegativeSafeInteger(value.linesChanged, 'linesChanged'),
    callTokens:
      value.callTokens === null ? null : validateAllowance(value.callTokens),
  });
}
