import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

const page = (body: string) => ['---', 'title: Retries', '---', '', body, '', '```toml', 'max_retries = 3', '```', ''].join('\n');
const original = page('The client uses exponential backoff. Set max_retries.');
const draft1 = page('The client uses exponential backoff between attempts. Set max_retries to the number of extra attempts you want.');
const draft2 = page('After a call fails, the client tries again. Each retry waits twice as long as the one before, starting at one second. After the last retry, the call fails with the last error. Set max_retries to how many times to try again.');

const reply = (value: unknown) => JSON.stringify(value);
const backoff = '"The client uses exponential backoff between attempts." The reader has not met "exponential backoff".';
const backoffAgain = 'The page says "backoff" without saying how long the client waits.';
const lastRetry = 'The page never says what happens when every retry fails.';
const table = 'Add a table of every client setting.';
const nit = '"Set max_retries to the number of extra attempts you want." could be shorter.';
const actBackoff = 'A reader who has not met the term cannot tell what the client does.';
const actLastRetry = 'A reader needs to know what the call does after the last retry.';
const skipNit = 'The sentence is clear as it is; a shorter one is taste.';

// The stand-in replays each command line tool's calls in order. Reviewers are
// write-1 (Claude), write-2 (Codex) and write-3 (OpenCode, Gemini). Round 1:
// all three review, Claude's seat merges, each votes on what it did not
// raise, and the judge decides each finding left. Round 2: all three pass,
// so there is nothing to merge, vote on or judge.
const script = {
  opencode: [
    { writes: { 'docs/retries.md': draft1 }, reply: reply({ status: 'pass', summary: 'Rewrote the page from the brief.' }) },
    { reply: reply({ status: 'revise', summary: 'One gap and one wording point.', findings: [
      { severity: 'should-fix', evidence: table, recommendation: 'List every setting with its default.' },
      { severity: 'nice-to-have', evidence: nit, recommendation: 'Set max_retries to the number of retries.' },
    ] }) },
    { reply: reply({ votes: [{ id: 'm1', vote: 'agree', reason: 'The term is unexplained.' }, { id: 'm2', vote: 'agree', reason: 'A reader will ask.' }] }) },
    { writes: { 'docs/retries.md': draft2 }, reply: reply({ status: 'pass', summary: 'Changed the sentences the findings named.' }) },
    { reply: reply({ status: 'pass', summary: 'Nothing fails for this reader.' }) },
  ],
  claude: [
    { reply: reply({ status: 'revise', summary: 'One term is unexplained.', findings: [{ severity: 'should-fix', evidence: backoff, recommendation: 'Say what the client does instead of naming it.' }] }) },
    { reply: reply({ groups: [{ ids: ['f1', 'f2'], evidence: 'f1', fix: 'f2' }] }) },
    { reply: reply({ votes: [
      { id: 'm2', vote: 'agree', reason: 'The reader needs to know.' },
      { id: 'm3', vote: 'disagree', reason: 'The page covers one setting; a table is past what this reader needs.' },
      { id: 'm4', vote: 'agree', reason: 'Shorter reads better.' },
    ] }) },
    { reply: reply({ status: 'pass', summary: 'Nothing fails for this reader.' }) },
  ],
  codex: [
    { reply: reply({ status: 'revise', summary: 'Two gaps.', findings: [
      { severity: 'should-fix', evidence: backoffAgain, recommendation: 'Each retry waits twice as long as the one before, starting at one second.' },
      { severity: 'should-fix', evidence: lastRetry, recommendation: 'After the last retry, the call fails with the last error.' },
    ] }) },
    { reply: reply({ votes: [
      { id: 'm3', vote: 'disagree', reason: 'Other settings belong on their own pages.' },
      { id: 'm4', vote: 'disagree', reason: 'It is already one short line.' },
    ] }) },
    { reply: reply({ status: 'pass', summary: 'Nothing fails for this reader.' }) },
  ],
};

