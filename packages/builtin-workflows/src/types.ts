import type { Judge } from '@obversa/runtime';
import type { ReviewerSeat, TeamInput } from '@obversa/runtime/workflow-support';
export type { TeamSeat } from '@obversa/api';
import type { SeatChoice, TeamSeat } from '@obversa/api';
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

export interface FeatureDeliveryConfig {
  /** The brief, as text. Give this or `briefPath`. */
  readonly brief?: string;
  /** The brief, as a file. The brief check reads it again when a paused run resumes, so a fixed brief needs no relaunch. */
  readonly briefPath?: string;
  /** The worktree the team builds in. */
  readonly workspace: string;
  /** The seat that builds. Its candidates take over when it cannot answer. */
  readonly implement: SeatChoice;
  /** The panel. The first reviewer also checks the brief, and reads the proof unless `reader` is given. */
  readonly reviewers: readonly ReviewerSeat[];
  /** How many reviewers must pass a round. Default: all of them. */
  readonly reviewThreshold?: number;
  /** The seat that checks the report's proof. Default: the first reviewer. */
  readonly reader?: SeatChoice;
  /** The judge between each review's verdict and the send-back. Without one, `rounds` bounds the send-backs. */
  readonly judge?: TeamSeat;
  /** The judge's cap on rounds; without one the judge alone ends them. */
  readonly cap?: number;
  /** The send-backs the build takes when there is no judge. Default 3. */
  readonly rounds?: number;
  /** The checks the change must pass, one command per entry: a string with no shell syntax, or an argv array. */
  readonly checks: readonly (string | readonly string[])[];
  /** What the change is measured against. Default `origin/main`. */
  readonly base?: string;
  /** Minutes one build attempt may run. Default 120. */
  readonly buildMinutes?: number;
  /** Minutes the brief check, the proof check and each reviewer may run. Default 40. */
  readonly reviewMinutes?: number;
  /** Minutes with no engine event before a step counts as stalled; it is then retried once, then its candidate runs. Off unless set. */
  readonly stallMinutes?: number;
  /** Commit the work on its branch when the run passes, with the commit message that ends the builder's report. */
  readonly commit?: boolean;
  /** The rules every seat reads: the builder obeys them and the reviewers hold the change to them. */
  readonly houseRules?: string;
  /** The seat that writes the research notes and the plan. With it, the research and plan stages run before the build. */
  readonly analyse?: SeatChoice;
  /** The files the change writes. Required with `analyse` or `testFiles`. */
  readonly files?: readonly string[];
  /** The test files written before the code. With them, the tests stage runs before the build. Every entry must be in `files`. */
  readonly testFiles?: readonly string[];
  /** The send-backs the research, plan and tests stages take. Default 1 each. */
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
