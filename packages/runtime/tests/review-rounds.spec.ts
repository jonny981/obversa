/**
 * A review panel with a send-back target keeps its rounds: from round 2
 * each reviewer reads its own open findings and the diff since its last
 * round; a paused round does not count; a resume numbers on from the
 * record; and a round that paused after blocks came in sends those blocks
 * to the build on resume. With a base, a reviewer reads the change sized to
 * its engine's input limit.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentJob, dag, fnJob, review, reviewPanel, run, type Engine, type LoopEvent, type Outcome } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { outcomeFromAgentText } from '../src/workflow-support.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-rounds-'));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'app.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, '.gitignore'), 'records/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return dir;
}

const REVISE = (evidence: string) => JSON.stringify({ status: 'revise', summary: 'fix it', findings: [{ severity: 'block', evidence }] });
const PASS = JSON.stringify({ status: 'pass', summary: 'clean' });

/** An engine that refuses inputs over `characters`, and whose replies `respond` writes. */
function limited(characters: number, respond: (prompt: string) => string): Engine & { prompts: string[] } {
  const prompts: string[] = [];
  const mock = new MockEngine((request) => {
    prompts.push(request.prompt);
    return respond(request.prompt);
  });
  return { name: 'limited', inputLimit: { characters }, prompts, run: (request, onEvent, signal) => mock.run(request, onEvent, signal) };
}

function reviewer(name: string, engine: Engine) {
  return {
    name,
    job: agentJob({ label: `review-${name}`, engine, prompt: 'Review the change.', leaf: true, outcome: (text) => outcomeFromAgentText(text, 'build') }),
  };
}

/** A build that writes the next line of app.ts on each attempt, and a panel that reviews it. */
function graph(cwd: string, reviewers: ReturnType<typeof reviewer>[], builds: { lastReview?: Outcome }[], pass: 'all' | number = 'all') {
  return dag({
    name: 'deliver',
    nodes: {
      build: {
        refine: review({ rounds: 3 }),
        job: fnJob('build', async (ctx) => {
          builds.push({ ...(ctx.lastReview === undefined ? {} : { lastReview: ctx.lastReview }) });
          writeFileSync(join(cwd, 'app.ts'), `export const a = ${builds.length + 1};\n`);
          return 'built';
        }),
      },
      review: { needs: ['build'], sendsBackTo: ['build'], job: reviewPanel({ label: 'review', target: 'build', pass, reviewers }) },
    },
  });
}

describe('review rounds', () => {
  it("gives a reviewer its open findings and the diff since its round in round 2", async () => {
    const cwd = repo();
    const engine = limited(10_000_000, (prompt) => prompt.includes('This is review round 2') ? PASS : REVISE('app.ts:1 a is wrong'));
    const builds: { lastReview?: Outcome }[] = [];

    const { outcome } = await run(graph(cwd, [reviewer('a', engine)], builds), { cwd });

    expect(outcome.status).toBe('pass');
    expect(engine.prompts).toHaveLength(2);
    expect(engine.prompts[0]).not.toContain('This is review round');
    expect(engine.prompts[1]).toContain('This is review round 2.');
    expect(engine.prompts[1]).toContain('=== your findings from round 1 ===\n- [block] app.ts:1 a is wrong');
    expect(engine.prompts[1]).toMatch(/=== the diff since your round 1 review ===\n[\s\S]*-export const a = 2;\n\+export const a = 3;/);
  });

  it('numbers a resumed review on from the record, and a paused round does not count', async () => {
    const cwd = repo();
    const record = join(cwd, 'records', 'run.jsonl');
    let calls = 0;
    const first = limited(10_000_000, () => {
      calls += 1;
      if (calls === 1) return REVISE('app.ts:1 a is wrong');
      throw new Error('the reviewer process died');
    });
    const firstRun = await run(graph(cwd, [reviewer('a', first)], []), { cwd, recordTo: record });
    expect(firstRun.outcome.status).toBe('paused');

    const second = limited(10_000_000, () => PASS);
    const resumed = await run(graph(cwd, [reviewer('a', second)], []), { cwd, recordTo: record, resume: true });

    expect(resumed.outcome.status).toBe('pass');
    // Round 2 paused, so the resumed review is round 2 again, not round 3.
    expect(second.prompts[0]).toContain('This is review round 2.');
    expect(second.prompts[0]).toContain('=== your findings from round 1 ===\n- [block] app.ts:1 a is wrong');
    const rounds = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LoopEvent)
      .flatMap((event) => event.kind === 'job:end' && event.label === 'review'
        ? [(event.outcome.data as { reviewRound?: number } | undefined)?.reviewRound] : []);
    expect(rounds).toEqual([1, 2, 2]);
  });

  it('sends the blocks of a paused round to the build on resume, without reviewing the unchanged tree again', async () => {
    const cwd = repo();
    const record = join(cwd, 'records', 'run.jsonl');
    const blocking = limited(10_000_000, () => REVISE('app.ts:1 a must be 5'));
    const silent = limited(10_000_000, () => { throw new Error('no answer'); });
    const builds: { lastReview?: Outcome }[] = [];
    const paused = await run(graph(cwd, [reviewer('a', blocking), reviewer('b', silent)], builds), { cwd, recordTo: record });
    expect(paused.outcome.status).toBe('paused');
    expect(builds).toHaveLength(1);

    const a = limited(10_000_000, () => PASS);
    const b = limited(10_000_000, () => PASS);
    const resumedBuilds: { lastReview?: Outcome }[] = [];
    const resumed = await run(graph(cwd, [reviewer('a', a), reviewer('b', b)], resumedBuilds), { cwd, recordTo: record, resume: true });

    expect(resumed.outcome.status).toBe('pass');
    // The block went straight to the build: the first thing the resume ran.
    expect(resumedBuilds).toHaveLength(1);
    expect(resumedBuilds[0]!.lastReview?.revision?.findings?.map((finding) => finding.evidence)).toEqual(['app.ts:1 a must be 5']);
    // Each reviewer read the changed tree once, in round 2; neither read the unchanged one.
    expect(a.prompts).toHaveLength(1);
    expect(b.prompts).toHaveLength(1);
    expect(a.prompts[0]).toContain('This is review round 2.');
    const delivered = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LoopEvent)
      .find((event) => event.kind === 'job:end' && event.label === 'review' && (event.outcome.data as { deliveredOnResume?: boolean } | undefined)?.deliveredOnResume === true);
    expect(delivered).toBeDefined();
  });
});

