import type { UsageReceipt } from './contracts.js';
import type { JsonObject, Sha256Digest } from './json.js';

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
