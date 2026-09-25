import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);

const notes = {
  brightwater: 'Hi Sam,\n\nYou asked at the harbour meetup whether our review step works on notebooks. It does, and I would like to show your team a five-minute run.\n\nWould a short call next week suit?\n\nPriya, Alder & Finch partnerships\n',
  carraway: 'Hi Lena,\n\nThanks for the reply to the newsletter. You wanted to see the person-in-the-loop step before showing your team, and I can walk you through it, ideally before the end of the month so it lands ahead of your planning round.\n\nShall I send over a few times?\n\nPriya, Alder & Finch partnerships\n',
  dunmore: 'Hi Theo,\n\nOur mutual contact mentioned you care about the record: who approved what and when. Every run keeps that as a plain file, and I would like to show you one.\n\nIs that worth twenty minutes?\n\nPriya, Alder & Finch partnerships\n',
};

// Three warm contacts, three drafts, three decisions. The person approved
// the first, refused the second with a note, and has not decided on the
// third, so one note is sent, one is refused on the record, and one run
// waits on its question.
await withExample({
  here,
  example: 'draft-then-send',
  files: {
    'briefs/outreach.md': await readFile(join(samples, 'briefs/outreach.md'), 'utf8'),
    'contacts/list.json': await readFile(join(samples, 'contacts/list.json'), 'utf8'),
    'decisions.json': await readFile(join(samples, 'decisions.json'), 'utf8'),
  },
  seats: {
    claude: [
      { writes: { 'outbox/brightwater.md': notes.brightwater }, reply: pass('draft written to outbox/brightwater.md') },
      { writes: { 'outbox/carraway.md': notes.carraway }, reply: pass('draft written to outbox/carraway.md') },
      { writes: { 'outbox/dunmore.md': notes.dunmore }, reply: pass('draft written to outbox/dunmore.md') },
    ],
  },
  commands: { curl: { output: '{"queued":true}' } },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    contacts: { contact: string; outcome: string; sent: boolean; note: string | null }[];
    sent: number;
    refused: number;
    waiting: number;
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.deepEqual(printed.contacts.map((entry) => [entry.contact, entry.outcome, entry.sent]), [
    ['brightwater', 'pass', true],
    ['carraway', 'fail', false],
    ['dunmore', 'paused', false],
  ]);
  assert.match(printed.contacts[1]?.note ?? '', /Too long/);
  assert.deepEqual([printed.sent, printed.refused, printed.waiting], [1, 1, 1]);

  assert.equal(run.seatCalls.length, 3, 'one draft per contact');
  const sends = run.commandCalls.filter((call) => call.name === 'curl');
  assert.equal(sends.length, 1, 'exactly one note went to the CRM');
  assert.ok(sends[0]?.args.includes('@outbox/brightwater.md'), 'the approved draft is the one sent');

  assert.match(await run.read('history/sent.jsonl'), /brightwater/);
  assert.match(await run.read('history/refused.jsonl'), /carraway.*Too long/);
  assert.match(await run.read('history/waiting.jsonl'), /dunmore/);
  for (const id of ['brightwater', 'carraway', 'dunmore']) {
    assert.ok(run.exists(`records/${id}.jsonl`), `${id} has its own record`);
    assert.match(await run.read(`outbox/${id}.md`), /Priya/, `${id}'s draft is on disk`);
  }

  console.log(JSON.stringify({
    status: 'pass',
    contacts: 3,
    drafted: 3,
    sent: 1,
    refused: 1,
    waiting: 1,
    mode: run.mode,
  }, null, 2));
});
