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
// again, and the run stops at the person who confirms the exact reply.
//
// This case used to assert that the reply went out and the person was never
// asked. That expectation WAS the defect: an example that teaches confidence
// gating sent a customer an email with nobody in the loop, and its own
// changelog promised the opposite. Nothing is sent without a person now.
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
  assert.equal(run.printed.status, 'paused', `the confident ticket stops at the person: ${run.stdout}`);
  assert.equal(run.printed.data?.classify?.status, 'pass');
  assert.equal(run.printed.data?.confirm?.status, 'paused', 'the person is asked before anything is sent');
  assert.match(run.printed.summary ?? '', /Send this reply/);
  assert.equal(run.commandCalls.length, 0, 'nothing is posted while the person has not answered');
  // The run stops at `confirm`, so `escalate` is never reached at all: it
  // reports as blocked behind the pause rather than skipped by its own
  // `when`. Either way nobody is asked to handle the ticket as a problem.
  assert.notEqual(run.printed.data?.escalate?.status, 'paused', 'a confident ticket is a confirmation, not an escalation');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 2, 'the classifier decides, is sent back once, and decides again');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 2, 'the second opinion reads both decisions');
  assert.match(await run.read('triage/reply.json'), /order 118204/, 'the repaired reply is the one waiting for the person');
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
});

// Routed auto, but under the brief's 0.8 minimum. The route alone used to
// decide, so this reply went to the customer on a confidence of 0.42. The
// gate reads the number now, and an unsure decision is an escalation.
await withExample({
  here,
  example: 'support-triage',
  files: { 'briefs/support.md': brief, 'tickets/inbox.json': damagedBook },
  seats: {
    claude: [
      {
        writes: {
          'triage/decision.json': decision('T-4821', 'auto', 0.42, 'probably the damage policy, but the photo rule is unclear here'),
          'triage/reply.json': reply('T-4821', 'Sorry about the torn cover. A replacement is on its way. Harbourline Books'),
        },
        reply: pass('routed auto, but only 0.42 sure'),
      },
    ],
    codex: [{ reply: pass('the route matches the policy') }],
  },
  commands: { curl: { output: '{"accepted":true}' } },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `an unsure auto decision goes to a person: ${run.stdout}`);
  assert.equal(run.commandCalls.length, 0, 'nothing is sent below the brief\'s minimum');
  assert.equal(run.printed.data?.escalate?.status, 'paused', 'it escalates rather than confirming');
  assert.match(run.printed.data?.confirm?.summary ?? '', /^skipped/, 'it is not offered to a person as ready to send');
  assert.match(run.printed.summary ?? '', /This ticket needs you/);
});

// A decision nobody can read. A model writes this file, so it can write a
// route that is not a route. That used to match neither branch, so the run
// did nothing at all: it neither sent nor asked anyone. It escalates now.
await withExample({
  here,
  example: 'support-triage',
  files: { 'briefs/support.md': brief, 'tickets/inbox.json': damagedBook },
  seats: {
    claude: [
      {
        writes: {
          'triage/decision.json': `${JSON.stringify({ ticket: 'T-4821', route: 'sort-of', confidence: 'high', reason: 'mostly the damage policy' }, null, 2)}\n`,
          'triage/reply.json': reply('T-4821', 'Sorry about the torn cover. Harbourline Books'),
        },
        reply: pass('wrote a decision in its own shape'),
      },
    ],
    codex: [{ reply: pass('read the ticket') }],
  },
  commands: { curl: { output: '{"accepted":true}' } },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `an unreadable decision goes to a person: ${run.stdout}`);
  assert.equal(run.commandCalls.length, 0, 'nothing is sent on a decision we cannot read');
  assert.equal(run.printed.data?.escalate?.status, 'paused', 'the unknown route escalates rather than doing nothing');
  assert.match(run.printed.summary ?? '', /This ticket needs you/);
});

// The file is not JSON at all. Without the guard around the parse, the `when`
// that reads it THROWS, and a stage that throws is a different failure from a
// ticket going to a person: it is a broken run rather than a cautious one.
await withExample({
  here,
  example: 'support-triage',
  files: { 'briefs/support.md': brief, 'tickets/inbox.json': damagedBook },
  seats: {
    claude: [
      {
        writes: {
          'triage/decision.json': 'route: auto, confidence: high\n',
          'triage/reply.json': reply('T-4821', 'Sorry about the torn cover. Harbourline Books'),
        },
        reply: pass('wrote the decision as prose instead of JSON'),
      },
    ],
    codex: [{ reply: pass('read the ticket') }],
  },
  commands: { curl: { output: '{"accepted":true}' } },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `an unparseable decision goes to a person: ${run.stdout}`);
  assert.equal(run.commandCalls.length, 0, 'nothing is sent on a decision that is not even JSON');
  assert.equal(run.printed.data?.escalate?.status, 'paused', 'it escalates rather than failing the run');

  console.log(JSON.stringify({
    status: 'pass',
    runs: 5,
    confident: { route: 'auto', secondOpinionKickbacks: 1, sent: 0, pausedAt: 'confirm' },
    unsure: { route: 'escalate', sent: 0, pausedAt: 'escalate' },
    lowConfidence: { route: 'auto', confidence: 0.42, sent: 0, pausedAt: 'escalate' },
    unreadable: { route: 'sort-of', sent: 0, pausedAt: 'escalate' },
    notJson: { sent: 0, pausedAt: 'escalate' },
    mode: run.mode,
  }, null, 2));
});