describe('the change a reviewer reads', () => {
  it('inlines code and lists a data file by path, size and sha256 when the whole change does not fit', async () => {
    const cwd = repo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    const data = `${'{"line":"record"}\n'.repeat(170_000)}`.slice(0, 3_000_000);
    writeFileSync(join(cwd, 'events.jsonl'), data);
    writeFileSync(join(cwd, 'small.ts'), 'export const small = true;\n');
    const engine = limited(1_000_000, () => PASS);

    const { outcome } = await run(reviewPanel({ label: 'review', target: 'build', base, reviewers: [reviewer('a', engine)] }), { cwd });

    expect(outcome.status).toBe('pass');
    const sha = createHash('sha256').update(data).digest('hex');
    expect(engine.prompts[0]).toContain('=== new file small.ts ===\nexport const small = true;');
    expect(engine.prompts[0]).toContain(`=== listed, not inlined: events.jsonl (3000000 bytes, sha256 ${sha}); read it from the worktree ===`);
    expect(engine.prompts[0]!.length).toBeLessThanOrEqual(1_000_000);
  });

  it("leaves out a file inside the run's own check output folder, tracked or not, when the change is read file by file", async () => {
    const cwd = repo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    // The record sits unignored in the worktree, and its check output folder holds a tracked file and an untracked one.
    execFileSync('mkdir', ['run.checks'], { cwd });
    writeFileSync(join(cwd, 'run.checks', 'tracked.log'), 'tracked check output\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'branch');
    writeFileSync(join(cwd, 'run.checks', 'untracked.log'), 'untracked check output\n');
    writeFileSync(join(cwd, 'events.jsonl'), '{"line":"record"}\n'.repeat(100_000));
    writeFileSync(join(cwd, 'small.ts'), 'export const small = true;\n');
    const engine = limited(1_000_000, () => PASS);

    const { outcome } = await run(reviewPanel({ label: 'review', target: 'build', base, reviewers: [reviewer('a', engine)] }), { cwd, recordTo: join(cwd, 'run.jsonl') });

    expect(outcome.status).toBe('pass');
    expect(engine.prompts[0]).toContain('=== listed, not inlined: events.jsonl');
    expect(engine.prompts[0]).toContain('=== new file small.ts ===');
    expect(engine.prompts[0]).not.toContain('run.checks');
  });

  it('pauses before calling the engine when the change is still too large with every permitted file listed', async () => {
    const cwd = repo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    // A tracked code file's diff is never listed.
    writeFileSync(join(cwd, 'app.ts'), `${'export const line = "a fairly long line of code";\n'.repeat(25_000)}`);
    const engine = limited(1_000_000, () => PASS);
    const events: LoopEvent[] = [];

    const { outcome } = await run(reviewPanel({ label: 'review', target: 'build', base, reviewers: [reviewer('a', engine)] }), { cwd, onEvent: (event) => events.push(event) });

    expect(outcome.status).toBe('paused');
    expect(engine.prompts).toHaveLength(0);
    const ended = events.find((event): event is Extract<LoopEvent, { kind: 'job:end' }> => event.kind === 'job:end' && event.label === 'review-a');
    expect(ended?.outcome.status).toBe('paused');
    expect(ended?.outcome.summary).toMatch(/the review input is \d+ characters with every data file listed, and limited takes at most 1000000; the largest files in the change: app\.ts/);
  });
});
