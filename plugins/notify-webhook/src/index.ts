/**
 * A notifier that posts one message per interesting run event to a URL the
 * caller supplies. It is a plain `onEvent` consumer: hand `onEvent` to `run`
 * and the run tells whoever is listening that it started, that a stage
 * finished, that a review sent work back and why, that it is waiting for a
 * person, and how it ended.
 *
 * The body carries a `text` field, which is what a Slack, Discord or Teams
 * incoming webhook renders, so those three work with no code of their own.
 * Everything else in the body is structured, for a relay that wants the parts.
 *
 * Two messages carry the information rather than a pointer to it: the paused
 * message names the run's page so the person can answer from it, and the
 * sent-back message carries the reviewer's reason. Both put that second part
 * on its own line, because it is a sentence rather than a clause.
 *
 * The words a message uses are the words the run's own events use: started,
 * finished, sent back, paused, failed. Somebody who reads a notification and
 * then opens the record meets one vocabulary, not two.
 *
 * A failure is reported from the event that ends the run, not from the `error`
 * event. An `error` can be followed by an iteration that passes, so notifying
 * on it would announce a failure for a run that went on to succeed. The ending
 * event carries the same message in its summary.
 *
 * The URL is always the caller's. Nothing in this package, its tests or its
 * documentation contains one.
 */

/** The outcome fields a message reads. */
export interface RunEventOutcome {
  readonly status: string;
  readonly summary?: string;
}

/**
 * The run event fields a message reads. Every event the runtime emits is
 * assignable to this: the kind, when it happened, and where in the job tree
 * it happened, plus the few fields the notified moments carry.
 */
export interface RunEvent {
  readonly kind: string;
  readonly ts: number;
  readonly path: readonly string[];
  /** The run's page address, on the `monitor` event. */
  readonly url?: string;
  /** The graph node, on a `dag:node` event. */
  readonly node?: string;
  /** Which end of the node this is, on a `dag:node` event. */
  readonly phase?: string;
  /** The job's name, on a `job:start` or `job:end` event. */
  readonly label?: string;
  /** The node that sent work back, on a `dag:kickback` event. */
  readonly from?: string;
  /** The node the work went back to, on a `dag:kickback` event. */
  readonly to?: string;
  /** What the reviewer said, on a `dag:kickback` event. */
  readonly reason?: string;
  /** Whether the graph honoured the request, on a `dag:kickback` event. */
  readonly accepted?: boolean;
  /** Why a kickback was refused, on a `dag:kickback` event. */
  readonly note?: string;
  /** How the moment ended, on the events that end something. */
  readonly outcome?: RunEventOutcome;
}

/** Which of the notified moments a message is about. */
export type MessageEvent =
  | 'run-started'
  | 'stage-finished'
  | 'sent-back'
  | 'paused'
  | 'finished'
  | 'failed';

/** One posted message. */
export interface WebhookMessage {
  /**
   * The one-line summary. Slack, Discord and Teams incoming webhooks all
   * render this field, so a message reads correctly in any of them.
   */
  text: string;
  /** Which moment this is, for a relay that routes on it. */
  event: MessageEvent;
  /** When the run event happened, in milliseconds since the epoch. */
  ts: number;
  /** The run's page, once the run has reported one. */
  monitor?: string;
  /** The graph node, on a stage-finished message. */
  stage?: string;
  /** The node that sent work back, on a sent-back message. */
  from?: string;
  /** The node the work went back to, on a sent-back message. */
  to?: string;
  /** What the reviewer said, on a sent-back message. */
  reason?: string;
  /** Whether the graph honoured the request, on a sent-back message. */
  accepted?: boolean;
  /** The outcome status, on the messages that have one. */
  status?: string;
  /** The outcome's own one-line summary, where it wrote one. */
  summary?: string;
}

/** The part of `fetch` this package uses. */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface WebhookNotifierOptions {
  /**
   * Where to post. The caller supplies this at run time, from its own
   * configuration or environment.
   */
  url: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /**
   * Called when a post fails. A failed notification never fails the run, so
   * without this the failure is silent by design.
   */
  onError?: (error: Error) => void;
}

export interface WebhookNotifier {
  /** Hand this to `run({ onEvent })`. */
  onEvent(event: RunEvent): void;
  /**
   * Resolves once every message this notifier started has been posted. Await
   * it after the run so the last message is not lost when the process exits.
   */
  done(): Promise<void>;
}

/** The job tree's top level, where a run's own start and end are reported. */
function atTopLevel(event: RunEvent): boolean {
  return event.path.length <= 1;
}

/**
 * How a run says it began. A graph reports `dag:start`, a loop reports
 * `loop:start` and a declarative workflow reports `workflow:start`. A
 * top-level `job:start` is a loop's body job starting another iteration, not
 * the run, so it is not one of these.
 */
const STARTING_KINDS = new Set(['workflow:start', 'dag:start', 'loop:start']);

/** The events that end something, so a terminal outcome can be read off them. */
const ENDING_KINDS = new Set(['dag:end', 'loop:end', 'job:end']);

function endingMessageEvent(status: string): MessageEvent {
  if (status === 'paused') return 'paused';
  if (status === 'pass') return 'finished';
  return 'failed';
}

