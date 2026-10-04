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

const ticket = [
  '---',
  'files: ["src/triple.mjs", "test/triple.test.mjs"]',
  '---',
  '',
  'Add triple(value) to src/triple.mjs.',
  '',
  '- triple returns three times its input.',
  '- triple throws a TypeError when its input is not a number.',
  '',
  'The test is test/triple.test.mjs.',
  '',
].join('\n');
const nodeTest = (name: string, body: string) => [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  `import { ${name} } from '../src/${name}.mjs';`,
  body,
  '',
].join('\n');
const tripleTest = nodeTest('triple', "test('triple returns three times its input', () => assert.equal(triple(3), 9));");

const reply = (value: unknown) => JSON.stringify(value);
const pass = (summary: string) => reply({ status: 'pass', summary });
const met = (requirement: string, evidence: string) => ({ requirement, verdict: 'met', evidence });
const triples = met('triple returns three times its input', 'src/triple.mjs returns value * 3; test/triple.test.mjs passes');
const throws = met('triple throws a TypeError when its input is not a number', 'src/triple.mjs:2 throws a TypeError');

const doubles = 'export const triple = (value) => value * 2;\n';
const noCheck = 'export const triple = (value) => value * 3;\n';
const plainError = [
  'export function triple(value) {',
  "  if (typeof value !== 'number') throw new TypeError('triple expects a number');",
  '  return value * 3;',
  '}',
  '',
].join('\n');
const namedError = plainError.replace("'triple expects a number'", '`triple expects a number, got ${typeof value}`');

const message = 'The TypeError does not say what the caller passed.';
const messageAgain = 'A caller who passes a string is not told what it passed.';
const comment = 'triple has no comment saying what it does.';
const act = 'A caller needs to know what it passed to fix the call.';
const skip = 'A comment on a three-line function is taste.';

// The stand-in replays each command line tool's calls in order. Claude is
// the builder and the first reviewer, so it also merges the reviews; Codex
// is the goal check and the second reviewer; OpenCode runs Gemini, the
// third reviewer.
//
// Round 1: the first build doubles, the test goes red, and the second
// build passes the test. The goal check finds the TypeError missing, so
// the round goes back with no review and no judge.
// Round 2: the goal check passes. The reviewers review at the same time:
// Claude and Codex raise the same problem in other words, and Gemini, in
// a pass, raises a comment. Claude's seat merges the first two; each
// reviewer votes on what it did not raise. The judge acts on the merged
// finding and skips the comment.
// Round 3: the goal check and all three reviewers pass.
const featureScript = {
  claude: [
    { writes: { 'src/triple.mjs': doubles }, reply: 'wrote src/triple.mjs' },
    { writes: { 'src/triple.mjs': noCheck }, reply: 'fixed the multiplier the test named' },
    { writes: { 'src/triple.mjs': plainError }, reply: 'added the TypeError' },
    { reply: reply({ status: 'revise', summary: 'The error message is too thin.', findings: [{ severity: 'should-fix', evidence: message, recommendation: 'Name the value in the message.' }] }) },
    { reply: reply({ groups: [{ ids: ['f1', 'f2'], evidence: 'f1', fix: 'f2' }] }) },
    { reply: reply({ votes: [{ id: 'm2', vote: 'disagree', reason: 'The function is three lines; a comment repeats them.' }] }) },
    { writes: { 'src/triple.mjs': namedError }, reply: 'named the type in the message' },
    { reply: pass('The change meets the ticket.') },
  ],
  codex: [
    { reply: reply({ requirements: [triples, { requirement: 'triple throws a TypeError when its input is not a number', verdict: 'unmet', evidence: 'src/triple.mjs has no check on its input' }] }) },
    { reply: reply({ requirements: [triples, throws] }) },
    { reply: reply({ status: 'revise', summary: 'One gap in the error.', findings: [{ severity: 'should-fix', evidence: messageAgain, recommendation: 'Say what it got: triple expects a number, got string.' }] }) },
    { reply: reply({ votes: [{ id: 'm2', vote: 'agree', reason: 'A comment helps a new reader.' }] }) },
    { reply: reply({ requirements: [triples, throws] }) },
    { reply: pass('The change meets the ticket.') },
  ],
  opencode: [
    { reply: reply({ status: 'pass', summary: 'One note.', findings: [{ severity: 'nice-to-have', evidence: comment, recommendation: 'Add a one-line comment above it.' }] }) },
    { reply: reply({ votes: [{ id: 'm1', vote: 'agree', reason: 'The message should name what it got.' }] }) },
    { reply: pass('The change meets the ticket.') },
  ],
};

