import { describe, it, expect } from 'vitest';

import {
  assertGraph,
  fnJob,
  jobMeta,
  loop,
  pipeline,
  predicate,
  LoopError,
} from '../src/api.ts';

// assertGraph turns lines-describe introspection (jobMeta) into test
// assertions: a partial shape expectation; a mismatch throws an Error whose
// message carries the JSON path to the mismatch.

const pass = (name: string) =>
  fnJob(name, async () => ({ status: 'pass' as const }));

const buildPipeline = () =>
  pipeline('ship', [
    { name: 'build', job: pass('build') },
    { name: 'test', job: pass('test') },
    { name: 'lint', job: pass('lint'), needs: ['build'], optional: true },
    {
      name: 'deploy',
      job: pass('deploy'),
      needs: ['test', 'lint'],
      when: predicate(() => true, 'on main'),
    },
  ]);

describe('assertGraph', () => {
  it('passes on a matching partial expectation over a pipeline', () => {
    assertGraph(buildPipeline(), {
      kind: 'dag',
      name: 'ship',
      nodes: [
        { name: 'build', needs: [] },
        { name: 'test', needs: ['build'] },
        { name: 'lint', needs: ['build'], optional: true },
        // needs as a set: order-insensitive; when: true = a gate exists.
        { name: 'deploy', needs: ['lint', 'test'], when: true, kind: 'fn' },
      ],
    });
  });

  it('recurses into a loop body', () => {
    const job = loop({
      name: 'converge',
      body: buildPipeline(),
      until: predicate(() => true, 'done'),
      max: 3,
    });
    assertGraph(job, {
      kind: 'loop',
      name: 'converge',
      max: 3,
      body: {
        kind: 'dag',
        name: 'ship',
        nodes: [{ name: 'deploy', when: true }],
      },
    });
  });

  it('a missing node fails with the node path in the message', () => {
    expect(() =>
      assertGraph(buildPipeline(), { nodes: [{ name: 'gate' }] }),
    ).toThrow(/nodes\[gate\]/);
  });

  it('a wrong needs set fails with the path and both values', () => {
    expect(() =>
      assertGraph(buildPipeline(), {
        nodes: [{ name: 'test', needs: ['lint'] }],
      }),
    ).toThrow(/nodes\[test\]\.needs.*\["lint"\].*\["build"\]/);
  });

  it('a wrong scalar fails with the path and both values', () => {
    expect(() => assertGraph(buildPipeline(), { name: 'release' })).toThrow(
      /name.*"release".*"ship"/,
    );
    const job = loop({ name: 'l', body: pass('b'), max: 2 });
    expect(() =>
      assertGraph(job, { body: { kind: 'agent' } }),
    ).toThrow(/body\.kind.*"agent".*"fn"/);
  });

  it('exactNodes catches an extra actual node', () => {
    expect(() =>
      assertGraph(buildPipeline(), {
        exactNodes: true,
        nodes: [{ name: 'build' }, { name: 'test' }, { name: 'lint' }],
      }),
    ).toThrow(/nodes/);
    // The same names, complete, pass regardless of order.
    assertGraph(buildPipeline(), {
      exactNodes: true,
      nodes: [
        { name: 'deploy' },
        { name: 'lint' },
        { name: 'test' },
        { name: 'build' },
      ],
    });
  });

  it('a duplicated expectation cannot mask a set difference', () => {
    // Sets are compared as sets: ['test','test'] must not pass against
    // ['test','lint'] on equal length alone.
    expect(() =>
      assertGraph(buildPipeline(), {
        nodes: [{ name: 'deploy', needs: ['test', 'test'] }],
      }),
    ).toThrow(/nodes\[deploy\]\.needs/);
  });

  it('a hand-written job (no meta) throws CONFIG', () => {
    const bare = async () => ({ status: 'pass' as const });
    try {
      assertGraph(bare, { kind: 'dag' });
      expect.unreachable('a meta-less job must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).code).toBe('CONFIG');
      expect((e as LoopError).message).toContain('not introspectable');
    }
  });

  it('accepts a JobMeta directly', () => {
    const meta = jobMeta(buildPipeline())!;
    assertGraph(meta, { kind: 'dag', nodes: [{ name: 'build' }] });
  });
});
