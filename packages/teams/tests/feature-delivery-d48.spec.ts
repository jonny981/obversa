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
      ? '1. Export result.\n2. Test result.\n'
      : output.endsWith('plan.md')
        ? '1. Export result. Acceptance check: source exists.\n2. Test result. Acceptance check: command exits 0.\n'
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

  it('reruns tests-first with tests-review findings before implementation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-kickback-'));
    let testsFirstCalls = 0;
    let testsReviewCalls = 0;
    const testsFirstPrompts: string[] = [];
    const analyse = scriptedEngine('analyse', [async (request) => {
      const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      const text = output.endsWith('research-requirements.md')
        ? '1. Export result.\n2. Test result.\n'
        : output.endsWith('plan.md')
          ? '1. Export result. Acceptance check: source exists.\n2. Test result. Acceptance check: command exits 0.\n'
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
    try {
      const base = config({ workspace });
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
});
