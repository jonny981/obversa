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

const page = (body: string) => ['---', 'title: Getting started', '---', '', body, '', '```bash', 'npx obversa init', '```', ''].join('\n');
const original = page('Bootstrap the toolchain via the CLI. The daemon supervises execution.');
const draft1 = page('Bootstrap the toolchain with the CLI. The daemon supervises execution.');
const draft2 = page('Install the tool with one command. The runner keeps the work going if your terminal closes.');
const reply = (summary: string) => JSON.stringify({ status: 'pass', summary });

const root = await mkdtemp(join(tmpdir(), 'obversa-mastra-proof-'));
const workspace = join(root, 'workspace');
const bin = join(root, 'bin');
try {
  await mkdir(join(workspace, 'briefs'), { recursive: true });
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(workspace, 'briefs/page.md'), [
    '---',
    'files: ["docs/getting-started.md"]',
    '---',
    '',
    'Use case: a developer who has just installed the tool reads this page once and runs the first command without asking anyone.',
    '',
    'Rewrite docs/getting-started.md so a person reads it once and knows what to do. Keep the front matter and the code block exactly as they are.',
    '',
  ].join('\n'));
  await writeFile(join(workspace, 'docs/getting-started.md'), original);
  // The Mastra agent's model, replayed: each round the agent calls its own
  // saveFile tool, then replies. Mastra runs the tool between the two turns.
  await writeFile(join(workspace, 'writer.json'), `${JSON.stringify([
    { save: { path: 'docs/getting-started.md', text: draft1 } },
    { text: reply('Rewrote the page from the brief.') },
    { save: { path: 'docs/getting-started.md', text: draft2 } },
    { text: reply('Changed the two sentences the findings named.') },
  ], null, 2)}\n`);
  // The judge is asked only when a round has no block: here, round 2, where
  // the one finding left is taste and the judge chooses `holds`.
  await writeFile(join(workspace, 'judge.json'), `${JSON.stringify([
    {
      holds: { type: 'noul', noul: 0.9 },
      worth_doing: { type: 'noul', noul: 0.2 },
      worth_another_round: { type: 'noul', noul: 0.1 },
      stop_reason: { type: 'choice', choice: 'holds', confidence: 0.8 },
    },
  ], null, 2)}\n`);
  await writeFile(
    join(workspace, '.obversa-stand-in.json'),
    `${JSON.stringify({
      codex: [
        {
          reply: JSON.stringify({
            status: 'revise',
            summary: 'Two sentences use words the reader has not met.',
            findings: [
              { severity: 'block', evidence: '"Bootstrap the toolchain with the CLI." "Bootstrap" and "toolchain" are words the reader has not met. Rewrite: "Install the tool with one command."' },
              { severity: 'block', evidence: '"The daemon supervises execution." It names the mechanism, not what the reader gets. Rewrite: "The runner keeps the work going if your terminal closes."' },
            ],
          }),
        },
        {
          reply: JSON.stringify({
            status: 'revise',
            summary: 'One sentence could be shorter.',
            findings: [
              { severity: 'nice-to-have', evidence: '"The runner keeps the work going if your terminal closes." A matter of taste.' },
            ],
          }),
        },
      ],
    }, null, 2)}\n`,
  );
  const callsLog = join(workspace, '.obversa-stand-in-calls.log');
  await symlink(standIn, join(bin, 'codex'));

  // Inside a fresh consumer there is no packages/runtime/tsconfig.json; tsx then
  // reads the nearest tsconfig, which is the consumer's own.
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, 'engine-mastra.js');
  const child = existsSync(compiled)
    ? { file: process.execPath, args: [compiled] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, 'engine-mastra.ts')] };
  const started = Date.now();
  const run = spawnSync(child.file, child.args, {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      // The proof is offline: Mastra's own switch keeps it from sending usage data.
      MASTRA_TELEMETRY_DISABLED: '1',
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
  assert.equal(printed.stop, 'the judge chose holds');

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string });
  const readerRuns = calls.filter((call) => call.role === 'codex').length;
  assert.equal(readerRuns, 2, 'the reader reads both drafts');

  interface RecordedEvent {
    readonly kind: string;
    readonly label?: string;
    readonly path?: readonly string[];
    readonly reason?: string;
    readonly accepted?: boolean;
    readonly role?: string;
    readonly model?: string;
    readonly usage?: unknown;
    readonly answers?: { readonly stop_reason?: { readonly choice?: string } };
    readonly outcome?: { status: string; summary?: string };
  }
  const record = (await readFile(join(workspace, 'records/mastra-writer.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
  const writerRuns = record.filter((event) => event.kind === 'job:start' && event.label === 'write' && event.path?.at(-1) === 'write-review');
  assert.equal(writerRuns.length, 2, 'the record shows two runs of the Mastra writer');
  const writerUsage = record.filter((event) => event.kind === 'engine:usage' && event.role === 'writer');
  assert.deepEqual(
    writerUsage.map((event) => [event.model, event.usage]),
    [1, 2].map(() => ['replayed-writer', { kind: 'reported', inputTokens: 800, outputTokens: 240 }]),
    'each writer run records the usage Mastra reports for its two model turns',
  );
  const kickbacks = record.filter((event) => event.kind === 'loop:review' && event.accepted === true);
  assert.equal(kickbacks.length, 1, 'the one round with blocks goes back once');
  assert.match(kickbacks[0]!.outcome!.summary ?? '', /\[block\]/, 'the round that went back carried block findings');
  const judged = record.filter((event) => event.kind === 'refine:judge');
  assert.deepEqual(judged.map((event) => event.answers?.stop_reason?.choice), ['holds'], 'the judge is asked once, on the round with no block, and chooses holds');

  assert.equal(await readFile(join(workspace, 'docs/getting-started.md'), 'utf8'), draft2, 'the page is the one the agent saved with its own tool');

  console.log(JSON.stringify({
    status: printed.status,
    writerRuns: writerRuns.length,
    readerRuns,
    kickbacks: kickbacks.length,
    judgeReasons: judged.map((event) => event.reason),
    stop: printed.stop,
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
