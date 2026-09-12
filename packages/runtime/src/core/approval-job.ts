/**
 * A person's decision as a job. The step asks one question through the run's
 * callbacks client and does one of three things: passes when the answer is
 * yes, sends the work back (or fails) with the person's note when it is no,
 * and pauses the run with the request pending when nobody has answered yet.
 * A run started again with the same client finds the answer and carries on.
 */

import { directRouter } from '../callback/client.js';
import { createCallbackGate, type CallbackRequest } from '../callback/gate.js';
import type { JsonObject, JsonValue } from '../graph/value.js';
import { setMeta } from './describe.js';
import { LoopError } from './errors.js';
import type { Job, JobContext, Outcome } from './types.js';

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

function answerTo(ctx: JobContext, requestId: string): ApprovalAnswer | undefined {
  const events = ctx.callbacks!.history(requestId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'callback-submitted') return toAnswer(event.response);
  }
  return undefined;
}

export function approval(label: string, opts: ApprovalOptions): Job {
  const job: Job = async (ctx) => {
    const path = [...ctx.path];
    ctx.emit({ kind: 'job:start', ts: Date.now(), path, label, timeoutMs: ctx.timeoutMs });
    const outcome = await decide(ctx, label, opts);
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
  const client = ctx.callbacks;
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
  let answer = answerTo(ctx, request.requestId);
  if (answer === undefined) {
    client.post(request);
    if (opts.answer === undefined) {
      return { status: 'paused', summary: `waiting for a person: ${opts.question}`, data: request };
    }
    const respond = opts.answer;
    const submitted = await directRouter(
      client,
      request,
      `${label}:answer`,
      async (asked) => (await respond(asked)) as unknown as JsonObject,
    );
    if (!submitted.ok) {
      return { status: 'fail', summary: `the answer to "${opts.question}" was refused: ${submitted.reason}` };
    }
    answer = toAnswer(submitted.response);
  }
  if (answer.approved) {
    return { status: 'pass', summary: `approved: ${opts.question}`, data: answer };
  }
  const note = typeof answer.note === 'string' && answer.note !== '' ? answer.note : `refused: ${opts.question}`;
  if (opts.target === undefined) {
    return { status: 'fail', summary: note, data: answer };
  }
  // The public `RevisionRequest` shape, built here for the same reason
  // `gateJob` builds its own: feedback.ts imports the condition module.
  return {
    status: 'fail',
    summary: note,
    data: answer,
    revision: {
      target: opts.target,
      reason: note,
      findings: [{ evidence: note, severity: 'block' }],
      rerun: 'target-and-dependents',
    },
  };
}
