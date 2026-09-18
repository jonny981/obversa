import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/outreach.md'), 'utf8');
const leads = await readFile(join(samples, 'leads.csv'), 'utf8');

const email = (to: string, subject: string, text: string) =>
  ({ from: 'ines@lanternanalytics.example', to: [to], subject, text });
const payload = (...emails: ReturnType<typeof email>[]): string => `${JSON.stringify(emails, null, 2)}\n`;
const drafts = (...emails: ReturnType<typeof email>[]): string =>
  emails.map((mail) => `## To ${mail.to[0]}\n\nSubject: ${mail.subject}\n\n${mail.text}\n`).join('\n');

const firstDraft = [
  email('tom@adeyemicycles.example', 'Two shops, one stock page', 'Hi Tom, congratulations on the second shop. We build dashboards that beat any spreadsheet. Would a five-minute call suit? Ines'),
  email('priya@cornerlarder.example', 'Your weekly bestsellers', 'Hi Priya, we noticed the bestsellers list you post each week. Is it a chore to build? Ines'),
  email('sam@rouxrecords.example', 'Weekend events and sales', 'Hi Sam, saw your forum question about weekend events and sales. Would you like to see how other shops answer it? Ines'),
];
const secondDraft = [
  email('tom@adeyemicycles.example', 'Two shops, one stock page', 'Hi Tom, congratulations on the second shop. We noticed both sites share one stock page that still shows sold-out items. Is that costing you orders? Ines'),
  firstDraft[1]!,
  firstDraft[2]!,
];

// The reviewer sends the first draft back for a claim the file cannot back
// and a call asked for in the first line; the second draft passes; the run
// stops at the person, and nothing is sent until they say yes.
await withExample({
  here,
  example: 'draft-then-send',
  files: { 'briefs/outreach.md': brief, 'leads.csv': leads },
  seats: {
    claude: [
      { writes: { 'outreach/notes.md': '# Notes\n\n- Tom Adeyemi: second shop in March; one stock page across both shows sold-out items.\n- Priya Nair: hand-made weekly bestsellers post.\n- Sam Roux: asked how shops track which weekend events lift sales.\n' }, reply: pass('three notes, one per lead') },
      { writes: { 'outreach/drafts.md': drafts(...firstDraft), 'outreach/emails.json': payload(...firstDraft) }, reply: pass('three drafts written') },
      { writes: { 'outreach/drafts.md': drafts(...secondDraft), 'outreach/emails.json': payload(...secondDraft) }, reply: pass('the Adeyemi email now leads with what we noticed and asks one question') },
    ],
    codex: [
      { reply: revise('the Adeyemi email breaks the brief twice', '"beat any spreadsheet" is a claim the file cannot back', 'the first line offers a call') },
      { reply: pass('tone and claims hold against leads.csv') },
    ],
  },
  commands: { curl: { output: '{"data":[]}' } },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the run stops at the person: ${run.stdout}`);
  assert.equal(run.printed.data?.send?.status, 'paused');
  assert.match(run.printed.summary ?? '', /exactly as they stand/);
  assert.notEqual(run.printed.data?.deliver?.status, 'pass', 'nothing is delivered before the person answers');
  // The seal runs before the person, so what they are shown is frozen: the
  // approval and the delivery now name one file, and the mutable draft cannot
  // be swapped underneath them afterwards.
  // The seal is a real shell command rather than a stood-in one, so it leaves
  // its evidence on disk instead of in commandCalls: the mail API is the only
  // command stood in for, and it has not been called.
  assert.equal(run.commandCalls.length, 0, 'the mail API is never called');
  assert.equal(await run.read('outreach/approved.json'), await run.read('outreach/emails.json'), 'the frozen payload is the drafted one');
  assert.match(await run.read('outreach/approved.sha256'), /approved\.json/, 'the digest of the frozen payload is recorded beside it');
  assert.notEqual(run.printed.data?.deliver?.status, 'pass', 'delivery waits behind the person');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 3, 'research once, draft twice');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 2, 'the reviewer reads both drafts');
  const emails = JSON.parse(await run.read('outreach/emails.json')) as { text: string }[];
  assert.equal(emails.length, 3);
  assert.match(emails[0]!.text, /sold-out items/, 'the payload on disk is the repaired draft');
  assert.doesNotMatch(emails[0]!.text, /beat any spreadsheet/);
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 4,
    draftsWritten: 2,
    reviewKickbacks: 1,
    pausedAt: 'send',
    sent: 0,
    mode: run.mode,
  }, null, 2));
});
