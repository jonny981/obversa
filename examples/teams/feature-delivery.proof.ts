import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '@obversa/runtime';
import { featureDelivery } from '@obversa/teams';

import { pass, scriptedSeat } from './scripted-engine.js';

async function writeNote(cwd: string, file: string): Promise<void> {
  await mkdir(join(cwd, 'team-output'), { recursive: true });
  const text = file.endsWith('research-requirements.md')
    ? '1. Export result.\n2. Test result.\n'
    : file.endsWith('plan.md')
      ? '1. Export result. Acceptance check: source exists.\n2. Test result. Acceptance check: command exits 0.\n'
      : 'The workspace context is recorded.\n';
  await writeFile(join(cwd, file), text);
}

async function writeTests(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(
    join(cwd, 'test/result.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result is 11', () => assert.equal(result, 11));\n",
  );
}

async function writeSource(cwd: string, result: number): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src/result.mjs'), `export const result = ${result};\n`);
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-feature-proof-'));
try {
  const analyse = scriptedSeat('feature-analyse', 'claude', [async (request) => {
    const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
    await writeNote(request.cwd!, output);
    return pass('research and plan note accepted');
  }]);
  let implementationCalls = 0;
  const implement = scriptedSeat('feature-implement', 'gpt', [
    async (request) => { await writeTests(request.cwd!); return pass('tests written first'); },
    async (request) => { implementationCalls += 1; await writeSource(request.cwd!, 10); return pass('first implementation written'); },
    async (request) => { implementationCalls += 1; await writeSource(request.cwd!, 11); return pass('implementation repaired'); },
  ]);
  const reviewer = scriptedSeat('feature-reviewer', 'claude', [async () => pass('review accepted')]);
  const approve = scriptedSeat('feature-approve', 'claude', [async (request) => {
    const marker = request.prompt.match(/Run marker: ([^\"]+)/)?.[1]?.trim() ?? '';
    await writeNote(request.cwd!, 'team-output/approval.md');
    await writeFile(join(request.cwd!, 'team-output/approval.md'), `Date: 2026-09-11\nRun marker: ${marker}\n`);
    return pass('delivery approved');
  }]);

  const team = featureDelivery({
    brief: 'Deliver a module that exports result 11.',
    workspace,
    files: ['src/result.mjs', 'test/result.test.mjs'],
    testFiles: ['test/result.test.mjs'],
    test: { command: process.execPath, args: ['--test', 'test/result.test.mjs'] },
    analyse,
    implement,
    reviewers: [{ name: 'correctness', seat: reviewer, scope: 'implementation' }],
    reviewThreshold: 1,
    approve,
  });
  let testCommandsRun = 0;
  let reviewRounds = 0;
  let acceptedReviewPanels = 0;
  const result = await run(team, {
    cwd: workspace,
    onEvent: (event) => {
      if (event.kind === 'condition:result' && event.label === 'test') testCommandsRun += 1;
      if (event.kind === 'loop:condition' && event.which === 'until' && event.path.at(-1) === 'implementation-loop') testCommandsRun += 1;
      if (event.kind === 'loop:review' && event.path.at(-1) === 'implementation-loop' && event.outcome.status === 'pass') reviewRounds += 1;
      if (event.kind === 'job:end' && event.label.endsWith('-review') && event.outcome.status === 'pass') acceptedReviewPanels += 1;
    },
  });
  assert.equal(result.outcome.status, 'pass');
  assert.equal(implementationCalls, 2);
  assert.match(await readFile(join(workspace, 'src/result.mjs'), 'utf8'), /result = 11/);
  assert.match(await readFile(join(workspace, 'team-output/approval.md'), 'utf8'), /Run marker:/);
  assert.match(await readFile(join(workspace, 'team-output/evidence.md'), 'utf8'), /Verification: passed/);
  console.log(JSON.stringify({
    status: result.outcome.status,
    stages: 11,
    testCommandsRun,
    implementationIterations: implementationCalls,
    reviewRounds,
    acceptedReviewPanels,
    kickbacks: 0,
    filesWritten: [
      'team-output/research-context.md',
      'team-output/research-requirements.md',
      'team-output/plan.md',
      'team-output/approval.md',
      'team-output/evidence.md',
      'team-output/learning.md',
      'src/result.mjs',
      'test/result.test.mjs',
    ],
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
