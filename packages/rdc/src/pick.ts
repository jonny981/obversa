export type MemoryCandidateRole = 'reference' | 'rule';

export interface MemoryCandidate {
  readonly sourceId: string;
  readonly sourceRevision?: string;
  readonly role: MemoryCandidateRole;
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly contentRef?: string;
  /** Repository paths this candidate changed. For a commit: the files in
   *  its diff, not paths the text mentions. */
  readonly changedPaths?: readonly string[];
  /** The repository-relative file path a note candidate lives at: the
   *  note's side of the commit-to-note link. */
  readonly path?: string;
  /** Opaque identifier both sides of a link share when their sources
   *  point into the same work tree; the source declares it (the repo
   *  toplevel, or a caller-supplied key). Candidates with different
   *  values, or where either side declares none, never link. */
  readonly repository?: string;
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
  /** The bar a 'reference' candidate at or above it still clears when a
   *  threshold-selected commit from the same `repository` names its
   *  `path` in `changedPaths`. Below the reference threshold on purpose.
   *  0.4 is a chosen default, not a measured best; it is not shown to
   *  beat the reference threshold everywhere. */
  readonly linkedPathBar?: number;
}

export type PickEntryStatus =
  | {
      readonly status: 'selected';
      readonly asked: boolean;
      readonly probability?: number;
      /** Present when the changed-path link, not the threshold, carried
       *  the candidate over: the selected candidate whose changedPaths
       *  named this candidate's path. An entry that passed on threshold
       *  alone carries none. */
      readonly link?: { readonly sourceId: string; readonly id: string };
    }
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
  /** The candidate's own content handle (a commit's full SHA); kept so
   *  a saved record names the exact bytes, not a short display form. */
  readonly contentRef?: string;
  readonly changedPaths?: readonly string[];
  readonly path?: string;
  readonly repository?: string;
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
  /** False when a source that can supply rule candidates did not finish
   *  enumerating them; its read returned `complete: false`. The combined
   *  coverage can then never report a complete applicable-rule set, even
   *  when every rule supplied was answered. Defaults to true. */
  readonly rulesEnumerationComplete?: boolean;
  readonly limits?: PickLimits;
  readonly thresholds?: PickThresholds;
  readonly signal?: AbortSignal;
}

export const PICK_QUESTION_VERSION = 'memory-pick-questions-1';

const DEFAULT_MAX_PER_BATCH = 150;
/** Characters of candidate text the decision model is shown by default.
 *  The Markdown readers cut long items to fit the same budget, so every
 *  part reaches the model whole. */
export const DEFAULT_MAX_QUESTION_TEXT = 700;
const DEFAULT_THRESHOLD = 0.6;
const DEFAULT_LINKED_PATH_BAR = 0.4;
const TIMED_OUT = Symbol('timed out');

const PICK_QUESTIONS: Record<
  MemoryCandidateRole,
  { readonly question: string; readonly trueCriterion: string; readonly falseCriterion: string }
> = {
  reference: {
    question: 'Does this item supply useful evidence, a constraint or a decision for this task?',
    trueCriterion: 'The item gives evidence, a constraint or a decision that helps with this task.',
    falseCriterion: 'The item gives no evidence, constraint or decision that helps with this task.',
  },
  rule: {
    question: 'Does this rule apply to this task?',
    trueCriterion: 'The rule governs this task, so the work must follow it.',
    falseCriterion: 'The rule does not govern this task.',
  },
};

type CheckedAnswer =
  | { readonly status: 'answered'; readonly probability: number }
  | { readonly status: 'refused' | 'missing' | 'error'; readonly detail?: string };

interface ResolvedLimits {
  readonly maxPerBatch: number;
  readonly maxBatches: number;
  readonly maxCandidates: number;
  readonly maxElapsedMs: number;
  readonly maxQuestionText: number;
}

function positiveLimit(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function probabilityLimit(value: number | undefined, name: string, fallback = DEFAULT_THRESHOLD): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a number between 0 and 1.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function takeCharacters(
  value: string,
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const character of value) {
    if (count === limit) break;
    end += character.length;
    count += 1;
  }
  return { text: value.slice(0, end), truncated: end < value.length };
}

function questionKey(candidate: MemoryCandidate): string {
  return JSON.stringify([candidate.sourceId, candidate.id]);
}

function signalScore(candidate: MemoryCandidate): number {
  let sum = 0;
  for (const value of Object.values(candidate.signals)) sum += value;
  return sum;
}

