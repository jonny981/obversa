export type MemoryCandidateRole = 'reference' | 'rule';

export interface MemoryCandidate {
  readonly sourceId: string;
  readonly sourceRevision?: string;
  readonly role: MemoryCandidateRole;
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly contentRef?: string;
  readonly date?: {
    readonly value: string;
    readonly meaning: 'changed' | 'effective' | 'recorded';
  };
  readonly signals: Readonly<Record<string, number>>;
  readonly applies?: 'always';
}

export interface PickQuestion {
  readonly key: string;
  readonly role: MemoryCandidateRole;
  readonly question: string;
  readonly trueCriterion: string;
  readonly falseCriterion: string;
  readonly sourceId: string;
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface PickBatch {
  readonly task: string;
  readonly questions: readonly PickQuestion[];
}

export type PickAnswer =
  | { readonly status: 'answered'; readonly probability: number }
  | { readonly status: 'refused' | 'missing' | 'error'; readonly detail?: string };

export type PickDecide = (
  batch: PickBatch,
  signal: AbortSignal,
) => Promise<Record<string, PickAnswer>>;

export interface PickLimits {
  readonly maxPerBatch?: number;
  readonly maxBatches?: number;
  readonly maxCandidates?: number;
  readonly maxElapsedMs?: number;
  readonly maxQuestionText?: number;
}

export interface PickThresholds {
  readonly reference?: number;
  readonly rule?: number;
}

export type PickEntryStatus =
  | { readonly status: 'selected'; readonly asked: boolean; readonly probability?: number }
  | { readonly status: 'rejected'; readonly probability: number }
  | {
      readonly status: 'unanswered';
      readonly answer: 'refused' | 'missing' | 'error';
      readonly detail?: string;
    }
  | { readonly status: 'unassessed'; readonly reason: 'limits' | 'time' | 'cancelled' };

export type PickRecordEntry = {
  readonly sourceId: string;
  readonly sourceRevision?: string;
  readonly id: string;
  readonly role: MemoryCandidateRole;
  readonly priority: number;
  readonly signals: Readonly<Record<string, number>>;
  readonly truncated?: boolean;
} & PickEntryStatus;

export interface PickRecord {
  readonly questionVersion: string;
  readonly limits: PickLimits;
  readonly thresholds: Required<PickThresholds>;
  readonly candidates: readonly PickRecordEntry[];
  readonly rulesCoverage: 'complete' | 'incomplete';
}

export interface PickResult {
  readonly selected: readonly MemoryCandidate[];
  readonly record: PickRecord;
}

export interface PickOptions {
  readonly task: string;
  readonly decide: PickDecide;
  readonly limits?: PickLimits;
  readonly thresholds?: PickThresholds;
  readonly signal?: AbortSignal;
}
