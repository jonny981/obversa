import type { TeamSeat } from '@obversa/api';
import type { Judge } from '@obversa/runtime';
import type { ReviewerSeat, TeamInput } from '@obversa/runtime/workflow-support';
export type { TeamSeat } from '@obversa/api';
export type { ReviewerSeat, TeamInput, TestCommand } from '@obversa/runtime/workflow-support';

/**
 * The rounds a node may be sent back for rework: one number for every
 * send-back target, or a map from target name to its own rounds or judge.
 * A map key naming a node that takes no send-backs is refused, and a
 * target absent from a map refuses send-backs.
 */
export type RefineBudget = number | Record<string, number | Judge>;

export interface PairConfig extends TeamInput {
  readonly writer: TeamSeat;
  readonly reviewer: TeamSeat;
  readonly refine?: RefineBudget;
}

export interface PanelConfig extends TeamInput {
  readonly implement: TeamSeat;
  readonly reviewers: readonly ReviewerSeat[];
  readonly threshold: number;
  readonly refine?: RefineBudget;
}

export interface FeatureDeliveryConfig extends TeamInput {
  /** Files created by the tests-first stage. Every entry must be in `files`. */
  readonly testFiles: readonly string[];
  readonly analyse: TeamSeat;
  readonly implement: TeamSeat;
  readonly reviewers: readonly ReviewerSeat[];
  readonly reviewThreshold: number;
  readonly approve: TeamSeat;
  readonly refine?: RefineBudget;
}

export interface ImproveWorkflowConfig {
  /** The record a run of the workflow wrote with `recordTo` and the `source` run option. */
  readonly record: string;
  /** The workflow file the record names as its `source`. */
  readonly workflow: string;
  /** The seat that reads the record and proposes one change. */
  readonly proposer: TeamSeat;
  /** A seat from another model family that checks the proposal. */
  readonly reviewer: TeamSeat;
}
