import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { jobMeta, run } from '@obversa/runtime';

import { writerReviewerPair } from '../src/index.js';
import { pass, revise, scriptedEngine, seat } from './scripted-engine.js';

const testCommand = {
  command: process.execPath,
  args: ['--test', 'test/result.test.mjs'],
  timeoutMs: 30_000,
};
const retryTestCommand = {
  command: process.execPath,
  args: ['--test', 'test/retry.test.mjs'],
  timeoutMs: 30_000,
};

async function writePairFiles(
  cwd: string,
  sourceFile = 'src/result.mjs',
  testFile = 'test/result.test.mjs',
): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, sourceFile), 'export const result = 42;\n');
  await writeFile(
    join(cwd, testFile),
    `import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../${sourceFile}';\ntest('result is written', () => assert.equal(result, 42));\n`,
  );
}

describe('writerReviewerPair', () => {
  it('runs owned writer, real test, and reviewer nodes with distinct binding identities', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-pair-'));
    try {
      const writerEngine = scriptedEngine('writer', [
        async (request) => {
          await writePairFiles(request.cwd!, 'src/retry.mjs', 'test/retry.test.mjs');
          return pass('writer wrote the requested files');
        },
        async (request) => {
          await writePairFiles(request.cwd!, 'src/retry.mjs', 'test/retry.test.mjs');
          return pass('writer applied the review');
        },
      ]);
      const reviewerEngine = scriptedEngine('reviewer', [
        async (request) => {
          await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
          await writeFile(join(request.cwd!, 'reviews/reviewer.json'), '{"status":"revise"}\n');
          return revise('review requested one repair', 'the review requires one repair');
        },
        async () => pass('review accepted the repaired files'),
      ]);

      const job = writerReviewerPair({
        brief: 'Write a module that exports result 42 and a test for it.',
        workspace,
        files: ['src/retry.mjs', 'test/retry.test.mjs'],
        test: retryTestCommand,
        writer: seat(writerEngine, 'writer'),
        reviewer: seat(reviewerEngine, 'reviewer'),
      });
      const meta = jobMeta(job);
      const nodes = (meta?.nodes as Array<Record<string, unknown>>) ?? [];
      expect(meta?.kind).toBe('dag');
      expect(nodes.map((node) => node.name)).toEqual(['writer', 'test', 'reviewer']);
      expect(nodes.map((node) => node.needs)).toEqual([[], ['writer'], ['test']]);
      expect(nodes.every((node) => typeof node.desc === 'string' && typeof node.gate === 'string')).toBe(true);

      const result = await run(job, { cwd: workspace });
      expect(result.outcome.status).toBe('pass');
      expect(writerEngine.calls).toHaveLength(2);
      expect(reviewerEngine.calls).toHaveLength(2);
      expect(await readFile(join(workspace, 'src/retry.mjs'), 'utf8')).toContain('result = 42');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('refuses equal model families from the two recorded bindings', async () => {
    const writer = scriptedEngine('writer', [async () => pass('unused')]);
    const reviewer = scriptedEngine('reviewer', [async () => pass('unused')]);
    expect(() => writerReviewerPair({
      brief: 'Write a module.',
      workspace: '/tmp/obversa-teams-pair',
      files: ['src/result.mjs'],
      test: testCommand,
      writer: seat(writer, 'same-family'),
      reviewer: seat(reviewer, 'same-family'),
    })).toThrow(/model family/i);
  });

  it('fails the writer node when a promised file is missing', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-pair-missing-'));
    try {
      const writer = scriptedEngine('writer', [async () => pass('writer claimed success')]);
      const reviewer = scriptedEngine('reviewer', [async () => pass('unused')]);
      const result = await run(writerReviewerPair({
        brief: 'Write a module that exports result 42 and a test for it.',
        workspace,
        files: ['src/result.mjs', 'test/result.test.mjs'],
        test: testCommand,
        writer: seat(writer, 'writer'),
        reviewer: seat(reviewer, 'reviewer'),
      }), { cwd: workspace });
      expect(result.outcome.status).toBe('fail');
      const nodes = result.outcome.data as { writer?: { summary?: string } };
      expect(nodes.writer?.summary).toContain('writer did not produce a non-empty file: src/result.mjs');
      expect(reviewer.calls).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
