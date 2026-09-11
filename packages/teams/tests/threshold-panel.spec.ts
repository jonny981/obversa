import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { jobMeta, run } from '@obversa/runtime';

import { thresholdPanel } from '../src/index.js';
import { pass, revise, scriptedEngine, seat } from './scripted-engine.js';

const testCommand = {
  command: process.execPath,
  args: ['--test', 'test/result.test.mjs'],
  timeoutMs: 30_000,
};

async function writePanelFiles(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, 'test'), { recursive: true });
  await writeFile(join(cwd, 'src/result.mjs'), 'export const result = 7;\n');
  await writeFile(
    join(cwd, 'test/result.test.mjs'),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { result } from '../src/result.mjs';\ntest('result is written', () => assert.equal(result, 7));\n",
  );
}

describe('thresholdPanel', () => {
  it('runs implementation, real test, parallel reviewers, and a threshold kickback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'obversa-teams-panel-'));
    try {
      const implement = scriptedEngine('implement', [
        async (request) => {
          await writePanelFiles(request.cwd!);
          return pass('implementation written');
        },
        async (request) => {
          await writePanelFiles(request.cwd!);
          return pass('implementation repaired');
        },
      ]);
      const reviewers = ['correctness', 'tests', 'scope'].map((name, index) => {
        const engine = scriptedEngine(name, [
          async (request) => {
            await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
            await writeFile(join(request.cwd!, `reviews/${name}.json`), `{"round":1}\n`);
            return index === 2
              ? pass(`${name} accepted the first implementation`)
              : revise(`${name} requested a repair`, `${name} found a missing requirement`);
          },
          async (request) => {
            await writeFile(join(request.cwd!, `reviews/${name}.json`), `{"round":2}\n`);
            return pass(`${name} accepted the repair`);
          },
        ]);
        return { name, engine, seat: seat(engine, name) };
      });

      const job = thresholdPanel({
        brief: 'Write a module that exports result 7 and a test for it.',
        workspace,
        files: ['src/result.mjs', 'test/result.test.mjs'],
        test: testCommand,
        implement: seat(implement, 'implement'),
        reviewers: reviewers.map(({ name, seat: reviewerSeat }) => ({ name, seat: reviewerSeat })),
        threshold: 3,
        maxKickbacks: 1,
      });
      const meta = jobMeta(job);
      const nodes = (meta?.nodes as Array<Record<string, unknown>>) ?? [];
      expect(nodes.map((node) => node.name)).toEqual(['implement', 'test', 'review']);
      expect(nodes.every((node) => typeof node.desc === 'string' && typeof node.gate === 'string')).toBe(true);

      const result = await run(job, { cwd: workspace });
      expect(result.outcome.status).toBe('pass');
      expect(implement.calls).toHaveLength(2);
      expect(reviewers.map(({ engine }) => engine.calls)).toEqual([
        expect.any(Array),
        expect.any(Array),
        expect.any(Array),
      ]);
      expect(await readFile(join(workspace, 'reviews/correctness.json'), 'utf8')).toContain('round');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('refuses duplicate model families across panel binding identities', () => {
    const make = (name: string) => scriptedEngine(name, [async () => pass('unused')]);
    const implement = make('implement');
    const reviewer = make('reviewer');
    expect(() => thresholdPanel({
      brief: 'Write a module.',
      workspace: '/tmp/obversa-teams-panel',
      files: ['src/result.mjs'],
      test: testCommand,
      implement: seat(implement, 'same-family'),
      reviewers: [{ name: 'reviewer', seat: seat(reviewer, 'same-family') }],
      threshold: 1,
    })).toThrow(/model family/i);
  });
});