/**
 * A summary with one full stop, not two. A question the person is being asked
 * already ends in its own mark, and `Paused: approve the spend?.` is a typo in
 * the one message somebody has to act on.
 */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trimEnd()) ? text.trimEnd() : `${text.trimEnd()}.`;
}

/** The run's page on its own line, for a message that asks somebody to act. */
function wayIn(monitor?: string): string {
  return monitor === undefined ? '' : `\n${monitor}`;
}

function describe(event: RunEvent): string {
  const where = event.path.join(' / ');
  return where === '' ? 'the run' : where;
}

/**
 * The message for one run event, or `undefined` when the event is not one of
 * the notified moments. Exported so the wording can be tested without a
 * server, and so a caller can see exactly what would be posted.
 */
export function messageFor(
  event: RunEvent,
  monitor?: string,
): WebhookMessage | undefined {
  const base = { ts: event.ts, ...(monitor === undefined ? {} : { monitor }) };

  if (STARTING_KINDS.has(event.kind) && atTopLevel(event)) {
    return { ...base, event: 'run-started', text: `Run started: ${describe(event)}.` };
  }

  if (event.kind === 'dag:node' && event.phase === 'done' && atTopLevel(event)) {
    const stage = event.node ?? 'a stage';
    const status = event.outcome?.status;
    const summary = event.outcome?.summary;
    // A stage that is waiting for a person has not finished. Reporting it as
    // finished is wrong in both modes, and in the mode where the run stays up
    // for the answer it is the only message that would ever be sent about the
    // wait.
    if (status === 'paused') {
      return {
        ...base,
        event: 'paused',
        stage,
        status,
        ...(summary === undefined ? {} : { summary }),
        text: `Paused: ${sentence(summary ?? stage)}${wayIn(monitor)}`,
      };
    }
    return {
      ...base,
      event: 'stage-finished',
      stage,
      ...(status === undefined ? {} : { status }),
      ...(summary === undefined ? {} : { summary }),
      text: `Stage finished: ${stage}${status === undefined ? '' : ` (${status})`}`,
    };
  }

  if (event.kind === 'dag:kickback') {
    const from = event.from ?? 'a reviewer';
    const to = event.to ?? 'an earlier stage';
    const accepted = event.accepted !== false;
    const reason = event.reason ?? '';
    // A refused request is still news: somebody asked for another pass and the
    // graph did not run one, and `note` says why.
    // The reviewer's reason is a sentence and the most valuable text in the
    // message, so it goes on its own line rather than after a full stop.
    const said = accepted ? reason : (event.note ?? reason);
    const opening = accepted
      ? `Sent back: ${from} returned work to ${to}`
      : `Sent back refused: ${from} asked ${to} for another pass`;
    const text = said === '' ? opening : `${opening}\n${said}`;
    return {
      ...base,
      event: 'sent-back',
      from,
      to,
      accepted,
      ...(reason === '' ? {} : { reason }),
      text: text.trimEnd(),
    };
  }

  if (ENDING_KINDS.has(event.kind) && atTopLevel(event) && event.outcome !== undefined) {
    const { status, summary } = event.outcome;
    const which = endingMessageEvent(status);
    const text = which === 'paused'
      ? `Paused: ${sentence(summary ?? describe(event))}${wayIn(monitor)}`
      : which === 'finished'
        ? 'Run finished.'
        : `Run failed: ${sentence(summary ?? describe(event))}`;
    return {
      ...base,
      event: which,
      status,
      ...(summary === undefined ? {} : { summary }),
      text,
    };
  }

  return undefined;
}

const TERMINAL: ReadonlySet<MessageEvent> = new Set(['finished', 'failed']);

export function webhookNotifier(options: WebhookNotifierOptions): WebhookNotifier {
  const post = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  let monitor: string | undefined;
  let started = false;
  let ended = false;
  // A stage pause and the run ending paused are the same news reported twice
  // in exit mode. The stage one arrives first and names the stage, so it wins.
  let toldAboutTheWait = false;
  // Messages are chained rather than raced, so they arrive in the order the
  // run produced them. Each link catches its own failure, so one failed post
  // never stops the next.
  let queue: Promise<void> = Promise.resolve();

  function send(message: WebhookMessage): void {
    queue = queue.then(async () => {
      const response = await post(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!response.ok) {
        throw new Error(`the webhook answered ${response.status}`);
      }
    }).catch((cause: unknown) => {
      options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    });
  }

  return {
    onEvent(event: RunEvent): void {
      if (event.kind === 'monitor' && typeof event.url === 'string') {
        monitor = event.url;
        return;
      }
      const message = messageFor(event, monitor);
      if (message === undefined) return;
      // A run starts once and ends once. A workflow reports both its own start
      // and its root job's, and a graph's end and the root job's end both
      // report the outcome, so without these a reader is told twice.
      if (message.event === 'run-started') {
        if (started) return;
        started = true;
      }
      if (message.event === 'paused') {
        const fromAStage = message.stage !== undefined;
        if (!fromAStage && toldAboutTheWait) return;
        if (fromAStage) toldAboutTheWait = true;
      }
      if (TERMINAL.has(message.event)) {
        if (ended) return;
        ended = true;
      }
      send(message);
    },
    done(): Promise<void> {
      return queue;
    },
  };
}