const root = await mkdtemp(join(tmpdir(), 'obversa-review-battery-proof-'));
const workspace = join(root, 'workspace');
const bin = join(root, 'bin');
try {
  await mkdir(join(workspace, 'briefs'), { recursive: true });
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await copyFile(join(here, 'briefs/retries.md'), join(workspace, 'briefs/retries.md'));
  await writeFile(join(workspace, 'docs/retries.md'), original);
  // The judge is asked once, after round 1, which has no block. It decides
  // each finding left, in the order the synthesis lists them: it acts on the
  // merged backoff finding and the last retry, and skips the disputed nit.
  await writeFile(join(workspace, 'judge.json'), `${JSON.stringify([
    {
      holds: { type: 'noul', noul: 0.2 },
      worth_doing: { type: 'noul', noul: 0.8 },
      worth_another_round: { type: 'noul', noul: 0.8 },
      stop_reason: { type: 'choice', choice: 'continue', confidence: 0.8 },
      'finding-1': { type: 'choice', choice: 'act', confidence: 0.9, reason: actBackoff },
      'finding-2': { type: 'choice', choice: 'act', confidence: 0.9, reason: actLastRetry },
      'finding-3': { type: 'choice', choice: 'skip', confidence: 0.8, reason: skipNit },
    },
  ], null, 2)}\n`);
  await writeFile(join(workspace, '.obversa-stand-in.json'), `${JSON.stringify(script, null, 2)}\n`);
  const callsLog = join(workspace, '.obversa-stand-in-calls.log');
  // The stand-in executables live beside the workspace, not inside it: a
  // read-only reviewer's workspace guard refuses a symlink under the
  // workspace that resolves outside it.
  for (const name of ['claude', 'codex', 'opencode']) {
    await symlink(standIn, join(bin, name));
  }

  // Inside a fresh consumer there is no packages/runtime/tsconfig.json; tsx then
  // reads the nearest tsconfig, which is the consumer's own.
  const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
  const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
  const compiled = join(here, 'review-battery.js');
  const child = existsSync(compiled)
    ? { file: process.execPath, args: [compiled] }
    : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(here, 'review-battery.ts')] };
  const started = Date.now();
  const run = spawnSync(child.file, child.args, {
    cwd: workspace,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const elapsed = Date.now() - started;

  const mode = existsSync(compiled) ? 'compiled-from-dist' : existsSync(repoTsconfig) ? 'repo-tsx' : 'consumer-tsx';
  assert.equal(run.status, 0, `the example child ${child.file} ${child.args.join(' ')} exited ${run.status ?? `signal ${run.signal}`} after ${elapsed}ms in ${mode} mode
  spawn error: ${run.error ?? 'none'}
  stdout: ${run.stdout}
  stderr: ${run.stderr}`);
  interface PrintedEntry {
    readonly result: string;
    readonly raisedBy?: readonly string[];
    readonly evidence: string;
    readonly votes?: readonly string[];
  }
  interface PrintedDecision {
    readonly route: string;
    readonly reason: string;
    readonly findings: readonly string[];
  }
  const printed = JSON.parse(run.stdout.slice(run.stdout.lastIndexOf('\n{') + 1)) as {
    status: string;
    rounds: PrintedEntry[][];
    judge: PrintedDecision[];
  };
  assert.equal(printed.status, 'pass');
  assert.equal(printed.rounds.length, 1, 'only round 1 had findings to synthesise');

  const [first] = printed.rounds as [PrintedEntry[]];
  assert.deepEqual(first.map((entry) => entry.result), ['kept', 'kept', 'dropped', 'disputed']);
  assert.deepEqual(first[0]!.raisedBy, ['write-1', 'write-2'], 'the two findings about "backoff" became one, crediting both reviewers');
  assert.equal(first[0]!.evidence, backoff, 'the merged finding keeps the clearest evidence');
  assert.equal(first[2]!.evidence, table, 'the table the other two reviewers rejected is dropped');
  assert.deepEqual(first[2]!.votes, [
    'write-1 disagree: The page covers one setting; a table is past what this reader needs.',
    'write-2 disagree: Other settings belong on their own pages.',
  ]);
  assert.equal(first[3]!.evidence, nit, 'a one-to-one vote on the nit keeps it, disputed, for the judge');
  assert.deepEqual(printed.judge, [{
    route: 'again',
    reason: 'the judge acts on 2 of 3 findings',
    findings: [`act: ${backoff} (${actBackoff})`, `act: ${lastRetry} (${actLastRetry})`, `skip: ${nit} (${skipNit})`],
  }], 'the judge acts on two findings and skips the disputed nit');

  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { role: string });
  const count = (role: string) => calls.filter((call) => call.role === role).length;
  assert.equal(count('opencode'), 5, 'the writer twice, and the OpenCode reviewer reviews twice and votes once');
  assert.equal(count('claude'), 4, 'Claude reviews twice, merges round 1 and votes in round 1');
  assert.equal(count('codex'), 3, 'Codex reviews twice and votes in round 1');

  interface RecordedEvent {
    readonly kind: string;
    readonly outcome?: { readonly revision?: { readonly findings?: readonly { readonly evidence: string; readonly judgeReason?: string }[] } };
    readonly accepted?: boolean;
  }
  const record = (await readFile(join(workspace, 'records/review-battery.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as RecordedEvent);
  assert.equal(record.filter((event) => event.kind === 'review:synthesis').length, 1, 'the record keeps the synthesis of the round with findings');
  const sentBack = record.filter((event) => event.kind === 'loop:review' && event.accepted === true);
  assert.equal(sentBack.length, 1, 'round 1 goes back once');
  assert.deepEqual(
    sentBack[0]!.outcome!.revision!.findings!.map((finding) => [finding.evidence, finding.judgeReason]),
    [[backoff, actBackoff], [lastRetry, actLastRetry]],
    'the writer gets only the findings the judge acts on, each with its reason: not the dropped table, not the skipped nit',
  );

  assert.equal(await readFile(join(workspace, 'docs/retries.md'), 'utf8'), draft2);

  console.log(JSON.stringify({
    status: printed.status,
    merged: first[0]!.raisedBy,
    dropped: first[2]!.evidence,
    disputed: first[3]!.evidence,
    judge: printed.judge[0]!.findings,
    mode,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
