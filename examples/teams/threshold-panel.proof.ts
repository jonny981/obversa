import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-panel-proof-'));
try {
  await mkdir(join(workspace, 'briefs'), { recursive: true });
  await mkdir(join(workspace, 'bin'), { recursive: true });
  await writeFile(join(workspace, 'briefs/double.md'), '---\nfiles: ["src/double.mjs"]\n---\n\nWrite a pure double(value) function in src/double.mjs with a Node test in test/double.test.mjs.\n');
  await writeFile(
    join(workspace, '.obversa-stand-in.json'),
    JSON.stringify({
      claude: [
        { writes: { 'src/double.mjs': 'export const double = (value) => value * 2;\nexport const result = 6;\n', 'test/double.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/double.mjs';\ntest('double result is written', () => assert.equal(result, 7));\n" }, reply: '{\"status\":\"pass\",\"summary\":\"implementation written\"}' },
        { writes: { 'src/double.mjs': 'export const double = (value) => value * 2;\nexport const result = 7;\n' }, reply: '{\"status\":\"pass\",\"summary\":\"implementation repaired\"}' },
      ],
      codex: [
        { writes: { 'reviews/review-1.json': '{"status":"pass"}\n' }, reply: '{\"status\":\"pass\",\"summary\":\"correctness accepted\"}' },
      ],
      opencode: [
        { writes: { 'reviews/review-2.json': '{"status":"pass"}\n' }, reply: '{\"status\":\"pass\",\"summary\":\"scope accepted\"}' },
      ],
    }, null, 2) + '\n',
  );
  const callsLog = join(workspace, '.obversa-stand-in-calls.log');
  for (const name of ['claude', 'codex', 'opencode']) {
    await symlink(standIn, join(workspace, 'bin', name));
  }

  // Inside a fresh consumer there is no packages/runtime/tsconfig.json; tsx then
  // reads the nearest tsconfig, which is the consumer's own.
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, 'threshold-panel.js');
  const child = existsSync(compiled)
    ? { file: process.execPath, args: [compiled] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, 'threshold-panel.ts')] };
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
  assert.equal(printed.status, 'pass');

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; writes: Record<string, string> });
  const implementerCalls = calls.filter((call) => call.role === 'claude');
  assert.equal(implementerCalls.length, 2, 'the implementer runs once and repairs once');
  assert.match(implementerCalls[0]!.writes['src/double.mjs'] ?? '', /result = 6/, 'the first draft fails the test');
  assert.match(implementerCalls[1]!.writes['src/double.mjs'] ?? '', /result = 7/, 'the repair passes the test');
  assert.equal(calls.filter((call) => call.role === 'codex').length, 1, 'the first reviewer ran');
  assert.equal(calls.filter((call) => call.role === 'opencode').length, 1, 'the second reviewer ran');

  assert.match(await readFile(join(workspace, 'src/double.mjs'), 'utf8'), /result = 7/);
  assert.ok((await readFile(join(workspace, 'reviews/review-1.json'), 'utf8')).includes('"pass"'));
  assert.ok((await readFile(join(workspace, 'reviews/review-2.json'), 'utf8')).includes('"pass"'));

  console.log(JSON.stringify({
    status: printed.status,
    filesWritten: ['src/double.mjs', 'test/double.test.mjs', 'reviews/review-1.json', 'reviews/review-2.json'],
    testCommandsRun: 2,
    threshold: '1 of 2',
    reviewerCalls: [1, 1],
    mode,
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
