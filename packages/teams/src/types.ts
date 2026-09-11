import type {
  EngineRef,
  GraphEngineBinding,
  Job,
} from '@obversa/runtime';

export interface TeamSeat {
  readonly engine: EngineRef;
  readonly binding: GraphEngineBinding;
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
  readonly maxKickbacks?: number;
}

export interface PanelConfig extends TeamInput {
  readonly implement: TeamSeat;
  readonly reviewers: readonly ReviewerSeat[];
  readonly threshold: number;
  readonly maxKickbacks?: number;
}

export interface FeatureDeliveryConfig extends TeamInput {
  readonly analyse: TeamSeat;
  readonly implement: TeamSeat;
  readonly reviewers: readonly ReviewerSeat[];
  readonly reviewThreshold: number;
  readonly approve: TeamSeat;
  readonly maxKickbacks?: number;
}

export interface TeamBuilders {
  readonly writerReviewerPair: (config: PairConfig) => Job;
  readonly thresholdPanel: (config: PanelConfig) => Job;
  readonly featureDelivery: (config: FeatureDeliveryConfig) => Job;
}
