import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { jobMeta, run } from '@obversa/runtime';
import { describe, expect, it } from 'vitest';

import {
  fromFile,
  person,
  stage,
  workflow,
} from '../src/index.js';
import { scriptedEngine, seat } from './scripted-engine.js';

function nodeMeta(job: unknown): Record<string, unknown> {
  return (jobMeta(job as Parameters<typeof jobMeta>[0]) ?? {}) as Record<string, unknown>;
}

function workflowInput() {
  const analyse = seat(scriptedEngine('analyse', [async () => 'accepted']), 'claude');
  const implement = seat(scriptedEngine('implement', [async () => 'accepted']), 'codex');
  return {
    brief: 'Deliver a triple function.',
    roles: {
      analyse,
      implement,
      review: [analyse, implement],
      approve: person('Ship this change?'),
    },
    stages: [
      stage('research-context', {
        agent: 'analyse',
        writes: 'team-output/research-context.md',
        desc: 'Record the context.',
        gate: 'The context note exists.',
        reviewedBy: 'review',
        retry: 3,
      }),
      stage('implement', {
        agent: 'implement',
        writes: 'src/triple.mjs',
        desc: 'Write the source.',
        gate: 'The source exists.',
      }),
      stage('test', {
        run: ['node', '--test', 'test/triple.test.mjs'],
        sendsBackTo: 'implement',
      }),
      stage('review', {
        panel: 'review',
        agree: 1,
        sendsBackTo: 'implement',
      }),
      stage('approve', {
        input: 'approve',
        sendsBackTo: 'implement',
      }),
    ],
    post: { always: ({ record }: { record: unknown }) => record },
  };
}

describe('declarative teams', () => {
  it('reads a brief body and its small workflow front matter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-brief-'));
    const file = join(directory, 'brief.md');
    await writeFile(file, [
      '---',
      'files: src/triple.mjs, test/triple.test.mjs',
      'testFiles: test/triple.test.mjs',
      'test: node --test test/triple.test.mjs',
      '---',
      '',
      'Deliver a triple function.',
      '',
    ].join('\n'));

    try {
      expect(fromFile(file)).toEqual({
        brief: 'Deliver a triple function.',
        files: ['src/triple.mjs', 'test/triple.test.mjs'],
        testFiles: ['test/triple.test.mjs'],
        test: {
          command: 'node',
          args: ['--test', 'test/triple.test.mjs'],
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('maps every stage form to the named runtime primitive', () => {
    const job = workflow('feature-delivery', workflowInput());
    const meta = nodeMeta(job);
    const nodes = (meta.nodes ?? []) as Array<Record<string, unknown>>;

    expect(nodes.map((node) => node.name)).toEqual([
      'research-context',
      'implement',
      'test',
      'review',
      'approve',
    ]);
    expect(nodeMeta(nodes[0]!.job).kind).toBe('loop');
    expect(nodeMeta(nodeMeta(nodes[0]!.job).review).kind).toBe('review-panel');
    expect(nodeMeta(nodes[1]!.job).kind).toBe('agent');
    expect(nodeMeta(nodes[2]!.job).kind).toBe('gate');
    expect(nodeMeta(nodes[3]!.job).kind).toBe('review-panel');
    expect(nodeMeta(nodes[4]!.job).kind).toBe('approval');
    expect(meta.maxKickbacks).toEqual({ implement: 1 });
  });

  it('keeps a reviewed stage bounded by its declared retry count', () => {
    const job = workflow('feature-delivery', workflowInput());
    const nodes = (nodeMeta(job).nodes ?? []) as Array<Record<string, unknown>>;
    const reviewed = nodeMeta(nodes[0]!.job);

    expect(reviewed.maxReviewRestarts).toBe(3);
  });

  it('rejects an agent that changes another declared file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-writes-'));
    const writer = scriptedEngine('writer', [async (request) => {
      await mkdir(join(request.cwd!, 'src'), { recursive: true });
      await writeFile(join(request.cwd!, 'src/triple.mjs'), 'export const triple = 3;\n');
      await writeFile(join(request.cwd!, 'test-result.txt'), 'unexpected\n');
      return 'accepted';
    }]);
    const job = workflow('writes-boundary', {
      brief: {
        brief: 'Write the source.',
        files: ['src/triple.mjs', 'test-result.txt'],
        testFiles: [],
        test: { command: 'true', args: [] },
      },
      roles: { writer: seat(writer, 'writer') },
      stages: [stage('write', {
        agent: 'writer',
        writes: 'src/triple.mjs',
      })],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      expect(result.outcome.summary).toContain('write');
      expect(await readFile(join(directory, 'test-result.txt'), 'utf8')).toBe('unexpected\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
