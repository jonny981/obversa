import type { Engine, ExecutionTarget, KickbackBudget } from '@obversa/runtime';

export interface TeamSeat {
  readonly engine: Engine;
  readonly identity: ExecutionTarget;
}

export interface TestCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface TeamInput {
  readonly brief: string;
  readonly workspace: string;
  readonly files: readonly string[];
  readonly test: TestCommand;
}

export interface ReviewerSeat {
  readonly name: string;
  readonly seat: TeamSeat;
  readonly scope?: string;
}

export interface PairConfig extends TeamInput {
  readonly writer: TeamSeat;
  readonly reviewer: TeamSeat;
  readonly maxKickbacks?: KickbackBudget;
}

export interface PanelConfig extends TeamInput {
  readonly implement: TeamSeat;
  readonly reviewers: readonly ReviewerSeat[];
  readonly threshold: number;
  readonly maxKickbacks?: KickbackBudget;
}

export interface FeatureDeliveryConfig extends TeamInput {
  /** Files created by the tests-first stage. Every entry must be in `files`. */
  readonly testFiles: readonly string[];
  readonly analyse: TeamSeat;
  readonly implement: TeamSeat;
  readonly reviewers: readonly ReviewerSeat[];
  readonly reviewThreshold: number;
  readonly approve: TeamSeat;
  readonly maxKickbacks?: KickbackBudget;
}
