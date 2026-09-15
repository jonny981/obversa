import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@obversa/runtime';

import { pass, scriptedSeat } from './scripted-engine.js';
import { createThresholdPanel } from './threshold-panel.js';

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
  await mkdir(join(workspace, 'briefs'), { recursive: true });
  await writeFile(join(workspace, 'briefs/double.md'), '---\nfiles: ["src/double.mjs"]\n---\n\nWrite a pure double(value) function in src/double.mjs with a Node test in test/double.test.mjs.\n');
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
  const team = (() => {
    const previousCwd = process.cwd();
    try {
      process.chdir(workspace);
      return createThresholdPanel({
        claude: () => implement,
        codex: () => reviewers[0]!,
        opencode: () => reviewers[1]!,
      });
    } finally {
      process.chdir(previousCwd);
    }
  })();
  let testRuns = 0;
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
