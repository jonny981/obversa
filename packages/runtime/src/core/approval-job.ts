/**
 * A person's decision as a job. The step asks one question through the run's
 * callbacks client and does one of three things: passes when the answer is
 * yes, sends the work back (or fails) with the person's note when it is no,
 * and pauses the run with the request pending when nobody has answered yet.
 * A run started again with the same client, or the stored client over the
 * same store, finds the answer and carries on.
 */

import type { CallbackEvent } from '../callback/client.js';
import { createCallbackGate, type CallbackRequest } from '../callback/gate.js';
import type { JsonObject, JsonValue } from '../graph/value.js';
import { setMeta } from './describe.js';
import { LoopError } from './errors.js';
import { redactSecrets } from './redact.js';
import type { Job, JobContext, Outcome, RunCallbacks } from './types.js';

/** The answer a person gives: yes or no, and a note when there is one. */
export interface ApprovalAnswer {
  readonly approved: boolean;
  readonly note?: string;
}

export interface ApprovalOptions {
  /** The question, in plain words. */
  question: string;
  /**
   * What the question is about. Default: the outcomes this step depends on
   * (their summaries), so a change upstream after a kickback is a new
   * question, and the same question about the same thing is the same request.
   */
  input?: JsonValue;
  /**
   * The node that owns the fix when the person says no: the note goes back
   * there as the finding. Without it a refusal fails the step with the note
   * as its summary.
   */
  target?: string;
  /**
   * Answer in-process (a test, an example, a script that decides). Without
   * it the step pauses the run with the request pending on the run's
   * callbacks client until a router answers it there.
   */
  answer?: (request: CallbackRequest) => ApprovalAnswer | Promise<ApprovalAnswer>;
}

const RESPONSE_SCHEMA: JsonObject = {
  type: 'object',
  properties: { approved: { type: 'boolean' }, note: { type: 'string' } },
  required: ['approved'],
};

function aboutOf(ctx: JobContext): JsonValue {
  if (ctx.needs !== undefined) {
    return Object.fromEntries(
      Object.entries(ctx.needs).map(([name, outcome]) => [name, outcome.summary ?? outcome.status]),
    );
  }
  return ctx.lastOutcome?.summary ?? null;
}

/** The submitted response, already checked against the schema by the client. */
function toAnswer(response: JsonValue): ApprovalAnswer {
  const record = response !== null && typeof response === 'object' && !Array.isArray(response)
    ? (response as JsonObject)
    : undefined;
  if (record === undefined || typeof record.approved !== 'boolean') {
    throw new LoopError({ code: 'VALIDATION', message: 'an approval answer needs a boolean "approved"' });
  }
  return {
    approved: record.approved,
    ...(typeof record.note === 'string' ? { note: record.note } : {}),
  };
}

type RequestState = 'absent' | 'pending' | 'claimed' | 'answered' | 'superseded';

/** Fold a request's history into its state and its answer, when it has one. */
function stateOf(events: readonly CallbackEvent[]): { state: RequestState; answer?: ApprovalAnswer } {
  let state: RequestState = 'absent';
  let answer: ApprovalAnswer | undefined;
  for (const event of events) {
    switch (event.kind) {
      case 'callback-requested': state = 'pending'; break;
      case 'callback-claimed': state = 'claimed'; break;
      case 'callback-released': state = 'pending'; break;
      case 'callback-submitted': state = 'answered'; answer = toAnswer(event.response); break;
      case 'callback-superseded': state = 'superseded'; break;
      case 'callback-rejected': break;
    }
  }
  return answer === undefined ? { state } : { state, answer };
}

export function approval(label: string, opts: ApprovalOptions): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label, timeoutMs: ctx.timeoutMs });
    let outcome: Outcome;
    try {
      outcome = await decide(ctx, label, opts);
    } catch (e) {
      const error = LoopError.from(e, { code: 'BODY', phase: 'body', path: ctx.path, iteration: ctx.iteration });
      outcome = { status: 'fail', summary: error.message, error };
      ctx.emit({ kind: 'error', ts: Date.now(), path, message: error.message, code: error.code });
    }
    ctx.emit({ kind: 'job:end', ts: Date.now(), path, label, outcome });
    return outcome;
  };
  return setMeta(job, {
    kind: 'approval',
    name: label,
    question: opts.question,
    ...(opts.target !== undefined ? { target: opts.target } : {}),
  });
}