// The judge is asked once, after round 2. It decides each finding left
// after the vote, in the order the synthesis lists them.
const judgeAnswers = [{
  holds: { type: 'noul', noul: 0.3 },
  worth_doing: { type: 'noul', noul: 0.8 },
  worth_another_round: { type: 'noul', noul: 0.8 },
  stop_reason: { type: 'choice', choice: 'continue', confidence: 0.8 },
  'finding-1': { type: 'choice', choice: 'act', confidence: 0.9, reason: act },
  'finding-2': { type: 'choice', choice: 'skip', confidence: 0.8, reason: skip },
}];

interface RecordedEvent {
  readonly kind: string;
  readonly node?: string;
  readonly phase?: string;
  readonly attempt?: number;
  readonly label?: string;
  readonly from?: string;
  readonly to?: string;
  readonly accepted?: boolean;
  readonly requirements?: readonly { requirement: string; verdict: string }[];
  readonly entries?: readonly { result: string; finding: { evidence: string; raisedBy?: readonly string[]; votes?: readonly { reviewer: string; vote: string }[] } }[];
  readonly findings?: readonly { decision: string; reason: string }[];
  readonly outcome?: { status: string; summary?: string; data?: unknown };
}

interface Seeded {
  readonly dir: string;
  readonly bin: string;
}

async function seed(name: string, files: Readonly<Record<string, string>>, script: unknown): Promise<Seeded> {
  const dir = join(root, name);
  const bin = join(root, `${name}-bin`);
  await mkdir(bin, { recursive: true });
  for (const [path, content] of Object.entries({
    ...files,
    'judge.json': `${JSON.stringify(judgeAnswers, null, 2)}\n`,
    '.obversa-stand-in.json': `${JSON.stringify(script, null, 2)}\n`,
  })) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  // The stand-ins sit beside the workspace, not inside it: a read-only
  // reviewer's workspace guard refuses a symlink under the workspace that
  // resolves outside it.
  for (const tool of ['claude', 'codex', 'opencode']) await symlink(standIn, join(bin, tool));
  // Each ticket runs in a worktree forked from HEAD, so the seats' script
  // has to be committed for the worktree to have it.
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Example');
  git('config', 'user.email', 'example@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: seed the work');
  return { dir, bin };
}

function child(stem: string, extraArgs: readonly string[]) {
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, `${stem}.js`);
  return existsSync(compiled)
    ? { file: process.execPath, args: [compiled, ...extraArgs] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, `${stem}.ts`), ...extraArgs] };
}

const envFor = (seeded: Seeded) => ({ ...process.env, PATH: `${seeded.bin}:${process.env.PATH ?? ''}` });

function runExample(seeded: Seeded, stem: string, extraArgs: readonly string[] = []) {
  const { file, args } = child(stem, extraArgs);
  const ran = spawnSync(file, args, { cwd: seeded.dir, env: envFor(seeded), encoding: 'utf8', timeout: 120_000 });
  assert.equal(ran.status, 0, `${stem} ${extraArgs.join(' ')} exited ${ran.status ?? `signal ${ran.signal}`}
  stdout: ${ran.stdout}
  stderr: ${ran.stderr}`);
  return ran;
}

const printed = (stdout: string) => JSON.parse(stdout.slice(stdout.lastIndexOf('\n{') + 1)) as Record<string, unknown>;

