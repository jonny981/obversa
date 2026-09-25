import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const read = (path: string) => readFile(join(samples, path), 'utf8');

const files: Record<string, string> = {
  'policy.json': await read('policy.json'),
  'bets.json': await read('bets.json'),
  'checks.json': await read('checks.json'),
  'tools/check-build.mjs': await read('tools/check-build.mjs'),
};
for (const dir of ['briefs', 'requests']) {
  for (const name of (await readdir(join(samples, dir))).sort()) files[`${dir}/${name}`] = await read(`${dir}/${name}`);
}

const pitch = (id: string, title: string, problem: string, solution: string, holes: string[], noGos: string[] | null): string => [
  `# ${title}`,
  '',
  '## Problem',
  problem,
  '',
  '## Appetite',
  'Appetite: small batch',
  '',
  '## Solution',
  solution,
  '',
  '## Rabbit holes',
  ...holes.map((hole) => `- ${hole}`),
  ...(noGos ? ['', '## No-gos', ...noGos.map((noGo) => `- ${noGo}`)] : []),
  '',
].join('\n');

const pitchOne = (noGos: string[] | null) => pitch('r-1', 'Export invoices as CSV',
  'Customers want their invoices as a spreadsheet at month end and copy them one at a time today; support sees a ticket about it most weeks.',
  'One button on the invoices page that downloads every invoice in the chosen month as a CSV, one row per invoice, with the columns the invoice list already shows.',
  ['Custom column choosers.', 'Other formats: the ask is a spreadsheet, and CSV opens in one.'],
  noGos);
const pitchTwo = pitch('r-2', 'A dark theme',
  'A few customers have asked for a dark theme; none has said what it would let them do that they cannot do now.',
  'A second colour set applied by a switch in settings, using the existing colour variables.',
  ['Re-drawing every screenshot in the help pages.', 'Per-component tuning.'],
  ['A theme editor.', 'System-theme detection.']);

const view = (id: string, seat: string, stance: string, why: string) => ({
  writes: { [`table/${id}/${seat}.md`]: `${stance}\n\n${why}\n` },
  reply: pass(`${seat}: ${stance} on ${id}`),
});

