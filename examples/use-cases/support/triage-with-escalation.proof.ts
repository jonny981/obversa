import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);

const classify = (kind: string, confidence: number, reason: string): string => JSON.stringify({ kind, confidence, reason });
const draft = (id: string, text: string) => ({ writes: { [`replies/${id}.md`]: `${text}\n\nThe support team\n` }, reply: pass(`reply drafted to replies/${id}.md`) });

// Four tickets. The first is routine and the seat is sure, so it is
// answered. The second is routine but the seat is not sure enough under
// the policy, the third needs a person, and the fourth's classification
// is not JSON at all; those three stop on a question with a draft beside
// them. The seat is asked twice per ticket: classify, then draft.
await withExample({
  here,
  example: 'triage-with-escalation',
  files: {
    'briefs/support.md': await readFile(join(samples, 'briefs/support.md'), 'utf8'),
    'help/password-reset.md': await readFile(join(samples, 'help/password-reset.md'), 'utf8'),
    'help/export.md': await readFile(join(samples, 'help/export.md'), 'utf8'),
    'tickets/inbox.json': await readFile(join(samples, 'tickets/inbox.json'), 'utf8'),
    'policy.json': await readFile(join(samples, 'policy.json'), 'utf8'),
  },
  seats: {
    claude: [
      { reply: classify('routine', 0.93, 'a password reset; the answer is in help/password-reset.md') },
      draft('t-101', 'Sorry the link did not arrive. Open Settings, choose Security, then Reset password; a new link arrives by email within a few minutes and is valid for one hour. If it still does not arrive, check your spam folder and reply here.'),
      { reply: classify('routine', 0.55, 'the export page answers the format but not the spreadsheet question') },
      draft('t-102', 'The export is a zip of CSV files, one per table. Open Settings, choose Data, then Export, and the download link arrives by email. Each CSV opens as its own sheet in a spreadsheet.'),
      { reply: classify('needs-a-person', 0.97, 'a double charge and a refund demand; money and an angry customer') },
      draft('t-103', 'I am sorry to see two charges on your card this month. I have passed this to a colleague who can look at the account and the charges directly, and they will reply here.'),
      { reply: 'This one is about pricing tiers, which help/ does not cover, so a person should answer it.' },
      draft('t-104', 'Thanks for asking about seats. A colleague who handles team plans will reply here with the options for twelve people and yearly billing.'),
    ],
  },
  commands: { curl: { output: '{"sent":true}' } },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    tickets: { ticket: string; kind: string; confidence: number | null; route: string; outcome: string }[];
    answered: number;
    forAPerson: number;
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.deepEqual(printed.tickets.map((entry) => [entry.ticket, entry.kind, entry.route, entry.outcome]), [
    ['t-101', 'routine', 'reply', 'pass'],
    ['t-102', 'routine', 'person', 'paused'],
    ['t-103', 'needs-a-person', 'person', 'paused'],
    ['t-104', 'unreadable', 'person', 'paused'],
  ]);
  assert.deepEqual([printed.answered, printed.forAPerson], [1, 3]);

  assert.equal(run.seatCalls.length, 8, 'classify and draft, per ticket');
  const sends = run.commandCalls.filter((call) => call.name === 'curl');
  assert.equal(sends.length, 1, 'one reply reached the helpdesk');
  assert.ok(sends[0]?.args.some((arg) => arg.endsWith('/t-101/reply')), 'the routine ticket is the one answered');

  for (const id of ['t-101', 't-102', 't-103', 't-104']) {
    assert.match(await run.read(`replies/${id}.md`), /The support team/, `${id} has a draft`);
    assert.ok(run.exists(`records/${id}.jsonl`), `${id} has its own record`);
  }
  assert.match(await run.read('history/answered.jsonl'), /t-101/);
  const forAPerson = await run.read('history/for-a-person.jsonl');
  assert.match(forAPerson, /t-102/);
  assert.match(forAPerson, /t-103/);
  assert.match(forAPerson, /t-104.*not JSON/);

  console.log(JSON.stringify({
    status: 'pass',
    tickets: 4,
    classified: 4,
    drafted: 4,
    answered: 1,
    forAPerson: 3,
    unreadableClassifications: 1,
    mode: run.mode,
  }, null, 2));
});
