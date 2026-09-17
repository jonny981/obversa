import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/friction.md'), 'utf8');

const rows = JSON.stringify({
  columns: ['event', 'url', 'n'],
  results: [
    ['$rageclick', '/invoices/new', 41],
    ['form_error', '/invoices/new', 37],
    ['$exception', '/export', 12],
    ['$exception', '/invoices', 9],
    ['$rageclick', '/settings/billing', 3],
  ],
});

const frictionsTwo = '# Frictions\n\n## New invoice form fights back\n\nPages: /invoices/new. Count: 78 (41 rage clicks, 37 form errors).\n\n## Export throws\n\nPages: /export. Count: 12 exceptions.\n';
const frictionsThree = `${frictionsTwo}\n## Invoice list throws\n\nPages: /invoices. Count: 9 exceptions.\n`;
const tickets = '# Tickets\n\n## New invoice form: submit fails and users hammer the button\n\nEvidence: 37 form_error and 41 $rageclick on /invoices/new in seven days. First suspect: the client-side validation on the due date field.\n\n## Export page throws\n\nEvidence: 12 $exception on /export. First suspect: the yearly export for accounts over 2,000 invoices.\n\n## Invoice list throws\n\nEvidence: 9 $exception on /invoices. First suspect: a null customer on archived invoices.\n';

// The pull is a recorded command that writes the rows; the reviewer sends
// the first grouping back for a dropped exception; the tickets are written
// and the run stops at the person, before anything is filed.
await withExample({
  here,
  example: 'watch-signals-then-file',
  files: { 'briefs/friction.md': brief },
  seats: {
    claude: [
      { writes: { 'signals/frictions.md': frictionsTwo }, reply: pass('two frictions from five rows') },
      { writes: { 'signals/frictions.md': frictionsThree }, reply: pass('three frictions; the /invoices exceptions are their own') },
      { writes: { 'signals/tickets.md': tickets }, reply: pass('three tickets with evidence') },
    ],
    codex: [
      { reply: revise('a row of exceptions was dropped', 'the 9 $exception rows on /invoices are in no friction; the brief keeps every exception') },
      { reply: pass('every row over the threshold is in a friction') },
      { reply: pass('every ticket carries its evidence') },
    ],
  },
  commands: { curl: { output: rows }, gh: { output: 'https://github.com/your-org/your-app/issues/1\n' } },
  env: { POSTHOG_API_KEY: 'stand-in-key' },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the run stops at the person: ${run.stdout}`);
  assert.equal(run.printed.data?.pull?.status, 'pass');
  assert.equal(run.printed.data?.decide?.status, 'paused');
  assert.match(run.printed.summary ?? '', /File these as issues/);
  const pulls = run.commandCalls.filter((call) => call.name === 'curl');
  assert.equal(pulls.length, 1, 'PostHog is asked once');
  assert.ok(pulls[0]?.args.some((arg) => arg.endsWith('/api/projects/12345/query/')), 'the query goes to the project endpoint');
  assert.ok(pulls[0]?.args.includes('Authorization: Bearer stand-in-key'), 'the key comes from the environment');
  assert.equal(run.commandCalls.filter((call) => call.name === 'gh').length, 0, 'nothing is filed before the person answers');
  assert.match(await run.read('signals/events.json'), /\$rageclick/, 'the rows are in the workspace');
  assert.match(await run.read('signals/frictions.md'), /Invoice list throws/, 'the repaired grouping is on disk');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 3, 'cluster twice, draft once');
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 5,
    rowsPulled: 5,
    frictions: 3,
    reviewKickbacks: 1,
    pausedAt: 'decide',
    filed: 0,
    mode: run.mode,
  }, null, 2));
});
