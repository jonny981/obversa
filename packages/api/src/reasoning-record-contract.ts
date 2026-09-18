/**
 * What a reasoning record offers a run, named once so that the runtime can
 * consume it without knowing which adapter supplies it.
 *
 * The record does not commit. A stage that opts in is already run in its own
 * worktree and committed there before its work is merged back; that commit is
 * the one carrying the change, so it is the one that should carry the reason
 * the change exists. The record watches the stage work and, when the stage
 * passes, offers a subject and a body for that commit.
 *
 * A stage that changed nothing produces no commit, so it produces no body:
 * the caller asks for one only when there is something to write it on.
 */

/** The shape a record reads out of a run's event stream. Structural, so the
 * runtime's own event type fits it without either side importing the other. */
export interface ReasoningEvent {
  readonly kind: string;
  readonly path?: readonly string[];
  readonly delta?: string;
}

/** What a stage ended as, in the words the record composes from. */
export interface ReasoningOutcome {
  readonly status: string;
  readonly summary?: string;
}

/** A commit message: one line, then the reasoning under it. */
export interface ReasoningMessage {
  readonly subject: string;
  readonly body: string;
}

export interface ReasoningRecorder {
  /**
   * Feed the run's events. A recorder keeps only what belongs to the stage it
   * was opened for, and only the turns that carry a writer's words.
   */
  observe(event: ReasoningEvent): void;
  /**
   * The message for the commit that carries this stage's change. Composition
   * that fails or has nothing to say still returns a message built from the
   * outcome, so an iteration that did work never leaves a commit that says
   * nothing about why.
   */
  message(outcome: ReasoningOutcome): Promise<ReasoningMessage>;
  /**
   * The commit the message landed on. A recorder that is asked for a message
   * and never told the commit succeeded keeps what it captured, so a commit
   * that failed can be tried again from the same turns; told the commit
   * exists, it starts the next iteration empty rather than explaining one
   * change with another's reasoning.
   */
  committed(commit: string): void;
}
