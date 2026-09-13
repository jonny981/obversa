import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@obversa/runtime';
import { stage, workflow } from '@obversa/teams';

import { pass, scriptedSeat } from './scripted-engine.js';

async function writeFiles(cwd: string, result: number): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/double.mjs'), `export const double = (value) => value * 2;\nexport const result = ${result};\n`);
  await writeFile(
    join(cwd, 'test/double.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/double.mjs';\ntest('double result is written', () => assert.equal(result, 7));\n",
  );
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-panel-example-'));
try {
  let implementationCalls = 0;
  const implement = scriptedSeat('panel-implement', 'claude', [
    async (request) => { implementationCalls += 1; await writeFiles(request.cwd!, 6); return pass('implementation written'); },
    async (request) => { implementationCalls += 1; await writeFiles(request.cwd!, 7); return pass('implementation repaired'); },
  ]);
  const reviewers = ['correctness', 'scope'].map((name, index) => scriptedSeat(
    `panel-${name}`,
    ['gpt', 'big-pickle'][index]!,
    [async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, `reviews/review-${index + 1}.json`), '{"status":"pass"}\n');
      return pass(`${name} accepted the implementation`);
    }],
  ));
  let testRuns = 0;
  const team = workflow('threshold-panel', {
    brief: {
      brief: 'Write a pure double(value) function in src/double.mjs with a Node test in test/double.test.mjs.',
      files: ['src/double.mjs'],
    },
    roles: {
      implement,
      review: reviewers,
    },
    stages: [
      stage('implement', {
        agent: 'implement',
        writes: ['src/double.mjs', 'test/double.test.mjs'],
        desc: 'Write the function and its test from the brief.',
        gate: 'The files named in the brief exist in the workspace.',
        retry: 1,
      }),
      stage('test', {
        run: [process.execPath, '--test', 'test/double.test.mjs'],
        desc: 'Run the test command against the written files.',
        gate: 'The test command exits 0.',
        sendsBackTo: 'implement',
      }),
      stage('review', {
        panel: 'review',
        agree: 1,
        desc: 'Have both reviewers read the change and count the acceptances.',
        gate: 'At least one reviewer has accepted.',
        sendsBackTo: 'implement',
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
  assert.equal(implementationCalls, 2);
  assert.equal(testRuns, 2);
  assert.match(await readFile(join(workspace, 'src/double.mjs'), 'utf8'), /result = 7/);
  console.log(JSON.stringify({
    status: result.outcome.status,
    filesWritten: ['src/double.mjs', 'test/double.test.mjs', 'reviews/review-1.json', 'reviews/review-2.json'],
    testCommandsRun: testRuns,
    threshold: '1 of 2',
    reviewerCalls: reviewers.map((seat) => seat.calls.length),
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