function readRecord(dir: string, name: string): RecordedEvent[] {
  return readFileSync(join(dir, 'records', `${name}.jsonl`), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
}

/** Where a node's run starts in the record, one index per attempt. */
const nodeStarts = (record: RecordedEvent[], node: string) =>
  record.flatMap((e, at) => (e.kind === 'dag:node' && e.phase === 'start' && e.node === node ? [at] : []));
const reviewerStarts = (record: RecordedEvent[]) =>
  record.flatMap((e, at) => (e.kind === 'job:start' && e.label?.startsWith('review-') ? [at] : []));

const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

/** What the stand-in was sent, in order, for one command line tool. The log lands with the change. */
const prompts = (dir: string, role: string) => readFileSync(join(dir, '.obversa-stand-in-calls.log'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as { role: string; prompt: string })
  .filter((call) => call.role === role).map((call) => call.prompt);

/** The seven steps, in order, from the record of one ticket. */
async function assertSevenSteps(seeded: Seeded, attended: boolean) {
  const record = readRecord(seeded.dir, 'feature-delivery');
  const builds = nodeStarts(record, 'build');
  assert.equal(builds.length, 3, 'the builder builds three rounds: the goal check sends one back, the judge one');
  const roundOf = (at: number) => builds.filter((start) => start < at).length;

  // 1 and 2. Build and checks. In round 1 the test goes red once and the
  // builder runs again with its output, with no model in between.
  const tests = record.filter((e) => e.kind === 'job:end' && e.label === 'test');
  assert.deepEqual(tests.map((e) => e.outcome!.status), ['fail', 'pass', 'pass', 'pass']);
  const red = record.filter((e) => e.kind === 'loop:review' && e.outcome!.status !== 'pass');
  assert.equal(red.length, 1, 'one red test in the whole run');
  assert.equal(red[0]!.accepted, true, 'the red test goes back to the builder');
  assert.match(red[0]!.outcome!.summary ?? '', /exited 1[\s\S]*command output/, "the builder gets the test's output");

  // What the builder was sent each time. The first build has the ticket
  // alone; each later one has what sent the work back.
  const toBuilder = prompts(seeded.dir, 'claude').filter((prompt) => prompt.includes('Make the change in src/triple.mjs'));
  assert.equal(toBuilder.length, 4, 'four builds: the first, after the red test, after the goal check, after the judge');
  assert.ok(!toBuilder[0]!.includes('Feedback to address'), 'the first build has nothing to address');
  assert.ok(toBuilder[1]!.includes('not ok 1 - triple returns three times its input') && toBuilder[1]!.includes('6 !== 9'), `the retry has the red test's output: ${toBuilder[1]}`);

  // 3. Goal check. It runs every round before any reviewer starts. Round 1
  // finds the TypeError unmet and no reviewer runs that round.
  const goals = record.flatMap((e, at) => (e.kind === 'goal:check' ? [{ at, e }] : []));
  assert.deepEqual(goals.map(({ at }) => roundOf(at)), [1, 2, 3], 'one goal check per round');
  assert.deepEqual(goals.map(({ e }) => e.requirements!.map((r) => r.verdict)), [['met', 'unmet'], ['met', 'met'], ['met', 'met']]);
  const reviews = reviewerStarts(record);
  assert.equal(reviews.filter((at) => roundOf(at) === 1).length, 0, 'no reviewer runs in a round the goal check sends back');
  for (const { at } of goals.slice(1)) {
    const round = reviews.filter((start) => roundOf(start) === roundOf(at));
    assert.equal(round.length, 3, `three reviewers in round ${roundOf(at)}`);
    assert.ok(round.every((start) => start > at), `the goal check ran before the reviews in round ${roundOf(at)}`);
  }
  assert.ok(toBuilder[2]!.includes('triple throws a TypeError when its input is not a number: src/triple.mjs has no check on its input'), `the next round has the unmet requirement: ${toBuilder[2]}`);
  const kickbacks = record.filter((e) => e.kind === 'dag:kickback');
  assert.deepEqual(kickbacks.map((e) => [e.from, e.to, e.accepted]), [['goal', 'build', true], ['review', 'build', true]]);

  // 4 and 5. Review battery and synthesis. Claude and Codex named the same
  // problem, merged into one; Gemini's comment is disputed by the vote.
  const syntheses = record.filter((e) => e.kind === 'review:synthesis');
  assert.equal(syntheses.length, 1, 'round 3 has no findings to merge');
  const [merged, disputed] = syntheses[0]!.entries!;
  assert.equal(merged!.result, 'kept');
  assert.deepEqual(merged!.finding.raisedBy, ['claude', 'codex']);
  assert.equal(merged!.finding.evidence, message);
  assert.equal(disputed!.result, 'disputed');
  assert.deepEqual(disputed!.finding.raisedBy, ['gemini']);
  assert.deepEqual(disputed!.finding.votes!.map((v) => `${v.reviewer} ${v.vote}`), ['claude disagree', 'codex agree']);

  // 6. Judge. Asked once, after the synthesis, never about the goal check.
  // It acts on the merged finding and skips the comment.
  const judges = record.flatMap((e, at) => (e.kind === 'refine:judge' ? [{ at, e }] : []));
  assert.equal(judges.length, 1, 'the judge is asked about the review only');
  assert.ok(judges[0]!.at > record.indexOf(syntheses[0]!), 'the judge reads the synthesised list');
  assert.deepEqual(judges[0]!.e.findings!.map((f) => [f.decision, f.reason]), [['act', act], ['skip', skip]]);
  assert.ok(toBuilder[3]!.includes(message) && toBuilder[3]!.includes(act), `the builder gets the finding the judge acts on: ${toBuilder[3]}`);
  assert.ok(!toBuilder[3]!.includes(comment) && !toBuilder[3]!.includes(skip), `the builder never sees the finding the judge skips: ${toBuilder[3]}`);

  // 7. Approval. Attended, a person approves the exact bytes that landed.
  const landed = await sha256(join(seeded.dir, 'src/triple.mjs'));
  assert.equal(await readFile(join(seeded.dir, 'src/triple.mjs'), 'utf8'), namedError, 'the round 3 change landed');
  const approve = record.filter((e) => e.kind === 'dag:node' && e.phase === 'done' && e.node === 'approve');
  if (!attended) {
    assert.equal(approve.length, 0, 'unattended, nobody is asked');
    return { landed };
  }
  // In rounds 1 and 2 an earlier node failed, so approve ended without asking.
  const approved = approve.filter((e) => e.outcome!.status === 'pass');
  assert.equal(approved.length, 1, 'the person is asked once, in the last round');
  assert.equal(nodeStarts(record, 'approve').length, 1, 'approve starts once');
  // The question names every file that landed, the ticket's or not, with
  // its bytes, and every file the run deleted.
  const git = (...args: string[]) => spawnSync('git', args, { cwd: seeded.dir, encoding: 'utf8' }).stdout.trim().split('\n');
  const [seedCommit] = git('rev-list', '--max-parents=0', 'HEAD');
  const shipped = await Promise.all(git('diff', '--name-status', '--no-renames', seedCommit!, 'HEAD').map(async (line) => {
    const [status, path] = line.split('\t');
    return status === 'D' ? `${path} (deleted)` : `${path} (sha256 ${(await sha256(join(seeded.dir, path!))).slice(0, 12)})`;
  }));
  assert.equal(approved[0]!.outcome!.summary, `approved: Ship these bytes? ${shipped.join(', ')}`, 'the approval names every landed file and its bytes');
  assert.ok(nodeStarts(record, 'approve')[0]! > reviews.at(-1)!, 'the approval comes after the last review');
  return { landed, question: approved[0]!.outcome!.summary!, approval: approved[0]!.outcome!.data };
}

const root = await mkdtemp(join(tmpdir(), 'obversa-feature-delivery-proof-'));
try {
  const featureFiles = { 'briefs/ticket.md': ticket, 'test/triple.test.mjs': tripleTest };

  // Attended. The run waits for the person's yes; the proof gives it on the
  // run's page and reads the question there while it is pending.
  const attended = await seed('attended', featureFiles, featureScript);
  const { file, args } = child('feature-delivery', []);
  const asked = await runAnswering(file, args, { cwd: attended.dir, env: envFor(attended), timeoutMs: 120_000, answer: { approved: true } });
  assert.equal(asked.status, 0, `the attended run exited ${asked.status ?? `signal ${asked.signal}`}
  stdout: ${asked.stdout}
  stderr: ${asked.stderr}`);
  assert.equal(printed(asked.stdout).status, 'pass');
  const attendedSteps = await assertSevenSteps(attended, true);
  assert.ok(asked.question?.includes(attendedSteps.landed.slice(0, 12)), `the page asked about the landed bytes: ${asked.question}`);

  // Attended, with approve.json beside the file: the answer comes from it,
  // and nobody has to be on the page. Here the first build also deletes a
  // file the ticket does not name, and the approval still names it.
  const recorded = await seed('approve-json', {
    ...featureFiles,
    'src/legacy.mjs': 'export const legacy = true;\n',
    'approve.json': `${JSON.stringify({ approved: true, note: 'approved from approve.json' })}\n`,
  }, { ...featureScript, claude: [{ ...featureScript.claude[0], deletes: ['src/legacy.mjs'] }, ...featureScript.claude.slice(1)] });
  assert.equal(printed(runExample(recorded, 'feature-delivery').stdout).status, 'pass');
  const recordedSteps = await assertSevenSteps(recorded, true);
  assert.deepEqual(recordedSteps.approval, { approved: true, note: 'approved from approve.json' });
  assert.ok(!existsSync(join(recorded.dir, 'src/legacy.mjs')), 'the deletion landed');
  assert.ok(recordedSteps.question.includes('src/legacy.mjs (deleted)'), `the approval names the deletion: ${recordedSteps.question}`);

  // A file edited in the worktree while the question waits is not what the
  // person approved: the yes fails the run, and nothing lands.
  const edited = await seed('edited', featureFiles, featureScript);
  const editedAnswer = await runAnswering(file, args, {
    cwd: edited.dir, env: envFor(edited), timeoutMs: 120_000, answer: { approved: true },
    beforeAnswer: async () => {
      const worktrees = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: edited.dir, encoding: 'utf8' }).stdout
        .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length));
      assert.equal(worktrees.length, 2, `one worktree for the ticket: ${worktrees.join(', ')}`);
      await writeFile(join(worktrees[1]!, 'src/triple.mjs'), `${namedError}export const extra = true;\n`);
    },
  });
  assert.equal(editedAnswer.status, 0, `the edited run exited ${editedAnswer.status ?? `signal ${editedAnswer.signal}`}
  stdout: ${editedAnswer.stdout}
  stderr: ${editedAnswer.stderr}`);
  assert.ok(editedAnswer.question?.startsWith('Ship these bytes?'), `the person was asked: ${editedAnswer.question}`);
  assert.equal(printed(editedAnswer.stdout).status, 'fail', 'a yes to bytes that changed fails the run');
  assert.ok(!existsSync(join(edited.dir, 'src/triple.mjs')), 'the edited change does not land');
  const editedApprove = readRecord(edited.dir, 'feature-delivery')
    .filter((e) => e.kind === 'dag:node' && e.phase === 'done' && e.node === 'approve').at(-1);
  assert.equal(editedApprove?.outcome?.summary, 'the files changed after the approval was asked for; nothing lands');

  // A no from the person fails the run, and the change does not land.
  const refused = await seed('refused', { ...featureFiles, 'approve.json': `${JSON.stringify({ approved: false, note: 'not this week' })}\n` }, featureScript);
  assert.equal(printed(runExample(refused, 'feature-delivery').stdout).status, 'fail');
  assert.ok(!existsSync(join(refused.dir, 'src/triple.mjs')), 'a refused change does not land');

  // Unattended. The same team, and the change lands without asking.
  const unattended = await seed('unattended', featureFiles, featureScript);
  assert.equal(printed(runExample(unattended, 'feature-delivery', ['--unattended']).stdout).status, 'pass');
  await assertSevenSteps(unattended, false);

  // The backlog. Two tickets, each delivered in its own worktree; each
  // passes on its first round, lands, and moves to done. The stand-in's
  // calls run on across tickets: ticket 1 takes each list's first entries
  // and ticket 2 the next ones. Each ticket's record shows one build and
  // one test run, so a retry in ticket 1 cannot use ticket 2's entries
  // unseen.
  const doubleTicket = ticket.replaceAll('triple', 'double').replace('three times', 'twice');
  const backlog = await seed('backlog', {
    'backlog/001-triple.md': ticket,
    'backlog/002-double.md': doubleTicket,
    'test/triple.test.mjs': tripleTest,
    'test/double.test.mjs': nodeTest('double', "test('double returns twice its input', () => assert.equal(double(3), 6));"),
  }, {
    claude: [
      { writes: { 'src/triple.mjs': namedError }, reply: 'added triple' },
      { reply: pass('The change meets the ticket.') },
      { writes: { 'src/double.mjs': namedError.replaceAll('triple', 'double').replace('* 3', '* 2') }, reply: 'added double' },
      { reply: pass('The change meets the ticket.') },
    ],
    codex: [
      { reply: reply({ requirements: [triples, throws] }) },
      { reply: pass('The change meets the ticket.') },
      { reply: reply({ requirements: [met('double returns twice its input', 'src/double.mjs returns value * 2'), met('double throws a TypeError when its input is not a number', 'src/double.mjs:2 throws one')] }) },
      { reply: pass('The change meets the ticket.') },
    ],
    opencode: [{ reply: pass('The change meets the ticket.') }],
  });
  const backlogRun = printed(runExample(backlog, 'feature-team-backlog', ['--unattended']).stdout) as { delivered: { ticket: string; status: string }[] };
  assert.deepEqual(backlogRun.delivered.map((d) => [d.ticket, d.status]), [['001-triple.md', 'pass'], ['002-double.md', 'pass']]);
  for (const name of ['001-triple', '002-double']) {
    assert.ok(existsSync(join(backlog.dir, 'backlog/done', `${name}.md`)), `${name} moved to done`);
    const record = readRecord(backlog.dir, name);
    assert.equal(nodeStarts(record, 'build').length, 1, `${name}: one build`);
    assert.deepEqual(record.filter((e) => e.kind === 'job:end' && e.label === 'test').map((e) => e.outcome!.status), ['pass'], `${name}: its own test passed the first time`);
    assert.equal(record.filter((e) => e.kind === 'goal:check').length, 1, `${name}: one goal check`);
    assert.equal(record.filter((e) => e.kind === 'run:end').at(-1)?.outcome?.status, 'pass', `${name}: the run passed`);
  }
  for (const file of ['src/triple.mjs', 'src/double.mjs']) assert.ok(existsSync(join(backlog.dir, file)), `${file} landed`);
  const log = spawnSync('git', ['log', '--merges', '--format=%s'], { cwd: backlog.dir, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.equal(log.length, 2, 'each ticket landed as its own merge');

  console.log(JSON.stringify({
    status: 'pass',
    rounds: 3,
    goalChecks: ['unmet', 'met', 'met'],
    synthesis: ['kept', 'disputed'],
    judge: ['act', 'skip'],
    approvedSha256: attendedSteps.landed.slice(0, 12),
    unattended: 'landed without asking',
    backlog: backlogRun.delivered.map((d) => `${d.ticket} ${d.status}`),
    mode: existsSync(join(here, 'feature-delivery.js')) ? 'compiled-from-dist'
      : existsSync(join(repo, 'packages', 'runtime', 'tsconfig.json')) ? 'repo-tsx' : 'consumer-tsx',
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
