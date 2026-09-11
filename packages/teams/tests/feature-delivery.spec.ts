import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { jobMeta, run } from '@obversa/runtime';

import { featureDelivery } from '../src/index.js';
import { pass, revise, scriptedEngine, seat } from './scripted-engine.js';

const testCommand = {
  command: process.execPath,
  args: ['--test', 'test/result.test.mjs'],
  timeoutMs: 30_000,
};

async function writeAnalysis(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'team-output'), { recursive: true });
  await writeFile(join(cwd, 'team-output/brief.md'), 'The module must export result 11.\n');
}

async function writeImplementation(cwd: string, repaired: boolean): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/result.mjs'), repaired ? 'export const result = 11;\n' : 'export const result = 10;\n');
  await writeFile(
    join(cwd, 'test/result.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result exists', () => assert.equal(typeof result, 'number'));\n",
  );
}

describe('featureDelivery', () => {
  it('writes a brief, repairs implementation after review, runs tests twice, and approves', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-feature-'));
    try {
      const analyse = scriptedEngine('analyse', [async (request) => {
        await writeAnalysis(request.cwd!);
        return pass('brief accepted');
      }]);
      const implement = scriptedEngine('implement', [
        async (request) => {
          await writeImplementation(request.cwd!, false);
          return pass('first implementation written');
        },
        async (request) => {
          expect(request.prompt).toContain('Feedback to address');
          await writeImplementation(request.cwd!, true);
          return pass('implementation repaired from review');
        },
      ]);
      const correctness = scriptedEngine('correctness', [
        async (request) => {
          await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
          await writeFile(join(request.cwd!, 'reviews/correctness.json'), '{"round":1}\n');
          return revise('result is not 11', 'the implementation does not meet the brief');
        },
        async (request) => {
          await writeFile(join(request.cwd!, 'reviews/correctness.json'), '{"round":2}\n');
          return pass('result meets the brief');
        },
      ]);
      const scope = scriptedEngine('scope', [
        async (request) => {
          await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
          await writeFile(join(request.cwd!, 'reviews/scope.json'), '{"round":1}\n');
          return pass('scope is inside the brief');
        },
        async () => pass('scope remains inside the brief'),
      ]);
      const approve = scriptedEngine('approve', [async (request) => {
        await writeFile(join(request.cwd!, 'team-output/approval.md'), 'The change is ready to ship.\n');
        return pass('delivery approved');
      }]);

      const job = featureDelivery({
        brief: 'Deliver a module that exports result 11.',
        workspace,
        files: ['src/result.mjs', 'test/result.test.mjs'],
        test: testCommand,
        analyse: seat(analyse, 'analyse'),
        implement: seat(implement, 'implement'),
        reviewers: [
          { name: 'correctness', seat: seat(correctness, 'correctness') },
          { name: 'scope', seat: seat(scope, 'scope') },
        ],
        reviewThreshold: 2,
        approve: seat(approve, 'approve'),
        maxKickbacks: 1,
      });
      const meta = jobMeta(job);
      const nodes = (meta?.nodes as Array<Record<string, unknown>>) ?? [];
      expect(nodes.map((node) => node.name)).toEqual(['analyse', 'implement', 'test', 'review', 'approve']);

      const result = await run(job, { cwd: workspace });
      expect(result.outcome.status).toBe('pass');
      expect(implement.calls).toHaveLength(2);
      expect(correctness.calls).toHaveLength(2);
      expect(scope.calls).toHaveLength(2);
      expect(approve.calls).toHaveLength(1);
      expect(await readFile(join(workspace, 'src/result.mjs'), 'utf8')).toContain('result = 11');
      expect(await readFile(join(workspace, 'team-output/approval.md'), 'utf8')).toContain('ready to ship');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fails the approve node when its approval note is missing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-feature-missing-approval-'));
    try {
      const analyse = scriptedEngine('analyse', [async (request) => {
        await writeAnalysis(request.cwd!);
        return pass('brief accepted');
      }]);
      const implement = scriptedEngine('implement', [async (request) => {
        await writeImplementation(request.cwd!, true);
        return pass('implementation written');
      }]);
      const correctness = scriptedEngine('correctness', [async (request) => {
        await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
        await writeFile(join(request.cwd!, 'reviews/correctness.json'), '{"round":1}\n');
        return pass('result meets the brief');
      }]);
      const approve = scriptedEngine('approve', [async () => pass('approval claimed without a note')]);
      const result = await run(featureDelivery({
        brief: 'Deliver a module that exports result 11.',
        workspace,
        files: ['src/result.mjs', 'test/result.test.mjs'],
        test: testCommand,
        analyse: seat(analyse, 'analyse'),
        implement: seat(implement, 'implement'),
        reviewers: [{ name: 'correctness', seat: seat(correctness, 'correctness') }],
        reviewThreshold: 1,
        approve: seat(approve, 'approve'),
      }), { cwd: workspace });
      expect(result.outcome.status).toBe('fail');
      const nodes = result.outcome.data as { approve?: { summary?: string } };
      expect(nodes.approve?.summary).toContain('approve did not produce a non-empty file: team-output/approval.md');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('checks diversity between implementation and reviewers, not analyse or approve', () => {
    const make = (name: string) => scriptedEngine(name, [async () => pass('unused')]);
    const analyse = make('analyse');
    const implement = make('implement');
    const reviewer = make('reviewer');
    const approve = make('approve');

    expect(() => featureDelivery({
      brief: 'Deliver a module.',
      workspace: '/tmp/obversa-teams-feature',
      files: ['src/result.mjs'],
      test: testCommand,
      analyse: seat(analyse, 'same-family'),
      implement: seat(implement, 'implementation-family'),
      reviewers: [{ name: 'reviewer', seat: seat(reviewer, 'same-family') }],
      reviewThreshold: 1,
      approve: seat(approve, 'same-family'),
    })).not.toThrow();

    expect(() => featureDelivery({
      brief: 'Deliver a module.',
      workspace: '/tmp/obversa-teams-feature',
      files: ['src/result.mjs'],
      test: testCommand,
      analyse: seat(analyse, 'analyse-family'),
      implement: seat(implement, 'same-family'),
      reviewers: [{ name: 'reviewer', seat: seat(reviewer, 'same-family') }],
      reviewThreshold: 1,
      approve: seat(approve, 'approve-family'),
    })).toThrow(/model family/i);
  });
});
