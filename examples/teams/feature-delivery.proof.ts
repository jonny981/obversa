import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCallbackClient, directRouter, run, type AgentRequest, type LoopEvent } from '@obversa/runtime';

import { pass, scriptedSeat } from './scripted-engine.js';
import { createFeatureDelivery } from './feature-delivery.js';

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
  await mkdir(join(workspace, 'briefs'), { recursive: true });
  await writeFile(join(workspace, 'briefs/triple.md'), '---\nfiles: ["src/triple.mjs"]\n---\n\nDeliver a pure triple(value) function in src/triple.mjs with a Node test in test/triple.test.mjs.\n');
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
  const review = async (request: AgentRequest) => {
    const reviewerName = request.prompt.match(/^Obversa team role: ([^\n]+)/m)?.[1] ?? 'stage-1';
    await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
    await writeFile(join(request.cwd!, `reviews/${reviewerName}.json`), '{"status":"pass"}\n');
    return pass('review accepted');
  };
  const researchReviewer = scriptedSeat('feature-research-reviewer', 'gpt', [review]);
  const codeReviewer = scriptedSeat('feature-code-reviewer', 'claude', [review]);
  const claudeSeats = [analyse, codeReviewer];
  const codexSeats = [implement, researchReviewer];
  let claudeIndex = 0;
  let codexIndex = 0;
  const engines = {
    claude: () => claudeSeats[claudeIndex++]!,
    codex: () => codexSeats[codexIndex++]!,
  };
  const callbacks = createCallbackClient();
  const team = (() => {
    const previousCwd = process.cwd();
    try {
      process.chdir(workspace);
      return createFeatureDelivery(engines);
    } finally {
      process.chdir(previousCwd);
    }
  })();
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
