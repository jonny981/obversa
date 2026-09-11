import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@obversa/runtime';
import { writerReviewerPair } from '@obversa/teams';

import { pass, revise, scriptedSeat } from './scripted-engine.js';

async function writeFiles(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/result.mjs'), 'export const result = 42;\n');
  await writeFile(
    join(cwd, 'test/result.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result is written', () => assert.equal(result, 42));\n",
  );
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-pair-example-'));
try {
  const writer = scriptedSeat('pair-writer', 'writer-family', [
    async (request) => { await writeFiles(request.cwd!); return pass('writer wrote the files'); },
    async (request) => { await writeFiles(request.cwd!); return pass('writer applied the review'); },
  ]);
  const reviewer = scriptedSeat('pair-reviewer', 'reviewer-family', [
    async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, 'reviews/reviewer.json'), '{"status":"revise"}\n');
      return revise('review requested one repair', 'the implementation needs one repair');
    },
    async () => pass('review accepted the repaired files'),
  ]);
  let testRuns = 0;
  const team = writerReviewerPair({
    brief: 'Write a module that exports result 42 and a test for it.',
    workspace,
    files: ['src/result.mjs', 'test/result.test.mjs'],
    test: { command: process.execPath, args: ['--test', 'test/result.test.mjs'] },
    writer,
    reviewer,
  });
  const result = await run(team, {
    cwd: workspace,
    onEvent: (event) => {
      if (event.kind === 'condition:result' && event.label === 'test') testRuns += 1;
    },
  });
  assert.equal(result.outcome.status, 'pass');
  assert.equal(testRuns, 2);
  assert.match(await readFile(join(workspace, 'src/result.mjs'), 'utf8'), /result = 42/);
  console.log(JSON.stringify({
    status: result.outcome.status,
    filesWritten: ['src/result.mjs', 'test/result.test.mjs', 'reviews/reviewer.json'],
    testCommandsRun: testRuns,
    reviewerKickbacks: reviewer.calls.length - 1,
    modelFamilies: [writer.identity.modelFamily, reviewer.identity.modelFamily],
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
