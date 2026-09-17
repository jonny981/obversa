import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  failed,
  jobMeta,
  LoopError,
  passed,
  run,
  RECORDED_ENGINE_USAGE,
  type Outcome,
} from '@obversa/runtime';
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

  it('uses a value written by a dependency before running a conditional stage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f40-condition-'));
    const writeDepth = [
      process.execPath,
      '-e',
      "require('node:fs').writeFileSync('depth.txt', 'dev\\n')",
    ];
    const append = (value: string) => [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync('actions.txt', '${value}\\n')`,
    ];
    const job = workflow('conditional-depth', {
      brief: 'Run the action only at full depth.',
      roles: {},
      stages: [
        stage('depth', { run: writeDepth, optional: true }),
        stage('middle-one', { run: ['true'] }),
        stage('middle-two', { run: ['true'] }),
        stage('perform', {
          run: append('perform'),
          needs: ['depth', 'middle-two'],
          when: async (ctx) => {
            if (ctx.needs?.depth?.status !== 'pass') return false;
            const value = await readFile(join(ctx.workspace!.dir, 'depth.txt'), 'utf8');
            return value.trim() === 'full';
          },
        }),
        stage('after', { run: append('after') }),
      ],
    });

    try {
      const meta = nodeMeta(job);
      const nodes = (meta.nodes ?? []) as Array<Record<string, unknown>>;
      expect(nodes[3]!.when).toBeDefined();
      expect(nodes[3]!.needs).toEqual(['middle-two', 'depth']);
      expect(nodes[0]!.optional).toBe(true);

      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'actions.txt'), 'utf8')).toBe('after\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the conditional stage when the dependency writes full depth', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f40-full-depth-'));
    const append = (value: string) => [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync('actions.txt', '${value}\\n')`,
    ];
    const job = workflow('full-depth', {
      brief: 'Run the action at full depth.',
      roles: {},
      stages: [
        stage('depth', {
          run: [process.execPath, '-e', "require('node:fs').writeFileSync('depth.txt', 'full\\n')"],
        }),
        stage('perform', {
          run: append('perform'),
          when: async (ctx) => {
            const value = await readFile(join(ctx.workspace!.dir, 'depth.txt'), 'utf8');
            return ctx.needs?.depth?.status === 'pass' && value.trim() === 'full';
          },
        }),
      ],
    });

    try {
      expect((await run(job, { cwd: directory })).outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'actions.txt'), 'utf8')).toBe('perform\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses passed and failed conditions with an optional dependency', async () => {
    const passDirectory = await mkdtemp(join(tmpdir(), 'obversa-f40-passed-'));
    const failDirectory = await mkdtemp(join(tmpdir(), 'obversa-f40-failed-'));
    const append = (value: string) => [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync('path.txt', '${value}\\n')`,
    ];

    const passJob = workflow('passed-condition', {
      brief: 'Choose the passed path.',
      roles: {},
      stages: [
        stage('probe', { run: ['true'] }),
        stage('passed-path', { run: append('passed'), when: passed('probe') }),
      ],
    });
    const failJob = workflow('failed-condition', {
      brief: 'Choose the failed path.',
      roles: {},
      stages: [
        stage('probe', {
          run: [process.execPath, '-e', 'process.exit(1)'],
          optional: true,
        }),
        stage('failed-path', { run: append('failed'), when: failed('probe') }),
      ],
    });

    try {
      expect((await run(passJob, { cwd: passDirectory })).outcome.status).toBe('pass');
      expect(await readFile(join(passDirectory, 'path.txt'), 'utf8')).toBe('passed\n');
      expect((await run(failJob, { cwd: failDirectory })).outcome.status).toBe('pass');
      expect(await readFile(join(failDirectory, 'path.txt'), 'utf8')).toBe('failed\n');
    } finally {
      await Promise.all([
        rm(passDirectory, { recursive: true, force: true }),
        rm(failDirectory, { recursive: true, force: true }),
      ]);
    }
  });

  it('resolves passed through an explicit dependency three stages away', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f40-passed-needs-'));
    const append = [
      process.execPath,
      '-e',
      "require('node:fs').appendFileSync('path.txt', 'perform\\n')",
    ];
    const job = workflow('passed-explicit-needs', {
      brief: 'Choose a path from a stage three steps back.',
      roles: {},
      stages: [
        stage('depth', { run: ['true'] }),
        stage('middle-one', { run: ['true'] }),
        stage('middle-two', { run: ['true'] }),
        stage('perform', {
          run: append,
          needs: ['depth', 'middle-two'],
          when: passed('depth'),
        }),
      ],
    });

    try {
      const nodes = (nodeMeta(job).nodes ?? []) as Array<Record<string, unknown>>;
      expect(nodes[3]!.needs).toEqual(['middle-two', 'depth']);
      expect((await run(job, { cwd: directory })).outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'path.txt'), 'utf8')).toBe('perform\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a required failure from running its dependent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f40-required-'));
    const job = workflow('required-failure', {
      brief: 'Stop after a required failure.',
      roles: {},
      stages: [
        stage('probe', { run: [process.execPath, '-e', 'process.exit(1)'] }),
        stage('dependent', {
          run: [process.execPath, '-e', "require('node:fs').writeFileSync('ran.txt', 'yes\\n')"],
        }),
      ],
    });

    try {
      expect((await run(job, { cwd: directory })).outcome.status).not.toBe('pass');
      await expect(readFile(join(directory, 'ran.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      expect(request.prompt).toContain('Review target: src/second.mjs.');
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

  it('defaults a reviewed stage to one review restart', () => {
    const input = workflowInput();
    const job = workflow('default-review-retry', {
      ...input,
      stages: [stage('note', {
        agent: 'analyse',
        writes: 'note.md',
        reviewedBy: 'review',
      })],
    });
    const node = ((nodeMeta(job).nodes ?? []) as Array<Record<string, unknown>>)[0]!;
    const reviewed = nodeMeta(node.job);

    expect(reviewed.max).toBe(2);
    expect(reviewed.maxReviewRestarts).toBe(1);
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

  it('allows a command to change its declared workflow file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f41-command-owned-'));
    try {
      const job = workflow('command-owned-file', {
        brief: { brief: 'Run the command.', files: ['owned.txt', 'other.txt'] },
        roles: {},
        stages: [stage('write', {
          run: [process.execPath, '-e', "require('node:fs').writeFileSync('owned.txt', 'owned\\n')"],
          writes: 'owned.txt',
        })],
      });

      const result = await run(job, { cwd: directory });

      expect(result.outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'owned.txt'), 'utf8')).toBe('owned\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a command that changes another declared file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f41-command-forbidden-'));
    try {
      const job = workflow('command-forbidden-file', {
        brief: { brief: 'Run the command.', files: ['owned.txt', 'other.txt'] },
        roles: {},
        stages: [stage('write', {
          run: [process.execPath, '-e', "require('node:fs').writeFileSync('other.txt', 'unexpected\\n')"],
          writes: 'owned.txt',
        })],
      });

      const result = await run(job, { cwd: directory });

      expect(result.outcome.status).toBe('fail');
      expect(JSON.stringify(result.outcome.data)).toContain('other.txt');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows a command with no writes to leave workflow files unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f41-command-read-only-'));
    try {
      const job = workflow('command-read-only', {
        brief: { brief: 'Run the check.', files: ['other.txt'] },
        roles: {},
        stages: [stage('check', { run: ['true'] })],
      });

      const result = await run(job, { cwd: directory });

      expect(result.outcome.status).toBe('pass');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a command with no writes that changes a workflow file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f41-command-no-writes-'));
    try {
      const job = workflow('command-no-writes', {
        brief: { brief: 'Run the check.', files: ['other.txt'] },
        roles: {},
        stages: [stage('check', {
          run: [process.execPath, '-e', "require('node:fs').writeFileSync('other.txt', 'unexpected\\n')"],
        })],
      });

      const result = await run(job, { cwd: directory });

      expect(result.outcome.status).toBe('fail');
      expect(JSON.stringify(result.outcome.data)).toContain('other.txt');
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

  it('refuses a panel whose recorded answers share one family despite declared difference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-recorded-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'claude-sonnet-4-5' }), 'gpt');
    const job = workflow('recorded-family-collision', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      expect(JSON.stringify(result.outcome.data ?? result.outcome.summary)).toMatch(/recorded model family/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a writer whose recorded answer belongs to the reviewer family', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-recorded-pre-'));
    // Declared: writer gpt, reviewer claude. Recorded: the writer's answer is
    // claude. The panel must refuse before the reviewers ever run.
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' }), 'gpt');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'gpt-5.4' }), 'claude');
    const job = workflow('recorded-family-pre-collision', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      expect(JSON.stringify(result.outcome.data ?? result.outcome.summary)).toMatch(/recorded model family/i);
      const reviewerCalls = (reviewer.engine as { calls?: unknown[] } | undefined)?.calls?.length ?? 0;
      expect(reviewerCalls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses an answer whose recorded model carries no readable family', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-recorded-unknown-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: '/' }), 'gpt');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'gpt-5.4' }), 'claude');
    const job = workflow('recorded-family-unknown', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      expect(JSON.stringify(result.outcome.data ?? result.outcome.summary)).toMatch(/recorded model family is unknown/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a reviewedBy stage whose recorded answers share one family despite declared difference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-reviewedby-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'grok-4' }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'grok-4' }), 'gpt');
    const job = workflow('recorded-family-reviewedby', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [stage('note', { agent: 'writer', writes: 'note.md', reviewedBy: 'review' })],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      const node = (result.outcome.data as { note: Outcome }).note;
      expect(node.error).toBeInstanceOf(LoopError);
      expect(node.error).toMatchObject({
        code: 'BODY',
        phase: 'review',
        message: expect.stringContaining('recorded model family collision'),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { model: 'gpt-5', usageArray: 'absent', reason: 'recorded model family collision' },
    { model: 'gpt-5', usageArray: 'empty', reason: 'recorded model family collision' },
    { model: '/', usageArray: 'absent', reason: 'recorded model family is unknown' },
    { model: '/', usageArray: 'empty', reason: 'recorded model family is unknown' },
  ])('refuses a reviewedBy writer recording $model with an $usageArray usage array', async ({ model, usageArray, reason }) => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-reviewedby-writer-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: model }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'grok-4' }), 'gpt');
    const job = workflow('recorded-family-reviewedby-writer', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [stage('note', { agent: 'writer', writes: 'note.md', reviewedBy: 'review' })],
    });
    const state: Record<string, unknown> = usageArray === 'absent'
      ? {}
      : { [RECORDED_ENGINE_USAGE]: [] };

    try {
      const result = await run(job, { cwd: directory, state });
      expect(result.outcome.status).toBe('fail');
      const node = (result.outcome.data as { note: Outcome }).note;
      expect(node.error).toBeInstanceOf(LoopError);
      expect(node.error).toMatchObject({
        code: 'BODY',
        phase: 'review',
        message: expect.stringContaining(reason),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a panel whose two recorded sides answered from one family despite declared difference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-recorded-vs-recorded-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'grok-4' }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'grok-4' }), 'gpt');
    const job = workflow('recorded-family-both-grok', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      const node = (result.outcome.data as { review: Outcome }).review;
      expect(node.error).toBeInstanceOf(LoopError);
      expect(node.error).toMatchObject({
        code: 'BODY',
        phase: 'review',
        message: expect.stringContaining('recorded model family collision'),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a reviewer that reports it cannot tell which family answered', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-unknown-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'unknown' }), 'gpt');
    const job = workflow('recorded-family-unknown-reviewer', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      expect(JSON.stringify(result.outcome.data ?? result.outcome.summary)).toMatch(/recorded model family is unknown/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      form: 'panel',
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
      expected: [
        { model: 'claude-sonnet-4-5', role: 'writer', stage: 'write' },
        { model: 'gpt-5', role: 'reviewer', stage: 'review' },
      ],
    },
    {
      form: 'reviewedBy',
      stages: [stage('note', { agent: 'writer', writes: 'note.md', reviewedBy: 'review' })],
      expected: [
        { model: 'claude-sonnet-4-5', role: 'writer', stage: 'note' },
        { model: 'gpt-5', role: 'reviewer', stage: 'note' },
      ],
    },
  ])('tags recorded answers with their role and stage for $form', async ({ stages, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-tags-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'gpt-5' }), 'gpt');
    const job = workflow('recorded-family-tags', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages,
    });

    try {
      const state: Record<string, unknown> = {};
      const result = await run(job, { cwd: directory, state });
      expect(result.outcome.status).toBe('pass');
      expect(state[RECORDED_ENGINE_USAGE]).toMatchObject(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts a later same-family panel whose honest answers keep every difference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-later-panel-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' }), 'claude');
    const reviewer = scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'gpt-5' });
    const laterReviewer = scriptedEngine('later-reviewer', [async () => pass('accepted')], { usageModel: 'gpt-5' });
    const job = workflow('recorded-family-later-panel', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [seat(reviewer, 'gpt')], laterReview: [seat(laterReviewer, 'gpt')] },
      stages: [
        stage('note', { agent: 'writer', writes: 'note.md', reviewedBy: 'review' }),
        stage('later', { panel: 'laterReview', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(reviewer.calls).toHaveLength(1);
      expect(laterReviewer.calls).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts an honest reviewedBy stage whose recorded answers keep the declared difference', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-reviewedby-ok-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'gpt-5' }), 'gpt');
    const job = workflow('recorded-family-reviewedby-ok', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [stage('note', { agent: 'writer', writes: 'note.md', reviewedBy: 'review' })],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts a panel despite an untagged advisor answer from the reviewer family at the writer path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f54-recorded-ok-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' }), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => pass('accepted')], { usageModel: 'gpt-5.4' }), 'gpt');
    const job = workflow('recorded-family-distinct', {
      brief: { brief: 'Write one note.', files: ['note.md'] },
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });
    const state: Record<string, unknown> = {
      [RECORDED_ENGINE_USAGE]: [
        { model: 'gpt-5', path: ['recorded-family-distinct', 'write'] },
      ],
    };

    try {
      const result = await run(job, { cwd: directory, state });
      expect(result.outcome.status).toBe('pass');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('checks a panel against the writer whose files it targets', () => {
    const preceding = seat(scriptedEngine('preceding', [async () => 'accepted']), 'claude');
    const target = seat(scriptedEngine('target', [async () => 'accepted']), 'gpt');
    const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'claude');

    expect(() => workflow('target-family-review', {
      brief: 'Review one note.',
      roles: { preceding, target, review: [reviewer] },
      stages: [
        stage('preceding', { agent: 'preceding', writes: 'old.md' }),
        stage('target', { agent: 'target', writes: 'note.md' }),
        stage('review', { panel: 'review', sendsBackTo: 'target', agree: 1 }),
      ],
    })).not.toThrow();
  });

  it('allows two same-family writers when the panel reviewers differ from each writer', () => {
    const writer = seat(scriptedEngine('writer', [async () => 'accepted']), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'codex');

    expect(() => workflow('draft-refine', {
      brief: 'Draft and refine one change.',
      roles: { writer, review: [reviewer] },
      stages: [
        stage('draft', { agent: 'writer', writes: 'draft.md' }),
        stage('refine', { agent: 'writer', writes: 'refine.md' }),
        stage('review', { panel: 'review', sendsBackTo: 'draft', agree: 1 }),
      ],
    })).not.toThrow();
  });

  it('checks a panel against the preceding writer when its target writes nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-target-run-'));
    const writer = seat(scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }]), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async (request) => {
      expect(request.prompt).toContain('Review target: note.md.');
      expect(request.prompt).not.toContain('brief.md');
      return pass('review accepted');
    }]), 'grok');

    const job = workflow('target-run-review', {
      brief: { brief: 'Review one note.', files: ['brief.md'] },
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('test', { run: ['true'] }),
        stage('review', { panel: 'review', sendsBackTo: 'test', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a panel whose run target follows a same-family writer', () => {
    const writer = seat(scriptedEngine('writer', [async () => 'accepted']), 'claude');
    const reviewer = seat(scriptedEngine('reviewer', [async () => 'accepted']), 'claude');

    expect(() => workflow('same-family-run-target', {
      brief: 'Review one note.',
      roles: { writer, review: [reviewer] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('test', { run: ['true'] }),
        stage('review', { panel: 'review', sendsBackTo: 'test', agree: 1 }),
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
      expect(result.outcome.status).toBe('paused');
      expect(result.outcome.summary).toContain('note.md');
      expect((result.outcome.data as { review: { error?: unknown } }).review.error).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('checks a reviewer that changes a declared file before returning a rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-review-rejection-'));
    const writer = scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'original\n');
      return pass('note written');
    }]);
    const reviewer = scriptedEngine('reviewer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'changed by reviewer\n');
      return '{"status":"revise","summary":"needs a correction"}';
    }]);
    const job = workflow('review-rejection-writes', {
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
      expect(result.outcome.status).toBe('paused');
      expect(result.outcome.summary).toContain('note.md');
      expect((result.outcome.data as { review: { error?: unknown } }).review.error).toBeDefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not hide a reviewer tamper behind a one-of-two threshold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'obversa-f35-review-threshold-'));
    const writer = scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'original\n');
      return pass('note written');
    }]);
    const tamperingReviewer = scriptedEngine('tampering-reviewer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'changed by reviewer\n');
      return pass('accepted');
    }]);
    const passingReviewer = scriptedEngine('passing-reviewer', [async () => pass('accepted')]);
    const job = workflow('review-threshold-writes', {
      brief: { brief: 'Review one note.', files: ['note.md'] },
      roles: {
        writer: seat(writer, 'writer'),
        review: [
          seat(tamperingReviewer, 'tamper-family'),
          seat(passingReviewer, 'pass-family'),
        ],
      },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('paused');
      expect(result.outcome.summary).toContain('note.md');
      expect(result.outcome.summary).toContain('Engine errors');
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
      ['needs-future', [
        stage('first', { run: ['true'], needs: 'later' } as WorkflowStage),
        stage('later', { run: ['true'] }),
      ]],
      ['needs-missing', [stage('first', { run: ['true'], needs: 'missing' } as WorkflowStage)]],
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

  it('rejects a non-boolean optional flag before building jobs', () => {
    for (const optional of [1, 'yes', null]) {
      expect(() => workflow('invalid-optional', {
        ...workflowInput(),
        stages: [stage('probe', { run: ['true'], optional } as unknown as WorkflowStage)],
      })).toThrow(/optional must be a boolean/);
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
