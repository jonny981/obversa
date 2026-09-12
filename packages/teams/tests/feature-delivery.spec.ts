import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { jobMeta, run } from '@obversa/runtime';

import { featureDelivery } from '../src/index.js';
import { assertTeamInput, requireNoFiles } from '../src/team-utils.js';
import { pass, scriptedEngine, seat } from './scripted-engine.js';

const testCommand = {
  command: process.execPath,
  args: ['--test', 'test/result.test.mjs'],
  timeoutMs: 30_000,
};

async function writeNote(cwd: string, file: string, text: string): Promise<void> {
  await mkdir(join(cwd, 'team-output'), { recursive: true });
  await writeFile(join(cwd, file), text);
}

function noteText(file: string): string {
  if (file.endsWith('research-requirements.md')) return 'R1: Export result.\nR2: Test result.\n';
  if (file.endsWith('plan.md')) return 'R1: Export result. Acceptance check: source exists.\nR2: Test result. Acceptance check: command exits 0.\n';
  return 'The workspace context is recorded.\n';
}

async function writeTest(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(
    join(cwd, 'test/result.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result is 11', () => assert.equal(result, 11));\n",
  );
}

function baseConfig(workspace: string) {
  const analyse = scriptedEngine('analyse', [async (request) => {
    const output = request.prompt.match(/Write only ([^\.]+\.md)/)?.[1] ?? 'team-output/unknown.md';
    await writeNote(request.cwd!, output, noteText(output));
    return pass('analysis accepted');
  }]);
  const implement = scriptedEngine('implement', [
    async (request) => {
      await writeTest(request.cwd!);
      return pass('tests written');
    },
    async (request) => {
      await mkdir(join(request.cwd!, 'src'), { recursive: true });
      await writeFile(join(request.cwd!, 'src/result.mjs'), 'export const result = 10;\n');
      return pass('first implementation written');
    },
    async (request) => {
      await writeFile(join(request.cwd!, 'src/result.mjs'), 'export const result = 11;\n');
      return pass('implementation repaired');
    },
  ]);
  const reviewer = scriptedEngine('reviewer', [async () => pass('review accepted')]);
  const approve = scriptedEngine('approve', [async (request) => {
    const marker = request.prompt.match(/Run marker: ([^\"]+)/)?.[1]?.trim() ?? '';
    await writeNote(request.cwd!, 'team-output/approval.md', `**Date:** 2026-09-11\nRun marker: ${marker}\n`);
    return pass('approved');
  }]);
  return {
    brief: 'Deliver a module that exports result 11.',
    workspace,
    files: ['src/result.mjs', 'test/result.test.mjs'],
    testFiles: ['test/result.test.mjs'],
    test: testCommand,
    analyse: seat(analyse, 'analyse'),
    implement: seat(implement, 'implement'),
    reviewers: [{ name: 'correctness', seat: seat(reviewer, 'reviewer'), scope: 'implementation' }],
    reviewThreshold: 1,
    approve: seat(approve, 'approve'),
  };
}

describe('featureDelivery', () => {
  it('exposes the eleven-stage process and completes the tests-first flow', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-feature-'));
    try {
      const config = baseConfig(workspace);
      const job = featureDelivery(config);
      const meta = jobMeta(job);
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

      const result = await run(job, { cwd: workspace });
      expect(result.outcome.status).toBe('pass');
      expect(await readFile(join(workspace, 'src/result.mjs'), 'utf8')).toContain('result = 11');
      expect(await readFile(join(workspace, 'team-output/evidence.md'), 'utf8')).toContain('Verification: passed');
      expect(await readFile(join(workspace, 'team-output/approval.md'), 'utf8')).toContain('Run marker:');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('removes a stale approval before the writer runs', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-feature-stale-'));
    try {
      await writeNote(workspace, 'team-output/approval.md', 'old approval\n');
      const config = baseConfig(workspace);
      const result = await run(featureDelivery(config), { cwd: workspace });
      expect(result.outcome.status).toBe('pass');
      expect(await readFile(join(workspace, 'team-output/approval.md'), 'utf8')).not.toContain('old approval');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects test files outside the complete file list', () => {
    const config = baseConfig('/tmp/obversa-teams-feature');
    expect(() => featureDelivery({ ...config, testFiles: ['test/other.test.mjs'] })).toThrow(/also be listed/i);
  });

  it('rejects team output notes as expected files', () => {
    for (const file of ['team-output/brief.md', 'team-output/approval.md']) {
      expect(() => assertTeamInput({
        brief: 'Deliver a module.',
        workspace: '/tmp/obversa-teams-feature',
        files: [file],
        test: testCommand,
      })).toThrow(/team output note/);
    }
  });

  it('allows an expected file that existed before the checked job', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-feature-existing-'));
    try {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src/result.mjs'), 'export const result = 10;\n');
      const result = await run(
        requireNoFiles(
          'analyse',
          async () => ({ status: 'pass' as const, summary: 'accepted' }),
          workspace,
          ['src/result.mjs'],
        ),
        { cwd: workspace },
      );
      expect(result.outcome.status).toBe('pass');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
