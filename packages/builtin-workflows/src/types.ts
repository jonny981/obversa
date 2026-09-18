import type { TeamSeat } from '@obversa/api';
import type { KickbackBudget } from '@obversa/runtime';
import type { ReviewerSeat, TeamInput } from '@obversa/runtime/workflow-support';
export type { TeamSeat } from '@obversa/api';
export type { ReviewerSeat, TeamInput, TestCommand } from '@obversa/runtime/workflow-support';

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
