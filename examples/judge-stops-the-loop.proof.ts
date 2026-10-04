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

const draft3 = [
  '---',
  'title: Getting started',
  '---',
  '',
  'In your project folder, install the tool with one command. The runner keeps the work going if your terminal closes.',
  '',
  '```bash',
  'npx obversa init',
  '```',
  '',
].join('\n');
const whereToRun = '"Install the tool with one command." The page never says where to run it. Rewrite: "In your project folder, install the tool with one command."';
const shorterRunner = '"The runner keeps the work going if your terminal closes." A matter of taste. Rewrite: "The work goes on if your terminal closes."';
const shorterInstall = '"In your project folder, install the tool with one command." A matter of taste. Rewrite: "Install the tool from your project folder."';

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
  // The judge is asked every round, and decides each finding. Round 1: it
  // acts on both blocks. Round 2: it acts on the missing folder (finding-1)
  // and skips the taste note (finding-2). Round 3: it skips the one taste
  // note left.
  await writeFile(join(workspace, 'judge.json'), `${JSON.stringify([
    {
      holds: { type: 'noul', noul: 0.1 },
      worth_doing: { type: 'noul', noul: 0.9 },
      worth_another_round: { type: 'noul', noul: 0.9 },
      stop_reason: { type: 'choice', choice: 'continue', confidence: 0.8 },
      'finding-1': { type: 'choice', choice: 'act', confidence: 0.9 },
      'finding-2': { type: 'choice', choice: 'act', confidence: 0.9 },
    },
    {
      holds: { type: 'noul', noul: 0.3 },
      worth_doing: { type: 'noul', noul: 0.7 },
      worth_another_round: { type: 'noul', noul: 0.7 },
      stop_reason: { type: 'choice', choice: 'continue', confidence: 0.7 },
      'finding-1': { type: 'choice', choice: 'act', confidence: 0.8 },
      'finding-2': { type: 'choice', choice: 'skip', confidence: 0.9 },
    },
    {
      holds: { type: 'noul', noul: 0.9 },
      worth_doing: { type: 'noul', noul: 0.2 },
      worth_another_round: { type: 'noul', noul: 0.1 },
      stop_reason: { type: 'choice', choice: 'holds', confidence: 0.8 },
      'finding-1': { type: 'choice', choice: 'skip', confidence: 0.9 },
    },
  ], null, 2)}\n`);
  await writeFile(join(workspace, 'approve.json'), '{"approved": true}\n');
  await writeFile(
    join(workspace, '.obversa-stand-in.json'),
    `${JSON.stringify({
      claude: [
        { writes: { 'docs/getting-started.md': draft1 }, reply: '{"status":"pass","summary":"Rewrote the page from the brief."}' },
        { writes: { 'docs/getting-started.md': draft2 }, reply: '{"status":"pass","summary":"Changed the two sentences the findings named."}' },
        { writes: { 'docs/getting-started.md': draft3 }, reply: '{"status":"pass","summary":"Said where to run the command."}' },
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
            summary: 'One sentence leaves out where to run the command; one could be shorter.',
            findings: [
              { severity: 'should-fix', evidence: whereToRun },
              { severity: 'nice-to-have', evidence: shorterRunner },
            ],
          }),
        },
        {
          reply: JSON.stringify({
            status: 'revise',
            summary: 'One sentence could be shorter.',
            findings: [
              { severity: 'nice-to-have', evidence: shorterInstall },
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
  assert.equal(printed.stop, 'the judge skipped every finding');

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; reply: string });
  const claudeCalls = calls.filter((call) => call.role === 'claude');
  const codexCalls = calls.filter((call) => call.role === 'codex');
  assert.equal(claudeCalls.length, 3, 'the writer runs three times: the draft, the two blocks the judge acted on, then the one finding it acted on next');
  assert.equal(codexCalls.length, 3, 'the reader reads all three drafts');

  interface RecordedEvent {
    readonly kind: string;
    readonly label?: string;
    readonly path?: readonly string[];
    readonly reason?: string;
    readonly accepted?: boolean;
    readonly answers?: { readonly stop_reason?: { readonly choice?: string } };
    readonly findings?: readonly { readonly id: string; readonly decision: string; readonly reason: string }[];
    readonly outcome?: { status: string; summary?: string; data?: unknown; revision?: { findings?: readonly { evidence: string; severity?: string }[] } };
  }
  const record = (await readFile(join(workspace, 'records/judge-stops-the-loop.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
  const writerRuns = record.filter((event) => event.kind === 'job:start' && event.label === 'write' && event.path?.at(-1) === 'write-review');
  assert.equal(writerRuns.length, 3, 'the record shows three writer runs');
  const kickbacks = record.filter((event) => event.kind === 'loop:review' && event.accepted === true);
  assert.equal(kickbacks.length, 2, 'the round with blocks goes back, then the round with a finding the judge acted on');
  assert.deepEqual(kickbacks[0]!.outcome!.revision?.findings?.map((finding) => finding.severity), ['block', 'block'], 'the first round that went back carried the two block findings');
  assert.deepEqual(kickbacks[1]!.outcome!.revision?.findings?.map((finding) => finding.evidence), [whereToRun],
    'the second send-back carries only the finding the judge acted on');
  const judged = record.filter((event) => event.kind === 'refine:judge');
  assert.deepEqual(judged.map((event) => event.findings?.map(({ id, decision }) => `${id}: ${decision}`)), [
    ['finding-1: act', 'finding-2: act'],
    ['finding-1: act', 'finding-2: skip'],
    ['finding-1: skip'],
  ], 'the judge is asked on every round, the one with blocks included, and decides each finding');
  assert.ok(judged.flatMap((event) => event.findings ?? []).every((finding) => finding.reason.length > 0), 'every decision has a reason');
  assert.equal(judged[2]!.reason, 'the judge skipped every finding');
  const approveEnds = record.filter((event) => event.kind === 'job:end' && event.label === 'approve');
  assert.equal(approveEnds.length, 2, 'one approval: the approve stage and the approval it calls each log one end');
  assert.ok(approveEnds.every((event) => event.outcome!.status === 'pass'), 'the approval passes');

  assert.equal(await readFile(join(workspace, 'docs/getting-started.md'), 'utf8'), draft3);

  console.log(JSON.stringify({
    status: printed.status,
    writerRuns: writerRuns.length,
    readerRuns: codexCalls.length,
    kickbacks: kickbacks.length,
    judgeReasons: judged.map((event) => event.reason),
    decisions: judged.map((event) => event.findings?.map(({ id, decision }) => `${id}: ${decision}`)),
    stop: printed.stop,
    approved: true,
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
