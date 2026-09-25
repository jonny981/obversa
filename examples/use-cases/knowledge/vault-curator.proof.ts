import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const read = (path: string) => readFile(join(samples, path), 'utf8');

const proposals = JSON.stringify([
  {
    note: 'n-01.md',
    path: 'projects/review-loop-decisions.md',
    title: 'Review loop: decisions',
    body: 'Meeting with the team about the review loop. Agreed: the limit stays at three; a second reviewer only for changes touching billing. Sam writes it up. Revisit in a month.',
  },
  {
    note: 'n-02.md',
    path: 'reading/links.md',
    title: 'Links to skim',
    body: 'Three articles on worktrees, one thread on feedback loops, one video not yet watched.',
  },
  {
    note: 'n-03.md',
    path: 'people/reading-group.md',
    title: 'Reading group: pick by impact',
    body: 'Idea: the reading group could pick papers by what changed our work last quarter, instead of by whoever ran the last session. Try it once and see if it sticks.',
  },
]);

const answer = [
  '# q-1: the review loop\'s limit and the second reviewer',
  '',
  '- The limit stays at three (projects/review-loop-decisions.md); the loop page already set three as the limit (projects/review-loop.md).',
  '- A second reviewer is added only for changes touching billing (projects/review-loop-decisions.md).',
  '',
  'Not settled by the vault: who the second reviewer is.',
  '',
].join('\n');

// Three inbox notes, three proposals, three decisions. The person filed
// the meeting note as proposed, dropped the link dump with a reason, and
// moved the idea to a path of their own instead of over the existing
// reading-group page. The search then finds the filed decision and the
// answer cites it.
await withExample({
  here,
  example: 'vault-curator',
  files: {
    'briefs/vault.md': await read('briefs/vault.md'),
    'inbox/n-01.md': await read('inbox/n-01.md'),
    'inbox/n-02.md': await read('inbox/n-02.md'),
    'inbox/n-03.md': await read('inbox/n-03.md'),
    'vault/projects/review-loop.md': await read('vault/projects/review-loop.md'),
    'vault/people/reading-group.md': await read('vault/people/reading-group.md'),
    'steering.json': await read('steering.json'),
    'questions.json': await read('questions.json'),
  },
  seats: {
    claude: [
      { reply: proposals },
      { writes: { 'answers/q-1.md': answer }, reply: pass('answered from two vault passages') },
    ],
  },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    proposed: [string, string][];
    filed: { note: string; path: string }[];
    dropped: { note: string; reason: string | null }[];
    searched: string[];
    answered: string[];
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.equal(printed.proposed.length, 3);
  assert.deepEqual(printed.filed, [
    { note: 'n-01.md', path: 'projects/review-loop-decisions.md' },
    { note: 'n-03.md', path: 'ideas/reading-group-by-impact.md' },
  ]);
  assert.equal(printed.dropped.length, 1);
  assert.equal(printed.dropped[0]?.note, 'n-02.md');
  assert.match(printed.dropped[0]?.reason ?? '', /link dump/i);
  assert.ok(printed.searched.includes('/memories/projects/review-loop-decisions.md'), `the filed decision was found: ${printed.searched.join(', ')}`);
  assert.deepEqual(printed.answered, ['q-1']);

  assert.equal(run.seatCalls.length, 2, 'one proposal turn, one answer turn');
  assert.match(await run.read('vault/projects/review-loop-decisions.md'), /second reviewer only for changes touching billing/);
  assert.match(await run.read('vault/ideas/reading-group-by-impact.md'), /pick papers by what changed/);
  assert.equal(await run.read('vault/people/reading-group.md'), await read('vault/people/reading-group.md'), 'the existing page was not overwritten');
  assert.equal(run.exists('vault/reading/links.md'), false, 'the dropped note entered nothing');
  assert.match(await run.read('answers/q-1.md'), /review-loop-decisions/);
  assert.ok(run.exists('records/vault-curator.jsonl'), 'the run has its record');

  console.log(JSON.stringify({
    status: 'pass',
    inboxNotes: 3,
    proposed: 3,
    filedAsProposed: 1,
    filedElsewhere: 1,
    dropped: 1,
    passagesFound: printed.searched.length,
    answered: 1,
    mode: run.mode,
  }, null, 2));
});
