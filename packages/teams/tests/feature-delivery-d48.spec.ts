import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { jobMeta, reviewPanel, run } from '@obversa/runtime';

import { featureDelivery } from '../src/index.js';
import { panelReviewers } from '../src/team-utils.js';
import type { FeatureDeliveryConfig } from '../src/types.js';
import { pass, revise, scriptedEngine, seat } from './scripted-engine.js';

const testCommand = {
  command: process.execPath,
  args: ['--test', 'test/result.test.mjs'],
  timeoutMs: 30_000,
};

function config(overrides: Partial<FeatureDeliveryConfig> = {}): FeatureDeliveryConfig {
  const analyse = scriptedEngine('analyse', [async (request) => {
    const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
    await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
    const text = output.endsWith('research-requirements.md')
      ? 'REQ-1: Export result.\nREQ-2: Test result.\n'
      : output.endsWith('plan.md')
        ? 'REQ-1: Acceptance check: source exists.\nREQ-2: Acceptance check: command exits 0.\n'
        : 'The workspace context is recorded.\n';
    await writeFile(join(request.cwd!, output), text);
    return pass('accepted');
  }]);
  const implement = scriptedEngine('implement', [async (request) => {
    if (request.prompt.includes('write the declared tests first')) {
      await mkdir(join(request.cwd!, 'test'), { recursive: true });
      await writeFile(
        join(request.cwd!, 'test/result.test.mjs'),
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('result is 11', () => assert.equal(11, 11));\n",
      );
    } else {
      await mkdir(join(request.cwd!, 'src'), { recursive: true });
      await writeFile(join(request.cwd!, 'src/result.mjs'), 'export const result = 11;\n');
    }
    return pass('accepted');
  }]);
  const reviewer = scriptedEngine('reviewer', [async () => pass('accepted')]);
  const approve = scriptedEngine('approve', [async (request) => {
    const marker = request.prompt.match(/marker value (.+?) anywhere/)?.[1] ?? '';
    await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
    await writeFile(join(request.cwd!, 'team-output/approval.md'), `Run marker: ${marker}\n`);
    return pass('accepted');
  }]);
  return {
    brief: 'Deliver a module that exports result 11.',
    workspace: '/tmp/obversa-teams-feature',
    files: ['src/result.mjs', 'test/result.test.mjs'],
    testFiles: ['test/result.test.mjs'],
    test: testCommand,
    analyse: seat(analyse, 'analyse'),
    implement: seat(implement, 'implement'),
    reviewers: [{ name: 'correctness', seat: seat(reviewer, 'reviewer'), scope: 'implementation' }],
    reviewThreshold: 1,
    approve: seat(approve, 'approve'),
    maxKickbacks: { plan: 3, 'tests-first': 3, implement: 3 },
    ...overrides,
  };
}

