import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const read = (path: string) => readFile(join(samples, path), 'utf8');

const chaser = (id: string, body: string) => ({
  writes: { [`chase/${id}.md`]: `${body}\n\nIf anything about this invoice looks wrong, reply here or call the accounts line.\n\nAccounts, Northlight Joinery\n` },
  reply: pass(`chaser drafted to chase/${id}.md`),
});

// Five invoices in the ledger as of the fixture's date: one paid, one not
// yet due, three overdue. The command finds the three. Two are chased
// through the mailer; the disputed one stops on a question for a person
// with its draft beside it. Nobody is offered a waiver by a model.
await withExample({
  here,
  example: 'invoice-chase',
  files: {
    'briefs/chase.md': await read('briefs/chase.md'),
    'ledger/invoices.json': await read('ledger/invoices.json'),
    'tools/overdue.mjs': await read('tools/overdue.mjs'),
  },
  seats: {
    claude: [
      chaser('inv-2002', 'Hello Ostrava Kitchens,\n\nInvoice inv-2002 for EUR 4380.00 was due on 2030-03-19 and is 12 days overdue. Could you let us know when it will be paid?'),
      chaser('inv-2003', 'Hello Bellweather Fit-Out,\n\nInvoice inv-2003 for EUR 9150.00 was due on 2030-02-19 and is 40 days overdue. We understand the delivered quantity is in question; a colleague will be in touch about that.'),
      chaser('inv-2004', 'Hello Pinecrest Studios,\n\nInvoice inv-2004 for EUR 760.00 was due on 2030-03-28 and is 3 days overdue. Could you let us know when it will be paid?'),
    ],
  },
  commands: { curl: { output: '{"sent":true}' } },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    overdue: string[];
    chased: string[];
    forAPerson: string[];
    invoices: { invoice: string; daysOverdue: number; disputed: boolean; outcome: string; sent: boolean }[];
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.deepEqual(printed.overdue, ['inv-2002', 'inv-2003', 'inv-2004']);
  assert.deepEqual(printed.chased, ['inv-2002', 'inv-2004']);
  assert.deepEqual(printed.forAPerson, ['inv-2003']);
  assert.deepEqual(printed.invoices.map((entry) => [entry.invoice, entry.daysOverdue, entry.disputed, entry.outcome]), [
    ['inv-2002', 12, false, 'pass'],
    ['inv-2003', 40, true, 'paused'],
    ['inv-2004', 3, false, 'pass'],
  ]);

  assert.equal(run.seatCalls.length, 3, 'one draft per overdue invoice');
  const sends = run.commandCalls.filter((call) => call.name === 'curl');
  assert.equal(sends.length, 2, 'two chasers went to the mailer');
  assert.ok(sends.every((call) => !call.args.includes('@chase/inv-2003.md')), 'the disputed invoice was not chased');

  assert.match(await run.read('chase/overdue.json'), /inv-2003/);
  assert.match(await run.read('chase/inv-2003.md'), /Northlight/);
  assert.match(await run.read('history/chased.jsonl'), /inv-2002[\s\S]*inv-2004/);
  assert.match(await run.read('history/for-a-person.jsonl'), /inv-2003.*twelve units/);
  for (const id of ['read-ledger', 'inv-2002', 'inv-2003', 'inv-2004']) {
    assert.ok(run.exists(`records/${id}.jsonl`), `${id} has its own record`);
  }

  console.log(JSON.stringify({
    status: 'pass',
    invoices: 5,
    overdue: 3,
    drafted: 3,
    chased: 2,
    forAPerson: 1,
    mode: run.mode,
  }, null, 2));
});
