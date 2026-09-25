/**
 * Tell somebody what the run is doing, without watching it.
 *
 * `@obversa/notify-webhook` is an `onEvent` consumer: it turns a run's own
 * events into one message each and posts them to a URL you supply. The body
 * carries a `text` field, which is the field a Slack, Discord or Teams
 * incoming webhook renders, so those three need no code of their own.
 *
 * This example runs a small graph offline whose review returns the work once,
 * so the interesting messages all appear: the run started, a stage finished,
 * a reviewer returned work with the reason, and the run finished. The URL is
 * not written down here either: the example starts its own receiver on a port
 * the operating system picks and prints what a channel would have shown. In
 * your own run, pass the address of your Slack incoming webhook instead.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { webhookNotifier, type WebhookMessage } from '@obversa/notify-webhook';
import { dag, fnJob, run, type LoopEvent } from '@obversa/runtime';

/** Stands in for the channel. In a real run this is Slack, and you own the URL. */
const delivered: WebhookMessage[] = [];
const channel = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
  request.on('end', () => {
    delivered.push(JSON.parse(body) as WebhookMessage);
    response.writeHead(200).end();
  });
});
await new Promise<void>((resolve) => { channel.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${(channel.address() as AddressInfo).port}/`;

/** The writer. In a real team this is an agent; here it gets it wrong once. */
let drafts = 0;
const draft = fnJob('draft', (ctx) => {
  drafts += 1;
  return ctx.lastReview ? `rewritten after: ${ctx.lastReview.summary}` : 'first draft';
});

/** The review. It returns the first draft with a reason, then accepts. */
const review = fnJob('review', () => (drafts === 1
  ? { status: 'fail' as const, summary: 'the second claim has no figure behind it', revision: { target: 'draft', reason: 'the second claim has no figure behind it' } }
  : { status: 'pass' as const, summary: 'both claims carry a figure' }));

const brief = dag({
  name: 'brief',
  maxKickbacks: 1,
  nodes: {
    draft: { desc: 'Write the brief.', gate: 'A draft exists.', job: draft },
    review: { needs: 'draft', desc: 'Check every claim carries a figure.', gate: 'The review returned a verdict.', job: review },
  },
});

const notifier = webhookNotifier({
  url,
  onError: (error) => { console.error(`the channel did not take a message: ${error.message}`); },
});

// The compiler checks the wiring: `run` hands a `LoopEvent` to a handler the
// notifier declared for its own `RunEvent`, so the two must stay structurally
// compatible. That catches `kind`, `ts` or `path` changing type or going
// missing. It does NOT catch a renamed event kind, because kinds are plain
// strings, nor a payload field disappearing, because every one is optional.
const onEvent: (event: LoopEvent) => void = notifier.onEvent;
const result = await run(brief, { onEvent });
// Await the posts before the process can exit, or the last message is lost.
await notifier.done();
await new Promise<void>((resolve) => { channel.close(() => { resolve(); }); });

console.log(JSON.stringify({
  run: result.outcome.status,
  drafts,
  channel: delivered.map((message) => message.text),
}, null, 2));

/**
 * Part of the documentation proof: it must fail when the behaviour it shows
 * stops happening. A notifier that posted nothing, or that stayed silent when
 * the reviewer sent work back, would otherwise print a passing run.
 */
const faults: string[] = [];
const sent = delivered.map((message) => message.event);
if (!sent.includes('run-started')) faults.push('the channel was never told the run started');
if (!sent.includes('stage-finished')) faults.push('the channel was never told a stage finished');
if (!sent.includes('sent-back')) faults.push('the channel was never told the reviewer sent work back');
if (!sent.includes('finished')) faults.push('the channel was never told the run finished');
const back = delivered.find((message) => message.event === 'sent-back');
if (back && !back.text.includes('no figure behind it')) faults.push('the sent-back message dropped the reviewer reason');
if (delivered.some((message) => message.text.trim() === '')) faults.push('a message carried no text for a channel to render');
if (drafts !== 2) faults.push(`the draft ran ${drafts} times, so the kickback did not happen`);
if (faults.length) {
  for (const fault of faults) console.error(fault);
  process.exitCode = 1;
}