describe('featureDelivery D48 contract', () => {
  it('requires testFiles instead of retaining the five-node graph', () => {
    const invalid = config() as unknown as Record<string, unknown>;
    delete invalid.testFiles;

    expect(() => featureDelivery(invalid as unknown as FeatureDeliveryConfig)).toThrow(/testFiles/i);
  });

  it('exposes the fine-grained stage list', () => {
    const meta = jobMeta(featureDelivery(config()));
    const nodes = (meta?.nodes as Array<Record<string, unknown>>) ?? [];

    expect(nodes.map((node) => node.name)).toEqual([
      'prepare',
      'research-context',
      'research-requirements',
      'plan',
      'plan-review',
      'tests-first',
      'tests-review',
      'implement',
      'verify',
      'approve',
      'close',
    ]);
  });

  it('rejects duplicate reviewer names before a run starts', () => {
    const duplicate = config({
      reviewers: [
        { name: 'correctness', seat: seat(scriptedEngine('one', [async () => pass('ok')]), 'one') },
        { name: ' correctness ', seat: seat(scriptedEngine('two', [async () => pass('ok')]), 'two') },
      ],
      reviewThreshold: 1,
    });

    expect(() => featureDelivery(duplicate)).toThrow(/reviewer name/i);
  });

  it('rejects reviewer names outside the workspace', () => {
    for (const name of ['../outside', '/tmp/outside']) {
      const invalid = config({
        reviewers: [{ name, seat: seat(scriptedEngine(name, [async () => pass('ok')]), name) }],
        reviewThreshold: 1,
      });

      expect(() => featureDelivery(invalid)).toThrow(/relative path/i);
    }
  });

  it('puts reviewer scope in the reviewer request', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-scope-'));
    const reviewer = scriptedEngine('scoped-reviewer', [async (request) => {
      expect(request.prompt).toContain('Scope: implementation');
      return pass('scoped review accepted');
    }]);
    try {
      const input = config({
        reviewers: [{
          name: 'scoped',
          seat: seat(reviewer, 'scoped-reviewer'),
          scope: 'implementation',
        }],
      });
      const [scoped] = panelReviewers(input.reviewers, input, 'team-output/research-context.md');
      const result = await run(scoped!.job, { cwd: workspace });
      expect(result.outcome.status).toBe('pass');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('puts the exact review target in the reviewer request', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-review-target-'));
    const reviewer = scriptedEngine('targeted-reviewer', [async (request) => {
      expect(request.prompt).toContain('Review target: team-output/research-context.md');
      expect(request.prompt).toContain('do not require files from another stage');
      return pass('target accepted');
    }]);
    try {
      const input = config({
        reviewers: [{
          name: 'targeted',
          seat: seat(reviewer, 'targeted-reviewer'),
          scope: 'research note',
        }],
      });
      const [targeted] = panelReviewers(input.reviewers, input, 'team-output/research-context.md');
      const result = await run(targeted!.job, { cwd: workspace });
      expect(result.outcome.status).toBe('pass');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps reviewer scope on a finding', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-finding-scope-'));
    try {
      const reviewer = scriptedEngine('scoped-reviewer', [async () => (
        revise('the implementation is incomplete', 'the source does not meet the requirement')
      )]);
      const input = config({
        reviewers: [{
          name: 'scoped',
          seat: seat(reviewer, 'scoped-reviewer'),
          scope: 'implementation',
        }],
      });
      const result = await run(reviewPanel({
        label: 'scoped-panel',
        reviewers: panelReviewers(input.reviewers, input),
        pass: 1,
        target: 'implement',
      }), { cwd: workspace });
      const finding = result.outcome.revision?.findings?.[0];
      expect(finding?.scope).toBe('implementation');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('retries one malformed reviewer reply before reviewing the note', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-review-retry-'));
    const reviewer = scriptedEngine('malformed-reviewer', [
      async () => 'not a decision',
      async () => pass('accepted after retry'),
    ]);
    try {
      const input = config({
        workspace,
        reviewers: [{
          name: 'correctness',
          seat: seat(reviewer, 'malformed-reviewer'),
          scope: 'requirements',
        }],
      });
      const result = await run(reviewPanel({
        label: 'review-retry',
        reviewers: panelReviewers(input.reviewers, input, 'team-output/research-requirements.md'),
        pass: 1,
        target: 'research-requirements',
      }), { cwd: workspace });

      expect(result.outcome.status).toBe('pass');
      expect(reviewer.calls).toHaveLength(2);
      expect(reviewer.calls[1]?.prompt).toContain('previous response was not a valid decision');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('pauses without a writer finding when the reviewer gives no decision twice', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-review-no-decision-'));
    const reviewer = scriptedEngine('malformed-reviewer', [async () => 'not a decision']);
    try {
      const input = config({
        workspace,
        reviewers: [{
          name: 'correctness',
          seat: seat(reviewer, 'malformed-reviewer'),
          scope: 'requirements',
        }],
      });
      const result = await run(reviewPanel({
        label: 'review-no-decision',
        reviewers: panelReviewers(input.reviewers, input, 'team-output/research-requirements.md'),
        pass: 1,
        target: 'research-requirements',
      }), { cwd: workspace });
      const data = result.outcome.data as { findings?: unknown[] } | undefined;

      expect(result.outcome.status).toBe('paused');
      expect(result.outcome.summary).toContain('reviewer correctness returned no decision');
      expect(result.outcome.revision).toBeUndefined();
      expect(data?.findings).toEqual([]);
      expect(reviewer.calls).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not accept an unrequested file instead of a read-only reviewer decision', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-review-file-'));
    const reviewer = scriptedEngine('file-reviewer', [async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, 'reviews/correctness.json'), pass('accepted from file'));
      return 'Result written to reviews/correctness.json';
    }]);
    try {
      const input = config({
        workspace,
        reviewers: [{
          name: 'correctness',
          seat: seat(reviewer, 'file-reviewer'),
          scope: 'requirements',
        }],
      });
      const result = await run(reviewPanel({
        label: 'review-file',
        reviewers: panelReviewers(input.reviewers, input, 'team-output/research-requirements.md'),
        pass: 1,
        target: 'research-requirements',
      }), { cwd: workspace });

      expect(result.outcome.status).toBe('paused');
      expect(result.outcome.summary).toContain('reviewer correctness returned no decision');
      expect(reviewer.calls).toHaveLength(2);
      expect(reviewer.calls[0]!.prompt).not.toContain('Write reviews/');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('does not trust a stale review file when the reviewer reply is prose', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-stale-review-'));
    await mkdir(join(workspace, 'reviews'), { recursive: true });
    await writeFile(join(workspace, 'reviews/correctness.json'), pass('stale acceptance'));
    const reviewer = scriptedEngine('stale-reviewer', [async () => 'Result written to reviews/correctness.json']);
    try {
      const input = config({
        workspace,
        reviewers: [{
          name: 'correctness',
          seat: seat(reviewer, 'stale-reviewer'),
          scope: 'requirements',
        }],
      });
      const result = await run(reviewPanel({
        label: 'stale-review-file',
        reviewers: panelReviewers(input.reviewers, input, 'team-output/research-requirements.md'),
        pass: 1,
        target: 'research-requirements',
      }), { cwd: workspace });

      expect(result.outcome.status).toBe('paused');
      expect(result.outcome.summary).toContain('reviewer correctness returned no decision');
      expect(reviewer.calls).toHaveLength(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reruns tests-first with tests-review findings before implementation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-kickback-'));
    let testsFirstCalls = 0;
    let testsReviewCalls = 0;
    const testsFirstPrompts: string[] = [];
    const analyse = scriptedEngine('analyse', [async (request) => {
      const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      const text = output.endsWith('research-requirements.md')
        ? 'REQ-1: Export result.\nREQ-2: Test result.\n'
        : output.endsWith('plan.md')
          ? 'REQ-1: Acceptance check: source exists.\nREQ-2: Acceptance check: command exits 0.\n'
          : 'The workspace context is recorded.\n';
      await writeFile(join(request.cwd!, output), text);
      return pass('analysis accepted');
    }]);
    const implement = scriptedEngine('implement', [async (request) => {
      testsFirstCalls += 1;
      testsFirstPrompts.push(request.prompt);
      await mkdir(join(request.cwd!, 'test'), { recursive: true });
      if (testsFirstCalls >= 4) {
        await mkdir(join(request.cwd!, 'src'), { recursive: true });
        await writeFile(join(request.cwd!, 'src/result.mjs'), 'export const result = 11;\n');
      }
      await writeFile(
        join(request.cwd!, 'test/result.test.mjs'),
        "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result is 11', () => assert.equal(result, 11));\n",
      );
      return pass(testsFirstCalls >= 3 ? 'implementation written' : 'tests written');
    }]);
    const reviewer = scriptedEngine('reviewer', [async (request) => {
      if (request.prompt.includes('Review target: test/result.test.mjs')) {
        testsReviewCalls += 1;
        if (testsReviewCalls <= 2) return revise('repair the test assertion', 'the test assertion needs one repair');
      }
      return pass('review accepted');
    }]);
    const approve = scriptedEngine('approve', [async (request) => {
      const marker = request.prompt.match(/marker value (.+?) anywhere/)?.[1] ?? '';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      await writeFile(join(request.cwd!, 'team-output/approval.md'), `Run marker: ${marker}\n`);
      return pass('approved');
    }]);

    try {
      const result = await run(featureDelivery({
        brief: 'Deliver a module that exports result 11.',
        workspace,
        files: ['src/result.mjs', 'test/result.test.mjs'],
        testFiles: ['test/result.test.mjs'],
        test: { command: process.execPath, args: ['--test', 'test/result.test.mjs'] },
        analyse: seat(analyse, 'analyse'),
        implement: seat(implement, 'implement'),
        reviewers: [{ name: 'correctness', seat: seat(reviewer, 'reviewer'), scope: 'implementation' }],
        reviewThreshold: 1,
        approve: seat(approve, 'approve'),
        maxKickbacks: { plan: 3, 'tests-first': 3, implement: 3 },
      }), { cwd: workspace });

      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('pass');
      expect(testsFirstCalls).toBe(4);
      expect(testsFirstPrompts[1]).toContain('Feedback to address');
      expect(testsFirstPrompts[1]).toContain('test assertion needs one repair');
      expect(testsFirstPrompts[2]).toContain('Feedback to address');
      expect(testsFirstPrompts[2]).toContain('test assertion needs one repair');
      expect(testsReviewCalls).toBe(3);
      expect(await readFile(join(workspace, 'src/result.mjs'), 'utf8')).toContain('result = 11');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps kickback budgets independent and records both target events', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-budget-map-'));
    const reviewerCalls = new Map<string, number>();
    const events: Array<{ kind?: string; from?: string; to?: string; accepted?: boolean }> = [];
    let planWrites = 0;
    try {
      const base = config({ workspace });
      const analyse = scriptedEngine('budget-analyse', [async (request) => {
        const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
        await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
        if (output.endsWith('research-requirements.md')) {
          await writeFile(join(request.cwd!, output), 'REQ-1: Export result.\nREQ-2: Test result.\n');
        } else if (output.endsWith('plan.md')) {
          planWrites += 1;
          await writeFile(
            join(request.cwd!, output),
            `REQ-1: Acceptance check: source exists.\nREQ-2: Acceptance check: command exits 0. Revision ${planWrites}.\n`,
          );
        } else {
          await writeFile(join(request.cwd!, output), 'The workspace context is recorded.\n');
        }
        return pass('accepted');
      }]);
      const reviewer = scriptedEngine('budget-reviewer', [async (request) => {
        const target = request.prompt.match(/Review target: ([^\n]+)/)?.[1]?.trim() ?? '';
        const calls = (reviewerCalls.get(target) ?? 0) + 1;
        reviewerCalls.set(target, calls);
        if (calls === 1 && (target.includes('plan.md') || target.includes('result.test.mjs'))) {
          return revise(`repair ${target}`, `the ${target} needs one repair`);
        }
        return pass(`${target} accepted`);
      }]);
      const result = await run(featureDelivery({
        ...base,
        analyse: seat(analyse, 'budget-analyse'),
        reviewers: [{ name: 'correctness', seat: seat(reviewer, 'budget-reviewer'), scope: 'implementation' }],
      }), {
        cwd: workspace,
        onEvent: (event) => events.push(event),
      });

      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('pass');
      expect(events.filter((event) => event.kind === 'dag:kickback')).toEqual([
        expect.objectContaining({ to: 'plan', accepted: true }),
        expect.objectContaining({ to: 'tests-first', accepted: true }),
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fails when a research writer returns the rejected note unchanged', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-unchanged-requirements-'));
    const requirementPrompts: string[] = [];
    let requirementWrites = 0;
    let requirementReviews = 0;
    const analyse = scriptedEngine('analyse', [async (request) => {
      const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      if (output.endsWith('research-requirements.md')) {
        requirementWrites += 1;
        requirementPrompts.push(request.prompt);
        await writeFile(join(request.cwd!, output), '1. The behavior is observable.\n');
      } else {
        await writeFile(join(request.cwd!, output), 'The workspace context is recorded.\n');
      }
      return pass('accepted');
    }]);
    const reviewer = scriptedEngine('reviewer', [async (request) => {
      if (request.prompt.includes('Review target: team-output/research-requirements.md')) {
        requirementReviews += 1;
        return revise('rewrite the requirements', 'remove the implementation prescription');
      }
      return pass('accepted');
    }]);

    try {
      const result = await run(featureDelivery(config({
        workspace,
        analyse: seat(analyse, 'analyse'),
        reviewers: [{ name: 'correctness', seat: seat(reviewer, 'reviewer'), scope: 'requirements' }],
      })), { cwd: workspace });
      const data = result.outcome.data as Record<string, { summary?: string }> | undefined;

      expect(data?.['research-requirements']?.summary).toBe(
        'research-requirements returned the rejected note unchanged',
      );
      expect(requirementWrites).toBe(2);
      expect(requirementReviews).toBe(1);
      expect(requirementPrompts[1]).toContain('A reviewer rejected the previous note');
      expect(requirementPrompts[1]).toContain('every finding');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fails when a plan writer returns the rejected note unchanged', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-unchanged-plan-'));
    let planWrites = 0;
    let planReviews = 0;
    const analyse = scriptedEngine('analyse', [async (request) => {
      const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      if (output.endsWith('research-requirements.md')) {
        await writeFile(join(request.cwd!, output), 'REQ-1: Export result.\nREQ-2: Test result.\n');
      } else if (output.endsWith('plan.md')) {
        planWrites += 1;
        await writeFile(
          join(request.cwd!, output),
          'REQ-1: Acceptance check: source exists.\nREQ-2: Acceptance check: command exits 0.\n',
        );
      } else {
        await writeFile(join(request.cwd!, output), 'The workspace context is recorded.\n');
      }
      return pass('accepted');
    }]);
    const reviewer = scriptedEngine('reviewer', [async (request) => {
      if (request.prompt.includes('Review target: team-output/research-requirements.md and team-output/plan.md')) {
        planReviews += 1;
        return revise('rewrite the plan', 'add the missing acceptance check');
      }
      return pass('accepted');
    }]);

    try {
      const result = await run(featureDelivery(config({
        workspace,
        analyse: seat(analyse, 'analyse'),
        reviewers: [{ name: 'correctness', seat: seat(reviewer, 'reviewer'), scope: 'plan' }],
      })), { cwd: workspace });
      const data = result.outcome.data as Record<string, { summary?: string }> | undefined;

      expect(data?.plan?.summary).toBe('plan returned the rejected note unchanged');
      expect(planWrites).toBe(2);
      expect(planReviews).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('can run the same featureDelivery object twice', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-rerun-'));
    try {
      const job = featureDelivery(config({ workspace }));
      const first = await run(job, { cwd: workspace });
      const second = await run(job, { cwd: workspace });

      expect(first.outcome.status, JSON.stringify(first.outcome)).toBe('pass');
      expect(second.outcome.status, JSON.stringify(second.outcome)).toBe('pass');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('names missing requirement ids in the plan review', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-plan-id-review-'));
    const events: Array<Record<string, unknown>> = [];
    const analyse = scriptedEngine('analyse', [async (request) => {
      const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      if (output.endsWith('research-requirements.md')) {
        await writeFile(join(request.cwd!, output), 'Export result: **REQ-1**.\nTest result: - REQ-2.\n');
      } else if (output.endsWith('plan.md')) {
        await writeFile(join(request.cwd!, output), 'REQ-1: Acceptance check: source exists.\n');
      } else {
        await writeFile(join(request.cwd!, output), 'The workspace context is recorded.\n');
      }
      return pass('accepted');
    }]);
    try {
      const result = await run(featureDelivery(config({
        workspace,
        analyse: seat(analyse, 'analyse'),
      })), {
        cwd: workspace,
        onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
      });

      expect(result.outcome.status).not.toBe('pass');
      const reviews = events.filter((event) => (
        event.kind === 'loop:review'
        && Array.isArray(event.path)
        && event.path.at(-1) === 'plan-loop'
      ));
      expect(reviews[0]?.outcome).toMatchObject({
        summary: 'plan is missing acceptance checks for REQ-2',
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('feeds missing requirement ids back to the plan writer', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-plan-id-round-trip-'));
    const planPrompts: string[] = [];
    let planWrites = 0;
    const analyse = scriptedEngine('analyse', [async (request) => {
      const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      if (output.endsWith('research-requirements.md')) {
        await writeFile(join(request.cwd!, output), 'REQ-1: Export result.\nREQ-2: Test result.\n');
      } else if (output.endsWith('plan.md')) {
        planWrites += 1;
        planPrompts.push(request.prompt);
        await writeFile(
          join(request.cwd!, output),
          planWrites === 1
            ? 'REQ-1: Acceptance check: source exists.\n'
            : 'REQ-1: Acceptance check: source exists.\nREQ-2: Acceptance check: command exits 0.\n',
        );
      } else {
        await writeFile(join(request.cwd!, output), 'The workspace context is recorded.\n');
      }
      return pass('accepted');
    }]);
    try {
      const result = await run(featureDelivery(config({
        workspace,
        analyse: seat(analyse, 'analyse'),
      })), { cwd: workspace });

      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('pass');
      expect(planWrites).toBe(2);
      expect(planPrompts[1]).toContain('Feedback to address');
      expect(planPrompts[1]).toContain('REQ-2');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('routes an id-less requirements note back to research once', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-requirement-id-round-trip-'));
    let requirementWrites = 0;
    const requirementPrompts: string[] = [];
    const analyse = scriptedEngine('analyse', [async (request) => {
      const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      if (output.endsWith('research-requirements.md')) {
        requirementWrites += 1;
        requirementPrompts.push(request.prompt);
        await writeFile(
          join(request.cwd!, output),
          requirementWrites === 1
            ? 'The implementation should be tested.\n'
            : 'The implementation should satisfy REQ-1.\n',
        );
      } else if (output.endsWith('plan.md')) {
        await writeFile(join(request.cwd!, output), 'REQ-1: Acceptance check: the test passes.\n');
      } else {
        await writeFile(join(request.cwd!, output), 'The workspace context is recorded.\n');
      }
      return pass('accepted');
    }]);
    try {
      const result = await run(featureDelivery(config({
        workspace,
        analyse: seat(analyse, 'analyse'),
      })), { cwd: workspace });

      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe('pass');
      expect(requirementWrites).toBe(2);
      expect(requirementPrompts[1]).toContain('Feedback to address');
      expect(requirementPrompts[1]).toContain('REQ-n');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
