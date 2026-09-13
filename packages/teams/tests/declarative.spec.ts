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
  type WorkflowStage,
} from '../src/index.js';
import { pass, scriptedEngine, seat } from './scripted-engine.js';

function nodeMeta(job: unknown): Record<string, unknown> {
  if (typeof job === 'function') {
    return (jobMeta(job as Parameters<typeof jobMeta>[0]) ?? {}) as Record<string, unknown>;
  }
  return (job ?? {}) as Record<string, unknown>;
}

function workflowInput() {
  const analyse = seat(scriptedEngine('analyse', [async () => 'accepted']), 'claude');
  const implement = seat(scriptedEngine('implement', [async () => 'accepted']), 'codex');
  const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'grok');
  return {
    brief: 'Deliver a triple function.',
    roles: {
      analyse,
      implement,
      review: [reviewer],
      approve: person('Ship this change?'),
    },
    options: { timeout: '10m' },
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
        retry: 3,
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
  };
}

describe('declarative teams', () => {
  it('reads a brief body and its small workflow front matter', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-brief-'));
    const file = join(directory, 'brief.md');
    await writeFile(file, [
      '---',
      'files: ["src/triple.mjs"]',
      '---',
      '',
      'Deliver a triple function.',
      '---',
      'Keep this line in the brief.',
      '',
    ].join('\n'));

    try {
      expect(fromFile(file)).toEqual({
        brief: 'Deliver a triple function.\n---\nKeep this line in the brief.',
        files: ['src/triple.mjs'],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reads CRLF front matter without losing the brief body', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-crlf-'));
    const file = join(directory, 'brief.md');
    await writeFile(file, '---\r\nfiles: src/triple.mjs\r\n---\r\n\r\nKeep the brief.\r\n');

    try {
      expect(fromFile(file)).toEqual({
        brief: 'Keep the brief.',
        files: ['src/triple.mjs'],
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
    expect(nodes.map((node) => node.needs)).toEqual([
      [],
      ['research-context'],
      ['implement'],
      ['test'],
      ['review'],
    ]);
    expect(nodeMeta(nodes[0]!.job).kind).toBe('loop');
    expect(nodeMeta(nodes[0]!.job).review).toBe(true);
    expect(nodeMeta(nodes[2]!.job).kind).toBe('gate');
    expect(nodeMeta(nodes[3]!.job).kind).toBe('reviewPanel');
    expect(nodeMeta(nodes[4]!.job).kind).toBe('approval');
    expect(meta.maxKickbacks).toEqual({ implement: 3 });
    expect(nodes[0]!.timeoutMs).toBe(600_000);
  });

  it('runs stages in the declared order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-order-'));
    const append = (value: string) => [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync('order.txt', '${value}\\n')`,
    ];
    const job = workflow('ordered', {
      brief: 'Run three steps.',
      roles: {},
      stages: [
        stage('first', { run: append('first') }),
        stage('second', { run: append('second') }),
        stage('third', { run: append('third') }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'order.txt'), 'utf8')).toBe('first\nsecond\nthird\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('limits stage prompts and review targets to files declared so far', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-stage-files-'));
    const writer = scriptedEngine('writer', [async (request) => {
      const match = request.prompt.match(/This stage may write only: (.+?)\. Do not/);
      const file = match?.[1];
      if (!file) throw new Error('writer file was not declared');
      await mkdir(join(request.cwd!, file, '..'), { recursive: true });
      await writeFile(join(request.cwd!, file), 'written\n');
      return pass('stage files written');
    }]);
    const reviewer = scriptedEngine('reviewer', [async (request) => {
      expect(request.prompt).toContain('Review target: team-output/first.md, src/second.mjs.');
      expect(request.prompt).not.toContain('team-output/later.md');
      return pass('review accepted');
    }]);
    const job = workflow('stage-files', {
      brief: 'Write the declared files in order.',
      roles: {
        writer: seat(writer, 'writer'),
        review: [seat(reviewer, 'reviewer')],
      },
      stages: [
        stage('first', { agent: 'writer', writes: 'team-output/first.md' }),
        stage('second', { agent: 'writer', writes: 'src/second.mjs' }),
        stage('review', { panel: 'review', agree: 1 }),
        stage('later', { agent: 'writer', writes: 'team-output/later.md' }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(writer.calls[0]!.prompt).toContain('Workflow files: team-output/first.md');
      expect(writer.calls[0]!.prompt).not.toContain('src/second.mjs');
      expect(writer.calls[1]!.prompt).toContain('Workflow files: team-output/first.md, src/second.mjs');
      expect(writer.calls[1]!.prompt).not.toContain('team-output/later.md');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a reviewed stage bounded by its declared retry count', () => {
    const job = workflow('feature-delivery', workflowInput());
    const nodes = (nodeMeta(job).nodes ?? []) as Array<Record<string, unknown>>;
    const reviewed = nodeMeta(nodes[0]!.job);

    expect(reviewed.max).toBe(4);
  });

  it('rejects an agent that changes another declared file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-writes-'));
    const writer = scriptedEngine('writer', [async (request) => {
      await mkdir(join(request.cwd!, 'src'), { recursive: true });
      await writeFile(join(request.cwd!, 'src/triple.mjs'), 'export const triple = 3;\n');
      await writeFile(join(request.cwd!, 'test-result.txt'), 'unexpected\n');
      return '{"status":"pass","summary":"accepted"}';
    }]);
    const job = workflow('writes-boundary', {
      brief: {
        brief: 'Write the source.',
        files: ['src/triple.mjs'],
      },
      roles: { writer: seat(writer, 'writer') },
      stages: [
        stage('write', { agent: 'writer', writes: 'src/triple.mjs' }),
        stage('test', { run: ['true'], writes: 'test-result.txt' }),
      ],
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

  it('rejects a reviewed stage whose writer shares a model family with a reviewer', () => {
    const writer = seat(scriptedEngine('writer', [async () => 'accepted']), 'gpt');
    const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'gpt');

    expect(() => workflow('same-family-review', {
      brief: 'Review one note.',
      roles: { writer, review: [reviewer] },
      stages: [stage('note', {
        agent: 'writer',
        writes: 'note.md',
        reviewedBy: 'review',
      })],
    })).toThrow(/model family must be distinct/);
    expect(writer.engine).toBeDefined();
  });

  it('rejects a panel whose reviewers share a model family with its preceding writer', () => {
    const writer = seat(scriptedEngine('writer', [async () => 'accepted']), 'gpt');
    const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'gpt');

    expect(() => workflow('same-family-kickback', {
      brief: 'Review one note.',
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    })).toThrow(/model family must be distinct/);
  });

  it('rejects reviewedBy on non-agent stages', () => {
    const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'grok');
    const stages = [
      stage('run', { run: ['true'], reviewedBy: 'review', retry: 1 } as WorkflowStage),
      stage('panel', { panel: 'review', reviewedBy: 'review', retry: 1 } as WorkflowStage),
      stage('input', { input: 'approve', reviewedBy: 'review', retry: 1 } as WorkflowStage),
    ];

    for (const invalidStage of stages) {
      expect(() => workflow('invalid-reviewed-by', {
        brief: 'Reject invalid review placement.',
        roles: { review: [reviewer], approve: person('Approve?') },
        stages: [invalidStage],
      })).toThrow('reviewedBy is for agent stages');
    }
  });

  it('rejects a reviewer that changes a declared workflow file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-review-writes-'));
    const writer = scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'original\n');
      return pass('note written');
    }]);
    const reviewer = scriptedEngine('reviewer', [async (request) => {
      await mkdir(join(request.cwd!, 'reviews'), { recursive: true });
      await writeFile(join(request.cwd!, 'reviews/review-1.json'), '{"status":"pass"}\n');
      await writeFile(join(request.cwd!, 'note.md'), 'changed by reviewer\n');
      return pass('review accepted');
    }]);
    const job = workflow('review-writes', {
      brief: { brief: 'Review one note.', files: ['note.md'] },
      roles: {
        writer: seat(writer, 'writer'),
        review: [seat(reviewer, 'reviewer')],
      },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects an agree count outside the panel size', () => {
    const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'grok');
    for (const agree of [0, 2]) {
      expect(() => workflow('invalid-agree', {
        brief: 'Reject an invalid panel threshold.',
        roles: { review: [reviewer] },
        stages: [stage('review', { panel: 'review', agree })],
      })).toThrow(/agree must be between 1 and 1/);
    }
  });

  it('rejects invalid stage links and retry placement before building jobs', () => {
    const cases: Array<[string, ReturnType<typeof workflowInput>['stages']]> = [
      ['duplicate', [stage('same', { run: ['true'] }), stage('same', { run: ['true'] })]],
      ['self', [stage('same', { run: ['true'], sendsBackTo: 'same' })]],
      ['unknown', [stage('later', { run: ['true'], sendsBackTo: 'missing' })]],
      ['future', [stage('first', { run: ['true'], sendsBackTo: 'later' }), stage('later', { run: ['true'] })]],
      ['both', [
        stage('first', { run: ['true'] }),
        stage('note', {
          agent: 'analyse',
          writes: 'note.md',
          reviewedBy: 'review',
          sendsBackTo: 'first',
        }),
      ]],
      ['retry', [stage('note', { run: ['true'], retry: 1 })]],
    ];

    for (const [name, stages] of cases) {
      expect(() => workflow(name, { ...workflowInput(), stages })).toThrow();
    }
  });

  it('rejects a reviewed note that is written unchanged after feedback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-unchanged-'));
    const writer = scriptedEngine('writer', [async (request) => {
      await mkdir(join(request.cwd!, 'team-output'), { recursive: true });
      await writeFile(join(request.cwd!, 'team-output/note.md'), 'same note\n');
      return '{"status":"pass","summary":"written"}';
    }]);
    const reviewer = scriptedEngine('reviewer', [async () => (
      '{"status":"revise","summary":"add the missing detail","findings":[{"evidence":"detail"}]}'
    )]);
    const job = workflow('unchanged-note', {
      brief: {
        brief: 'Write one note.',
        files: ['team-output/note.md'],
      },
      roles: {
        writer: seat(writer, 'writer'),
        review: [seat(reviewer, 'reviewer')],
      },
      stages: [stage('note', {
        agent: 'writer',
        writes: 'team-output/note.md',
        reviewedBy: 'review',
        retry: 2,
      })],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).not.toBe('pass');
      expect(result.outcome.summary).toContain('unchanged');
      expect(writer.calls).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retries a malformed panel reply before accepting the panel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-panel-'));
    const reviewer = scriptedEngine('reviewer', [
      async () => 'not a decision',
      async () => '{"status":"pass","summary":"accepted after retry"}',
    ]);
    const job = workflow('panel-retry', {
      brief: 'Review the change.',
      roles: { review: [seat(reviewer, 'reviewer')] },
      stages: [stage('review', {
        panel: 'review',
        agree: 1,
      })],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(reviewer.calls).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs post.always with a record after the graph settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-post-'));
    let summary = '';
    const job = workflow('post-hook', {
      brief: 'Run one command.',
      roles: {},
      stages: [stage('test', {
        run: [process.execPath, '-e', 'process.exit(0)'],
      })],
      post: {
        always: ({ record }) => { summary = record.summary(); },
      },
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(summary).toContain('all 1 node(s) green');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
