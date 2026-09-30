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

const draft1 = [
  '---',
  'title: Getting started',
  '---',
  '',
  'Bootstrap the toolchain with the CLI. The daemon supervises execution.',
  '',
  '```bash',
  'npx obversa init',
  '```',
  '',
].join('\n');
const draft2 = [
  '---',
  'title: Getting started',
  '---',
  '',
  'Install the tool with one command. The runner keeps the work going if your terminal closes.',
  '',
  '```bash',
  'npx obversa init',
  '```',
  '',
].join('\n');

const root = await mkdtemp(join(tmpdir(), 'obversa-judge-proof-'));
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
    '## For the reader',
    '',
    'You did not write the page, and you change nothing. The front matter, code blocks and link targets are out of scope: the writer keeps them as they are, so a finding on them cannot be acted on.',
    '',
    'The use case sets the bar. Ask one question of every sentence: would a reader of this kind of page, described above, read it once and know what to do?',
    '',
    'What fails: a word the reader has never met used without the sentence saying what it is; a line that gives the mechanism where the reader wanted what they get; a claim the page does not support; a figure of speech a person would not use; a sentence a person would stumble over aloud.',
    '',
    'Report only the sentences that fail for this audience, worst first. Do not fill a list: three findings that matter beat ten that do not. "Nothing fails" is a good report when it is true; then the status is pass.',
    '',
    'Give each finding a severity. "block": a person would not understand it, or it claims something false. "should-fix": a person would say it differently. "nice-to-have": taste. In the evidence, quote the sentence, say in a few words why, and give the plainest rewrite a person would say. No praise.',
    '',
  ].join('\n'));
  await writeFile(join(workspace, 'docs/getting-started.md'), [
    '---',
    'title: Getting started',
    '---',
    '',
    'Bootstrap the toolchain via the CLI. The daemon supervises execution.',
    '',
    '```bash',
    'npx obversa init',
    '```',
    '',
  ].join('\n'));
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
  await writeFile(join(workspace, 'approve.json'), '{"approved": true}\n');
  await writeFile(
    join(workspace, '.obversa-stand-in.json'),
    `${JSON.stringify({
      claude: [
        { writes: { 'docs/getting-started.md': draft1 }, reply: '{"status":"pass","summary":"Rewrote the page from the brief."}' },
        { writes: { 'docs/getting-started.md': draft2 }, reply: '{"status":"pass","summary":"Changed the two sentences the findings named."}' },
      ],
      codex: [
        {
          reply: JSON.stringify({
            status: 'revise',
            summary: 'Two sentences use words the reader has not met.',
            findings: [
              { severity: 'block', evidence: '"Bootstrap the toolchain with the CLI." "Bootstrap" and "toolchain" are words the reader has not met. Rewrite: "Install the tool with one command."' },
              { severity: 'block', evidence: '"The daemon supervises execution." "Daemon" and "supervises" name the mechanism, not what the reader gets. Rewrite: "The runner keeps the work going if your terminal closes."' },
            ],
          }),
        },
        {
          reply: JSON.stringify({
            status: 'revise',
            summary: 'One sentence could be shorter.',
            findings: [
              { severity: 'nice-to-have', evidence: '"The runner keeps the work going if your terminal closes." A matter of taste. Rewrite: "The work goes on if your terminal closes."' },
            ],
          }),
        },
      ],
    }, null, 2)}\n`,
  );
  const callsLog = join(workspace, '.obversa-stand-in-calls.log');
  for (const name of ['claude', 'codex', 'opencode']) {
    await symlink(standIn, join(bin, name));
  }

  // Inside a fresh consumer there is no packages/runtime/tsconfig.json; tsx then
  // reads the nearest tsconfig, which is the consumer's own.
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, 'judge-stops-the-loop.js');
  const child = existsSync(compiled)
    ? { file: process.execPath, args: [compiled] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, 'judge-stops-the-loop.ts')] };
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
  assert.equal(printed.approved, true);
  assert.equal(printed.stop, 'the judge chose holds');

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; reply: string });
  const claudeCalls = calls.filter((call) => call.role === 'claude');
  const codexCalls = calls.filter((call) => call.role === 'codex');
  assert.equal(claudeCalls.length, 2, 'the writer runs twice: the draft, then the two sentences the findings named');
  assert.equal(codexCalls.length, 2, 'the reader reads both drafts');

  interface RecordedEvent {
    readonly kind: string;
    readonly label?: string;
    readonly path?: readonly string[];
    readonly reason?: string;
    readonly accepted?: boolean;
    readonly answers?: { readonly stop_reason?: { readonly choice?: string } };
    readonly outcome?: { status: string; summary?: string; data?: unknown };
  }
  const record = (await readFile(join(workspace, 'records/judge-stops-the-loop.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
  const writerRuns = record.filter((event) => event.kind === 'job:start' && event.label === 'write' && event.path?.at(-1) === 'write-review');
  assert.equal(writerRuns.length, 2, 'the record shows two writer runs');
  const kickbacks = record.filter((event) => event.kind === 'loop:review' && event.accepted === true);
  assert.equal(kickbacks.length, 1, 'the one round with blocks goes back once');
  assert.match(kickbacks[0]!.outcome!.summary ?? '', /\[block\]/, 'the round that went back carried block findings');
  const judged = record.filter((event) => event.kind === 'refine:judge');
  assert.deepEqual(judged.map((event) => event.answers?.stop_reason?.choice), ['holds'], 'the judge is asked once, on the round with no block, and chooses holds');
  assert.equal(judged[0]!.reason, 'the judge chose holds');
  const approveEnds = record.filter((event) => event.kind === 'job:end' && event.label === 'approve');
  assert.equal(approveEnds.length, 2, 'one approval: the approve stage and the approval it calls each log one end');
  assert.ok(approveEnds.every((event) => event.outcome!.status === 'pass'), 'the approval passes');

  assert.equal(await readFile(join(workspace, 'docs/getting-started.md'), 'utf8'), draft2);

  console.log(JSON.stringify({
    status: printed.status,
    writerRuns: writerRuns.length,
    readerRuns: codexCalls.length,
    kickbacks: kickbacks.length,
    judgeReasons: judged.map((event) => event.reason),
    stop: printed.stop,
    approved: true,
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
