import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = (() => {
  // The repo root is the nearest directory with a package.json: the
  // repository and the throwaway consumer have different depths.
  let dir = here;
  for (let i = 0; i < 4; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('no package.json above the proof');
})();
const standIn = join(repo, 'scripts', 'stand-in-cli.mjs');

const pass = (summary: string): string => JSON.stringify({ status: 'pass', summary });
const revise = (summary: string, finding: string): string => JSON.stringify({
  status: 'revise', summary, findings: [{ severity: 'block', evidence: finding }],
});

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

const REPAIRED_SOURCE = DRAFT_SOURCE
  .replace('  const delayMs = options.delayMs ?? 10;\n', '  const delayMs = options.delayMs ?? 10;\n  const signal = options.signal;\n')
  .replace('  for (let used = 0; used < attempts; used += 1) {\n', "  for (let used = 0; used < attempts; used += 1) {\n    if (signal?.aborted) throw new Error('aborted');\n");

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

const workspace = await mkdtemp(join(tmpdir(), 'obversa-feature-delivery-proof-'));
try {
  await mkdir(join(workspace, 'bin'), { recursive: true });
  await writeFile(
    join(workspace, '.obversa-stand-in.json'),
    JSON.stringify({
      claude: [
        { writes: {}, reply: pass('retry, cap and abort are accepted criteria') },
        { writes: { 'reviews/correctness-first.json': '{"status":"revise"}\n' }, reply: revise('correctness found one missing criterion', 'the source does not stop when the caller aborts') },
        { writes: { 'reviews/api.json': '{"status":"pass"}\n' }, reply: pass('the public exports are correct') },
        { writes: { 'reviews/correctness-second.json': '{"status":"pass"}\n' }, reply: pass('correctness accepted the repaired files') },
        { writes: {}, reply: pass('the public exports remain correct') },
      ],
      codex: [
        { writes: { 'src/retry.js': DRAFT_SOURCE, 'test/retry.test.js': DRAFT_TESTS }, reply: pass('wrote the first draft') },
        { writes: { 'reviews/tests-first.json': '{"status":"revise"}\n' }, reply: revise('tests found one missing criterion', 'the tests do not cover an aborted caller') },
        { writes: { 'src/retry.js': REPAIRED_SOURCE, 'test/retry.test.js': REPAIRED_TESTS }, reply: pass('repaired the abort criterion') },
        { writes: { 'reviews/tests-second.json': '{"status":"pass"}\n' }, reply: pass('tests accepted the repaired files') },
      ],
    }, null, 2) + '\n',
  );
  const callsLog = join(workspace, '.obversa-stand-in-calls.log');
  for (const name of ['claude', 'codex', 'opencode']) {
    await symlink(standIn, join(workspace, 'bin', name));
  }

  // The workflow ends at the approve stage, where a person answers. Until
  // F42 gives a second process that route, the proof asserts to the pause.
  // Inside a fresh consumer there is no packages/runtime/tsconfig.json; tsx then
  // reads the nearest tsconfig, which is the consumer's own.
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, 'feature-delivery.js');
  const child = existsSync(compiled)
    ? { file: process.execPath, args: [compiled] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, 'feature-delivery.ts')] };
  const started = Date.now();
  const run = spawnSync(child.file, child.args, {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${join(workspace, 'bin')}:${process.env.PATH ?? ''}`,
    },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const elapsed = Date.now() - started;

  const mode = existsSync(compiled) ? 'compiled-from-dist' : existsSync(repoTsconfig) ? 'repo-tsx' : 'consumer-tsx';
  assert.equal(run.status, 0, `the example child ${child.file} ${child.args.join(' ')} exited ${run.status ?? `signal ${run.signal}`} after ${elapsed}ms in ${mode} mode
  spawn error: ${run.error ?? 'none'}
  stdout: ${run.stdout}
  stderr: ${run.stderr}`);
  const printed = JSON.parse(run.stdout.slice(run.stdout.lastIndexOf('\n{') + 1));
  assert.equal(printed.status, 'paused');

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; writes: Record<string, string> });
  const implementRuns = calls.filter((call) => 'src/retry.js' in call.writes).length;
  assert.equal(implementRuns, 2, 'the implementer runs once and repairs once');

  assert.match(await readFile(join(workspace, 'src/retry.js'), 'utf8'), /signal\?\.aborted/);
  assert.match(await readFile(join(workspace, 'test/retry.test.js'), 'utf8'), /abort:/);
  const reviews = await readdir(join(workspace, 'reviews'));
  assert.ok(reviews.includes('correctness-first.json') && reviews.includes('tests-first.json') && reviews.includes('api.json'), `reviews: ${reviews.join(', ')}`);

  // The example writes its record beside the workspace; the pause is in it.
  const recordRoot = join(workspace, '.obversa', 'records');
  const record = (await readdir(recordRoot)).filter((name) => name.endsWith('.jsonl')).map((name) => join(recordRoot, name))[0]!;
  const events = (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { kind?: string; path?: string[]; outcome?: { status?: string } });
  assert.ok(events.some((event) => event.kind === 'job:end' && event.path?.includes('approve')
    && (event as { outcome?: { status?: string } }).outcome?.status === 'paused'), 'the pause is in the record');
  assert.ok(events.some((event) => event.kind === 'dag:end'
    && (event as { outcome?: { status?: string } }).outcome?.status === 'paused'), 'the run recorded its paused end');

  console.log(JSON.stringify({
    status: printed.status,
    implementRuns,
    reviewRounds: 2,
    filesWritten: ['src/retry.js', 'test/retry.test.js', 'reviews/correctness-first.json', 'reviews/tests-first.json', 'reviews/api.json'],
    pausedAt: 'approve',
    mode,
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
