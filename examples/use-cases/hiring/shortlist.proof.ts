import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);

const files: Record<string, string> = {
  'briefs/role.md': await readFile(join(samples, 'briefs/role.md'), 'utf8'),
  'filters.json': await readFile(join(samples, 'filters.json'), 'utf8'),
};
for (const name of (await readdir(join(samples, 'applications'))).sort()) {
  files[`applications/${name}`] = await readFile(join(samples, 'applications', name), 'utf8');
}

// Three applicants pass the gates; a-02 fails on years, a-03 on the skill,
// a-05 on region. The first ranker drops one eligible applicant and ranks
// one the gates excluded, so the judge scores it lower. The second covers
// all three with a reason each, and lands.
const rankingWithAStray = [
  '1. a-04: three years on a developer-tools queue and reviews replies before they go out.',
  '2. a-01: built the help centre from scratch for a payments product.',
  '3. a-05: five years of written support for a marketplace.',
  '',
].join('\n');

const rankingComplete = [
  '1. a-04: three years on a developer-tools queue; reviews replies before they go out.',
  '2. a-01: ran a two-person queue and wrote the help centre from scratch.',
  '3. a-06: keeps a doc of the onboarding answers that worked.',
  '',
].join('\n');

await withExample({
  here,
  example: 'shortlist',
  files,
  seats: {
    claude: [{ writes: { 'shortlist/ranking.md': rankingWithAStray }, reply: pass('three applicants ranked') }],
    codex: [{ writes: { 'shortlist/ranking.md': rankingComplete }, reply: pass('three applicants ranked with a reason each') }],
  },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    filter: { eligible: string[]; excluded: string[] } | null;
    rank: string | null;
    choose: string | null;
  };
  assert.equal(printed.status, 'paused', `the run stops at the person: ${run.stdout}`);
  assert.deepEqual(printed.filter?.eligible, ['a-01', 'a-04', 'a-06']);
  assert.deepEqual(printed.filter?.excluded, ['a-02', 'a-03', 'a-05']);
  assert.equal(printed.choose, 'paused');

  // Each ranker ran in its own worktree, so its seat call is logged there
  // and the worktree is gone by now; the ranking on the main branch is the
  // evidence of which one the judge chose.
  const landed = await run.read('shortlist/ranking.md');
  assert.equal(landed, rankingComplete, 'the ranking that held against the brief is the one on the main branch');
  const excluded = await run.read('shortlist/excluded.json');
  assert.match(excluded, /a-02[\s\S]*fewer than 2 years/);
  assert.match(excluded, /a-03[\s\S]*no written-support skill/);
  assert.match(excluded, /a-05[\s\S]*work region US/);
  assert.ok(run.exists('records/shortlist.jsonl'), 'the run has its record');

  console.log(JSON.stringify({
    status: 'pass',
    applications: 6,
    eligible: 3,
    excludedByARule: 3,
    rankers: 2,
    landed: 'the complete ranking',
    pausedAt: 'choose',
    mode: run.mode,
  }, null, 2));
});
