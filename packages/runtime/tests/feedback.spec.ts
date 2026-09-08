import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  loop,
  dag,
  agentJob,
  fnJob,
  agentCheck,
  quorum,
  reviewPanel,
  reviewContext,
  revisionRequest,
  confidenceCondition,
  LoopError,
} from '../src/api.ts';
import type { AgentRequest, Condition, RunOptions } from '../src/api.ts';
import {
  feedbackBlock,
  isRequiredFeedbackSeverity,
  normalizeFeedbackSeverity,
} from '../src/core/feedback.ts';
import { MockEngine } from '../src/testing.ts';
import { commit, stageAll } from '../src/core/git.ts';
import { cleanupRepos, tmpRepo, write } from './git-helpers.ts';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

afterAll(cleanupRepos);

async function commitFiles(repo: string, subject: string): Promise<void> {
  await stageAll({ cwd: repo });
  await commit({ subject }, { cwd: repo });
}

function capturing(
  responder: (req: AgentRequest) => string = () => 'done',
): { opts: RunOptions; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    opts: {
      engine: 'mock',
      engines: {
        mock:
          new MockEngine((req) => {
            prompts.push(req.prompt);
            return responder(req);
          }),
      },
    },
  };
}

describe('feedback protocol', () => {
  it('agentJob consumeFeedback appends ctx.lastReview to the next agent prompt', async () => {
    const repo = await tmpRepo();
    const cap = capturing();
    let reviews = 0;

    const { outcome } = await run(
      loop({
        name: 'build',
        body: agentJob({
          label: 'implementation',
          prompt: 'Implement the parser.',
          consumeFeedback: true,
        }),
        review: fnJob('review', async () => {
          reviews += 1;
          return reviews === 1
            ? revisionRequest({
                reason: 'Parser still accepts empty duration strings.',
                findings: [
                  {
                    reviewer: 'correctness',
                    severity: 'block',
                    evidence: 'parseDuration("") returns 0',
                    recommendation: 'Reject empty input before unit parsing.',
                  },
                ],
              })
            : { status: 'pass', summary: 'approved' };
        }),
        max: 2,
      }),
      { ...cap.opts, cwd: repo },
    );

    expect(outcome.status).toBe('pass');
    expect(cap.prompts).toHaveLength(2);
    expect(cap.prompts[0]).toBe('Implement the parser.');
    expect(cap.prompts[1]).toContain('## Feedback to address');
    expect(cap.prompts[1]).toContain('Parser still accepts empty duration strings.');
    expect(cap.prompts[1]).toContain('correctness');
    expect(cap.prompts[1]).toContain('Reject empty input');
  });

  it('revisionRequest is the shared loop-review and dag-kickback feedback shape', async () => {
    const seen: string[] = [];
    let implementationFeedback: string | undefined;
    let reviewRuns = 0;

    const { outcome } = await run(
      dag({
        name: 'ship',
        maxKickbacks: 1,
        nodes: {
          implementation: fnJob('implementation', async (ctx) => {
            seen.push('implementation');
            implementationFeedback = ctx.lastReview?.revision?.reason;
            return { status: 'pass' };
          }),
          review: {
            needs: ['implementation'],
            job: fnJob('review', async () => {
              seen.push('review');
              reviewRuns += 1;
              return reviewRuns === 1
                ? revisionRequest({
                    target: 'implementation',
                    reason: 'The implementation misses cancellation handling.',
                    findings: [
                      {
                        reviewer: 'resilience',
                        severity: 'block',
                        evidence: 'AbortSignal is ignored.',
                      },
                    ],
                  })
                : { status: 'pass' };
            }),
          },
        },
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    expect(seen).toEqual(['implementation', 'review', 'implementation', 'review']);
    expect(implementationFeedback).toContain('cancellation handling');
  });

  it('reviewPanel aggregates reviewers into one structured outcome', async () => {
    const pass: Condition = async () => ({
      met: true,
      confidence: 0.95,
      reason: 'No issue found.',
    });
    const block: Condition = async () => ({
      met: false,
      confidence: 0.2,
      reason: 'The query path interpolates user input.',
    });
    const alsoBlock: Condition = async () => ({
      met: false,
      confidence: 0.6,
      reason: 'The helper name is vague.',
    });

    const { outcome } = await run(
      reviewPanel({
        label: 'review',
        reviewers: [
          { name: 'correctness', review: pass },
          { name: 'security', review: block },
          { name: 'simplicity', review: alsoBlock },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('1/3 reviewer(s) cleared');
    expect(outcome.revision?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reviewer: 'security', severity: 'block' }),
        expect.objectContaining({ reviewer: 'simplicity', severity: 'block' }),
      ]),
    );
    expect((outcome.data as { findings: unknown[] }).findings).toHaveLength(2);
  });

  it('classifies finding severities and gates on k-of-n over all reviewers', async () => {
    expect(normalizeFeedbackSeverity(undefined)).toBe('block');
    expect(isRequiredFeedbackSeverity('should-fix')).toBe(true);
    expect(isRequiredFeedbackSeverity('nice-to-have')).toBe(false);

    const passing: Condition = async () => ({
      met: true,
      confidence: 0.9,
      reason: 'Looks good.',
    });
    const failing: Condition = async () => ({
      met: false,
      confidence: 0.7,
      reason: 'The retry path loses the original error.',
    });

    // Every reviewer gates; `pass: 2` clears when 2 of the 3 pass.
    const { outcome } = await run(
      reviewPanel({
        pass: 2,
        reviewers: [
          { name: 'correctness', review: passing },
          { name: 'security', review: passing },
          { name: 'simplicity', review: failing },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('2/3 reviewer(s) cleared');
    // A failing reviewer's finding is still surfaced, as a blocking finding.
    expect((outcome.data as { findings: unknown[] }).findings).toEqual([
      expect.objectContaining({ reviewer: 'simplicity', severity: 'block' }),
    ]);

    // An empty panel is a construction error, not a vacuous 0/0 pass.
    expect(() => reviewPanel({ reviewers: [] })).toThrow(/at least one reviewer/);
    expect(() =>
      reviewPanel({ pass: 0, reviewers: [{ name: 'a', review: passing }] }),
    ).toThrow(/pass must be an integer/);
    expect(() =>
      reviewPanel({ pass: 2, reviewers: [{ name: 'a', review: passing }] }),
    ).toThrow(/pass must be an integer/);
    expect(() =>
      reviewPanel({ pass: 1.5, reviewers: [{ name: 'a', review: passing }] }),
    ).toThrow(/pass must be an integer/);
  });

  it('caps reviewer fan-out, defaulting to four in flight', async () => {
    let active = 0;
    let peak = 0;
    const reviewer = (): Condition => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { met: true, reason: 'ok' };
    };

    const { outcome } = await run(
      reviewPanel({
        reviewers: Array.from({ length: 6 }, (_, i) => ({
          name: `r${i}`,
          review: reviewer(),
        })),
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('keeps run-owned files out of whole-workspace pass fingerprints', async () => {
    const repo = await tmpRepo();
    const recordTo = join(repo, 'review.run.jsonl');
    const state: Record<string, unknown> = {};
    let stableRuns = 0;
    let limitedRuns = 0;
    const build = () =>
      reviewPanel({
        label: 'persisted-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [
          {
            name: 'stable',
            cacheVersion: 'v1',
            review: async () => {
              stableRuns += 1;
              return { met: true, confidence: 0.95, reason: 'stable' };
            },
          },
          {
            name: 'limited',
            cacheVersion: 'v1',
            review: async () => {
              limitedRuns += 1;
              if (limitedRuns === 1)
                throw new LoopError({ code: 'QUOTA', message: 'usage limit' });
              return { met: true, confidence: 0.96, reason: 'recovered' };
            },
          },
        ],
      });
    const opts = {
      engine: 'mock' as const,
      engines: { mock: new MockEngine(() => '') },
      cwd: repo,
      recordTo,
      state,
    };

    const first = await run(build(), opts);
    expect(first.outcome.status).toBe('paused');

    const second = await run(build(), opts);
    expect(second.outcome.status).toBe('pass');
    expect(stableRuns).toBe(1);
    expect(limitedRuns).toBe(2);
  });

  it('reruns a persisted pass only when its declared content changes', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'docs'));
    write(repo, 'src/reviewed.ts', 'export const value = 1;\n');
    write(repo, 'docs/notes.md', 'first\n');
    await commitFiles(repo, 'test: add review fixture');
    const state: Record<string, unknown> = {};
    let runs = 0;
    const build = () =>
      reviewPanel({
        label: 'scoped-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [
          {
            name: 'correctness',
            cacheVersion: 'v1',
            invalidateOn: ['src'],
            review: async () => {
              runs += 1;
              return { met: true, confidence: 0.95, reason: 'clear' };
            },
          },
        ],
      });
    const opts = {
      engine: 'mock' as const,
      engines: { mock: new MockEngine(() => '') },
      cwd: repo,
      state,
    };

    expect((await run(build(), opts)).outcome.status).toBe('pass');
    expect(Object.values(state)).toEqual([
      {
        correctness: {
          identity: expect.stringMatching(/^[0-9a-f]{64}$/),
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          confidence: 0.95,
        },
      },
    ]);
    expect((await run(build(), opts)).outcome.status).toBe('pass');
    write(repo, 'docs/notes.md', 'second\n');
    expect((await run(build(), opts)).outcome.status).toBe('pass');
    expect(runs).toBe(1);

    write(repo, 'src/reviewed.ts', 'export const value = 2;\n');
    expect((await run(build(), opts)).outcome.status).toBe('pass');
    expect(runs).toBe(2);
  });

  it('fails closed for low-confidence and malformed persisted passes', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    write(repo, 'src/reviewed.ts', 'export const value = 1;\n');
    const state: Record<string, unknown> = {};
    let lowRuns = 0;
    const lowConfidence = () =>
      reviewPanel({
        label: 'low-confidence-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [
          {
            name: 'correctness',
            cacheVersion: 'v1',
            invalidateOn: ['src'],
            review: async () => {
              lowRuns += 1;
              return { met: true, confidence: 0.89, reason: 'uncertain' };
            },
          },
        ],
      });
    const opts = {
      engine: 'mock' as const,
      engines: { mock: new MockEngine(() => '') },
      cwd: repo,
      state,
    };

    await run(lowConfidence(), opts);
    await run(lowConfidence(), opts);
    expect(lowRuns).toBe(2);
    expect(state).toEqual({});

    let highRuns = 0;
    const highConfidence = () =>
      reviewPanel({
        label: 'malformed-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [
          {
            name: 'security',
            cacheVersion: 'v1',
            invalidateOn: ['src'],
            review: async () => {
              highRuns += 1;
              return { met: true, confidence: 0.95, reason: 'clear' };
            },
          },
        ],
      });
    await run(highConfidence(), opts);
    for (const key of Object.keys(state)) state[key] = 'malformed';
    await run(highConfidence(), opts);
    expect(highRuns).toBe(2);
  });

  it('does not persist a pass when its evidence changes during review', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    write(repo, 'src/reviewed.ts', 'export const value = 1;\n');
    const state: Record<string, unknown> = {};
    let runs = 0;
    const build = () =>
      reviewPanel({
        label: 'stable-evidence-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [
          {
            name: 'correctness',
            cacheVersion: 'v1',
            invalidateOn: ['src'],
            review: async () => {
              runs += 1;
              if (runs === 1)
                write(repo, 'src/reviewed.ts', 'export const value = 2;\n');
              return { met: true, confidence: 0.95, reason: 'clear' };
            },
          },
        ],
      });
    const opts = {
      engine: 'mock' as const,
      engines: { mock: new MockEngine(() => '') },
      cwd: repo,
      state,
    };

    await run(build(), opts);
    await run(build(), opts);
    expect(runs).toBe(2);
  });

  it('binds persisted passes to an explicit reviewer cache version', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    write(repo, 'src/reviewed.ts', 'export const value = 1;\n');
    const state: Record<string, unknown> = {};
    let firstRuns = 0;
    let changedRuns = 0;
    const opts = {
      engine: 'mock' as const,
      engines: { mock: new MockEngine(() => '') },
      cwd: repo,
      state,
    };

    const first = reviewPanel({
      label: 'versioned-review',
      persistPasses: { minConfidence: 0.9 },
      reviewers: [
        {
          name: 'correctness',
          cacheVersion: 'v1',
          invalidateOn: ['src'],
          review: async () => {
            firstRuns += 1;
            return { met: true, confidence: 0.95, reason: 'old criteria pass' };
          },
        },
      ],
    });
    expect((await run(first, opts)).outcome.status).toBe('pass');

    const changed = reviewPanel({
      label: 'versioned-review',
      persistPasses: { minConfidence: 0.9 },
      reviewers: [
        {
          name: 'correctness',
          cacheVersion: 'v2',
          invalidateOn: ['src'],
          review: async () => {
            changedRuns += 1;
            return { met: false, confidence: 0.99, reason: 'new criteria fail' };
          },
        },
      ],
    });
    expect((await run(changed, opts)).outcome.status).toBe('fail');
    expect(firstRuns).toBe(1);
    expect(changedRuns).toBe(1);
  });

  it('reruns stale reused seats in parallel after another reviewer changes their evidence', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    write(repo, 'src/reviewed.ts', 'export const value = 1;\n');
    const state: Record<string, unknown> = {};
    const reusedRuns = [0, 0];
    let mutatorRuns = 0;
    let mutate = false;
    let active = 0;
    let peak = 0;
    let arrivals = 0;
    let releaseReruns = () => {};
    let rerunBarrier = Promise.resolve();
    const reusableReviewer = (index: number): Condition => async () => {
      reusedRuns[index]! += 1;
      if (mutate) {
        active += 1;
        peak = Math.max(peak, active);
        arrivals += 1;
        if (arrivals === 2) releaseReruns();
        await rerunBarrier;
        active -= 1;
      }
      return { met: true, confidence: 0.95, reason: 'clear' };
    };
    const build = () =>
      reviewPanel({
        label: 'concurrent-invalidation-review',
        persistPasses: { minConfidence: 0.9 },
        concurrency: 2,
        reviewers: [
          {
            name: 'stable-a',
            cacheVersion: 'v1',
            invalidateOn: ['src'],
            review: reusableReviewer(0),
          },
          {
            name: 'stable-b',
            cacheVersion: 'v1',
            invalidateOn: ['src'],
            review: reusableReviewer(1),
          },
          {
            name: 'mutator',
            cacheVersion: 'v1',
            invalidateOn: ['src'],
            review: async () => {
              mutatorRuns += 1;
              if (mutate) {
                write(repo, 'src/reviewed.ts', 'export const value = 2;\n');
              }
              return { met: true, confidence: 0.5, reason: 'not reusable' };
            },
          },
        ],
      });
    const opts = {
      engine: 'mock' as const,
      engines: { mock: new MockEngine(() => '') },
      cwd: repo,
      state,
    };

    expect((await run(build(), opts)).outcome.status).toBe('pass');
    rerunBarrier = new Promise<void>((resolve) => {
      releaseReruns = resolve;
    });
    mutate = true;
    expect((await run(build(), opts)).outcome.status).toBe('pass');
    mutate = false;
    expect((await run(build(), opts)).outcome.status).toBe('pass');

    expect(reusedRuns).toEqual([2, 2]);
    expect(mutatorRuns).toBe(3);
    expect(peak).toBe(2);
  });

  it('fails the current panel when a bounded rerun invalidates another reused pass', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    write(repo, 'src/a.ts', 'export const a = 1;\n');
    write(repo, 'src/b.ts', 'export const b = 1;\n');
    const state: Record<string, unknown> = {};
    const runs = [0, 0];
    let cascade = false;
    const build = () =>
      reviewPanel({
        label: 'overlapping-mutation-review',
        persistPasses: { minConfidence: 0.9 },
        concurrency: 2,
        reviewers: [
          {
            name: 'review-a',
            cacheVersion: 'v1',
            invalidateOn: ['src/a.ts'],
            review: async () => {
              runs[0]! += 1;
              if (cascade) write(repo, 'src/b.ts', 'export const b = 2;\n');
              return { met: true, confidence: 0.95, reason: 'a clear' };
            },
          },
          {
            name: 'review-b',
            cacheVersion: 'v1',
            invalidateOn: ['src/b.ts'],
            review: async () => {
              runs[1]! += 1;
              return { met: true, confidence: 0.95, reason: 'b clear' };
            },
          },
          {
            name: 'mutator',
            cacheVersion: 'v1',
            invalidateOn: ['src/a.ts'],
            review: async () => {
              if (cascade) write(repo, 'src/a.ts', 'export const a = 2;\n');
              return { met: true, confidence: 0.5, reason: 'not reusable' };
            },
          },
        ],
      });
    const opts = {
      engine: 'mock' as const,
      engines: { mock: new MockEngine(() => '') },
      cwd: repo,
      state,
    };

    expect((await run(build(), opts)).outcome.status).toBe('pass');
    cascade = true;
    const unstable = await run(build(), opts);
    expect(unstable.outcome.status).toBe('fail');
    expect(unstable.outcome.revision?.findings).toEqual([
      expect.objectContaining({
        reviewer: 'review-b',
        evidence: 'review evidence changed during panel',
      }),
    ]);

    cascade = false;
    expect((await run(build(), opts)).outcome.status).toBe('pass');
    expect(runs).toEqual([2, 2]);
  });

  it('requires stable reviewer identities for persisted passes', async () => {
    const pass: Condition = async () => ({
      met: true,
      confidence: 0.95,
      reason: 'clear',
    });

    expect(() =>
      reviewPanel({
        persistPasses: { minConfidence: 0.9 },
        reviewers: [{ name: 'correctness', cacheVersion: 'v1', review: pass }],
      }),
    ).toThrow(/explicit label/);
    expect(() =>
      reviewPanel({
        label: 'persisted-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [{ cacheVersion: 'v1', review: pass }],
      }),
    ).toThrow(/explicit name/);
    expect(() =>
      reviewPanel({
        label: 'persisted-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [
          { name: 'correctness', cacheVersion: 'v1', review: pass },
          { name: 'correctness', cacheVersion: 'v1', review: pass },
        ],
      }),
    ).toThrow(/unique/);
    expect(() =>
      reviewPanel({
        label: 'persisted-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [
          { name: 'correctness', cacheVersion: 'v1', review: pass },
          { name: ' correctness ', cacheVersion: 'v1', review: pass },
        ],
      }),
    ).toThrow(/unique/);
    expect(() =>
      reviewPanel({
        label: 'persisted-review',
        persistPasses: { minConfidence: 0.9 },
        reviewers: [{ name: 'correctness', review: pass }],
      }),
    ).toThrow(/cacheVersion/);
    expect(() =>
      reviewPanel({
        label: 'persisted-review',
        persistPasses: { minConfidence: 2 },
        reviewers: [{ name: 'correctness', cacheVersion: 'v1', review: pass }],
      }),
    ).toThrow(/minConfidence/);
  });

  it('keeps engine errors out of review findings and pauses an all-error panel', async () => {
    const limit = new LoopError({
      code: 'RATE_LIMIT',
      phase: 'engine',
      message: 'provider throttled',
    });

    const { outcome } = await run(
      reviewPanel({
        reviewers: [
          {
            name: 'transport',
            job: fnJob('transport', async () => ({
              status: 'fail',
              summary: 'provider throttled',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('RATE_LIMIT');
    expect(outcome.revision?.findings).toBeUndefined();
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('pauses when confidenceCondition wraps an infrastructure failure', async () => {
    const limit = new LoopError({
      code: 'QUOTA',
      message: "You've hit your session limit",
    });
    const reviewer = fnJob('limited-reviewer', async () => ({
      status: 'fail',
      summary: limit.message,
      error: limit,
    }));

    const { outcome } = await run(
      reviewPanel({
        reviewers: [
          {
            name: 'wrapped-reviewer',
            review: confidenceCondition(reviewer),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error).toBe(limit);
    expect(outcome.revision).toBeUndefined();
    expect((outcome.data as { findings: unknown[] }).findings).toHaveLength(0);
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('keeps budget exhaustion out of review findings and pauses the panel', async () => {
    const { outcome } = await run(
      reviewPanel({
        reviewers: [
          {
            name: 'budget',
            review: async () => {
              throw new LoopError({
                code: 'BUDGET',
                phase: 'review',
                message: 'token budget exhausted',
              });
            },
          },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('BUDGET');
    expect(outcome.revision).toBeUndefined();
    expect((outcome.data as { findings: unknown[] }).findings).toHaveLength(0);
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('preserves quorum engine errors when they can change the verdict', async () => {
    const yes: Condition = async () => ({ met: true, reason: 'yes' });
    const limit: Condition = async () => {
      throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
    };

    const { outcome } = await run(
      reviewPanel({
        reviewers: [{ name: 'jury', review: quorum(2, yes, limit) }],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.revision).toBeUndefined();
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('can pass k-of-n while still reporting reviewer engine errors separately', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const limit = new LoopError({ code: 'QUOTA', message: 'usage limit' });

    const { outcome } = await run(
      reviewPanel({
        pass: 2,
        reviewers: [
          { name: 'a', review: pass },
          { name: 'b', review: pass },
          {
            name: 'quota',
            job: fnJob('quota', async () => ({
              status: 'fail',
              summary: 'usage limit',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    expect((outcome.data as { findings: unknown[] }).findings).toHaveLength(0);
    expect((outcome.data as { errors: unknown[] }).errors).toHaveLength(1);
  });

  it('pauses k-of-n when an infrastructure error could change the threshold', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const fail: Condition = async () => ({
      met: false,
      reason: 'the retry path loses the original error',
      output: 'Full deterministic finding: preserve original error cause.',
    });
    const limit = new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });

    const { outcome } = await run(
      reviewPanel({
        pass: 2,
        reviewers: [
          { name: 'a', review: pass },
          { name: 'b', review: fail },
          {
            name: 'transport',
            job: fnJob('transport', async () => ({
              status: 'fail',
              summary: 'throttled',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('RATE_LIMIT');
    expect(outcome.revision).toBeUndefined();
    const data = outcome.data as {
      findings: Array<{ evidence?: string }>;
      errors: unknown[];
    };
    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]?.evidence).toContain(
      'Full deterministic finding',
    );
    expect(data.errors).toHaveLength(1);
  });

  it('preserves failing quorum output while pausing on infrastructure uncertainty', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const fail: Condition = async () => ({
      met: false,
      reason: 'short finding',
      output: 'Nested quorum finding: the migration drops retries.',
    });
    const limit: Condition = async () => {
      throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
    };

    const { outcome } = await run(
      reviewPanel({
        reviewers: [{ name: 'jury', review: quorum(2, pass, fail, limit) }],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    expect(outcome.error?.code).toBe('RATE_LIMIT');
    expect(outcome.revision).toBeUndefined();
    const data = outcome.data as {
      findings: Array<{ evidence?: string }>;
      errors: unknown[];
    };
    expect(data.findings).toEqual([
      expect.objectContaining({
        reviewer: 'jury',
        evidence: expect.stringContaining('Nested quorum finding'),
      }),
    ]);
    expect(data.errors).toHaveLength(1);
  });

  it('pauses default all panels when a required reviewer engine-errors', async () => {
    const pass: Condition = async () => ({ met: true, reason: 'ok' });
    const limit = new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });

    const { outcome } = await run(
      reviewPanel({
        reviewers: [
          { name: 'a', review: pass },
          {
            name: 'transport',
            job: fnJob('transport', async () => ({
              status: 'fail',
              summary: 'throttled',
              error: limit,
            })),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('paused');
    const data = outcome.data as { required: number; errors: unknown[] };
    expect(data.required).toBe(2);
    expect(data.errors).toHaveLength(1);
  });

  it('escalates out-of-scope findings instead of failing a scoped panel', async () => {
    const { outcome } = await run(
      reviewPanel({
        actionableScopes: ['connector'],
        reviewers: [
          {
            name: 'platform-review',
            job: fnJob('platform-review', async () =>
              revisionRequest({
                reason: 'Platform helper needs a separate wave.',
                findings: [
                  {
                    reviewer: 'platform-review',
                    severity: 'block',
                    scope: 'platform',
                    evidence: 'Shared manifest loader lacks validation.',
                  },
                ],
              }),
            ),
          },
        ],
      }),
      { engine: 'mock', engines: { mock: new MockEngine(() => '') } },
    );

    expect(outcome.status).toBe('pass');
    const data = outcome.data as {
      findings: unknown[];
      escalatedFindings: Array<{ scope?: string; decision?: string }>;
    };
    expect(data.findings).toHaveLength(0);
    expect(data.escalatedFindings).toEqual([
      expect.objectContaining({ scope: 'platform', decision: 'escalated' }),
    ]);
  });

  it('renders caller decisions and canonical severity labels in feedback blocks', () => {
    const block = feedbackBlock(
      revisionRequest({
        reason: 'Tests are red.',
        decision: 'accepted',
        findings: [
          {
            reviewer: 'correctness',
            severity: 'should-fix',
            decision: 'deferred',
            evidence: 'The retry test fails on the second attempt.',
            recommendation: 'Preserve the original error across retries.',
          },
        ],
      }),
    );

    expect(block).toContain('Caller decision: accepted');
    expect(block).toContain('correctness [should-fix]');
    expect(block).toContain('Decision: deferred.');
    expect(block).toContain('Preserve the original error');
  });

  it('reviewContext provides a diff, selected files, and last outcome context', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'), { recursive: true });
    write(repo, 'src/a.ts', 'export const value = 1;\n');
    await commitFiles(repo, 'chore: add fixture');
    write(repo, 'src/a.ts', 'export const value = 2;\n');

    const cap = capturing(() => JSON.stringify({ verdict: 'yes', confidence: 0.9, reason: 'ok' }));
    const { outcome } = await run(
      loop({
        name: 'review',
        body: fnJob('body', async () => ({
          status: 'pass',
          summary: 'Tests passed in the implementation step.',
        })),
        review: reviewPanel({
          reviewers: [
            {
              name: 'correctness',
              review: agentCheck({
                question: 'Is the change correct?',
                context: reviewContext({
                  diff: true,
                  files: ['src/a.ts'],
                  tests: true,
                }),
              }),
            },
          ],
        }),
        max: 1,
      }),
      { ...cap.opts, cwd: repo },
    );

    expect(outcome.status).toBe('pass');
    const prompt = cap.prompts[0]!;
    expect(prompt).toContain('## Git diff');
    expect(prompt).toContain('-export const value = 1;');
    expect(prompt).toContain('+export const value = 2;');
    expect(prompt).toContain('## File: src/a.ts');
    expect(prompt).toContain('Tests passed in the implementation step.');
  });

  it('caps the assembled reviewContext while keeping higher-priority evidence first', async () => {
    const repo = await tmpRepo();
    mkdirSync(join(repo, 'src'));
    write(repo, 'src/change.ts', 'export const changed = "before";\n');
    write(repo, 'src/detail.ts', 'FILE-THIRD '.repeat(40));
    await commitFiles(repo, 'test: add context fixtures');
    write(repo, 'src/change.ts', 'export const changed = "DIFF-SECOND";\n');
    const maxChars = 180;
    let context = '';

    await run(
      fnJob('capture-review-context', async (ctx) => {
        context = await reviewContext({
          tests: true,
          diff: true,
          files: ['src/detail.ts'],
          maxChars,
        })(ctx, { status: 'pass', summary: 'TEST-FIRST' });
        return { status: 'pass' };
      }),
      {
        engine: 'mock',
      engines: { mock: new MockEngine(() => '') },
        cwd: repo,
      },
    );

    expect(context.length).toBeLessThanOrEqual(maxChars);
    expect(context).toContain('TEST-FIRST');
    expect(context).toContain('## Git diff');
    expect(context).not.toContain('## File: src/detail.ts');
  });

  it('agentJob graphContext appends the node location without exposing the whole graph', async () => {
    const repo = await tmpRepo();
    const cap = capturing();

    await run(
      dag({
        name: 'ship',
        nodes: {
          implementation: agentJob({
            label: 'implementation',
            prompt: 'Build it.',
            graphContext: true,
          }),
          review: {
            needs: ['implementation'],
            job: fnJob('review', async () => ({ status: 'pass' })),
          },
        },
      }),
      { ...cap.opts, cwd: repo },
    );

    expect(cap.prompts[0]).toContain('## Graph position');
    expect(cap.prompts[0]).toContain('Current node: implementation');
    expect(cap.prompts[0]).toContain('Depends on: none');
    expect(cap.prompts[0]).toContain('Direct dependents: review');
  });
});
