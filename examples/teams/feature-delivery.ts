import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@obversa/runtime';
import { featureDelivery } from '@obversa/teams';

import { pass, revise, scriptedSeat } from './scripted-engine.js';

async function writeBrief(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'team-output'), { recursive: true });
  await writeFile(join(cwd, 'team-output/brief.md'), 'The module must export result 11.\n');
}

async function writeImplementation(cwd: string, repaired: boolean): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/result.mjs'), `export const result = ${repaired ? 11 : 10};\n`);
  await writeFile(
    join(cwd, 'test/result.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result exists', () => assert.equal(typeof result, 'number'));\n",
  );
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-feature-example-'));
try {
  const analyse = scriptedSeat('feature-analyse', 'analyse-family', [async (request) => {
    await writeBrief(request.cwd!);
    return pass('brief accepted');
  }]);
  const implement = scriptedSeat('feature-implement', 'implement-family', [
    async (request) => { await writeImplementation(request.cwd!, false); return pass('first implementation written'); },
    async (request) => { await writeImplementation(request.cwd!, true); return pass('implementation repaired'); },
  ]);
  const correctness = scriptedSeat('feature-correctness', 'correctness-family', [
    async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, 'reviews/correctness.json'), '{"round":1}\n');
      return revise('result is not 11', 'the implementation does not meet the brief');
    },
    async (request) => {
      await writeFile(join(request.cwd!, 'reviews/correctness.json'), '{"round":2}\n');
      return pass('result meets the brief');
    },
  ]);
  const scope = scriptedSeat('feature-scope', 'scope-family', [
    async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, 'reviews/scope.json'), '{"round":1}\n');
      return pass('scope is inside the brief');
    },
    async () => pass('scope remains inside the brief'),
  ]);
  const approve = scriptedSeat('feature-approve', 'approve-family', [async (request) => {
    await writeFile(join(request.cwd!, 'team-output/approval.md'), 'The change is ready to ship.\n');
    return pass('delivery approved');
  }]);
  let testRuns = 0;
  const team = featureDelivery({
    brief: 'Deliver a module that exports result 11.',
    workspace,
    files: ['src/result.mjs', 'test/result.test.mjs'],
    test: { command: process.execPath, args: ['--test', 'test/result.test.mjs'] },
    analyse,
    implement,
    reviewers: [
      { name: 'correctness', seat: correctness },
      { name: 'scope', seat: scope },
    ],
    reviewThreshold: 2,
    approve,
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
  assert.equal(implement.calls.length, 2);
  assert.match(await readFile(join(workspace, 'src/result.mjs'), 'utf8'), /result = 11/);
  assert.match(await readFile(join(workspace, 'team-output/approval.md'), 'utf8'), /ready to ship/);
  console.log(JSON.stringify({
    status: result.outcome.status,
    filesWritten: ['team-output/brief.md', 'team-output/approval.md', 'src/result.mjs', 'test/result.test.mjs', 'reviews/correctness.json', 'reviews/scope.json'],
    testCommandsRun: testRuns,
    reviewRounds: 2,
    kickbacks: 1,
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
