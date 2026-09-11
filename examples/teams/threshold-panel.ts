import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@obversa/runtime';
import { thresholdPanel } from '@obversa/teams';

import { pass, revise, scriptedSeat } from './scripted-engine.js';

async function writeFiles(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/result.mjs'), 'export const result = 7;\n');
  await writeFile(
    join(cwd, 'test/result.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result is written', () => assert.equal(result, 7));\n",
  );
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-panel-example-'));
try {
  const implement = scriptedSeat('panel-implement', 'implement-family', [
    async (request) => { await writeFiles(request.cwd!); return pass('implementation written'); },
    async (request) => { await writeFiles(request.cwd!); return pass('implementation repaired'); },
  ]);
  const reviewers = ['correctness', 'tests', 'scope'].map((name, index) => scriptedSeat(
    `panel-${name}`,
    `${name}-family`,
    [
      async (request) => {
        await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
        await writeFile(join(request.cwd!, `reviews/${name}.json`), '{"round":1}\n');
        return index === 2
          ? pass(`${name} accepted the first implementation`)
          : revise(`${name} requested a repair`, `${name} found a missing requirement`);
      },
      async (request) => {
        await writeFile(join(request.cwd!, `reviews/${name}.json`), '{"round":2}\n');
        return pass(`${name} accepted the repair`);
      },
    ],
  ));
  let testRuns = 0;
  const team = thresholdPanel({
    brief: 'Write a module that exports result 7 and a test for it.',
    workspace,
    files: ['src/result.mjs', 'test/result.test.mjs'],
    test: { command: process.execPath, args: ['--test', 'test/result.test.mjs'] },
    implement,
    reviewers: reviewers.map((seat, index) => ({ name: ['correctness', 'tests', 'scope'][index]!, seat })),
    threshold: 3,
    maxKickbacks: 1,
  });
  const result = await run(team, {
    cwd: workspace,
    onEvent: (event) => {
      if (event.kind === 'condition:result' && event.label === 'test') testRuns += 1;
    },
  });
  assert.equal(result.outcome.status, 'pass');
  assert.equal(testRuns, 2);
  assert.match(await readFile(join(workspace, 'reviews/correctness.json'), 'utf8'), /round/);
  console.log(JSON.stringify({
    status: result.outcome.status,
    filesWritten: ['src/result.mjs', 'test/result.test.mjs', 'reviews/correctness.json', 'reviews/tests.json', 'reviews/scope.json'],
    testCommandsRun: testRuns,
    threshold: '3 of 3',
    reviewerCalls: reviewers.map((seat) => seat.calls.length),
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
