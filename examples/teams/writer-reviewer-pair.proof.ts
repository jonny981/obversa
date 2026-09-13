import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@obversa/runtime';
import { stage, workflow } from '@obversa/teams';

import { pass, revise, scriptedSeat } from './scripted-engine.js';

async function writeFiles(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/add.mjs'), 'export const add = (a, b) => a + b;\n');
  await writeFile(
    join(cwd, 'test/add.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/add.mjs';\ntest('add sums two values', () => assert.equal(add(2, 3), 5));\n",
  );
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-pair-example-'));
try {
  const writer = scriptedSeat('pair-writer', 'claude', [
    async (request) => { await writeFiles(request.cwd!); return pass('writer wrote the files'); },
    async (request) => { await writeFiles(request.cwd!); return pass('writer applied the review'); },
  ]);
  const reviewer = scriptedSeat('pair-reviewer', 'gpt', [
    async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, 'reviews/review-1.json'), '{"status":"revise"}\n');
      return revise('review requested one repair', 'the implementation needs one repair');
    },
    async () => pass('review accepted the repaired files'),
  ]);
  let testRuns = 0;
  const team = workflow('writer-reviewer-pair', {
    brief: {
      brief: 'Write a pure add(a, b) function in src/add.mjs with a Node test in test/add.test.mjs.',
      files: ['src/add.mjs'],
    },
    roles: {
      write: writer,
      review: [reviewer],
    },
    stages: [
      stage('write', {
        agent: 'write',
        writes: ['src/add.mjs', 'test/add.test.mjs'],
        desc: 'Write the function and its test from the brief.',
        gate: 'The files named in the brief exist in the workspace.',
        retry: 1,
      }),
      stage('test', {
        run: [process.execPath, '--test', 'test/add.test.mjs'],
        desc: 'Run the test command against the written files.',
        gate: 'The test command exits 0.',
        sendsBackTo: 'write',
      }),
      stage('review', {
        panel: 'review',
        agree: 1,
        desc: 'Read the code, the test and its result.',
        gate: 'The change meets the brief.',
        sendsBackTo: 'write',
      }),
    ],
  });
  const result = await run(team, {
    cwd: workspace,
    onEvent: (event) => {
      if (event.kind === 'condition:result' && event.label === 'test') testRuns += 1;
    },
  });
  assert.equal(result.outcome.status, 'pass');
  assert.equal(testRuns, 2);
  assert.match(await readFile(join(workspace, 'src/add.mjs'), 'utf8'), /add =/);
  console.log(JSON.stringify({
    status: result.outcome.status,
    filesWritten: ['src/add.mjs', 'test/add.test.mjs', 'reviews/review-1.json'],
    testCommandsRun: testRuns,
    reviewerKickbacks: reviewer.calls.length - 1,
    modelFamilies: [writer.identity.modelFamily, reviewer.identity.modelFamily],
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
