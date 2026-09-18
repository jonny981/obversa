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

/**
 * The most body a record will put on a commit.
 *
 * Writer turns are the engine's raw stream, not the scrubbed result text, and
 * a commit is permanent and pushable. A composed body is therefore capped
 * rather than trusted: a run that streamed for an hour cannot write an
 * unbounded body into history. The floor never carries turn text at all, only
 * how many turns there were, so it has nothing to cap.
 */
const BODY_LIMIT = 16_000;

function bounded(body: string): string {
  if (body.length <= BODY_LIMIT) return body;
  return `${body.slice(0, BODY_LIMIT)}\n\n[record: body truncated at ${BODY_LIMIT} characters]`;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Collapse anything that would break a one-line commit subject. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function usable(message: unknown): message is ReasoningMessage {
  return typeof message === 'object'
    && message !== null
    && typeof (message as ReasoningMessage).subject === 'string'
    && (message as ReasoningMessage).subject.trim() !== ''
    // ReasoningMessage promises one line then the reasoning under it. A
    // composed subject carrying a newline breaks that promise silently, and
    // everything after the newline reads as body with no blank line before it.
    // Refusing here sends it to the floor, which says what happened.
    && !/[\r\n]/.test((message as ReasoningMessage).subject)
    && typeof (message as ReasoningMessage).body === 'string'
    && (message as ReasoningMessage).body.trim() !== '';
}

/** The message written when composition fails or has nothing: the outcome,
 * said plainly, so a change never lands with a body that explains nothing. */
function floor(stage: string, outcome: ReasoningOutcome, captured: number): ReasoningMessage {
  const turns = captured === 1 ? '1 captured turn' : `${captured} captured turns`;
  return {
    // The summary comes from the job and can be many lines; the floor exists
    // to be dependable, so it normalises rather than inheriting the problem.
    subject: oneLine(`record(${stage}): ${outcome.summary ?? outcome.status}`),
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
 * With a path, the event's own path starts with it.
 *
 * Without one, the stage name finds the path once and the record then holds
 * it, and everything under that path belongs to the stage. Two holes sit on
 * either side of this. Matching the last segment kept a record from seeing its
 * own work whenever the stage was a loop or a nested job, because the engine's
 * turns arrive one or more segments deeper. Matching the name anywhere without
 * pinning let two stages both named `implement`, under `ticket-a` and
 * `ticket-b`, share one record and explain one change with the other's
 * reasoning. Pinning the path up to the name, then matching by prefix, closes
 * both: the stage's descendants are kept and its namesake elsewhere is not.
 */
function belongs(event: ReasoningEvent, stage: string, path: readonly string[]): boolean {
  const where = event.path ?? [];
  if (path.length === 0) return false;
  return path.every((segment, index) => where[index] === segment);
}

/**
 * The path this record is bound to, once an event has revealed it.
 *
 * The stage's own turns do not all arrive on the stage's own path. `isolated`
 * appends its label, and then whatever runs underneath appends more: a loop
 * adds its name, and the engine emits its text under that. So the stage name
 * is looked for anywhere in the path, and what is pinned is the path up to and
 * including it, which is the stage's own path. Requiring the name to be the
 * LAST segment was the hole: a stage that is a loop or a nested job then
 * matched nothing at all and floored to zero captured turns, which is what the
 * package page's own example does.
 */
function pathFor(event: ReasoningEvent, stage: string): readonly string[] | undefined {
  const where = event.path ?? [];
  const at = where.indexOf(stage);
  return at === -1 ? undefined : where.slice(0, at + 1);
}

export function openReasoningRecord(options: ReasoningRecordOptions): ReasoningRecorder {
  const stage = nonEmpty(options.stage, 'stage');
  // Given a path, the record is bound before it sees anything. Given only a
  // stage name, it binds to the path of the first event that carries that name
  // and keeps it, so a same-named stage elsewhere in the run cannot join.
  let path = options.path ?? [];
  const captured: CapturedTurn[] = [];

  return Object.freeze({
    observe(event: ReasoningEvent): void {
      if (!WRITER_TURNS.has(event.kind)) return;
      if (typeof event.delta !== 'string' || event.delta === '') return;
      if (path.length === 0) {
        const found = pathFor(event, stage);
        if (!found) return;
        path = [...found];
      }
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
      if (!usable(composed)) return floor(stage, outcome, captured.length);
      return { subject: composed.subject, body: bounded(composed.body) };
    },
    committed(): void {
      // The words are on a commit now. Keeping them would put this change's
      // reasoning in the next change's body.
      captured.length = 0;
    },
  });
}
