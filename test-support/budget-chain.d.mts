export type BudgetPhase = readonly [name: string, allowanceMs: number];

export interface BudgetChainDefinition {
  readonly setup: number;
  readonly phases: readonly BudgetPhase[];
  readonly cleanup: number;
}

export interface BudgetChain {
  readonly name: string;
  readonly budgetMs: number;
  readonly totalMs: number;
  allowance(phase: string): number;
  span(name: string, phases: readonly string[]): number;
  run<Value>(
    phase: string,
    operation: (signal: AbortSignal) => Value | PromiseLike<Value>,
  ): Promise<Value>;
}

export declare function defineBudgetChain(
  name: string,
  budgetMs: number,
  definition: BudgetChainDefinition,
): BudgetChain;
