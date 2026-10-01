import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { runAnswering } from '../use-cases/proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = (() => {
  // The repo root is the nearest directory with a package.json: the
  // repository and the throwaway consumer have different depths.
  let dir = here;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('no package.json above the proof');
})();
const standIn = join(repo, 'scripts', 'stand-in-cli.mjs');

const ticket = 'Deliver a pure triple(value) function in src/triple.mjs. A Node test for it is at test/triple.test.mjs. This is a feature: no existing triple function exists yet.\n';
const testFile = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { triple } from '../src/triple.mjs';",
  "test('triple returns three times the input', () => assert.equal(triple(3), 9));",
  '',
].join('\n');

// The judge only needs to be asked once here: review clears on its second
// attempt, so the loop never asks a second time. The second entry is a safe
// fallback (stop the loop) if an unexpected extra round ever reaches it.
const jev = {
  triage: [{ kind: { choice: 'feature' }, risk: { score: 0.4 } }],
  judge: [{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'holds' } }],
};

const evidence = "Triage read the ticket and called it a feature. Research iterated once before the panel cleared the plan. The tournament ran two candidates in their own worktrees; Codex's passed the test and landed, Claude's produced nothing. The review panel rejected the first cut on a naming finding, a judge said another round was worth it, and Codex's rename cleared the second review. The exact bytes were approved by sha.\n";

// Claude writes the plan (twice, once per research round) and, round-robin,
// lands on this same third entry for every later claude call: the tournament's
// candidate-0 (designed to lose) and the close step both read it. It writes
// only evidence.md, never src/triple.mjs, so candidate-0 always fails its own
// "did you produce anything" check and close never touches the shipped file.
const standInScript = {
  claude: [
    { writes: { 'team-output/plan.md': 'REQ-1: triple multiplies by 3.\n' }, reply: 'wrote the plan' },
    { writes: { 'team-output/plan.md': 'REQ-1: triple multiplies by 3. Check: source exists.\n' }, reply: 'revised the plan' },
    { writes: { 'team-output/evidence.md': evidence }, reply: 'the candidate produced nothing' },
  ],
  codex: [
    { reply: JSON.stringify({ status: 'revise', summary: 'missing a check', findings: [{ severity: 'should-fix', evidence: 'no check named' }] }) },
    { reply: JSON.stringify({ status: 'pass', summary: 'plan covers it' }) },
    { writes: { 'src/triple.mjs': 'export const triple = (value) => value * 3;\n' }, reply: 'implemented the plan' },
    {
      writes: { 'src/triple.mjs': 'export const triple = (value) => value * 3; // named clearly\n' },
      reply: JSON.stringify({ status: 'revise', summary: 'variable name is unclear', findings: [{ severity: 'should-fix', evidence: 'name the parameter' }] }),
    },
    { reply: JSON.stringify({ status: 'pass', summary: 'the rename covers it' }) },
  ],
  opencode: [
    { reply: JSON.stringify({ status: 'revise', summary: 'name is unclear', findings: [{ severity: 'should-fix', evidence: 'triple could be clearer' }] }) },
  ],
};

interface RecordedEvent {
  readonly kind: string;
  readonly path?: readonly string[];
  readonly identity?: string;
  readonly node?: string;
  readonly phase?: string;
  readonly attempt?: number;
  readonly label?: string;
  readonly from?: string;
  readonly to?: string;
  readonly accepted?: boolean;
  readonly count?: number;
  readonly limit?: number;
  readonly answers?: unknown;
  readonly outcome?: { status: string; summary?: string; data?: unknown };
}

async function seedWorkspace(dir: string, bin: string): Promise<void> {
  await mkdir(join(dir, 'briefs'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(dir, 'briefs/ticket.md'), ticket);
  await writeFile(join(dir, 'test/triple.test.mjs'), testFile);
  await writeFile(join(dir, 'triage.json'), JSON.stringify(jev.triage, null, 2));
  await writeFile(join(dir, 'judge.json'), JSON.stringify(jev.judge, null, 2));
  await writeFile(join(dir, '.obversa-stand-in.json'), JSON.stringify(standInScript, null, 2));
  for (const name of ['claude', 'codex', 'opencode']) await symlink(standIn, join(bin, name));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Example');
  git('config', 'user.email', 'example@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: seed the ticket');
}

function exampleChild(extraArgs: readonly string[] = []) {
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, 'feature-delivery.js');
  return existsSync(compiled)
    ? { file: process.execPath, args: [compiled, ...extraArgs] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, 'feature-delivery.ts'), ...extraArgs] };
}

