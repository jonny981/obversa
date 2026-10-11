import type { MemoryCandidate, PickOptions, PickResult } from './pick.js';
import { DEFAULT_MAX_QUESTION_TEXT, pick } from './pick.js';

/** What a source is asked for, once per attempt. */
export interface CandidateReadRequest {
  /** The task the agent is about to do; the same text pick receives. */
  readonly task: string;
  /** Repository/workspace paths the task names, if the host supplied
   *  them. Ranking-signal hints only; never a filter, and never the
   *  exclusion mechanism. */
  readonly paths?: readonly string[];
  /** Paths excluded by resolved policy. The reader refuses them before
   *  opening contents and before their text reaches signals or a model.
   *  Distinct from `paths` hints. */
  readonly exclude?: readonly string[];
  /** Pin the read to one revision (a SHA, or 'HEAD'). Resolved once by
   *  the reader and used for every operation; history, contents,
   *  dates. Absent means "read the working state". */
  readonly revision?: string;
  /** Most candidates the source should emit, best first. When the
   *  limit truncates enumeration, `complete` is false. */
  readonly limit?: number;
  /** Characters of candidate text the decision model is shown: pick's
   *  `limits.maxQuestionText`. A source that offers a long item in parts
   *  cuts the parts to fit, so every part reaches the model whole.
   *  `pickFromSources` fills it from the pick limits. */
  readonly maxQuestionText?: number;
  /** Cancellation reaches file reads and child processes. */
  readonly signal?: AbortSignal;
}

export type CandidateReadResult =
  | {
      readonly status: 'read';
      /** Source revision at read time; HEAD SHA or the pinned
       *  revision; recorded on the source and copied onto each
       *  candidate's sourceRevision. */
      readonly revision?: string;
      readonly candidates: readonly MemoryCandidate[];
      /** False when enumeration stopped early (limit) or skipped
       *  items; propagates into the combined coverage so a truncated
       *  rule source can never yield a falsely "complete" rule set. */
      readonly complete: boolean;
      /** Why it is partial, plus a count when items were skipped. */
      readonly partial?: string;
    }
  | {
      /** Expected absence: no repository, no git binary, no record
       *  file, no directory. Non-fatal; the step does not fail, the
       *  reason is recorded. Distinct from a real read failure. */
      readonly status: 'absent';
      readonly reason: string;
    };

export interface CandidateSource {
  /** Stable identity, recorded on every candidate and in PickRecord. */
  readonly id: string;
  /** 'reference' | 'rule' | 'mixed'; declared so the caller knows
   *  whether this source can feed the applicable-rule set. */
  readonly role: 'reference' | 'rule' | 'mixed';
  read(request: CandidateReadRequest): Promise<CandidateReadResult>;
}

/** A real read failure: permission denied, corrupt store, killed
 *  mid-read. Cancellation throws the same class with code 'cancelled',
 *  kept apart from 'failed' so a caller can tell them apart. Expected
 *  absence is the 'absent' result, not a throw. */
export class SourceReadError extends Error {
  readonly code: 'failed' | 'cancelled';

  constructor(code: 'failed' | 'cancelled', message: string) {
    super(message);
    this.name = 'SourceReadError';
    this.code = code;
  }
}

export interface PickSourcesResult extends PickResult {
  /** The read each source returned, in the order the sources were
   *  given; absent reasons and partial notes ride along so the caller
   *  can record them beside the pick record. */
  readonly reads: readonly CandidateReadResult[];
}

/**
 * Read every source, then pick over the combined candidates. The read
 * revision is copied onto candidates that do not carry their own
 * sourceRevision, and a rule source that did not enumerate completely
 * (`complete: false`, or absent when rules were expected) makes the
 * record's rulesCoverage 'incomplete' even when every supplied rule was
 * answered. A caller-supplied `rulesEnumerationComplete: false` in the
 * options is honoured the same way.
 */
export async function pickFromSources(
  sources: readonly CandidateSource[],
  request: CandidateReadRequest,
  options: PickOptions,
): Promise<PickSourcesResult> {
  const reads = await Promise.all(sources.map((source) => source.read({
    ...request,
    maxQuestionText: options.limits?.maxQuestionText ?? DEFAULT_MAX_QUESTION_TEXT,
  })));
  const candidates: MemoryCandidate[] = [];
  let rulesEnumerationComplete = options.rulesEnumerationComplete !== false;
  for (const [index, read] of reads.entries()) {
    if (read.status !== 'read') {
      if (sources[index]!.role !== 'reference') rulesEnumerationComplete = false;
      continue;
    }
    if (sources[index]!.role !== 'reference' && !read.complete) rulesEnumerationComplete = false;
    for (const candidate of read.candidates) {
      candidates.push(
        read.revision === undefined || candidate.sourceRevision !== undefined
          ? candidate
          : { ...candidate, sourceRevision: read.revision },
      );
    }
  }
  const result = await pick(candidates, { ...options, rulesEnumerationComplete });
  return { ...result, reads };
}
