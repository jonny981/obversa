import { describe, it, expect } from 'vitest';
import {
  loop,
  dag,
  agentJob,
  defineAgent,
  fnJob,
  gateJob,
  commandSucceeds,
  agentCheck,
  quorum,
  predicate,
  jobMeta,
  renderPlan,
  describeConditions,
} from '../src/api.ts';
import {
  inspectionEnvelopeV1,
  jobShapeV1,
} from '../src/core/describe.ts';

// Builders register a shape that a host can inspect without running the job.

describe('job introspection (meta + renderPlan)', () => {
  it('attaches meta to a loop and renders its shape', () => {
    const worker = defineAgent({
      name: 'worker',
      system: 'Do the work.',
      tier: 'worker',
      outputs: [{ name: 'patch' }],
      requiresSkills: ['tdd'],
    });
    const job = loop({
      name: 'build',
      max: 20,
      body: agentJob({ agent: worker, prompt: 'go' }),
      until: [
        commandSucceeds('npm', ['test']),
        agentCheck({ question: 'done?', threshold: 0.85 }),
      ],
    });

    const meta = jobMeta(job);
    expect(meta?.kind).toBe('loop');
    expect(meta?.name).toBe('build');
    expect(meta?.max).toBe(20);
    expect(meta?.gate).toEqual(['npm test', 'judge "done?" >=0.85']);
    const body = meta?.body as { kind: string; name: string };
    expect(body.kind).toBe('agent');
    expect(body.name).toBe('worker');
    expect(body).toMatchObject({
      contract: {
        tier: 'worker',
        outputs: ['patch'],
        requiresSkills: ['tdd'],
      },
    });

    const plan = renderPlan(meta).join('\n');
    expect(plan).toContain('loop "build" (max 20)');
    expect(plan).toContain('gate: npm test, judge "done?" >=0.85');
    expect(plan).toContain('agent "worker"');
    expect(plan).toContain('contract: tier worker; outputs patch; requires tdd');
  });

  it('attaches meta to a dag with nodes, deps, and a nested loop', () => {
    const job = dag({
      name: 'ship',
      nodes: {
        research: agentJob({ label: 'research', prompt: 'r' }),
        implement: {
          needs: ['research'],
          job: loop({
            name: 'impl',
            body: fnJob('x', async () => ({ status: 'pass' as const })),
            until: predicate(() => true, 'ok'),
          }),
        },
        review: {
          needs: ['implement'],
          job: gateJob('review', commandSucceeds('npm', ['run', 'lint'])),
        },
      },
    });

    const meta = jobMeta(job);
    expect(meta?.kind).toBe('dag');
    const nodes = meta?.nodes as Array<{
      name: string;
      needs: string[];
      job?: { kind: string };
    }>;
    expect(nodes.map((n) => n.name)).toEqual(['research', 'implement', 'review']);
    expect(nodes[1]!.needs).toEqual(['research']);
    expect(nodes[1]!.job?.kind).toBe('loop');
    expect(nodes[2]!.job?.kind).toBe('gate');

    const plan = renderPlan(meta).join('\n');
    expect(plan).toContain('dag "ship" (3 nodes)');
    expect(plan).toContain('- implement (needs research)');
    expect(plan).toContain('loop "impl"');
  });

  it('normalizes scalar needs and carries node purpose into the plan and record shape', () => {
    const job = dag({
      name: 'ship',
      nodes: {
        build: fnJob('build', async () => ({ status: 'pass' as const })),
        review: {
          needs: 'build',
          desc: 'Review the built change.',
          gate: 'The change meets the acceptance criteria.',
          job: fnJob('review', async () => ({ status: 'pass' as const })),
        },
      },
    });

    const meta = jobMeta(job)!;
    const nodes = meta.nodes as Array<{
      name: string;
      needs: string[];
      desc?: string;
      gate?: string;
    }>;
    expect(nodes[1]).toMatchObject({
      name: 'review',
      needs: ['build'],
      desc: 'Review the built change.',
      gate: 'The change meets the acceptance criteria.',
    });

    const plan = renderPlan(meta).join('\n');
    expect(plan).toContain('- review (needs build)');
    expect(plan).toContain('desc: Review the built change.');
    expect(plan).toContain('gate: The change meets the acceptance criteria.');

    const shape = jobShapeV1(meta);
    expect(shape).toMatchObject({ kind: 'dag' });
    if (shape.kind !== 'dag') throw new Error('expected a DAG job shape');
    expect(shape.nodes).toEqual([
      expect.objectContaining({ name: 'build', needs: [] }),
      expect.objectContaining({
        name: 'review',
        needs: ['build'],
        desc: 'Review the built change.',
        gate: 'The change meets the acceptance criteria.',
      }),
    ]);
  });

  it('captures optional and when on dag nodes and renders them', () => {
    const job = dag({
      name: 'ship',
      nodes: {
        build: fnJob('b', async () => ({ status: 'pass' as const })),
        deploy: {
          needs: ['build'],
          when: commandSucceeds('git', ['diff', '--quiet']),
          job: fnJob('d', async () => ({ status: 'pass' as const })),
        },
        notify: {
          needs: ['deploy'],
          optional: true,
          job: fnJob('n', async () => ({ status: 'pass' as const })),
        },
      },
    });

    const meta = jobMeta(job);
    const nodes = meta?.nodes as Array<{
      name: string;
      optional: boolean;
      when?: string[];
    }>;
    expect(nodes[0]).toMatchObject({ name: 'build', optional: false });
    expect(nodes[0]!.when).toBeUndefined(); // only set when configured
    expect(nodes[1]).toMatchObject({
      name: 'deploy',
      optional: false,
      when: ['git diff --quiet'],
    });
    expect(nodes[2]).toMatchObject({ name: 'notify', optional: true });

    const plan = renderPlan(meta).join('\n');
    expect(plan).toContain('- deploy (needs build; when: git diff --quiet)');
    expect(plan).toContain('- notify (needs deploy; optional)');
  });

  it('labels a quorum, and a hand-written job has no meta', () => {
    const j = quorum(
      2,
      agentCheck({ question: 'a' }),
      agentCheck({ question: 'b' }),
      agentCheck({ question: 'c' }),
    );
    expect(describeConditions(j)).toEqual(['quorum 2/3']);

    const bare = async () => ({ status: 'pass' as const });
    expect(jobMeta(bare)).toBeUndefined();
    expect(renderPlan(undefined)).toEqual([
      '(a runnable job, shape not introspectable)',
    ]);
  });

  it('normalizes recursive inspection shapes and preserves producer fields', () => {
    const meta = {
      kind: 'loop' as const,
      name: 'outer',
      max: 4,
      producer: { retained: true },
      body: {
        kind: 'dag' as const,
        name: 'delivery',
        nodes: [
          {
            name: 'build',
            job: {
              kind: 'fn' as const,
              name: 'compile',
              producerField: ['kept'],
            },
          },
          {
            name: 'review',
            needs: ['build'],
            optional: true,
            isolate: true,
            when: ['approved'],
            job: {
              kind: 'loop' as const,
              name: 'review-loop',
              body: { kind: 'agent' as const, name: 'reviewer' },
            },
          },
        ],
      },
    };

    expect(jobShapeV1(meta)).toEqual({
      kind: 'loop',
      name: 'outer',
      max: 4,
      producer: { retained: true },
      body: {
        kind: 'dag',
        name: 'delivery',
        nodes: [
          {
            name: 'build',
            needs: [],
            optional: false,
            isolate: false,
            when: [],
            job: {
              kind: 'fn',
              name: 'compile',
              producerField: ['kept'],
            },
          },
          {
            name: 'review',
            needs: ['build'],
            optional: true,
            isolate: true,
            when: ['approved'],
            job: {
              kind: 'loop',
              name: 'review-loop',
              body: { kind: 'agent', name: 'reviewer' },
            },
          },
        ],
      },
    });
  });

  it('wraps known and opaque jobs in the same versioned envelope', () => {
    const file = './recipes/ship.loop.ts';
    const meta = { kind: 'fn' as const, name: 'ship', output: 'artifact' };

    expect(inspectionEnvelopeV1('validate', file, meta)).toEqual({
      schemaVersion: 1,
      command: 'validate',
      file,
      ok: true,
      executed: false,
      shape: { kind: 'fn', name: 'ship', output: 'artifact' },
    });
    expect(inspectionEnvelopeV1('describe', file, undefined)).toEqual({
      schemaVersion: 1,
      command: 'describe',
      file,
      ok: true,
      executed: false,
      shape: { kind: 'opaque' },
    });
  });
});
