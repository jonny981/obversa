import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, revise, withExample } from '../proof-host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const brief = await readFile(join(here, 'briefs/playbook.md'), 'utf8');
const contract = await readFile(join(here, 'contracts/msa.md'), 'utf8');

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
// redline. The second set covers every push-back and never clause, the
// positions note follows, and the run stops at the lawyer.
await withExample({
  here,
  example: 'contract-playbook',
  files: { 'briefs/playbook.md': brief, 'contracts/msa.md': contract },
  seats: {
    claude: [
      { writes: { 'review/clauses.md': clauses }, reply: pass('seven clauses mapped: one accept, four push back, two never') },
      { writes: { 'review/redlines.md': redlinesMissingTwo }, reply: pass('four redlines written from the playbook wording') },
      { writes: { 'review/redlines.md': redlinesComplete }, reply: pass('six redlines: the two never-sign clauses are struck with a fallback offered on the indemnity') },
      { writes: { 'review/positions.md': '# Positions\n\n- Hold: clauses 4 and 6 struck (walk-away).\n- Hold: liability at twelve months (clause 3).\n- Concede: notice period 60 -> 45 days on clause 1 if pressed.\n- Concede: payment terms 30 -> 21 days on clause 2 if the price cap holds.\n' }, reply: pass('positions written: two walk-aways, two concessions') },
    ],
    codex: [
      { reply: revise('two never-sign clauses have no redline', 'clause 4 (uncapped indemnity) is marked never in clauses.md and absent from redlines.md', 'clause 6 (exclusivity) is marked never and absent') },
      { reply: pass('every push-back and never clause has a redline, and none goes past its rule') },
    ],
  },
}, async (run) => {
  assert.equal(run.printed.status, 'paused', `the run stops at the lawyer: ${run.stdout}`);
  assert.equal(run.printed.data?.negotiate?.status, 'paused');
  assert.match(run.printed.summary ?? '', /Send these redlines/);
  assert.equal(run.seatCalls.filter((call) => call.role === 'claude').length, 4, 'clauses once, redlines twice, positions once');
  assert.equal(run.seatCalls.filter((call) => call.role === 'codex').length, 2, 'the checker reads both sets of redlines');
  const redlines = await run.read('review/redlines.md');
  assert.match(redlines, /## Clause 4/, 'the indemnity redline is on disk');
  assert.match(redlines, /## Clause 6/, 'the exclusivity redline is on disk');
  assert.match(await run.read('review/positions.md'), /walk-away/);
  assert.match(run.stdout, /tok/, 'the run prints its usage lines');

  console.log(JSON.stringify({
    status: 'pass',
    stages: 4,
    clauses: 7,
    redlineRounds: 2,
    checkerKickbacks: 1,
    pausedAt: 'negotiate',
    mode: run.mode,
  }, null, 2));
});
