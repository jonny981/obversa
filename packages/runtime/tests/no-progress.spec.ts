/**
 * No-progress (stall) detection — the third hard stop. Offline and
 * deterministic: the tracker is exercised directly, the loop wiring through
 * fnJob bodies with custom signals, and the workspace fingerprint against real
 * temp git repos.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  loop,
  fnJob,
  predicate,
  jobMeta,
} from '../src/api.ts';
import type { RunOptions, LoopEvent, Condition } from '../src/api.ts';
import { commit, stageAll, workspaceFingerprint } from '../src/core/git.ts';
import {
  ProgressTracker,
  resolveNoProgress,
} from '../src/core/progress.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, tmpBareDir, cleanupRepos } from './git-helpers.ts';
import { vi } from 'vitest';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000 });

afterAll(cleanupRepos);

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};

/** Run opts pinned to a non-repo cwd, so the workspace channel is absent. */
const bareOpts = (): RunOptions => ({ ...mockOpts, cwd: tmpBareDir() });

describe('resolveNoProgress', () => {
  it('is undefined when unset', () => {
    expect(resolveNoProgress(undefined)).toBeUndefined();
  });

  it('treats a bare number as the window', () => {
    const cfg = resolveNoProgress(2);
    expect(cfg?.window).toBe(2);
    expect(cfg?.minConfidenceDelta).toBe(0.02);
  });

  it('applies defaults to a partial config', () => {
    const cfg = resolveNoProgress({ minConfidenceDelta: 0.1 });
    expect(cfg?.window).toBe(3);
    expect(cfg?.minConfidenceDelta).toBe(0.1);
  });
});

describe('ProgressTracker (the novelty rule)', () => {
  const tracker = () => new ProgressTracker({ window: 3, minConfidenceDelta: 0.02 });

  it('stalls after `window` consecutive revisits of a seen signal', () => {
    const t = tracker();
    expect(t.record({ iteration: 1, signal: 'a' })).toBeUndefined(); // novel
    expect(t.record({ iteration: 2, signal: 'a' })).toBeUndefined();
    expect(t.record({ iteration: 3, signal: 'a' })).toBeUndefined();
    const report = t.record({ iteration: 4, signal: 'a', reason: 'tests red' });
    expect(report).toBeDefined();
    expect(report?.iterations).toEqual([2, 3, 4]);
    expect(report?.reason).toBe('tests red');
    expect(report?.evidence.join(' ')).toContain('signal');
  });

  it('novelty resets the run — progress at iteration 3 restarts the count', () => {
    const t = tracker();
    t.record({ iteration: 1, signal: 'a' });
    t.record({ iteration: 2, signal: 'a' });
    t.record({ iteration: 3, signal: 'b' }); // novel — reset
    t.record({ iteration: 4, signal: 'b' });
    t.record({ iteration: 5, signal: 'b' });
    const report = t.record({ iteration: 6, signal: 'b' });
    expect(report?.iterations).toEqual([4, 5, 6]);
  });

  it('oscillation gets no credit: A→B→A→B stalls (revisits are not progress)', () => {
    const t = tracker();
    expect(t.record({ iteration: 1, signal: 'A' })).toBeUndefined(); // novel
    expect(t.record({ iteration: 2, signal: 'B' })).toBeUndefined(); // novel
    expect(t.record({ iteration: 3, signal: 'A' })).toBeUndefined(); // seen — 1
    expect(t.record({ iteration: 4, signal: 'B' })).toBeUndefined(); // seen — 2
    expect(t.record({ iteration: 5, signal: 'A' })).toBeDefined(); //   seen — 3
  });

  it('confidence must beat the high-water mark by the delta', () => {
    const t = tracker();
    expect(t.record({ iteration: 1, confidence: 0.5 })).toBeUndefined(); // first — progress
    // Jitter below the delta is not progress…
    expect(t.record({ iteration: 2, confidence: 0.51 })).toBeUndefined();
    expect(t.record({ iteration: 3, confidence: 0.5 })).toBeUndefined();
    // …but slow, steady improvement accumulates past the bar (0.5 → 0.53).
    expect(t.record({ iteration: 4, confidence: 0.53 })).toBeUndefined(); // progress — reset
    expect(t.record({ iteration: 5, confidence: 0.53 })).toBeUndefined();
    expect(t.record({ iteration: 6, confidence: 0.53 })).toBeUndefined();
    const report = t.record({ iteration: 7, confidence: 0.52 });
    expect(report?.iterations).toEqual([5, 6, 7]);
    expect(report?.evidence.join(' ')).toContain('confidence');
  });

  it('any one channel showing novelty counts as progress', () => {
    const t = tracker();
    t.record({ iteration: 1, signal: 'a', confidence: 0.5 });
    // signal flat, but confidence keeps climbing — never stalls
    t.record({ iteration: 2, signal: 'a', confidence: 0.6 });
    t.record({ iteration: 3, signal: 'a', confidence: 0.7 });
    t.record({ iteration: 4, signal: 'a', confidence: 0.8 });
    expect(t.record({ iteration: 5, signal: 'a', confidence: 0.9 })).toBeUndefined();
  });

  it('an evidence-free sample is indeterminate: neither extends nor resets', () => {
    const t = tracker();
    t.record({ iteration: 1, signal: 'a' });
    t.record({ iteration: 2, signal: 'a' }); // flat — 1
    t.record({ iteration: 3 }); //              indeterminate — no effect
    t.record({ iteration: 4, signal: 'a' }); // flat — 2
    expect(t.record({ iteration: 5, signal: 'a' })).toBeDefined(); // flat — 3
    expect(t.isInert()).toBe(false);
  });

  it('reports inert only when every sample lacked evidence', () => {
    const t = tracker();
    t.record({ iteration: 1 });
    t.record({ iteration: 2 });
    expect(t.isInert()).toBe(false); // window not yet filled
    t.record({ iteration: 3 });
    expect(t.isInert()).toBe(true);
  });

  it('gate channel: an equal output is flat, a differing output is novelty', () => {
    const t = tracker();
    expect(t.record({ iteration: 1, gate: 'exit: 1 FAIL a' })).toBeUndefined(); // novel
    expect(t.record({ iteration: 2, gate: 'exit: 1 FAIL a' })).toBeUndefined(); // flat — 1
    expect(t.record({ iteration: 3, gate: 'exit: 1 FAIL b' })).toBeUndefined(); // novel — reset
    expect(t.record({ iteration: 4, gate: 'exit: 1 FAIL b' })).toBeUndefined(); // flat — 1
    expect(t.record({ iteration: 5, gate: 'exit: 1 FAIL b' })).toBeUndefined(); // flat — 2
    const report = t.record({ iteration: 6, gate: 'exit: 1 FAIL b' }); //          flat — 3
    expect(report?.iterations).toEqual([4, 5, 6]);
    expect(report?.evidence.join(' ')).toContain('gate');
  });
});

