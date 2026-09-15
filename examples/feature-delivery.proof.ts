import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCallbackClient,
  directRouter,
  run,
  type AgentRequest,
  type LoopEvent,
} from '@obversa/runtime';

import { pass, revise, scriptedSeat } from './teams/scripted-engine.js';
import { createFeatureDelivery } from './feature-delivery.js';

const DRAFT_SOURCE = [
  'export const MAX_ATTEMPTS = 3;',
  '',
  'export async function retry(fn, options = {}) {',
  '  const attempts = options.attempts ?? MAX_ATTEMPTS;',
  '  const delayMs = options.delayMs ?? 10;',
  '  let lastError;',
  '  for (let used = 0; used < attempts; used += 1) {',
  '    try {',
  '      return await fn();',
  '    } catch (error) {',
  '      lastError = error;',
  '      if (used + 1 < attempts) {',
  '        await new Promise((resolve) => setTimeout(resolve, delayMs));',
  '      }',
  '    }',
  '  }',
  '  throw lastError;',
  '}',
  '',
].join('\n');

const DRAFT_TESTS = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { retry } from '../src/retry.js';",
  '',
  "test('retry: a failing request is retried until it succeeds', async () => {",
  '  let calls = 0;',
  '  const value = await retry(async () => {',
  '    calls += 1;',
  "    if (calls < 3) throw new Error('flaky');",
  "    return 'ok';",
  '  });',
  "  assert.equal(value, 'ok');",
  '  assert.equal(calls, 3);',
  '});',
  '',
  "test('cap: the retry attempts are capped', async () => {",
  '  let calls = 0;',
  '  await assert.rejects(',
  '    retry(async () => {',
  '      calls += 1;',
  "      throw new Error('down');",
  '    }),',
  '    /down/,',
  '  );',
  '  assert.equal(calls, 3);',
  '});',
  '',
].join('\n');

const REPAIRED_SOURCE = [
  DRAFT_SOURCE.replace('  const delayMs = options.delayMs ?? 10;\n', '  const delayMs = options.delayMs ?? 10;\n  const signal = options.signal;\n'),
].join('').replace(
  '  for (let used = 0; used < attempts; used += 1) {\n',
  "  for (let used = 0; used < attempts; used += 1) {\n    if (signal?.aborted) throw new Error('aborted');\n",
);

const REPAIRED_TESTS = [
  DRAFT_TESTS,
  "test('abort: retrying stops when the caller aborts', async () => {",
  '  const controller = new AbortController();',
  '  controller.abort();',
  '  let calls = 0;',
  '  await assert.rejects(',
  '    retry(async () => {',
  '      calls += 1;',
  "      return 'ok';",
  '    }, { signal: controller.signal }),',
  '    /aborted/,',
  '  );',
  '  assert.equal(calls, 0);',
  '});',
  '',
].join('\n');

async function writeFiles(cwd: string, source: string, tests: string): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/retry.js'), source);
  await writeFile(join(cwd, 'test/retry.test.js'), tests);
}

function reviewer(name: string, family: string, finding: string) {
  return scriptedSeat(`feature-${name}`, family, [
    async (request: AgentRequest) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, `reviews/${name}-first.json`), '{"status":"revise"}\n');
      return revise(`${name} found one missing criterion`, finding);
    },
    async (request: AgentRequest) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, `reviews/${name}-second.json`), '{"status":"pass"}\n');
      return pass(`${name} accepted the repaired files`);
    },
  ]);
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-feature-delivery-proof-'));
try {
  const analyse = scriptedSeat('feature-analyse', 'claude', [
    async () => pass('retry, cap and abort are accepted criteria'),
  ]);
  const implement = scriptedSeat('feature-implement', 'gpt', [
    async (request) => {
      await writeFiles(request.cwd!, DRAFT_SOURCE, DRAFT_TESTS);
      return pass('wrote the first draft');
    },
    async (request) => {
      await writeFiles(request.cwd!, REPAIRED_SOURCE, REPAIRED_TESTS);
      return pass('repaired the abort criterion');
    },
  ]);
  const correctness = reviewer('correctness', 'claude', 'the source does not stop when the caller aborts');
  const tests = reviewer('tests', 'gpt', 'the tests do not cover an aborted caller');
  const api = scriptedSeat('feature-api', 'claude', [
    async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, 'reviews/api.json'), '{"status":"pass"}\n');
      return pass('the public exports are correct');
    },
    async () => pass('the public exports remain correct'),
  ]);
  const callbacks = createCallbackClient();
  const engines = {
    analyse: analyse.engine,
    implement: implement.engine,
    correctness: correctness.engine,
    tests: tests.engine,
    api: api.engine,
  };
  const events: LoopEvent[] = [];
  const featureDelivery = createFeatureDelivery(engines);
  const first = await run(featureDelivery, {
    cwd: workspace,
    callbacks,
    onEvent: (event) => events.push(event),
  });
  assert.equal(first.outcome.status, 'paused');
  const pending = callbacks.listPending();
  assert.equal(pending.length, 1);
  const answered = await directRouter(callbacks, pending[0]!, 'feature-proof-person', () => ({ approved: true }));
  assert.equal(answered.ok, true);
  const result = await run(featureDelivery, {
    cwd: workspace,
    callbacks,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.outcome.status, 'pass');
  assert.match(await readFile(join(workspace, 'src/retry.js'), 'utf8'), /signal\?\.aborted/);
  assert.match(await readFile(join(workspace, 'test/retry.test.js'), 'utf8'), /abort:/);
  assert.equal(implement.calls.length, 2);
  assert.equal(correctness.calls.length, 2);
  assert.equal(tests.calls.length, 2);
  assert.equal(api.calls.length, 2);
  console.log(JSON.stringify({
    status: result.outcome.status,
    implementRuns: implement.calls.length,
    reviewRounds: events.filter((event) => event.kind === 'loop:review').length,
    filesWritten: [
      'src/retry.js',
      'test/retry.test.js',
      'reviews/correctness-first.json',
      'reviews/tests-first.json',
      'reviews/api.json',
    ],
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
