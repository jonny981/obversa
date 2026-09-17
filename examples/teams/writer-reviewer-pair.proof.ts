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

// The stand-in executables live beside the workspace, not inside it: a read-only
// reviewer's workspace guard refuses a symlink under the workspace that resolves
// outside it, and the stand-in is a symlink to a script in the repository.
const root = await mkdtemp(join(tmpdir(), 'obversa-team-pair-proof-'));
const workspace = join(root, 'workspace');
const bin = join(root, 'bin');
try {
  await mkdir(join(workspace, 'briefs'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(workspace, 'briefs/add.md'), '---\nfiles: ["src/add.mjs"]\n---\n\nWrite a pure add(a, b) function in src/add.mjs with a Node test in test/add.test.mjs.\n');
  const files = {
    'src/add.mjs': 'export const add = (a, b) => a + b;\n',
    'test/add.test.mjs': "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/add.mjs';\ntest('add sums two values', () => assert.equal(add(2, 3), 5));\n",
  };
  await writeFile(
    join(workspace, '.obversa-stand-in.json'),
    JSON.stringify({
      claude: [
        { writes: files, reply: '{"status":"pass","summary":"writer wrote the files"}' },
        { writes: files, reply: '{"status":"pass","summary":"writer applied the review"}' },
      ],
      codex: [
        { writes: { 'reviews/review-1.json': '{"status":"revise"}\n' }, reply: '{"status":"revise","summary":"review requested one repair","findings":[{"severity":"block","evidence":"the implementation needs one repair"}]}' },
        { writes: { 'reviews/review-2.json': '{"status":"pass"}\n' }, reply: '{"status":"pass","summary":"review accepted the repaired files"}' },
      ],
    }, null, 2) + '\n',
  );
  const callsLog = join(workspace, '.obversa-stand-in-calls.log');
  for (const name of ['claude', 'codex', 'opencode']) {
    await symlink(standIn, join(bin, name));
  }

  // Inside a fresh consumer there is no packages/runtime/tsconfig.json; tsx then
  // reads the nearest tsconfig, which is the consumer's own.
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, 'writer-reviewer-pair.js');
  const child = existsSync(compiled)
    ? { file: process.execPath, args: [compiled] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, 'writer-reviewer-pair.ts')] };
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
  assert.equal(printed.status, 'pass');

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; reply: string });
  const writerCalls = calls.filter((call) => call.role === 'claude');
  const reviewerCalls = calls.filter((call) => call.role === 'codex');
  assert.equal(writerCalls.length, 2, 'the writer runs once and applies the review once');
  assert.equal(reviewerCalls.length, 2, 'the reviewer revises once and accepts once');
  assert.match(reviewerCalls[0]!.reply, /"status":"revise"/, 'the first review sends the work back');
  assert.match(reviewerCalls[1]!.reply, /"status":"pass"/, 'the second review accepts');

  assert.match(await readFile(join(workspace, 'src/add.mjs'), 'utf8'), /add =/);
  assert.ok((await readFile(join(workspace, 'reviews/review-1.json'), 'utf8')).includes('"revise"'));
  assert.ok((await readFile(join(workspace, 'reviews/review-2.json'), 'utf8')).includes('"pass"'));

  console.log(JSON.stringify({
    status: printed.status,
    filesWritten: ['src/add.mjs', 'test/add.test.mjs', 'reviews/review-1.json', 'reviews/review-2.json'],
    testCommandsRun: 2,
    reviewerKickbacks: 1,
    modelFamilies: ['claude', 'gpt'],
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
