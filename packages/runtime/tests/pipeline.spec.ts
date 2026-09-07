import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  pipeline,
  jobMeta,
  fnJob,
  commandSucceeds,
  LoopError,
} from '../src/api.ts';
import type { RunOptions } from '../src/api.ts';
import { renderPipelineTable } from '../src/core/pipeline.ts';
import { MockEngine } from '../src/testing.ts';
import { tmpRepo, cleanupRepos } from './git-helpers.ts';
import { vi } from 'vitest';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000 });

afterAll(cleanupRepos);

const mockOpts: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};
const pass = (rec: string[], name: string) =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'pass' as const };
  });
const fail = (rec: string[], name: string) =>
  fnJob(name, async () => {
    rec.push(name);
    return { status: 'fail' as const };
  });

describe('pipeline', () => {
  it('auto-chains stages and runs them strictly in order', async () => {
    const order: string[] = [];
    const { outcome } = await run(
      pipeline('p', [
        { name: 'a', job: pass(order, 'a') },
        { name: 'b', job: pass(order, 'b') },
        { name: 'c', job: pass(order, 'c') },
      ]),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('a failing stage blocks the rest and fails the pipeline', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      pipeline('p', [
        { name: 'a', job: pass(ran, 'a') },
        { name: 'b', job: fail(ran, 'b') },
        { name: 'c', job: pass(ran, 'c') },
      ]),
      mockOpts,
    );
    expect(ran).toEqual(['a', 'b']);
    expect(outcome.status).toBe('fail');
  });

  it('explicit needs replaces the chain default (fan-out/fan-in)', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      pipeline('p', [
        { name: 'src', job: pass(ran, 'src') },
        { name: 'left', job: pass(ran, 'left'), needs: ['src'] },
        { name: 'right', job: pass(ran, 'right'), needs: ['src'] },
        { name: 'join', job: pass(ran, 'join'), needs: ['left', 'right'] },
      ]),
      mockOpts,
    );
    expect(outcome.status).toBe('pass');
    expect(ran[0]).toBe('src'); // fan-out: both branches wait on src
    expect([...ran.slice(1, 3)].sort()).toEqual(['left', 'right']);
    expect(ran[3]).toBe('join'); // fan-in: join waits on both branches
  });

  it('a skipped stage (unmet when) counts green and the chain continues', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      pipeline('p', [
        { name: 'a', job: pass(ran, 'a') },
        { name: 'b', job: pass(ran, 'b'), when: () => false },
        { name: 'c', job: pass(ran, 'c') },
      ]),
      mockOpts,
    );
    expect(ran).toEqual(['a', 'c']);
    expect(outcome.status).toBe('pass');
  });

  it("an optional stage's failure does not block the next stage", async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      pipeline('p', [
        { name: 'a', job: pass(ran, 'a') },
        { name: 'b', job: fail(ran, 'b'), optional: true },
        { name: 'c', job: pass(ran, 'c') },
      ]),
      mockOpts,
    );
    expect(ran).toEqual(['a', 'b', 'c']);
    expect(outcome.status).toBe('pass');
  });

  it('a stage named "__proto__" is a real stage, not a silent no-op', async () => {
    const ran: string[] = [];
    const { outcome } = await run(
      pipeline('p', [{ name: '__proto__', job: pass(ran, '__proto__') }]),
      mockOpts,
    );
    // On a plain nodes object this key would hit the Object.prototype
    // accessor and the dag would pass green with zero nodes run.
    expect(ran).toEqual(['__proto__']);
    expect(outcome.status).toBe('pass');
  });

  it('rejects duplicate stage names', () => {
    const j = fnJob('x', async () => ({ status: 'pass' as const }));
    try {
      pipeline('p', [
        { name: 'a', job: j },
        { name: 'a', job: j },
      ]);
      expect.unreachable('duplicate stage name must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).code).toBe('CONFIG');
      expect((e as LoopError).message).toMatch(/duplicate stage name "a"/);
    }
  });

  it('rejects an empty stage list', () => {
    try {
      pipeline('p', []);
      expect.unreachable('empty stages must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).code).toBe('CONFIG');
    }
  });

  it('exposes dag-shaped meta with chained needs, optional, and when labels', () => {
    const j = fnJob('x', async () => ({ status: 'pass' as const }));
    const job = pipeline('p', [
      { name: 'build', job: j },
      {
        name: 'deploy',
        job: j,
        when: commandSucceeds('git', ['diff', '--quiet']),
      },
      { name: 'notify', job: j, optional: true },
    ]);
    const meta = jobMeta(job);
    expect(meta?.kind).toBe('dag'); // pure sugar — no new meta kind
    expect(meta?.name).toBe('p');
    const nodes = meta?.nodes as Array<{
      name: string;
      needs: string[];
      optional: boolean;
      when?: string[];
    }>;
    expect(nodes.map((n) => [n.name, n.needs])).toEqual([
      ['build', []],
      ['deploy', ['build']],
      ['notify', ['deploy']],
    ]);
    expect(nodes[0]).toMatchObject({ optional: false });
    expect(nodes[0]!.when).toBeUndefined();
    expect(nodes[1]).toMatchObject({ when: ['git diff --quiet'] });
    expect(nodes[2]).toMatchObject({ optional: true });
  });

  it('renders the stages as a markdown table (from the Job or its meta)', () => {
    const j = fnJob('x', async () => ({ status: 'pass' as const }));
    const job = pipeline('p', [
      { name: 'build', job: j },
      {
        name: 'deploy',
        job: j,
        when: commandSucceeds('git', ['diff', '--quiet']),
      },
      { name: 'notify', job: j, optional: true },
      { name: 'join', job: j, needs: ['build', 'notify'] },
    ]);
    const expected = [
      '| # | stage | needs | when | optional |',
      '| --- | --- | --- | --- | --- |',
      '| 1 | build | — | — | — |',
      '| 2 | deploy | build | git diff --quiet | — |',
      '| 3 | notify | deploy | — | yes |',
      '| 4 | join | build, notify | — | — |',
    ].join('\n');
    expect(renderPipelineTable(job)).toBe(expected);
    expect(renderPipelineTable(jobMeta(job)!)).toBe(expected);

    // a non-dag job (or one with no meta at all) is rejected
    try {
      renderPipelineTable(j);
      expect.unreachable('non-dag meta must throw');
    } catch (e) {
      expect((e as LoopError).code).toBe('CONFIG');
    }
    try {
      renderPipelineTable(async () => ({ status: 'pass' as const }));
      expect.unreachable('missing meta must throw');
    } catch (e) {
      expect((e as LoopError).code).toBe('CONFIG');
    }
  });

  it('passes per-stage isolate through to the dag node', async () => {
    const repo = await tmpRepo();
    const dirs: Record<string, string> = {};
    const dirOf = (name: string) =>
      fnJob(name, async (ctx) => {
        dirs[name] = ctx.workspace.dir;
        return { status: 'pass' as const };
      });
    const { outcome } = await run(
      pipeline('iso', [
        { name: 'shared', job: dirOf('shared') },
        { name: 'writer', job: dirOf('writer'), isolate: true },
      ]),
      { ...mockOpts, cwd: repo },
    );
    expect(outcome.status).toBe('pass');
    // The isolated stage ran in its own worktree; the shared one did not.
    expect(dirs.writer).toBeDefined();
    expect(dirs.writer).not.toBe(dirs.shared);
  });

  it('passes opts through to the dag (stopOnError: false)', async () => {
    const ran: string[] = [];
    const slowPass = (name: string) =>
      fnJob(name, async () => {
        await new Promise((r) => setTimeout(r, 30));
        ran.push(name);
        return { status: 'pass' as const };
      });
    const { outcome } = await run(
      pipeline(
        'p',
        [
          { name: 'bad', job: fail(ran, 'bad') },
          { name: 'slow', job: slowPass('slow'), needs: [] },
          { name: 'after', job: pass(ran, 'after'), needs: ['slow'] },
        ],
        { stopOnError: false },
      ),
      mockOpts,
    );
    // With stopOnError (the default) bad's early failure would abort `after`
    // before it starts; stopOnError:false lets the unrelated branch finish.
    expect(ran.sort()).toEqual(['after', 'bad', 'slow']);
    expect(outcome.status).toBe('fail'); // bad still fails the pipeline
  });
});
