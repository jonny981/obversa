import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/support.md'), 'utf8');
const damagedBook = await readFile(join(samples, 'tickets/inbox.json'), 'utf8');

const decision = (ticket: string, route: 'auto' | 'escalate', confidence: number, reason: string): string =>
  `${JSON.stringify({ ticket, route, confidence, reason }, null, 2)}\n`;
const reply = (ticket: string, body: string): string => `${JSON.stringify({ ticket, body }, null, 2)}\n`;

// A confident ticket: the second opinion sends the first decision back once
// (a replacement needs the order number checked), the classifier decides
// again, the reply goes out by command, and the person is never asked.
await withExample({
  here,
  example: 'support-triage',
  files: { 'briefs/support.md': brief, 'tickets/inbox.json': damagedBook },
  seats: {
    claude: [
      {
        writes: {
          'triage/decision.json': decision('T-4821', 'auto', 0.97, 'damaged on arrival, replaced under the policy'),
          'triage/reply.json': reply('T-4821', 'Sorry about the torn cover. A replacement is on its way; keep the damaged copy. Harbourline Books'),
        },
        reply: pass('routed auto: a damaged book is replaced under the policy'),
      },
      {
        writes: {
          'triage/decision.json': decision('T-4821', 'auto', 0.91, 'damaged on arrival with an order number, replaced under the policy'),
          'triage/reply.json': reply('T-4821', 'Sorry about the torn cover. Could you send a photo of the damage? A replacement for order 118204 goes out as soon as it arrives, and you can keep the damaged copy. Harbourline Books'),
        },
        reply: pass('routed auto: the reply now asks for the photo the policy needs and names the order'),
      },
    ],
    codex: [
      { reply: revise('the policy asks for a photo before a replacement and the reply does not', 'no photo requested; the order number 118204 in the ticket is not in the reply') },
      { reply: pass('route and confidence agree with the policy') },
    ],
  },
  commands: { curl: { output: '{"accepted":true}' } },
}, async (run) => {
  assert.equal(run.printed.status, 'pass', `the confident ticket completes: ${run.stdout}`);
  assert.equal(run.printed.data?.classify?.status, 'pass');
  assert.equal(run.printed.data?.['auto-reply']?.status, 'pass');
  assert.match(run.printed.data?.escalate?.summary ?? '', /^skipped/, 'the person is not asked about a confident ticket');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 2, 'the classifier decides, is sent back once, and decides again');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 2, 'the second opinion reads both decisions');
  assert.equal(run.commandCalls.length, 1, 'the reply is posted once');
  assert.deepEqual(run.commandCalls[0]?.args.slice(-2), ['--data-binary', '@triage/reply.json'], 'the exact payload file is what goes out');
  assert.match(await run.read('triage/reply.json'), /order 118204/, 'the repaired reply is the one on disk');
  assert.match(run.stdout, /engine:usage|tok/, 'the run prints its usage lines');
});

// An unsure ticket: the route is escalate, the command never runs, and the
// run pauses with the question to the person on the record.
const missingOrder = JSON.stringify({
  id: 'T-4822',
  from: 'p.marsh@example.com',
  subject: 'Order 118377 never arrived',
  body: 'It has been twelve working days and my order has not arrived. If this is not sorted by Friday I will ask my bank for a chargeback.',
}, null, 2);

await withExample({
  here,
  example: 'support-triage',
  files: { 'briefs/support.md': brief, 'tickets/inbox.json': missingOrder },
  seats: {
    claude: [
      {
        writes: {
          'triage/decision.json': decision('T-4822', 'escalate', 0.35, 'an order missing after ten working days and a chargeback mention both go to a person'),
          'triage/reply.json': reply('T-4822', 'Sorry your order has not arrived. We are looking into where it is now and will come back to you today. Harbourline Books'),
        },
        reply: pass('routed escalate: a missing order past ten days goes to a person'),
      },
    ],
    codex: [{ reply: pass('escalate is right: the policy names this case') }],
  },
  commands: { curl: { output: '{"accepted":true}' } },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the unsure ticket pauses for a person: ${run.stdout}`);
  assert.match(run.printed.data?.['auto-reply']?.summary ?? '', /^skipped/, 'nothing is sent for an unsure ticket');
  assert.equal(run.printed.data?.escalate?.status, 'paused');
  assert.match(run.printed.summary ?? '', /This ticket needs you/);
  assert.equal(run.commandCalls.length, 0, 'the helpdesk is never called');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 1, 'the classifier decides once');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 1, 'the second opinion agrees first time');
  assert.match(await run.read('triage/reply.json'), /looking into where it is/, 'the draft is ready for the person');

  console.log(JSON.stringify({
    status: 'pass',
    runs: 2,
    confident: { route: 'auto', secondOpinionKickbacks: 1, sent: 1, asked: 0 },
    unsure: { route: 'escalate', sent: 0, pausedAt: 'escalate' },
    mode: run.mode,
  }, null, 2));
});
