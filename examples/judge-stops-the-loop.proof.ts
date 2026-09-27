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
  // The scripted answers follow the shape of a real run of this team over a docs
  // page (record 2026-09-27T16-09-12-984Z). Its judge answered, round 1:
  //   {"holds":{"type":"noul","noul":0.05},"worth_doing":{"type":"noul","noul":0.79},"worth_another_round":{"type":"noul","noul":0.63},"stop_reason":{"type":"choice","choice":"continue","confidence":0.54,"probabilities":{"not_converging":0.03,"continue":0.66,"over_polishing":0.16,"holds":0.15}}}
  // and round 2:
  //   {"holds":{"type":"noul","noul":0.07},"worth_doing":{"type":"noul","noul":0.79},"worth_another_round":{"type":"noul","noul":0.63},"stop_reason":{"type":"choice","choice":"continue","confidence":0.51,"probabilities":{"over_polishing":0.14,"holds":0.07,"not_converging":0.15,"continue":0.64}}}
  // The record's kickback lines:
  //   route -> write: "round 1: the judge says another round is worth it (0.63); 6 block, 4 should, 0 nit" (1 of 6)
  //   route -> write: "round 2: the judge says another round is worth it (0.63); 3 block, 7 should, 0 nit" (2 of 6)
  // Here the judge chooses `holds` on round 2, so the proof shows the stop as well as the round that went back.
  await writeFile(join(workspace, 'judge.json'), `${JSON.stringify([
    {
      holds: { type: 'noul', noul: 0.1 },
      worth_doing: { type: 'noul', noul: 0.8 },
      worth_another_round: { type: 'noul', noul: 0.7 },
      stop_reason: { type: 'choice', choice: 'continue', confidence: 0.5 },
    },
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
        { writes: { 'docs/getting-started.md': draft1 }, reply: 'Rewrote the page from the brief.' },
        { writes: { 'docs/getting-started.md': draft2 }, reply: 'Changed the two sentences the findings named.' },
      ],
      codex: [
        {
          reply: [
            '[block] "Bootstrap the toolchain with the CLI." "Bootstrap" and "toolchain" are words the reader has not met. Rewrite: "Install the tool with one command."',
            '[block] "The daemon supervises execution." "Daemon" and "supervises" name the mechanism, not what the reader gets. Rewrite: "The runner keeps the work going if your terminal closes."',
          ].join('\n'),
        },
        { reply: 'Nothing fails.' },
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
  assert.equal(printed.rounds, 2);
  assert.equal(printed.approved, true);
  assert.match(printed.stop, /^round 2: the judge stopped it, reason holds/);

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string; reply: string });
  const claudeCalls = calls.filter((call) => call.role === 'claude');
  const codexCalls = calls.filter((call) => call.role === 'codex');
  assert.equal(claudeCalls.length, 2, 'the writer runs twice: the draft, then the two sentences the findings named');
  assert.equal(codexCalls.length, 2, 'the reader reads both drafts');
  assert.equal(codexCalls[1]!.reply, 'Nothing fails.');

  interface RecordedEvent {
    readonly kind: string;
    readonly label?: string;
    readonly from?: string;
    readonly to?: string;
    readonly reason?: string;
    readonly accepted?: boolean;
    readonly count?: number;
    readonly limit?: number;
    readonly outcome?: { status: string; summary?: string; data?: unknown };
  }
  const record = (await readFile(join(workspace, 'records/judge-stops-the-loop.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
  const kickbacks = record.filter((event) => event.kind === 'dag:kickback');
  assert.equal(kickbacks.length, 1, 'the one round with blocks goes back once');
  assert.equal(kickbacks[0]!.from, 'route');
  assert.equal(kickbacks[0]!.to, 'write');
  assert.equal(kickbacks[0]!.accepted, true);
  assert.equal(kickbacks[0]!.count, 1);
  assert.equal(kickbacks[0]!.limit, 3);
  assert.equal(kickbacks[0]!.reason, 'round 1: 2 block findings always go back; 2 block, 0 should, 0 nit');
  const jobEnds = record.filter((event) => event.kind === 'job:end');
  const judgeAnswers = jobEnds.filter((event) => event.label === 'judge')
    .map((event) => (JSON.parse(String(event.outcome!.data)) as { stop_reason: { choice: string } }).stop_reason.choice);
  assert.deepEqual(judgeAnswers, ['continue', 'holds'], 'the judge answered once per round: continue, then holds');
  const routeEnds = jobEnds.filter((event) => event.label === 'route');
  assert.equal(routeEnds[routeEnds.length - 1]!.outcome!.status, 'pass');
  assert.match(routeEnds[routeEnds.length - 1]!.outcome!.summary ?? '', /^round 2: the judge stopped it, reason holds/);
  const approveEnds = jobEnds.filter((event) => event.label === 'approve');
  assert.equal(approveEnds.length, 1);
  assert.equal(approveEnds[0]!.outcome!.status, 'pass');

  assert.equal(await readFile(join(workspace, 'docs/getting-started.md'), 'utf8'), draft2);

  console.log(JSON.stringify({
    status: printed.status,
    writerRuns: 2,
    readerRuns: 2,
    judgeAnswers,
    kickbacks: 1,
    kickbackReason: kickbacks[0]!.reason,
    stop: printed.stop,
    approved: true,
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