async function decide(ctx: JobContext, label: string, opts: ApprovalOptions): Promise<Outcome> {
  const client: RunCallbacks | undefined = ctx.callbacks;
  if (client === undefined) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `approval "${label}" needs the run's callbacks client; run it through run()`,
    });
  }
  const request = createCallbackGate({
    gateId: label,
    gateVersion: 1,
    decisionText: opts.question,
    responseSchema: RESPONSE_SCHEMA,
    input: opts.input ?? aboutOf(ctx),
  });
  let { state, answer } = stateOf(await client.history(request.requestId));
  if (answer === undefined) {
    // The newest post is the live question: it re-opens this request if an
    // earlier question superseded it, and supersedes the others.
    await client.post(request);
    ({ state, answer } = stateOf(await client.history(request.requestId)));
    if (answer === undefined && state !== 'pending' && state !== 'claimed') {
      return {
        status: 'fail',
        summary: `the question "${opts.question}" is not pending and not answered after it was asked (${state}); nobody can answer it`,
        data: request,
      };
    }
  }
  if (answer === undefined && opts.answer !== undefined) {
    answer = await answerInProcess(client, request, `${label}:answer`, opts.answer);
  }
  if (answer === undefined) {
    return { status: 'paused', summary: `waiting for a person: ${opts.question}`, data: request };
  }
  if (answer.approved) {
    const accepted: ApprovalAnswer = {
      approved: true,
      ...(typeof answer.note === 'string' && answer.note !== '' ? { note: redactSecrets(answer.note) } : {}),
    };
    return { status: 'pass', summary: `approved: ${opts.question}`, data: accepted };
  }
  const note = typeof answer.note === 'string' && answer.note !== ''
    ? redactSecrets(answer.note)
    : `refused: ${opts.question}`;
  const scrubbed: ApprovalAnswer = { approved: false, note };
  if (opts.target === undefined) {
    return { status: 'fail', summary: note, data: scrubbed };
  }
  // The public `RevisionRequest` shape, built here for the same reason
  // `gateJob` builds its own: feedback.ts imports the condition module.
  return {
    status: 'fail',
    summary: note,
    data: scrubbed,
    revision: {
      target: opts.target,
      reason: note,
      findings: [{ evidence: note, severity: 'block' }],
      rerun: 'target-and-dependents',
    },
  };
}

/** Claim the question for the in-process responder, ask it, and submit its answer. */
async function answerInProcess(
  client: RunCallbacks,
  request: CallbackRequest,
  routerId: string,
  respond: NonNullable<ApprovalOptions['answer']>,
): Promise<ApprovalAnswer> {
  const claim = await client.claim(request.requestId, routerId);
  if (!claim.ok) {
    throw new LoopError({
      code: 'VALIDATION',
      message: `the question "${request.decisionText}" could not be claimed to answer it (${claim.kind})`,
    });
  }
  // The claim is durable: a throw or a refused answer gives it back, as
  // `directRouter` does, so the question stays answerable on the next run.
  let response: ApprovalAnswer;
  try {
    response = await respond(request);
  } catch (error) {
    await client.release(request.requestId, claim.claimToken);
    throw error;
  }
  const submitted = await client.submit(
    request.requestId,
    claim.claimToken,
    routerId,
    request.digest,
    response as unknown as JsonObject,
  );
  if (!submitted.ok) {
    await client.release(request.requestId, claim.claimToken);
    throw new LoopError({
      code: 'VALIDATION',
      message: `the answer to "${request.decisionText}" was refused: ${submitted.reason}`,
    });
  }
  return toAnswer(submitted.response);
}
