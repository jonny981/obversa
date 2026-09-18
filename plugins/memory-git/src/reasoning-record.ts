import type {
  ReasoningEvent,
  ReasoningMessage,
  ReasoningOutcome,
  ReasoningRecorder,
} from '@obversa/api';

/**
 * The reasoning behind a change, written into the body of that change.
 *
 * The git memory beside this one uses Git as a store: a private ref per
 * scope, a tree, no commits. This uses Git as the record, and the difference
 * that matters is where the words land. A stage that opts in already runs in
 * its own worktree and is committed there before its work merges back. That
 * commit carries the change, so it is the one that carries the reason the
 * change exists. This record makes no commit of its own: a second commit
 * would be a note beside the work, and a note is not attached to a line.
 *
 * Reasoning is captured while the stage works, because context decays inside
 * a run and a summary written afterwards has already lost the discarded
 * attempt, which is the part a later reader cannot reconstruct. Composition
 * has a floor: if the call that composes fails or has nothing to say, the
 * message is still built from the outcome, so a stage that did work never
 * leaves a commit whose body says nothing about why.
 */

export interface CapturedTurn {
  /** The node the words came from: the last segment of the event path. */
  readonly node: string;
  readonly text: string;
}

export interface ComposeInput {
  readonly stage: string;
  readonly captured: readonly CapturedTurn[];
  readonly outcome: ReasoningOutcome;
}

export interface ReasoningRecordOptions {
  /** The stage that opted in. It names the subject and the floor. */
  readonly stage: string;
  /**
   * The stage's own path in the run. Only events under it are kept, so a
   * sibling stage writing at the same time does not end up in this body.
   */
  readonly path?: readonly string[];
  /**
   * Turn the captured turns into a message: one line, then why, what else was
   * considered, what constrained it, what comes next. Never what changed; the
   * diff says that better. Returning nothing, or throwing, takes the floor.
   */
  readonly compose?: (
    input: ComposeInput,
  ) => ReasoningMessage | undefined | Promise<ReasoningMessage | undefined>;
}

const WRITER_TURNS = new Set(['engine:text', 'engine:thinking']);

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function usable(message: unknown): message is ReasoningMessage {
  return typeof message === 'object'
    && message !== null
    && typeof (message as ReasoningMessage).subject === 'string'
    && (message as ReasoningMessage).subject.trim() !== ''
    && typeof (message as ReasoningMessage).body === 'string'
    && (message as ReasoningMessage).body.trim() !== '';
}

/** The message written when composition fails or has nothing: the outcome,
 * said plainly, so a change never lands with a body that explains nothing. */
function floor(stage: string, outcome: ReasoningOutcome, captured: number): ReasoningMessage {
  const turns = captured === 1 ? '1 captured turn' : `${captured} captured turns`;
  return {
    subject: `record(${stage}): ${outcome.summary ?? outcome.status}`,
    body: [
      '## Why',
      '',
      'Composition left no message, so this is the deterministic floor: the',
      `stage ended ${outcome.status} with ${turns}. The reasoning for this`,
      'change was not composed, and the outcome above is what the record can',
      'state.',
    ].join('\n'),
  };
}

/**
 * True when the event belongs to the stage this record was opened for.
 *
 * With a path, the event's own path starts with it. Without one, the stage
 * name is the filter: the runtime names a stage's child path with the stage
 * as its last segment, so that is what an event of this stage looks like.
 * An empty filter accepting everything was the hole: a record opened with a
 * stage and no path took a concurrent stage's words and explained one change
 * with another's reasoning.
 */
function belongs(event: ReasoningEvent, stage: string, path: readonly string[]): boolean {
  const where = event.path ?? [];
  if (path.length > 0) return path.every((segment, index) => where[index] === segment);
  return where[where.length - 1] === stage;
}

export function openReasoningRecord(options: ReasoningRecordOptions): ReasoningRecorder {
  const stage = nonEmpty(options.stage, 'stage');
  const path = options.path ?? [];
  const captured: CapturedTurn[] = [];

  return Object.freeze({
    observe(event: ReasoningEvent): void {
      if (!WRITER_TURNS.has(event.kind)) return;
      if (typeof event.delta !== 'string' || event.delta === '') return;
      if (!belongs(event, stage, path)) return;
      const where = event.path ?? [];
      captured.push({ node: where[where.length - 1] ?? stage, text: event.delta });
    },
    async message(outcome: ReasoningOutcome): Promise<ReasoningMessage> {
      // The turns are kept, not consumed: a commit that fails can be tried
      // again, and composing from nothing the second time would write the
      // floor over reasoning we still hold.
      let composed: ReasoningMessage | undefined;
      if (options.compose) {
        try {
          composed = await options.compose({ stage, captured: [...captured], outcome });
        } catch {
          composed = undefined;
        }
      }
      return usable(composed) ? composed : floor(stage, outcome, captured.length);
    },
    committed(): void {
      // The words are on a commit now. Keeping them would put this change's
      // reasoning in the next change's body.
      captured.length = 0;
    },
  });
}