// The whole cycle, offline. Shaping goes round once (the first pitch set
// has no no-gos on r-1). The table's three seats write a view on each
// pitch, the recorded checks make r-2 uncertain, so r-2 is researched; the
// person bets on r-1 and passes on r-2. The build for r-1 goes round once
// (the first change names a no-go) and the check passes the second. The
// cool-down summarises. The seats answer in the order the cycle asks.
await withExample({
  here,
  example: 'shape-up-cycle',
  files,
  seats: {
    claude: [
      { writes: { 'pitches/r-1.md': pitchOne(null), 'pitches/r-2.md': pitchTwo }, reply: pass('two pitches written') },
      { writes: { 'pitches/r-1.md': pitchOne(['A scheduled export by email.', 'Per-customer column choices.']), 'pitches/r-2.md': pitchTwo }, reply: pass('no-gos added to r-1') },
      view('r-1', 'claude', 'bet', 'The problem is concrete and recurring (a ticket most weeks), and the solution is one button over data the page already has.'),
      view('r-2', 'claude', 'pass', 'The problem section says nobody has named what the theme lets them do; the pitch itself calls that out.'),
      { writes: { 'table/r-2/research.md': 'What the table should know: the pitch\'s own problem section says no customer has named a task the theme enables. The solution reuses existing colour variables, so the cost is low, but the appetite would buy nothing measurable. Nothing in the pitch settles demand.\n' }, reply: pass('research written from the pitch') },
      { writes: { 'build/r-1/change.md': 'Built the month export: a button on the invoices page downloads a CSV of the month\'s invoices, one row each, with the list\'s columns. Also added a scheduled export by email for customers who asked.\n' }, reply: pass('change written') },
      { writes: { 'build/r-1/change.md': 'Built the month export: a button on the invoices page downloads a CSV of the month\'s invoices, one row each, with the list\'s columns. Checked by exporting three months of the demo account and opening each file in a spreadsheet.\n' }, reply: pass('the email export is out; the change stays inside the no-gos') },
      { writes: { 'build/r-1/scope.md': '- Cut: a date range picker; the export is one calendar month. Cost: two exports for a period that spans a month end.\n- Cut: currency formatting per locale; amounts are plain numbers. Cost: the spreadsheet formats them.\n' }, reply: pass('two cuts written down') },
      { writes: { 'cooldown/summary.md': '## Shipped\n- r-1: the month CSV export of invoices.\n\n## Cut\n- r-1: a date range picker; per-locale currency formatting.\n\n## Back to the pile\n- r-2: a dark theme; no customer has named what it lets them do.\n' }, reply: pass('cool-down written') },
    ],
    codex: [
      { reply: revise('r-1 has no no-gos', 'pitches/r-1.md has no No-gos heading; the shaping brief needs one') },
      { reply: pass('both pitches carry all five parts and the request\'s appetite') },
      view('r-1', 'codex', 'bet', 'The no-gos rule out the scheduled export and column choices, which is where the appetite would go; what is left fits.'),
      view('r-2', 'codex', 'needs research', 'The pitch does not say how many customers asked or what for; the table should know before betting.'),
      { reply: revise('the change names a no-go', 'build/r-1/change.md adds a scheduled export by email, which the pitch lists under No-gos') },
      { reply: pass('the change stays inside the no-gos and clear of the rabbit holes') },
    ],
    opencode: [
      view('r-1', 'opencode', 'bet', 'The solution reuses the columns the list already shows, which keeps it inside a small batch.'),
      view('r-2', 'opencode', 'pass', 'The rabbit holes are large relative to a small batch, and the problem is thin.'),
    ],
  },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    pitches: string[];
    table: Record<string, { views: { seat: string; stance: string; confidence: number | null }[]; researched: boolean; bet: string; why: string | null }>;
    built: string[];
    cooldown: string | null;
    hill: string[];
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.deepEqual(printed.pitches, ['r-1', 'r-2']);

  assert.deepEqual(printed.table['r-1']?.views.map((entry) => [entry.seat, entry.stance]), [['claude', 'bet'], ['codex', 'bet'], ['opencode', 'bet']]);
  assert.equal(printed.table['r-1']?.researched, false);
  assert.equal(printed.table['r-1']?.bet, 'bet');
  assert.deepEqual(printed.table['r-2']?.views.map((entry) => entry.stance), ['pass', 'needs-research', 'pass']);
  assert.equal(printed.table['r-2']?.researched, true, 'an uncertain check sent r-2 to research');
  assert.equal(printed.table['r-2']?.bet, 'pass');
  assert.match(printed.table['r-2']?.why ?? '', /Back to the pile/);

  assert.deepEqual(printed.built, ['r-1']);
  assert.equal(printed.cooldown, 'pass');

  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 9);
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 6);
  assert.equal(run.seatCalls.filter((call) => call.role === 'opencode').length, 2);
  assert.match(await run.read('pitches/r-1.md'), /## No-gos/);
  assert.doesNotMatch(await run.read('build/r-1/change.md'), /scheduled export/);
  assert.match(await run.read('build/r-1/scope.md'), /Cut:/);
  assert.match(await run.read('table/r-2/research.md'), /Nothing in the pitch settles demand/);
  assert.equal(run.exists('build/r-2'), false, 'the passed pitch was not built');
  assert.match(await run.read('cooldown/summary.md'), /## Shipped[\s\S]*## Cut[\s\S]*## Back to the pile/);

  assert.ok(printed.hill.some((entry) => entry.startsWith('Uphill:')) && printed.hill.some((entry) => entry.startsWith('Downhill:')), 'the hill has both sides');
  assert.ok(printed.hill.every((entry) => !entry.startsWith('unmarked')), 'every stage says which side of the hill it is on');
  assert.ok(printed.hill.some((entry) => entry.startsWith('Uphill, then downhill: build-r-1/')), 'the build stage crosses the hill');

  console.log(JSON.stringify({
    status: 'pass',
    requests: 2,
    shapingRounds: 2,
    tableSeats: 3,
    checksPerView: 1,
    researched: ['r-2'],
    bets: { 'r-1': 'bet', 'r-2': 'pass' },
    buildRounds: 2,
    built: ['r-1'],
    hillStages: printed.hill.length,
    mode: run.mode,
  }, null, 2));
});
