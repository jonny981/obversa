import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, recordEvents, revise, shouldFix, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const brief = await readFile(join(samples, 'briefs/playbook.md'), 'utf8');
const contract = await readFile(join(samples, 'contracts/msa.md'), 'utf8');
const judgeJson = await readFile(join(samples, 'judge.json'), 'utf8');

const clauses = [
  '1. Term: push back (auto-renewal; 30-day notice)',
  '2. Fees: push back (14 days; unilateral increases)',
  '3. Liability: push back (three months of fees)',
  '4. Indemnity: never (uncapped, one-sided)',
  '5. Data: push back (processing beyond our instructions)',
  '6. Exclusivity: never',
  '7. Governing law: accept',
  '',
].join('\n');

const redlinesMissingTwo = [
  '## Clause 1',
  'Current: renews automatically ... 30 days notice.',
  'Replacement: renewal by written agreement; either party may end the agreement at the end of a term on 60 days written notice.',
  '## Clause 2',
  'Current: within 14 days ... change the fees at any time on 30 days notice.',
  'Replacement: within 30 days of invoice; fees change at most once a year, by no more than 5% or CPI, whichever is lower, on 90 days written notice.',
  '## Clause 3',
  'Current: limited to the fees paid in the three months before the claim.',
  'Replacement: limited to the fees paid in the twelve months before the claim.',
  '## Clause 5',
  'Current: as reasonably required to provide the services and to improve them.',
  'Replacement: only on the Customer\'s written instructions, and deleted within 30 days of the end of the agreement.',
  '',
].join('\n');

const redlinesComplete = `${redlinesMissingTwo}## Clause 4
Current: the Customer indemnifies the Supplier against all claims.
Replacement: struck; an uncapped indemnity is never signed. Offer a mutual indemnity capped at clause 3 if the Supplier insists on one.
## Clause 6
Current: exclusively from the Supplier during the term.
Replacement: struck; exclusivity of any kind is never signed.
`;

// The checker sends the redlines back once: two never-sign clauses had no
// redline, two blocks the judge acts on. On the second set the
// checker has only a taste note, and the judge stops the loop; the
// positions note follows and is checked in its turn, and the run waits for
// the lawyer, who answers on the run's page. The note is reviewed because deciding what to concede is the most
// judgement-heavy step here; it used to be the only unreviewed one.
await withExample({
  here,
  example: 'contract-playbook',
  files: { 'briefs/playbook.md': brief, 'contracts/msa.md': contract, 'judge.json': judgeJson },
  answer: { approved: true },
  seats: {
    claude: [
      { writes: { 'review/clauses.md': clauses }, reply: pass('seven clauses mapped: one accept, four push back, two never') },
      { writes: { 'review/redlines.md': redlinesMissingTwo }, reply: pass('four redlines written from the playbook wording') },
      { writes: { 'review/redlines.md': redlinesComplete }, reply: pass('six redlines: the two never-sign clauses are struck with a fallback offered on the indemnity') },
      { writes: { 'review/positions.md': '# Positions\n\n- Hold: clauses 4 and 6 struck (walk-away).\n- Hold: liability at twelve months (clause 3).\n- Concede: notice period 60 -> 45 days on clause 1 if pressed.\n- Concede: payment terms 30 -> 21 days on clause 2 if the price cap holds.\n' }, reply: pass('positions written: two walk-aways, two concessions') },
    ],
    codex: [
      { reply: revise('two never-sign clauses have no redline', 'clause 4 (uncapped indemnity) is marked never in clauses.md and absent from redlines.md', 'clause 6 (exclusivity) is marked never and absent') },
      { reply: shouldFix('one redline could be tighter', 'clause 3: the fallback sentence on the liability redline could go; the twelve-month term already meets the rule') },
      { reply: pass('every redline has a position, and the two walk-aways match the never-sign rules') },
    ],
  },
}, async (run) => {
  assert.match(run.stdout, /http:\/\/127\.0\.0\.1:\d+\//, 'the run prints the page to answer on');
  assert.equal(run.question, 'Send these redlines to the other side?', 'the page shows the lawyer the question');
  assert.equal(run.printed.status, 'pass', `the lawyer's answer finishes the run: ${run.stdout}`);
  assert.equal(run.printed.data?.negotiate?.status, 'pass');
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 4, 'clauses once, redlines twice, positions once');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 3, 'the checker reads both sets of redlines, then the positions note');
  const redlines = await run.read('review/redlines.md');
  assert.match(redlines, /## Clause 4/, 'the indemnity redline is on disk');
  assert.match(redlines, /## Clause 6/, 'the exclusivity redline is on disk');
  assert.match(await run.read('review/positions.md'), /walk-away/);
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  const events = await recordEvents(run, 'records/contract-playbook.jsonl');
  const judged = events.filter((event) => event.kind === 'refine:judge');
  assert.deepEqual(judged.map((event) => event.reason), ['the judge acts on 2 of 2 findings', 'the judge chose holds'], 'the judge is asked on both rounds: it acts on the blocks, then chooses holds');
  assert.ok(judged.every((event) => (event.path as string[]).includes('redline')), 'both judged rounds are the redline stage');
  const negotiate = events.filter((event) => event.kind === 'dag:node' && event.node === 'negotiate' && event.phase === 'done');
  assert.deepEqual(negotiate.map((event) => (event.outcome as { status: string }).status), ['paused', 'pass'], 'the run pauses at the lawyer, then the answer passes the step');
  const starts = events.filter((event) => event.kind === 'dag:node' && event.phase === 'start').map((event) => event.node);
  assert.deepEqual(starts, ['clauses', 'redline', 'positions', 'negotiate'], 'each stage starts once: the answer repeats no finished work');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 4,
    clauses: 7,
    redlineRounds: 2,
    checkerKickbacks: 1,
    judge: ['act', 'holds'],
    answeredOnPage: 'negotiate',
    mode: run.mode,
  }, null, 2));
});
