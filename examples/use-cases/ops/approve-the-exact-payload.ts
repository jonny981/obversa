import { readFile } from 'node:fs/promises';

import {
  approval,
  commandJob,
  createCallbackClient,
  dag,
  formatEvent,
  run,
  type Outcome,
} from '@obversa/runtime';

/**
 * A person approves the exact bytes of a request, not a story about it.
 * The refund payload is the approval's input, so the question's digest
 * covers every byte of it, and the answer is recorded against that
 * digest. The same payload asked again finds the answer and is sent. A
 * payload that differs by one field has a different digest, finds no
 * answer, and asks again. Nothing is rebuilt after the yes: what was
 * approved is what is sent.
 */

type Refund = {
  readonly kind: 'refund';
  readonly orderId: string;
  readonly customer: string;
  readonly amount: string;
  readonly currency: string;
  readonly reason: string;
};

const paymentsUrl = process.env.PAYMENTS_URL ?? 'https://payments.example/api/refunds';
const onEvent = (event: Parameters<typeof formatEvent>[0]) => console.log(formatEvent(event));

/** The request as a run: a person's yes on these bytes, then the call with these bytes. */
function refundRun(payload: Refund) {
  return dag({
    name: 'refund',
    nodes: {
      approve: approval('approve', {
        question: `Issue this refund of ${payload.currency} ${payload.amount} on ${payload.orderId}, exactly as shown?`,
        input: payload,
      }),
      execute: {
        needs: 'approve',
        job: commandJob('execute', [
          'curl', '-sS', '-X', 'POST', paymentsUrl,
          '-H', 'content-type: application/json',
          '--data', JSON.stringify(payload),
        ]),
      },
    },
  });
}

// One callbacks client across every pass: the questions asked and the
// answers given live there, keyed by the request digest.
const callbacks = createCallbackClient();

/** The digests of every question asked so far, in the order they were asked. */
const questionsAsked = async (): Promise<string[]> => (await callbacks.history())
  .flatMap((event) => (event.kind === 'callback-requested' ? [event.request.digest] : []));

async function pass(name: string, payload: Refund) {
  const before = (await questionsAsked()).length;
  const result = await run(refundRun(payload), { callbacks, recordTo: `records/${name}.jsonl`, runId: name, onEvent });
  const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
  const asked = await questionsAsked();
  return {
    pass: name,
    outcome: result.outcome.status,
    askedANewQuestion: asked.length > before,
    digest: asked.at(-1) ?? null,
    sent: nodes.execute?.status === 'pass',
  };
}

const refund = JSON.parse(await readFile('requests/refund.json', 'utf8')) as Refund;
const changed = JSON.parse(await readFile('requests/refund-changed.json', 'utf8')) as Refund;

// Pass one: the question is asked and nobody has answered. Nothing is sent.
const asked = await pass('asked', refund);

// The person's console. In use this is a page that shows the payload and
// takes the yes; here the file plays that part so it runs offline. The
// answer is recorded against the request's digest, which covers the bytes.
const [pending] = await callbacks.listPending();
if (pending === undefined) throw new Error('the question was not asked');
const claim = await callbacks.claim(pending.requestId, 'ops-console');
if (!claim.ok) throw new Error(`the console could not claim the question: ${claim.kind}`);
const submitted = await callbacks.submit(pending.requestId, claim.claimToken, 'ops-console', pending.digest, { approved: true });
if (!submitted.ok) throw new Error(`the answer was refused: ${submitted.kind}`);

// Pass two: the same bytes. The approval finds the answer and the call goes out.
const approved = await pass('approved', refund);

// Pass three: one field differs. A new digest, no answer, the question is asked again.
const askedAgain = await pass('asked-again', changed);

console.log(JSON.stringify({
  status: 'pass',
  passes: [asked, approved, askedAgain],
  sameBytesReusedTheAnswer: !approved.askedANewQuestion && approved.sent,
  changedBytesAskedAgain: askedAgain.askedANewQuestion && askedAgain.digest !== asked.digest,
  pendingQuestions: (await callbacks.listPending()).length,
}, null, 2));