describe('workspaceFingerprint', () => {
  it('is undefined outside a git repo', async () => {
    expect(await workspaceFingerprint({ cwd: tmpBareDir() })).toBeUndefined();
  });

  it('is stable when nothing changes, and moves on a tracked edit', async () => {
    const repo = await tmpRepo();
    const a = await workspaceFingerprint({ cwd: repo });
    const b = await workspaceFingerprint({ cwd: repo });
    expect(a).toBeDefined();
    expect(b).toBe(a);
    writeFileSync(join(repo, 'README.md'), '# changed\n');
    expect(await workspaceFingerprint({ cwd: repo })).not.toBe(a);
  });

  it('sees untracked file CONTENT, not just the path', async () => {
    const repo = await tmpRepo();
    writeFileSync(join(repo, 'scratch.txt'), 'v1');
    const a = await workspaceFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'scratch.txt'), 'v2'); // same path, new content
    const b = await workspaceFingerprint({ cwd: repo });
    expect(b).not.toBe(a);
  });

  it('a byte-identical revisit fingerprints identically (oscillation is caught)', async () => {
    const repo = await tmpRepo();
    const before = await workspaceFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# detour\n');
    const detour = await workspaceFingerprint({ cwd: repo });
    writeFileSync(join(repo, 'README.md'), '# test\n'); // back to committed content
    const after = await workspaceFingerprint({ cwd: repo });
    expect(detour).not.toBe(before);
    expect(after).toBe(before);
  });

  it('scopes fingerprints to declared content across edits and commits', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'src', 'reviewed.ts'), 'export const value = 1;\n');
    writeFileSync(join(repo, 'docs', 'notes.md'), 'first\n');
    await stageAll({ cwd: repo });
    await commit({ subject: 'test: add scoped files' }, { cwd: repo });

    const fingerprint = () =>
      workspaceFingerprint({ cwd: repo, includePaths: ['src'] });
    const before = await fingerprint();

    writeFileSync(join(repo, 'docs', 'notes.md'), 'second\n');
    expect(await fingerprint()).toBe(before);
    await stageAll({ cwd: repo });
    await commit({ subject: 'test: change unreviewed file' }, { cwd: repo });
    expect(await fingerprint()).toBe(before);

    writeFileSync(join(repo, 'src', 'reviewed.ts'), 'export const value = 2;\n');
    expect(await fingerprint()).not.toBe(before);
    writeFileSync(join(repo, 'src', 'reviewed.ts'), 'export const value = 1;\n');
    expect(await fingerprint()).toBe(before);

    writeFileSync(join(repo, 'src', 'new.ts'), 'export const added = true;\n');
    expect(await fingerprint()).not.toBe(before);
  });

  it('includes explicitly scoped ignored content without adding it to the whole workspace', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(
      join(repo, 'node_modules', 'fixture', 'output.json'),
      '{"value":1}\n',
    );
    await stageAll({ cwd: repo });
    await commit({ subject: 'test: ignore dependencies' }, { cwd: repo });

    const scopedBefore = await workspaceFingerprint({
      cwd: repo,
      includePaths: ['node_modules/fixture'],
    });
    const wholeBefore = await workspaceFingerprint({ cwd: repo });
    writeFileSync(
      join(repo, 'node_modules', 'fixture', 'output.json'),
      '{"value":2}\n',
    );

    expect(
      await workspaceFingerprint({
        cwd: repo,
        includePaths: ['node_modules/fixture'],
      }),
    ).not.toBe(scopedBefore);
    expect(await workspaceFingerprint({ cwd: repo })).toBe(wholeBefore);
  });

  it('fails closed when a scoped pathspec makes a git probe fail', async () => {
    const repo = await tmpRepo();

    expect(
      await workspaceFingerprint({
        cwd: repo,
        includePaths: ['../outside-the-worktree'],
      }),
    ).toBeUndefined();
    expect(
      await workspaceFingerprint({
        cwd: repo,
        includePaths: [':(attr:missing-close'],
      }),
    ).toBeUndefined();
  });
});

