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

const pass = (summary: string): string => JSON.stringify({ status: 'pass', summary });

// The stand-in executables live beside the workspace, not inside it: a read-only
// reviewer's workspace guard refuses a symlink under the workspace that resolves
// outside it, and the stand-in is a symlink to a script in the repository.
const root = await mkdtemp(join(tmpdir(), 'obversa-team-feature-proof-'));
const workspace = join(root, 'workspace');
const bin = join(root, 'bin');
try {
  await mkdir(join(workspace, 'briefs'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(workspace, 'briefs/triple.md'), '---\nfiles: ["src/triple.mjs"]\n---\n\nDeliver a pure triple(value) function in src/triple.mjs with a Node test in test/triple.test.mjs.\n');
  await writeFile(
    join(workspace, '.obversa-stand-in.json'),
    JSON.stringify({
      claude: [
        { writes: { 'team-output/research-context.md': 'The workspace context is recorded.\n' }, reply: pass('analysis note written') },
        { writes: { 'team-output/research-requirements.md': 'REQ-1: Export triple.\nREQ-2: Test triple.\n' }, reply: pass('requirements written') },
        { writes: { 'team-output/plan.md': 'REQ-1: Source exports triple. Check: source exists.\nREQ-2: Test covers triple. Check: command exits 0.\n' }, reply: pass('plan written') },
        { writes: {}, reply: pass('tests reviewed') },
        { writes: {}, reply: pass('review accepted') },
      ],
      codex: [
        { writes: {}, reply: pass('research accepted') },
        { writes: {}, reply: pass('requirements accepted') },
        { writes: {}, reply: pass('plan accepted') },
        { writes: { 'test/triple.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { triple } from '../src/triple.mjs';\ntest('triple returns three times the input', () => assert.equal(triple(3), 9));\n" }, reply: pass('tests written first') },
        { writes: { 'src/triple.mjs': 'export const triple = (value) => value * 10;\n' }, reply: pass('first implementation written') },
        { writes: { 'src/triple.mjs': 'export const triple = (value) => value * 3;\n' }, reply: pass('implementation repaired') },
      ],
    }, null, 2) + '\n',
  );
  const callsLog = join(workspace, '.obversa-stand-in-calls.log');
  for (const name of ['claude', 'codex', 'opencode']) {
    await symlink(standIn, join(bin, name));
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
      PATH: `${bin}:${process.env.PATH ?? ''}`,
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

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; reply: string; writes: Record<string, string> });
  const implementerCalls = calls.filter((call) => call.role === 'codex').filter((call) => 'src/triple.mjs' in call.writes);
  assert.equal(implementerCalls.length, 2, 'the implementer runs once and repairs once');
  assert.match(implementerCalls[0]!.writes['src/triple.mjs'] ?? '', /value \* 10/, 'the first draft fails the test');
  assert.match(implementerCalls[1]!.writes['src/triple.mjs'] ?? '', /value \* 3/, 'the repair passes the test');
  assert.equal(calls.filter((call) => call.role === 'claude').length, 5, 'three analysis notes and two reviews');

  assert.match(await readFile(join(workspace, 'src/triple.mjs'), 'utf8'), /triple = \(value\) => value \* 3/);
  assert.match(await readFile(join(workspace, 'team-output/plan.md'), 'utf8'), /REQ-2/);
  assert.ok(await readFile(join(workspace, 'test/triple.test.mjs'), 'utf8'), 'the test file exists');

  console.log(JSON.stringify({
    status: printed.status,
    stages: 9,
    implementationIterations: 2,
    reviewRounds: 2,
    kickbacks: 1,
    pausedAt: 'approve',
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