function runExample(dir: string, bin: string, extraArgs: readonly string[] = []) {
  const child = exampleChild(extraArgs);
  return spawnSync(child.file, child.args, {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function readRecord(dir: string): RecordedEvent[] {
  return readFileSync(join(dir, 'records/feature-delivery.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
}
function doneNode(record: RecordedEvent[], node: string, attempt: number): RecordedEvent {
  const found = record.find((e) => e.kind === 'dag:node' && e.phase === 'done' && e.node === node && e.attempt === attempt);
  assert.ok(found, `no dag:node done event for "${node}" attempt ${attempt}`);
  return found!;
}

const root = await mkdtemp(join(tmpdir(), 'obversa-feature-delivery-proof-'));
const workspace = join(root, 'workspace');
const bin = join(root, 'bin');
try {
  await seedWorkspace(workspace, bin);

  // The run waits for the person's yes; the proof gives it on the run's page.
  const child = exampleChild();
  const run = await runAnswering(child.file, child.args, {
    cwd: workspace,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    timeoutMs: 120_000,
    answer: { approved: true },
  });
  const mode = existsSync(join(here, 'feature-delivery.js')) ? 'compiled-from-dist'
    : existsSync(join(repo, 'packages', 'runtime', 'tsconfig.json')) ? 'repo-tsx' : 'consumer-tsx';
  assert.equal(run.status, 0, `the example child exited ${run.status ?? `signal ${run.signal}`} in ${mode} mode
  stdout: ${run.stdout}
  stderr: ${run.stderr}`);
  const printed = JSON.parse(run.stdout.slice(run.stdout.lastIndexOf('\n{') + 1));
  assert.equal(printed.status, 'pass');
  assert.match(printed.summary, /all 7 node\(s\) green/);

  // 1. Triage chose feature, so research and the rest of the pipeline ran.
  const record = readRecord(workspace);
  const triage = doneNode(record, 'triage', 1);
  assert.equal(triage.outcome!.status, 'pass');
  assert.match(triage.outcome!.summary ?? '', /"choice":"feature"/);

  // 2. Research (the nested workflow()) accepted the plan on its second round.
  const loopIterations = record.filter((e) => e.kind === 'loop:iteration');
  assert.equal(loopIterations.length, 2, 'research refines the plan once before the panel clears it');
  const research = doneNode(record, 'research', 1);
  assert.equal(research.outcome!.status, 'pass');

  // 3. The tournament ran two candidates; the test-passing one won, twice
  // (once per implement attempt, since round 1's review sends it back).
  const implement1 = doneNode(record, 'implement', 1);
  const implement2 = doneNode(record, 'implement', 2);
  for (const node of [implement1, implement2]) {
    assert.equal(node.outcome!.status, 'pass');
    assert.match(node.outcome!.summary ?? '', /landed candidate 1 \(score 1\) of 2/);
  }
  const candidateEnds = record.filter((e) => e.kind === 'job:end' && (e.label === 'candidate-0' || e.label === 'candidate-1'));
  assert.ok(candidateEnds.some((e) => e.label === 'candidate-0' && e.outcome!.status === 'fail'), "Claude's candidate never produces src/triple.mjs, so it always loses");
  assert.ok(candidateEnds.filter((e) => e.label === 'candidate-1' && e.outcome!.status === 'pass').length >= 2, "Codex's candidate wins both rounds");

  // 4. review ran twice: rejected round 1, cleared round 2 (pass:1 needs only
  // one of the two reviewers).
  const review1 = doneNode(record, 'review', 1);
  const review2 = doneNode(record, 'review', 2);
  assert.equal(review1.outcome!.status, 'fail');
  assert.equal(review2.outcome!.status, 'pass');

  // The visible `judge(judgeSeat, { cap: 4 })` on the panel's kickback target was
  // consulted for real: it answered once, said the round was worth it, and
  // the dag accepted exactly the one kickback that produced.
  const judgeCalls = record.filter((e) => e.kind === 'refine:judge');
  assert.equal(judgeCalls.length, 1, 'review only fails once, so the judge is asked once');
  assert.equal((judgeCalls[0]!.answers as { stop_reason: { choice: string } }).stop_reason.choice, 'continue');
  const kickbacks = record.filter((e) => e.kind === 'dag:kickback');
  assert.equal(kickbacks.length, 1);
  assert.equal(kickbacks[0]!.from, 'review');
  assert.equal(kickbacks[0]!.to, 'implement');
  assert.equal(kickbacks[0]!.accepted, true);
  assert.equal(kickbacks[0]!.count, 1);
  assert.equal(kickbacks[0]!.limit, 4);

  // 5. The run waits at approve and prints a page. The proof reads the
  // question there while it is pending, so the run was still going and the
  // step had not ended. The question carries the sha256 of the exact bytes
  // that landed, and the yes given on the page passes the step.
  const shippedBytes = await readFile(join(workspace, 'src/triple.mjs'));
  const sha256 = createHash('sha256').update(shippedBytes).digest('hex');
  assert.match(run.stdout, /http:\/\/127\.0\.0\.1:\d+\//, 'the run prints the page to answer on');
  assert.ok(run.question?.includes(sha256.slice(0, 12)), `the page shows the question with the landed file's own sha256: ${run.question}`);
  const approve = doneNode(record, 'approve', 2);
  assert.equal(approve.outcome!.status, 'pass');
  assert.ok((approve.outcome!.summary ?? '').includes(sha256.slice(0, 12)), "the approval names the landed file's own sha256");
  const nodeStarts = (node: string) => record.filter((e) => e.kind === 'dag:node' && e.phase === 'start' && e.node === node).length;
  assert.equal(nodeStarts('approve'), 1, 'approve starts once: waiting for the answer starts nothing again');
  assert.equal(nodeStarts('review'), 2, 'review starts once per implement attempt, not again for the answer');

  // 6. Close wrote its evidence from the record alone, and never touched the
  // shipped file or the plan while doing it.
  const close = doneNode(record, 'close', 2);
  assert.equal(close.outcome!.status, 'pass');
  const closeEvidence = await readFile(join(workspace, 'team-output/evidence.md'), 'utf8');
  assert.equal(closeEvidence, evidence);

  const calls = (await readFile(join(workspace, '.obversa-stand-in-calls.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string });
  const byRole = (role: string) => calls.filter((c) => c.role === role).length;

  // 7. Resume. A finished node is reused on --resume the way a finished
  // workflow stage is: the record's pass stands in for running it again.
  const resumed = runExample(workspace, bin, ['--resume']);
  assert.equal(resumed.status, 0, `the resumed example exited ${resumed.status ?? `signal ${resumed.signal}`}
  stdout: ${resumed.stdout}
  stderr: ${resumed.stderr}`);
  const resumedRecord = readRecord(workspace);
  const runStarts = resumedRecord.map((e, i) => (e.kind === 'run:start' ? i : -1)).filter((i) => i >= 0);
  assert.equal(runStarts.length, 2, 'resume appends to the same record rather than starting a fresh file');
  const secondRun = resumedRecord.slice(runStarts[1]!);
  assert.equal(
    secondRun.filter((e) => e.kind === 'job:start').length,
    0,
    'a resumed run starts no job: triage, the tournament, test, review, approve, close and research\'s stages are all reused',
  );
  for (const node of ['triage', 'research', 'implement', 'test', 'review', 'approve', 'close']) {
    const done = secondRun.find((e) => e.kind === 'dag:node' && e.node === node && e.phase === 'done');
    assert.equal(done?.outcome?.status, 'pass', `"${node}" has no recorded pass in the resumed run`);
  }
  // Across both runs, triage's job started once and implement's once per
  // attempt of the first run (review sent it back once): none in the resumed run.
  const jobStarts = (label: string) => resumedRecord.filter((e) => e.kind === 'job:start' && e.label === label).length;
  assert.equal(jobStarts('triage'), 1, 'triage started once across the first run and the resumed run');
  assert.equal(jobStarts('implement'), 2, 'implement started once per first-run attempt and not again on resume');
  const runEnd = secondRun.find((e) => e.kind === 'run:end');
  assert.equal(runEnd?.outcome?.status, 'pass', 'the resumed run did not pass');
  const anchors = resumedRecord.filter((e) => e.kind === 'workflow:start' && e.path?.join('/') === 'feature-delivery');
  assert.equal(anchors.length, 2, 'one resume anchor per run:start');
  assert.equal(anchors[0]!.identity, anchors[1]!.identity, 'the resumed run matched the same declared shape');

  // 8. With approve.json beside the file, the answer comes from it. A fresh
  // run with that file and nobody on the page ends on its own: a question
  // left pending would keep it waiting until the timeout. The file's note is
  // on the approval, so the file gave the answer.
  const fileWorkspace = join(root, 'with-approve-json');
  const fileBin = join(root, 'with-approve-json-bin');
  await seedWorkspace(fileWorkspace, fileBin);
  const fileNote = 'approved from approve.json';
  await writeFile(join(fileWorkspace, 'approve.json'), `${JSON.stringify({ approved: true, note: fileNote })}\n`);
  const fromFile = runExample(fileWorkspace, fileBin);
  assert.equal(fromFile.status, 0, `the run with approve.json exited ${fromFile.status ?? `signal ${fromFile.signal}`}
  stdout: ${fromFile.stdout}
  stderr: ${fromFile.stderr}`);
  assert.equal(JSON.parse(fromFile.stdout.slice(fromFile.stdout.lastIndexOf('\n{') + 1)).status, 'pass');
  const fileApprove = doneNode(readRecord(fileWorkspace), 'approve', 2);
  assert.equal(fileApprove.outcome!.status, 'pass');
  assert.deepEqual(fileApprove.outcome!.data, { approved: true, note: fileNote }, 'the answer is the one in approve.json');

  console.log(JSON.stringify({
    status: printed.status,
    triage: 'feature',
    researchRounds: 2,
    tournamentRounds: 2,
    reviewRounds: 2,
    judgeAnswers: judgeCalls.map((e) => (e.answers as { stop_reason: { choice: string } }).stop_reason.choice),
    kickbacks: kickbacks.length,
    approvedSha256: sha256.slice(0, 12),
    calls: { claude: byRole('claude'), codex: byRole('codex'), opencode: byRole('opencode') },
    resume: {
      exit: resumed.status,
      runStarts: 2,
      triageStarts: jobStarts('triage'),
      implementStarts: jobStarts('implement'),
      resumedJobStarts: secondRun.filter((e) => e.kind === 'job:start').length,
      note: 'finished nodes are reused on resume, like finished workflow stages',
    },
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
