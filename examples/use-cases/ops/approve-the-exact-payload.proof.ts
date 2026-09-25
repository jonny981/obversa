import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const refund = await readFile(join(samples, 'requests/refund.json'), 'utf8');
const changed = await readFile(join(samples, 'requests/refund-changed.json'), 'utf8');

// Three passes over one callbacks client. The first asks and sends nothing.
// The person answers yes to exactly those bytes. The second pass, with the
// same bytes, finds the answer and sends. The third, with the amount
// changed, has a different digest, finds no answer, and asks again.
await withExample({
  here,
  example: 'approve-the-exact-payload',
  files: { 'requests/refund.json': refund, 'requests/refund-changed.json': changed },
  seats: {},
  commands: { curl: { output: '{"refunded":true}' } },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    passes: { pass: string; outcome: string; askedANewQuestion: boolean; digest: string | null; sent: boolean }[];
    sameBytesReusedTheAnswer: boolean;
    changedBytesAskedAgain: boolean;
    pendingQuestions: number;
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.deepEqual(printed.passes.map((entry) => [entry.pass, entry.outcome, entry.askedANewQuestion, entry.sent]), [
    ['asked', 'paused', true, false],
    ['approved', 'pass', false, true],
    ['asked-again', 'paused', true, false],
  ]);
  assert.equal(printed.sameBytesReusedTheAnswer, true, 'the same bytes find the recorded answer and are sent');
  assert.equal(printed.changedBytesAskedAgain, true, 'a changed payload has a new digest and asks again');
  assert.notEqual(printed.passes[2]?.digest, printed.passes[0]?.digest);
  assert.equal(printed.pendingQuestions, 1, 'the changed payload is the one question still waiting');

  const sends = run.commandCalls.filter((call) => call.name === 'curl');
  assert.equal(sends.length, 1, 'exactly one call reached payments');
  const sentBody = sends[0]?.args[sends[0].args.indexOf('--data') + 1] ?? '';
  assert.deepEqual(JSON.parse(sentBody), JSON.parse(refund), 'what was sent is byte-for-byte what was approved');
  assert.notEqual(JSON.parse(sentBody).amount, JSON.parse(changed).amount);
  for (const name of ['asked', 'approved', 'asked-again']) {
    assert.ok(run.exists(`records/${name}.jsonl`), `${name} has its own record`);
  }

  console.log(JSON.stringify({
    status: 'pass',
    passes: 3,
    asked: 2,
    approved: 1,
    sent: 1,
    changedPayloadSent: 0,
    mode: run.mode,
  }, null, 2));
});