function rankAndInterleave(
  pool: readonly MemoryCandidate[],
  priority: Map<MemoryCandidate, number>,
): MemoryCandidate[] {
  const groups = new Map<string, MemoryCandidate[]>();
  for (const candidate of pool) {
    const group = groups.get(candidate.sourceId);
    if (group === undefined) groups.set(candidate.sourceId, [candidate]);
    else group.push(candidate);
  }
  const ordered: MemoryCandidate[] = [];
  for (const group of groups.values()) {
    group.sort((left, right) =>
      signalScore(right) - signalScore(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    group.forEach((candidate, rank) => priority.set(candidate, rank));
  }
  let added = true;
  for (let round = 0; added; round += 1) {
    added = false;
    for (const group of groups.values()) {
      const candidate = group[round];
      if (candidate !== undefined) {
        ordered.push(candidate);
        added = true;
      }
    }
  }
  return ordered;
}

function checkAnswer(raw: unknown): CheckedAnswer {
  if (raw === undefined) return { status: 'missing' };
  if (!isRecord(raw)) return { status: 'error', detail: 'The answer is not an object.' };
  const { status, probability, detail } = raw;
  if (status === 'answered') {
    return typeof probability === 'number' && Number.isFinite(probability)
      && probability >= 0 && probability <= 1
      ? { status: 'answered', probability }
      : { status: 'error', detail: 'The answer probability is not a number between 0 and 1.' };
  }
  if (status === 'refused' || status === 'missing' || status === 'error') {
    return typeof detail === 'string' ? { status, detail } : { status };
  }
  return { status: 'error', detail: 'The answer status is not recognised.' };
}

export async function pick(
  candidates: readonly MemoryCandidate[],
  options: PickOptions,
): Promise<PickResult> {
  const input = options.limits ?? {};
  const limits: ResolvedLimits = {
    maxPerBatch: positiveLimit(input.maxPerBatch, 'maxPerBatch', DEFAULT_MAX_PER_BATCH),
    maxBatches: positiveLimit(input.maxBatches, 'maxBatches', Number.POSITIVE_INFINITY),
    maxCandidates: positiveLimit(input.maxCandidates, 'maxCandidates', Number.POSITIVE_INFINITY),
    maxElapsedMs: positiveLimit(input.maxElapsedMs, 'maxElapsedMs', Number.POSITIVE_INFINITY),
    maxQuestionText: positiveLimit(input.maxQuestionText, 'maxQuestionText', DEFAULT_MAX_QUESTION_TEXT),
  };
  const recordedLimits: PickLimits = {
    maxPerBatch: limits.maxPerBatch,
    maxQuestionText: limits.maxQuestionText,
    ...(input.maxBatches !== undefined ? { maxBatches: input.maxBatches } : {}),
    ...(input.maxCandidates !== undefined ? { maxCandidates: input.maxCandidates } : {}),
    ...(input.maxElapsedMs !== undefined ? { maxElapsedMs: input.maxElapsedMs } : {}),
  };
  const thresholds: Required<PickThresholds> = {
    reference: probabilityLimit(options.thresholds?.reference, 'thresholds.reference'),
    rule: probabilityLimit(options.thresholds?.rule, 'thresholds.rule'),
    linkedPathBar: probabilityLimit(options.thresholds?.linkedPathBar, 'thresholds.linkedPathBar', DEFAULT_LINKED_PATH_BAR),
  };
  const signal = options.signal ?? new AbortController().signal;
  const started = Date.now();

  const priority = new Map<MemoryCandidate, number>();
  const rules = rankAndInterleave(candidates.filter((c) => c.role === 'rule'), priority);
  const references = rankAndInterleave(candidates.filter((c) => c.role === 'reference'), priority);

  const selected: MemoryCandidate[] = [];
  const statuses = new Map<MemoryCandidate, PickEntryStatus>();
  const truncated = new Map<MemoryCandidate, boolean>();
  const queue: MemoryCandidate[] = [];
  for (const rule of rules) {
    if (rule.applies === 'always') {
      selected.push(rule);
      statuses.set(rule, { status: 'selected', asked: false });
    } else {
      queue.push(rule);
    }
  }
  queue.push(...references);

  let asked = 0;
  let batches = 0;
  let index = 0;
  let stop: 'limits' | 'time' | 'cancelled' | undefined;
  while (index < queue.length) {
    if (signal.aborted) {
      stop = 'cancelled';
      break;
    }
    if (batches >= limits.maxBatches || asked >= limits.maxCandidates) {
      stop = 'limits';
      break;
    }
    if (Date.now() - started >= limits.maxElapsedMs) {
      stop = 'time';
      break;
    }
    const slice = queue.slice(index, index + Math.min(
      limits.maxPerBatch,
      limits.maxCandidates - asked,
    ));
    const questions: PickQuestion[] = slice.map((candidate) => {
      const spec = PICK_QUESTIONS[candidate.role];
      const shown = takeCharacters(candidate.text, limits.maxQuestionText);
      truncated.set(candidate, shown.truncated);
      return {
        key: questionKey(candidate),
        role: candidate.role,
        question: spec.question,
        trueCriterion: spec.trueCriterion,
        falseCriterion: spec.falseCriterion,
        sourceId: candidate.sourceId,
        id: candidate.id,
        title: candidate.title,
        text: shown.text,
      };
    });

    const deadline = Number.isFinite(limits.maxElapsedMs)
      ? AbortSignal.timeout(Math.ceil(limits.maxElapsedMs - (Date.now() - started)))
      : undefined;
    let answers: Record<string, PickAnswer> | undefined;
    let decideError: unknown;
    let timedOut = false;
    try {
      const returned: unknown = await Promise.race([
        options.decide(
          { task: options.task, questions },
          deadline === undefined ? signal : AbortSignal.any([signal, deadline]),
        ),
        new Promise<typeof TIMED_OUT>((resolve) => {
          deadline?.addEventListener('abort', () => resolve(TIMED_OUT), { once: true });
        }),
      ]);
      if (returned === TIMED_OUT) timedOut = true;
      else answers = isRecord(returned) ? returned as Record<string, PickAnswer> : undefined;
    } catch (error) {
      timedOut = deadline?.aborted === true;
      decideError = error;
    }

    for (const candidate of slice) {
      const answer = timedOut
        ? {
            status: 'error' as const,
            detail: 'The decide call did not finish before the elapsed limit.',
          }
        : decideError !== undefined || answers === undefined
          ? {
              status: 'error' as const,
              detail: decideError instanceof Error ? decideError.message : 'The decide call failed.',
            }
          : checkAnswer(answers[questionKey(candidate)]);
      if (answer.status === 'answered') {
        const threshold = candidate.role === 'rule' ? thresholds.rule : thresholds.reference;
        if (answer.probability >= threshold) {
          selected.push(candidate);
          statuses.set(candidate, { status: 'selected', asked: true, probability: answer.probability });
        } else {
          statuses.set(candidate, { status: 'rejected', probability: answer.probability });
        }
      } else {
        statuses.set(candidate, { status: 'unanswered', answer: answer.status, detail: answer.detail });
      }
    }
    asked += slice.length;
    batches += 1;
    index += slice.length;
    if (timedOut) {
      stop = 'time';
      break;
    }
  }
  for (; index < queue.length; index += 1) {
    statuses.set(queue[index]!, { status: 'unassessed', reason: stop! });
  }

  // The changed-path link, one pass after the threshold pass: a
  // reference candidate that answered at or above the link bar (but below
  // the threshold) still passes when a selected commit from the same
  // repository changed the path it lives at. Only candidates the
  // threshold pass selected can carry a link, so a linked candidate can
  // never carry another; there is no recursion. The pass only adds: it never
  // demotes an ordinary selection and never lowers a threshold.
  const chosen = new Set(selected);
  for (const candidate of candidates) {
    const status = statuses.get(candidate)!;
    if (status.status !== 'rejected'
      || status.probability < thresholds.linkedPathBar
      || candidate.role !== 'reference'
      || candidate.path === undefined
      || candidate.repository === undefined) continue;
    const carrier = candidates.find((other) =>
      other !== candidate
      && other.role === 'reference'
      && chosen.has(other)
      && other.repository === candidate.repository
      && other.changedPaths?.includes(candidate.path!) === true);
    if (carrier === undefined) continue;
    selected.push(candidate);
    statuses.set(candidate, {
      status: 'selected',
      asked: true,
      probability: status.probability,
      link: { sourceId: carrier.sourceId, id: carrier.id },
    });
  }

  const entries: PickRecordEntry[] = candidates.map((candidate) => {
    const status = statuses.get(candidate)!;
    const wasTruncated = truncated.get(candidate);
    const base = {
      sourceId: candidate.sourceId,
      sourceRevision: candidate.sourceRevision,
      id: candidate.id,
      role: candidate.role,
      priority: priority.get(candidate)!,
      signals: candidate.signals,
      ...(candidate.contentRef === undefined ? {} : { contentRef: candidate.contentRef }),
      ...(candidate.changedPaths === undefined ? {} : { changedPaths: candidate.changedPaths }),
      ...(candidate.path === undefined ? {} : { path: candidate.path }),
      ...(candidate.repository === undefined ? {} : { repository: candidate.repository }),
      ...(wasTruncated === undefined ? {} : { truncated: wasTruncated }),
    };
    return status.status === 'unanswered'
      ? { ...base, status: 'unanswered', answer: status.answer, detail: status.detail }
      : { ...base, ...status };
  });
  const rulesCoverage = options.rulesEnumerationComplete === false
    || entries.some((entry) =>
      entry.role === 'rule' && (entry.status === 'unanswered' || entry.status === 'unassessed'))
    ? 'incomplete' as const
    : 'complete' as const;

  return {
    selected,
    record: {
      questionVersion: PICK_QUESTION_VERSION,
      limits: recordedLimits,
      thresholds,
      candidates: entries,
      rulesCoverage,
    },
  };
}
