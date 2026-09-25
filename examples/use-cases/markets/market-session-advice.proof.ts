import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);

/** Every fixture file beside the example, path to content, so the workspace matches the folder a reader copies. */
async function fixtures(root: string, directories: readonly string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const directory of directories) {
    for (const entry of await readdir(join(root, directory), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      files[relative(root, path)] = await readFile(path, 'utf8');
    }
  }
  return files;
}

const researchNote = [
  '# obs-002: what the evidence says',
  '',
  '- news.md: a recall of one product line in one region, under two percent of revenue.',
  '- news.md: a competitor cut prices across the category.',
  '- filings.md: revenue up on the prior quarter, margin flat, guidance unchanged.',
  '',
  'Not settled: whether the price cut reaches this company\'s main lines.',
  '',
  'Read: hold. The recall is small and guidance is unchanged.',
  '',
].join('\n');

// Seven recorded observations across three sessions. The ordinary session
// admits four: a confident hold, an uncertain one the research seat reads,
// a consider-buy that stops on a question for a person, and a malformed
// assessment that fails its check. The closed session admits none, and the
// shortened session refuses the observation after its early close.
await withExample({
  here,
  example: 'market-session-advice',
  files: {
    ...await fixtures(samples, ['briefs', 'sessions', 'observations', 'evidence']),
    'policy.json': await readFile(join(samples, 'policy.json'), 'utf8'),
  },
  seats: {
    claude: [
      { writes: { 'advice/obs-002-research.md': researchNote }, reply: pass('research note written from the two evidence files') },
    ],
  },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    venue: string;
    sessions: { date: string; kind: string; refused: { id: string; reason: string }[]; runs: { id: string; outcome: string; advice: string | null; researched: boolean; question: string | null }[] }[];
    pendingQuestions: number;
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.equal(printed.venue, 'example-venue');
  const [ordinary, closed, shortened] = printed.sessions;

  assert.equal(ordinary?.kind, 'ordinary');
  assert.deepEqual(ordinary?.runs.map((entry) => [entry.id, entry.outcome, entry.advice, entry.researched]), [
    ['obs-001', 'pass', 'hold', false],
    ['obs-002', 'pass', 'hold', true],
    ['obs-003', 'paused', 'consider-buy', false],
    ['obs-004', 'fail', null, false],
  ]);
  assert.match(ordinary?.runs[2]?.question ?? '', /Consider acting on EXV-A \(obs-003\)/);

  assert.equal(closed?.kind, 'closed');
  assert.deepEqual(closed?.refused, [{ id: 'obs-005', reason: 'the venue is closed' }]);
  assert.deepEqual(closed?.runs, []);

  assert.equal(shortened?.kind, 'shortened');
  assert.deepEqual(shortened?.runs.map((entry) => [entry.id, entry.outcome]), [['obs-006', 'pass']]);
  assert.deepEqual(shortened?.refused, [{ id: 'obs-007', reason: 'after the close' }]);

  assert.equal(printed.pendingQuestions, 1);
  assert.equal(run.seatCalls.length, 1, 'the research seat reads one uncertain observation');
  assert.match(await run.read('advice/obs-002.json'), /"researched": true/);
  assert.match(await run.read('advice/obs-002-research.md'), /Read: hold/);
  assert.equal(run.exists('advice/obs-004.json'), false, 'a malformed assessment leaves no advice record');
  assert.match(await run.read('history/questions.jsonl'), /obs-003/);
  for (const id of ['obs-001', 'obs-002', 'obs-003', 'obs-004', 'obs-006']) {
    assert.ok(run.exists(`records/${id}.jsonl`), `${id} has its own record`);
  }

  console.log(JSON.stringify({
    status: 'pass',
    sessions: 3,
    observations: 7,
    admitted: 5,
    refused: 2,
    researched: 1,
    pausedForAPerson: 1,
    malformed: 1,
    mode: run.mode,
  }, null, 2));
});
