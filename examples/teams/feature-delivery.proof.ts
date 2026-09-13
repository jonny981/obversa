import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCallbackClient, directRouter, run, type LoopEvent } from '@obversa/runtime';
import { person, stage, workflow } from '@obversa/teams';

import { pass, scriptedSeat } from './scripted-engine.js';

async function writeAnalysis(cwd: string, prompt: string): Promise<void> {
  const line = prompt.split('\n').find((value) => value.startsWith('This stage may write only:'));
  const files = line
    ?.replace(/^This stage may write only: /, '')
    .replace(/\. Do not write.*$/, '')
    .split(', ')
    .filter(Boolean) ?? [];
  await Promise.all(files.map(async (file) => {
    await mkdir(join(cwd, file, '..'), { recursive: true });
    const text = file.endsWith('research-requirements.md')
      ? 'REQ-1: Export triple.\nREQ-2: Test triple.\n'
      : file.endsWith('plan.md')
        ? 'REQ-1: Source exports triple. Check: source exists.\nREQ-2: Test covers triple. Check: command exits 0.\n'
        : file.endsWith('evidence.md')
          ? 'Verification: passed.\n'
          : file.endsWith('learning.md')
            ? 'The run records its evidence.\n'
            : 'The workspace context is recorded.\n';
    await writeFile(join(cwd, file), text);
  }));
}

async function writeTests(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(
    join(cwd, 'test/triple.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { triple } from '../src/triple.mjs';\ntest('triple returns three times the input', () => assert.equal(triple(3), 9));\n",
  );
}

async function writeSource(cwd: string, value: number): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await writeFile(join(cwd, 'src/triple.mjs'), `export const triple = (value) => value * ${value};\n`);
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-feature-proof-'));
try {
  const analyse = scriptedSeat('feature-analyse', 'claude', [async (request) => {
    await writeAnalysis(request.cwd!, request.prompt);
    return pass('analysis note written');
  }]);
  let implementationCalls = 0;
  const implement = scriptedSeat('feature-implement', 'gpt', [
    async (request) => { await writeTests(request.cwd!); return pass('tests written first'); },
    async (request) => { implementationCalls += 1; await writeSource(request.cwd!, 10); return pass('first implementation written'); },
    async (request) => { implementationCalls += 1; await writeSource(request.cwd!, 3); return pass('implementation repaired'); },
  ]);
  const reviewer = scriptedSeat('feature-reviewer', 'claude-review', [async (request) => {
    const reviewerName = request.prompt.match(/^Obversa team role: ([^\n]+)/m)?.[1] ?? 'stage-1';
    await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
    await writeFile(join(request.cwd!, `reviews/${reviewerName}.json`), '{"status":"pass"}\n');
    return pass('review accepted');
  }]);
  const callbacks = createCallbackClient();
  const team = workflow('feature-delivery', {
    brief: {
      brief: 'Deliver a pure triple(value) function in src/triple.mjs with a Node test in test/triple.test.mjs.',
      files: ['src/triple.mjs'],
    },
    options: { timeout: '10m' },
    roles: {
      analyse,
      implement,
      review: [reviewer],
      approve: person('Ship this change?'),
    },
    stages: [
      stage('research-context', {
        agent: 'analyse',
        writes: 'team-output/research-context.md',
        desc: 'Read the workspace and write down what the change touches.',
        gate: 'The context note is in the workspace and a reviewer has accepted it.',
        reviewedBy: 'review',
        retry: 3,
      }),
      stage('research-requirements', {
        agent: 'analyse',
        writes: 'team-output/research-requirements.md',
        desc: 'Turn the brief and the context note into requirements, one REQ-n per line.',
        gate: 'The requirements note is in the workspace and a reviewer has accepted it.',
        reviewedBy: 'review',
        retry: 3,
      }),
      stage('plan', {
        agent: 'analyse',
        writes: 'team-output/plan.md',
        desc: 'Write an executable plan from the requirements, one check per REQ-n.',
        gate: 'Every requirement has a check in the plan.',
        reviewedBy: 'review',
        retry: 3,
      }),
      stage('tests-first', {
        agent: 'implement',
        writes: 'test/triple.test.mjs',
        desc: 'Write the declared test files from the accepted plan before any implementation exists.',
        gate: 'Every declared test file exists and covers the plan.',
        reviewedBy: 'review',
        retry: 3,
      }),
      stage('implement', {
        agent: 'implement',
        writes: 'src/triple.mjs',
        desc: 'Write the code to the plan and the tests.',
        gate: 'The source file exists.',
        retry: 3,
      }),
      stage('test', {
        run: [process.execPath, '--test', 'test/triple.test.mjs'],
        sendsBackTo: 'implement',
      }),
      stage('review', {
        panel: 'review',
        agree: 1,
        desc: 'Read the change and the test result against the plan.',
        sendsBackTo: 'implement',
      }),
      stage('approve', {
        input: 'approve',
      }),
      stage('close', {
        agent: 'analyse',
        writes: ['team-output/evidence.md', 'team-output/learning.md'],
        desc: 'Write the evidence of the run and what was learned, from the record alone.',
        gate: 'Both notes are in the workspace.',
      }),
    ],
  });
  let testCommandsRun = 0;
  let reviewRounds = 0;
  let acceptedReviewPanels = 0;
  let kickbacks = 0;
  const onEvent = (event: LoopEvent) => {
    if (event.kind === 'condition:result' && event.label === 'test') testCommandsRun += 1;
    if (event.kind === 'loop:review' && event.outcome.status === 'pass') {
      reviewRounds += 1;
      acceptedReviewPanels += 1;
    }
    if (event.kind === 'job:end' && event.label === 'review' && event.outcome.status === 'pass') {
      acceptedReviewPanels += 1;
    }
    if (event.kind === 'dag:kickback' && event.accepted) kickbacks += 1;
  };
  const first = await run(team, { cwd: workspace, callbacks, onEvent });
  assert.equal(first.outcome.status, 'paused');
  const pending = callbacks.listPending();
  assert.equal(pending.length, 1);
  const answered = await directRouter(callbacks, pending[0]!, 'feature-proof-person', () => ({ approved: true }));
  assert.equal(answered.ok, true);
  const result = await run(team, { cwd: workspace, callbacks, onEvent });
  assert.equal(result.outcome.status, 'pass');
  assert.match(await readFile(join(workspace, 'src/triple.mjs'), 'utf8'), /triple = \(value\) => value \* 3/);
  assert.match(await readFile(join(workspace, 'team-output/evidence.md'), 'utf8'), /Verification: passed/);
  console.log(JSON.stringify({
    status: result.outcome.status,
    stages: 9,
    testCommandsRun,
    implementationIterations: implementationCalls,
    reviewRounds,
    acceptedReviewPanels,
    kickbacks,
    filesWritten: [
      'team-output/research-context.md',
      'team-output/research-requirements.md',
      'team-output/plan.md',
      'team-output/evidence.md',
      'team-output/learning.md',
      'src/triple.mjs',
      'test/triple.test.mjs',
    ],
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