describe('loop({ noProgress })', () => {
  it('is off by default: a flat loop runs all the way to max', async () => {
    const { outcome, stats } = await run(
      loop({
        name: 'flat',
        body: fnJob('b', async () => ({ status: 'fail', summary: 'same' })),
        max: 8,
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.stall).toBeUndefined();
    expect(stats.loopRuns[0]?.iterations).toBe(8);
  });

  it('stalls out early on a flat custom signal, with the evidence attached', async () => {
    const events: LoopEvent[] = [];
    const { outcome, stats } = await run(
      loop({
        name: 'doomed',
        body: fnJob('b', async () => ({ status: 'fail', summary: 'no luck' })),
        max: 20,
        noProgress: { window: 3, signal: () => 'stuck' },
      }),
      { ...bareOpts(), onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.iterations).toEqual([2, 3, 4]);
    expect(stats.loopRuns[0]?.iterations).toBe(4); // 1 novel + window, not 20
    const stall = events.find((e) => e.kind === 'loop:stall');
    expect(stall).toBeDefined();
    if (stall?.kind === 'loop:stall') {
      expect(stall.report.window).toBe(3);
      expect(stall.report.reason).toBeTruthy();
    }
  });

  it('accepts the bare-number sugar', async () => {
    const { stats } = await run(
      loop({
        name: 'sugar',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 20,
        noProgress: 2, // window of 2
      }),
      { ...mockOpts, cwd: await tmpRepo() }, // repo present, nothing ever written
    );
    expect(stats.loopRuns[0]?.iterations).toBe(3); // 1 novel + 2 flat
  });

  it('keeps going while the signal makes progress, stalls when it flattens', async () => {
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'slows',
        body: fnJob('b', async () => {
          n += 1;
          return { status: 'fail', summary: `n=${n}` };
        }),
        max: 20,
        noProgress: { window: 3, signal: () => Math.min(n, 4) },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    // 4 progressing iterations, then 3 flat ones fill the window.
    expect(stats.loopRuns[0]?.iterations).toBe(7);
  });

  it('rising gate confidence above the delta is progress; flat confidence is not', async () => {
    let conf = 0.3;
    const rising: Condition = async () => {
      conf = Math.min(conf + 0.1, 0.6); // climbs, then plateaus at 0.6
      return { met: false, confidence: conf, reason: 'not there yet' };
    };
    const { outcome, stats } = await run(
      loop({
        name: 'judge',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: rising,
        max: 20,
        noProgress: { window: 2 },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.reason).toBe('not there yet');
    // 0.4, 0.5, 0.6 are progress; the two plateau turns fill the window.
    expect(stats.loopRuns[0]?.iterations).toBe(5);
  });

  it('the workspace channel alone catches an agent that stops writing', async () => {
    const repo = await tmpRepo();
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'writer',
        body: fnJob('b', async () => {
          n += 1;
          // Writes for two turns, then goes idle (the classic dead loop).
          if (n <= 2) writeFileSync(join(repo, 'work.txt'), `attempt ${n}`);
          return { status: 'fail', summary: 'tests still red' };
        }),
        max: 20,
        noProgress: { window: 2 },
      }),
      { ...mockOpts, cwd: repo },
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.evidence.join(' ')).toContain('workspace');
    expect(stats.loopRuns[0]?.iterations).toBe(4); // 2 writing + 2 idle
  });

  it('ignores the run record when measuring workspace progress', async () => {
    const repo = await tmpRepo();
    const { outcome, stats } = await run(
      loop({
        name: 'recording',
        body: fnJob('b', async () => ({ status: 'fail', summary: 'same' })),
        max: 10,
        noProgress: { window: 2 },
      }),
      { ...mockOpts, cwd: repo, recordTo: join(repo, 'run.jsonl') },
    );

    expect(outcome.summary).toContain('stalled');
    expect(stats.loopRuns[0]?.iterations).toBe(3);
  });

  it('warns once and stays inert when no evidence channel exists', async () => {
    const events: LoopEvent[] = [];
    const { outcome, stats } = await run(
      loop({
        name: 'blind',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 6,
        noProgress: { window: 2, workspace: false }, // no repo, no signal, no confidence
      }),
      { ...bareOpts(), onEvent: (e) => events.push(e) },
    );
    expect(outcome.status).toBe('exhausted'); // via max, not the detector
    expect(outcome.stall).toBeUndefined();
    expect(stats.loopRuns[0]?.iterations).toBe(6);
    const warns = events.filter(
      (e) => e.kind === 'log' && e.level === 'warn' && /inert/.test(e.message),
    );
    expect(warns.length).toBe(1);
  });

  it('a converging loop is never cut short', async () => {
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'converges',
        body: fnJob('b', async () => {
          n += 1;
          return { status: n >= 5 ? 'pass' : 'fail' };
        }),
        until: predicate(() => n >= 5, 'done'),
        max: 20,
        noProgress: { window: 3, signal: () => n }, // signal changes every turn
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('pass');
    expect(stats.loopRuns[0]?.iterations).toBe(5);
  });

  it('a throwing signal fn fails the loop loudly (guarded user code)', async () => {
    const { outcome } = await run(
      loop({
        name: 'buggy',
        body: fnJob('b', async () => ({ status: 'fail' })),
        max: 5,
        noProgress: {
          window: 2,
          signal: () => {
            throw new Error('signal blew up');
          },
        },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('signal blew up');
  });

  it('review-rejection turns feed the detector (a flat standoff stalls)', async () => {
    const { outcome, stats } = await run(
      loop({
        name: 'standoff',
        body: fnJob('b', async () => ({ status: 'pass', summary: 'claimed done' })),
        review: fnJob('r', async () => ({
          status: 'fail',
          summary: 'same blocker',
          confidence: 0.4,
        })),
        max: 20,
        noProgress: { window: 3, signal: () => 'unchanged' },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.reason).toBe('same blocker');
    expect(stats.loopRuns[0]?.iterations).toBe(4);
  });

  it('exposes the window in the loop description', () => {
    const j = loop({
      name: 'shaped',
      body: fnJob('b', async () => ({ status: 'pass' })),
      noProgress: 4,
    });
    expect(jobMeta(j)?.noProgress).toBe(4);
  });

  it('gate: true stalls on a repeating until-failure signature', async () => {
    const { outcome, stats } = await run(
      loop({
        name: 'gate-stall',
        body: fnJob('b', async () => ({ status: 'fail', summary: 'attempt' })),
        until: async () => ({
          met: false,
          reason: 'tests red',
          output: 'exit: 1\n\nstdout:\nFAIL store.spec\n\nstderr:\n',
        }),
        max: 20,
        noProgress: { window: 2, gate: true, workspace: false },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted');
    expect(outcome.summary).toContain('stalled');
    expect(outcome.stall?.evidence.join(' ')).toContain('gate');
    expect(stats.loopRuns[0]?.iterations).toBe(3); // 1 novel + window
  });

  it('a changing failure signature is progress — the loop runs to max', async () => {
    let n = 0;
    const { outcome, stats } = await run(
      loop({
        name: 'gate-moves',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: async () => {
          n += 1;
          return { met: false, reason: 'red', output: `failure #${n}` };
        },
        max: 6,
        noProgress: { window: 2, gate: true, workspace: false },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted'); // via max, not the detector
    expect(outcome.stall).toBeUndefined();
    expect(stats.loopRuns[0]?.iterations).toBe(6);
  });

  it('a gate verdict with no output leaves the channel absent (indeterminate)', async () => {
    const { outcome, stats } = await run(
      loop({
        name: 'gate-blind',
        body: fnJob('b', async () => ({ status: 'fail' })),
        until: async () => ({ met: false, reason: 'red, no diagnostics' }),
        max: 5,
        noProgress: { window: 2, gate: true, workspace: false },
      }),
      bareOpts(),
    );
    expect(outcome.status).toBe('exhausted'); // via max, not the detector
    expect(outcome.stall).toBeUndefined();
    expect(stats.loopRuns[0]?.iterations).toBe(5);
  });
});
