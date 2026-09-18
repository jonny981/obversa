import { realpath } from 'node:fs/promises';

import { invoke } from './git-memory.js';

/**
 * The reasoning behind a change, written into the body of the change.
 *
 * The git memory beside this one uses git as a *store*: a private ref per
 * scope, a tree, no commits. This uses git as the *record*: what a stage was
 * thinking is captured while it works and composed into the commit body of
 * the work itself, where it is attached to the lines it explains and readable
 * by every tool a reader already has.
 *
 * Two properties carry the design. The reasoning is captured as the work
 * happens, because context decays inside a run and a summary written
 * afterwards has already lost the discarded attempt, which is the part a
 * later reader cannot reconstruct. And composition has a floor: if the model
 * call fails or has nothing to say, a body is still written from the outcome,
 * because a gap falls exactly where the work was routine, which is where a
 * later reader is most lost.
 *
 * A stage opts in. Short independent runs gain nothing for the capture cost,
 * so nothing is paid for where it is not chosen.
 */

/** The shape this reads out of a run's event stream. Structural on purpose:
 * the runtime's own event type is assignable to it, and this package does not
 * import the runtime. */
export interface RecordedEvent {
  readonly kind: string;
  readonly path?: readonly string[];
  readonly delta?: string;
}

export interface CapturedTurn {
  /** The node the turn belongs to: the last segment of the event path. */
  readonly node: string;
  readonly text: string;
}

export interface RecordOutcome {
  readonly status: string;
  readonly summary?: string;
}

export interface ComposeInput {
  readonly stage: string;
  readonly captured: readonly CapturedTurn[];
  readonly outcome: RecordOutcome;
}

export interface ReasoningRecordOptions {
  readonly repositoryPath: string;
  /** The stage that opted in. It names a refusal and heads the body. */
  readonly stage: string;
  /**
   * Turn the captured turns into a body: why, what else was considered, what
   * constrained it, what comes next. Never what changed; the diff says that
   * better. Returning nothing, or throwing, takes the floor.
   */
  readonly compose?: (input: ComposeInput) => string | undefined | Promise<string | undefined>;
}

export interface RecordResult {
  readonly composed: boolean;
  readonly floor: boolean;
  readonly commit: string;
  readonly captured: number;
}

export interface ReasoningRecord {
  /** Feed the run's events. Only a writer's turns are kept. */
  observe(event: RecordedEvent): void;
  /** At the stage boundary: compose, commit, reset. */
  close(outcome: RecordOutcome): Promise<RecordResult>;
}

const WRITER_TURNS = new Set(['engine:text', 'engine:thinking']);

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/** The body written when composition fails or has nothing: the outcome, said
 * plainly, so the iteration still leaves a trace. */
function floorBody(stage: string, outcome: RecordOutcome, captured: number): string {
  const turns = captured === 1 ? '1 captured turn' : `${captured} captured turns`;
  return [
    `record(${stage}): ${outcome.summary ?? outcome.status}`,
    '',
    '## Why',
    '',
    `Composition left no body, so this is the deterministic floor: the stage`,
    `ended ${outcome.status} with ${turns}. The reasoning for this change was`,
    'not composed, and the outcome above is what the record can state.',
    '',
  ].join('\n');
}

export async function openReasoningRecord(
  options: ReasoningRecordOptions,
): Promise<ReasoningRecord> {
  const stage = nonEmpty(options.stage, 'stage');
  nonEmpty(options.repositoryPath, 'repositoryPath');
  const repositoryPath = await realpath(options.repositoryPath).catch(() => {
    throw new TypeError(`stage ${stage} cannot record: ${options.repositoryPath} is not accessible`);
  });
  const probe = await invoke(repositoryPath, ['rev-parse', '--git-dir']);
  if (probe.exitCode !== 0) {
    throw new TypeError(
      `stage ${stage} cannot record its reasoning: ${repositoryPath} is not a Git repository`,
    );
  }

  let captured: CapturedTurn[] = [];
  return Object.freeze({
    observe(event: RecordedEvent): void {
      if (!WRITER_TURNS.has(event.kind)) return;
      if (typeof event.delta !== 'string' || event.delta === '') return;
      const path = event.path ?? [];
      captured.push({ node: path[path.length - 1] ?? stage, text: event.delta });
    },
    async close(outcome: RecordOutcome): Promise<RecordResult> {
      const turns = captured;
      captured = [];
      let body: string | undefined;
      if (options.compose) {
        try {
          body = await options.compose({ stage, captured: turns, outcome });
        } catch {
          body = undefined;
        }
      }
      const composed = typeof body === 'string' && body.trim() !== '';
      const message = composed ? body! : floorBody(stage, outcome, turns.length);

      const staged = await invoke(repositoryPath, ['add', '-A']);
      if (staged.exitCode !== 0) {
        throw new TypeError(`stage ${stage} could not stage its workspace for the record`);
      }
      // `--allow-empty` because a stage that changed no file still reasoned,
      // and the floor exists so that every iteration leaves a trace.
      const committed = await invoke(
        repositoryPath,
        ['commit', '--allow-empty', '--quiet', '-F', '-'],
        Buffer.from(message, 'utf8'),
      );
      if (committed.exitCode !== 0) {
        throw new TypeError(`stage ${stage} could not write its reasoning record`);
      }
      const head = await invoke(repositoryPath, ['rev-parse', 'HEAD']);
      return Object.freeze({
        composed,
        floor: !composed,
        commit: head.stdout.toString('utf8').trim(),
        captured: turns.length,
      });
    },
  });
}
