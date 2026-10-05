import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCallbackClient, dag, fnJob, kickback, loop, person, predicate, run, stage, withEnv, workflow } from '../src/api.ts';
import type { Job, LoopEvent, RunOptions, RunResult } from '../src/api.ts';
import { makeRecorder, readResumeRecord } from '../src/runtime/persist.ts';
import { MockEngine } from '../src/testing.ts';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'obversa-resume-any-round-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const recordTo = (name = 'record.jsonl') => join(cwd, name);

async function result(job: Job, options: RunOptions): Promise<RunResult> {
  return run(job, { cwd, signal: new AbortController().signal, ...options });
}

async function recordEvents(path: string): Promise<LoopEvent[]> {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoopEvent);
}

/** Keep the record up to and including the `count`th event that matches, as if the worker died there. */
async function cutAfter(path: string, matches: (event: LoopEvent) => boolean, count = 1): Promise<void> {
  const lines = (await readFile(path, 'utf8')).trim().split('\n');
  let seen = 0;
  const cut = lines.findIndex((line) => matches(JSON.parse(line) as LoopEvent) && (seen += 1) === count);
  expect(cut).toBeGreaterThanOrEqual(0);
  await writeFile(path, `${lines.slice(0, cut + 1).join('\n')}\n`);
}

const nodeDone = (node: string) => (event: LoopEvent) =>
  event.kind === 'dag:node' && event.node === node && event.phase === 'done';
const nodeStart = (node: string) => (event: LoopEvent) =>
  event.kind === 'dag:node' && event.node === node && event.phase === 'start';

/** A loop whose body is a graph: a build, then a check that fails until the given round. */
function roundsOfWork(runs: { build: number; check: number }, passAt = 3, name = 'rounds'): Job {
  return loop({
    name,
    max: 3,
    body: dag({
      name: 'work',
      nodes: {
        build: { job: fnJob('build', () => { runs.build += 1; }) },
        check: {
          needs: 'build',
          retrySafe: true,
          job: fnJob('check', (ctx) => {
            runs.check += 1;
            return ctx.iteration < passAt ? { status: 'fail' as const, summary: 'red' } : undefined;
          }),
        },
      },
    }),
  });
}

describe('a resume in a later round', () => {
  it('resumes at the check when the worker dies between the build and the check in round 2', async () => {
    const runs = { build: 0, check: 0 };
    const path = recordTo();
    expect((await result(roundsOfWork(runs), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ build: 3, check: 3 });

    await cutAfter(path, nodeDone('build'), 2);
    const resumed = await result(roundsOfWork(runs), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    // Round 2's build stands; its check runs, then round 3 builds and checks.
    expect(runs).toEqual({ build: 4, check: 5 });
  });

  it('never reuses a step that passed in an earlier round for the round it did not reach', async () => {
    const runs = { build: 0, check: 0 };
    const build = () => loop({
      name: 'rounds',
      max: 3,
      until: predicate((ctx) => ctx.iteration >= 3, 'third round'),
      body: dag({
        name: 'work',
        nodes: {
          build: { job: fnJob('build', () => { runs.build += 1; }) },
          check: { needs: 'build', job: fnJob('check', () => { runs.check += 1; }) },
        },
      }),
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ build: 3, check: 3 });

    // Round 2's check never started; round 1's check passed.
    await cutAfter(path, nodeDone('build'), 2);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ build: 4, check: 5 });
  });

  it('resumes a loop with a graph body at the check that was running in round 3', async () => {
    const runs = { build: 0, check: 0 };
    const path = recordTo();
    expect((await result(roundsOfWork(runs), { recordTo: path })).outcome.status).toBe('pass');

    await cutAfter(path, nodeStart('check'), 3);
    const resumed = await result(roundsOfWork(runs), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ build: 3, check: 4 });
  });

  it('resumes a workflow() reviewed stage at the review that was running in round 3', async () => {
    let builds = 0;
    let reviews = 0;
    const writer = new MockEngine((request) => {
      builds += 1;
      writeFileSync(join(request.cwd!, 'page.md'), `draft ${builds}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine(() => {
      reviews += 1;
      return JSON.stringify(reviews < 3
        ? { status: 'revise', summary: 'not yet', findings: [{ severity: 'should-fix', evidence: 'the page never says who it is for' }] }
        : { status: 'pass', summary: 'reads well' });
    });
    const seat = (engine: MockEngine, model: string, tools: readonly string[] = []) =>
      ({ engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } });
    const build = () => workflow('rounds', {
      brief: 'Write the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', retrySafe: true, refine: 2 })],
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect({ builds, reviews }).toEqual({ builds: 3, reviews: 3 });

    // The worker dies once round 3's build is checked and its review began.
    await cutAfter(path, (event) => event.kind === 'loop:condition' && event.which === 'until' && event.iteration === 3);
    reviews = 2;
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect({ builds, reviews }).toEqual({ builds: 3, reviews: 3 });
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 3');
  });

  it('resumes a dag() send-back at the review that was running in round 3', async () => {
    const runs = { write: 0, review: 0 };
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 2 },
      nodes: {
        write: { job: fnJob('write', () => { runs.write += 1; }) },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', (ctx) => {
            runs.review += 1;
            return (ctx.graph?.attempt ?? 1) < 3 ? kickback('write', 'not yet') : undefined;
          }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 3, review: 3 });

    await cutAfter(path, nodeStart('review'), 3);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 3, review: 4 });
  });

  it('runs the steps a send-back target had not reached in round 3, never round 2\'s results', async () => {
    const runs = { draft: 0, polish: 0, review: 0 };
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 2 },
      nodes: {
        write: {
          retrySafe: true,
          job: dag({
            name: 'writing',
            nodes: {
              draft: { job: fnJob('draft', () => { runs.draft += 1; }) },
              polish: { needs: 'draft', job: fnJob('polish', () => { runs.polish += 1; }) },
            },
          }),
        },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', (ctx) => {
            runs.review += 1;
            return (ctx.graph?.attempt ?? 1) < 3 ? kickback('write', 'not yet') : undefined;
          }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ draft: 3, polish: 3, review: 3 });

    // The worker dies after round 3's draft, before its polish started.
    await cutAfter(path, nodeDone('draft'), 3);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ draft: 3, polish: 4, review: 4 });
  });

  it('resumes at the inner step when a loop inside a loop\'s body dies in its round 2', async () => {
    const runs = { build: 0, check: 0 };
    const build = () => loop({
      name: 'outer',
      max: 2,
      until: predicate((ctx) => ctx.iteration >= 2, 'second round'),
      body: dag({
        name: 'release',
        nodes: { inner: { retrySafe: true, job: roundsOfWork(runs, 3, 'inner') } },
      }),
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ build: 6, check: 6 });

    // The outer loop is in its round 2; the inner loop has built its round 2.
    await cutAfter(path, nodeDone('build'), 5);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ build: 7, check: 8 });
  });

  it('reuses a loop review\'s finished check when a loop inside that review dies after its body', async () => {
    const runs = { write: 0, check: 0, build: 0 };
    const build = () => loop({
      name: 'outer',
      max: 1,
      body: fnJob('write', () => { runs.write += 1; }),
      review: dag({
        name: 'review',
        nodes: {
          check: { job: fnJob('check', () => { runs.check += 1; }) },
          inner: { needs: 'check', retrySafe: true, job: loop({ name: 'inner', max: 1, body: fnJob('build', () => { runs.build += 1; }) }) },
        },
      }),
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 1, check: 1, build: 1 });

    // The worker dies once the inner loop saved its finished body.
    await cutAfter(path, (event) => event.kind === 'interaction:checkpoint'
      && event.path.includes('inner') && event.path.at(-1) === '@interaction-loop');
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 1, check: 1, build: 1 });
  });

  it('returns a passed loop\'s result on a resume, without running its review again', async () => {
    const runs = { write: 0, review: 0 };
    const build = () => loop({
      name: 'rounds',
      max: 1,
      body: dag({
        name: 'body',
        nodes: {
          write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
        },
      }),
      // A second look at the same page would not pass it.
      review: fnJob('review', () => { runs.review += 1; return runs.review > 1 ? { status: 'fail' as const, summary: 'red' } : undefined; }),
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 1, review: 1 });

    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 1, review: 1 });
  });
});

describe('a recorded step whose file is missing', () => {
  const trio = (runs: { write: number; check: number }, retrySafe: boolean, checkFails: () => boolean) => dag({
    name: 'trio',
    nodes: {
      write: {
        file: 'page.md',
        retrySafe,
        job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }),
      },
      check: {
        needs: 'write',
        job: fnJob('check', () => { runs.check += 1; return checkFails() ? { status: 'fail' as const, summary: 'red' } : undefined; }),
      },
    },
  });

  it('runs again when it is retry-safe, and the record says why', async () => {
    const runs = { write: 0, check: 0 };
    let checkFails = true;
    const path = recordTo();
    expect((await result(trio(runs, true, () => checkFails), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 1, check: 1 });

    // With the file in place, the write stands.
    expect((await result(trio(runs, true, () => checkFails), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 1, check: 2 });

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(trio(runs, true, () => checkFails), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, check: 3 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
    const notes = (await recordEvents(path)).filter((event): event is Extract<LoopEvent, { kind: 'log' }> => event.kind === 'log');
    expect(notes.some((event) => event.message.includes('page.md') && event.message.includes('write'))).toBe(true);
  });

  it('runs again from a record that does not list the files a step wrote', async () => {
    const runs = { write: 0, check: 0 };
    const path = recordTo();
    expect((await result(trio(runs, true, () => true), { recordTo: path })).outcome.status).toBe('fail');
    // A record written before steps listed their files.
    const older = (await recordEvents(path)).map((event) => {
      const { wrote: _wrote, ...rest } = event as LoopEvent & { wrote?: string[] };
      return JSON.stringify(rest);
    });
    await writeFile(path, `${older.join('\n')}\n`);

    // With the file in place, the write stands, and the record keeps its file.
    expect((await result(trio(runs, true, () => true), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 1, check: 2 });
    expect((await recordEvents(path)).some((event) => nodeDone('write')(event) && (event as { wrote?: string[] }).wrote?.includes('page.md'))).toBe(true);

    await unlink(join(cwd, 'page.md'));
    expect((await result(trio(runs, true, () => false), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, check: 3 });
  });

  it('pauses for a person when it is not retry-safe', async () => {
    const runs = { write: 0, check: 0 };
    const path = recordTo();
    expect((await result(trio(runs, false, () => true), { recordTo: path })).outcome.status).toBe('fail');

    await unlink(join(cwd, 'page.md'));
    const paused = await result(trio(runs, false, () => false), { recordTo: path, resume: true, callbacks: createCallbackClient() });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/page\.md/);
    expect(runs).toEqual({ write: 1, check: 1 });
  });

  it('checks a rebuilt file again, so a rebuild the check would refuse never passes on the old check', async () => {
    const runs = { write: 0, check: 0 };
    const build = () => dag({
      name: 'trio',
      nodes: {
        write: {
          file: 'page.md',
          retrySafe: true,
          job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${runs.write}`); }),
        },
        check: {
          needs: 'write',
          job: fnJob('check', (ctx) => {
            runs.check += 1;
            return readFileSync(join(ctx.workspace.dir, 'page.md'), 'utf8') === 'draft 1' ? undefined : { status: 'fail' as const, summary: 'red' };
          }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');

    await unlink(join(cwd, 'page.md'));
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');
    expect(runs).toEqual({ write: 2, check: 2 });
    expect(resumed.outcome.status).toBe('fail');
    const notes = (await recordEvents(path)).filter((event): event is Extract<LoopEvent, { kind: 'log' }> => event.kind === 'log');
    expect(notes.some((event) => event.message.includes('"check"') && event.message.includes('write'))).toBe(true);
  });

  it('runs a graph wrapped in withEnv() again when its inner step\'s file is gone', async () => {
    const runs = { write: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        inner: {
          retrySafe: true,
          job: withEnv({ PAGE_MODE: 'draft' }, dag({
            name: 'inner',
            nodes: {
              write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
            },
          })),
        },
        check: {
          needs: 'inner',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 1, check: 1 });

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, check: 2 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('runs a finished inner graph again when its file is gone, from a compact record', async () => {
    const runs = { write: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        inner: {
          retrySafe: true,
          job: dag({
            name: 'inner',
            nodes: {
              write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
            },
          }),
        },
        check: {
          needs: 'inner',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');
    expect(runs).toEqual({ write: 1, check: 1 });

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, check: 2 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('runs a finished inner graph again when its file is gone, from a compact record that does not list the files steps wrote', async () => {
    const runs = { write: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        inner: {
          retrySafe: true,
          job: dag({
            name: 'inner',
            nodes: {
              write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
            },
          }),
        },
        check: {
          needs: 'inner',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');
    expect(runs).toEqual({ write: 1, check: 1 });
    // A compact record written before steps listed their files.
    const older = (await recordEvents(path)).map((event) => {
      const { wrote: _wrote, ...rest } = event as LoopEvent & { wrote?: string[] };
      return JSON.stringify(rest);
    });
    await writeFile(path, `${older.join('\n')}\n`);

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, check: 2 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('runs a finished loop with a graph body again when its file is gone, from a compact record that does not list the files steps wrote', async () => {
    const runs = { write: 0, review: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 3,
            body: dag({
              name: 'work',
              nodes: {
                write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
                review: {
                  needs: 'write',
                  retrySafe: true,
                  job: fnJob('review', (ctx) => { runs.review += 1; return ctx.iteration < 2 ? { status: 'fail' as const, summary: 'red' } : undefined; }),
                },
              },
            }),
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');
    expect(runs).toEqual({ write: 2, review: 2, check: 1 });
    // A compact record written before steps listed their files.
    const older = (await recordEvents(path)).map((event) => {
      const { wrote: _wrote, ...rest } = event as LoopEvent & { wrote?: string[] };
      return JSON.stringify(rest);
    });
    await writeFile(path, `${older.join('\n')}\n`);

    // With the file in place, the loop stands.
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 2, review: 2, check: 2 });

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    // The loop's last round writes the file again, and that round's review reads it again.
    expect(runs).toEqual({ write: 3, review: 3, check: 3 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('keeps waiting for the person on every resume from a compact record, when a step that is not retry-safe lost its file', async () => {
    const runs = { write: 0, check: 0 };
    expect((await result(trio(runs, false, () => true), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');

    await unlink(join(cwd, 'page.md'));
    const callbacks = createCallbackClient();
    for (let resume = 0; resume < 2; resume += 1) {
      const paused = await result(trio(runs, false, () => false), { recordTo: path, resume: true, callbacks });
      expect(paused.outcome.status).toBe('paused');
      expect(paused.outcome.summary).toMatch(/page\.md/);
      expect(runs).toEqual({ write: 1, check: 1 });
    }
    expect((await callbacks.listPending()).filter((request) => request.decisionText.includes('page.md'))).toHaveLength(1);
  });

  it('keeps the question a resume asks about a missing file in a compact record', async () => {
    const path = recordTo('compact.jsonl');
    const input = { identity: 'trio', workspace: cwd, stage: 'write', recordId: 'record', startLine: 4, missing: ['page.md'] };
    makeRecorder(path, { thin: true })({
      kind: 'dag:node', ts: 0, path: ['trio'], node: 'write', phase: 'done', attempt: 1,
      outcome: { status: 'paused', summary: 'waiting for a person', data: { requestId: 'request', decisionText: 'Approve?', input, resumeReconciliation: true } },
    });
    const recorded = readResumeRecord(path).outcomes.stages.get('trio/write');
    expect(recorded).toMatchObject({ kind: 'completed', outcome: { status: 'paused', data: { requestId: 'request', resumeReconciliation: true, input } } });
  });

  it('runs a finished inner graph again when its file is gone after an earlier resume reused it, from a compact record', async () => {
    const runs = { write: 0, check: 0 };
    const build = () => dag({
      name: 'outer',
      nodes: {
        inner: {
          retrySafe: true,
          job: dag({
            name: 'inner',
            nodes: {
              write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
            },
          }),
        },
        check: {
          needs: 'inner',
          job: fnJob('check', () => { runs.check += 1; return { status: 'fail' as const, summary: 'red' }; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');

    // With the file in place, the inner graph stands.
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 1, check: 2 });

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 2, check: 3 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  const innerWrite = (runs: { write: number }) => dag({
    name: 'inner',
    nodes: {
      write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
    },
  });

  it('runs a finished inner graph again when its file is gone after a resume reused it and stopped in the loop\'s review, from a compact record', async () => {
    const runs = { write: 0, check: 0, review: 0 };
    const build = () => loop({
      name: 'rounds',
      max: 1,
      body: dag({
        name: 'outer',
        nodes: {
          inner: { retrySafe: true, job: innerWrite(runs) },
          check: { needs: 'inner', retrySafe: true, job: fnJob('check', () => { runs.check += 1; }) },
        },
      }),
      review: fnJob('review', () => { runs.review += 1; }),
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('pass');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');

    // The worker dies after the inner graph finished; the resume reuses it.
    await cutAfter(path, nodeDone('inner'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 1, check: 2, review: 2 });

    // That resume dies in the loop's review, and the file is then lost.
    await cutAfter(path, (event) => event.kind === 'interaction:checkpoint'
      && event.path.at(-1) === '@interaction-loop' && (event.data as { phase?: string } | null)?.phase === 'review');
    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    // The check reads the rebuilt file again.
    expect(runs).toEqual({ write: 2, check: 3, review: 3 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('runs a finished loop again when its file is gone after a resume reused its body and finished it from the loop\'s review, from a compact record', async () => {
    const runs = { write: 0, check: 0, review: 0 };
    const build = () => dag({
      name: 'outer',
      nodes: {
        looped: {
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 1,
            body: dag({ name: 'body', nodes: { inner: { retrySafe: true, job: innerWrite(runs) } } }),
            review: fnJob('review', () => { runs.review += 1; }),
          }),
        },
        check: {
          needs: 'looped',
          job: fnJob('check', () => { runs.check += 1; return { status: 'fail' as const, summary: 'red' }; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');

    // The worker dies after the inner graph finished; the resume reuses it,
    // then dies in the loop's review.
    await cutAfter(path, nodeDone('inner'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    await cutAfter(path, (event) => event.kind === 'interaction:checkpoint'
      && event.path.at(-1) === '@interaction-loop' && (event.data as { phase?: string } | null)?.phase === 'review');

    // A resume finishes the loop from its review.
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 1, check: 3, review: 3 });

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs.write).toBe(2);
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('runs a finished loop again when its review\'s file is gone, from a compact record', async () => {
    const runs = { write: 0, report: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        looped: {
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 1,
            body: dag({ name: 'body', nodes: { inner: { retrySafe: true, job: innerWrite(runs) } } }),
            review: dag({
              name: 'review',
              nodes: {
                report: {
                  file: 'report.md',
                  retrySafe: true,
                  job: fnJob('report', (ctx) => { runs.report += 1; writeFileSync(join(ctx.workspace.dir, 'report.md'), 'ok'); }),
                },
              },
            }),
          }),
        },
        check: {
          needs: 'looped',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');
    expect(runs).toEqual({ write: 1, report: 1, check: 1 });

    await unlink(join(cwd, 'report.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs.report).toBe(2);
    expect(existsSync(join(cwd, 'report.md'))).toBe(true);
  });

  it('runs a finished loop again when its review\'s file is gone, from a compact record that does not list the files steps wrote', async () => {
    const runs = { write: 0, report: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        looped: {
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 1,
            body: dag({ name: 'body', nodes: { inner: { retrySafe: true, job: innerWrite(runs) } } }),
            review: dag({
              name: 'review',
              nodes: {
                report: {
                  file: 'report.md',
                  retrySafe: true,
                  job: fnJob('report', (ctx) => { runs.report += 1; writeFileSync(join(ctx.workspace.dir, 'report.md'), 'ok'); }),
                },
              },
            }),
          }),
        },
        check: {
          needs: 'looped',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');
    expect(runs).toEqual({ write: 1, report: 1, check: 1 });
    // A compact record written before steps listed their files.
    const older = (await recordEvents(path)).map((event) => {
      const { wrote: _wrote, ...rest } = event as LoopEvent & { wrote?: string[] };
      return JSON.stringify(rest);
    });
    await writeFile(path, `${older.join('\n')}\n`);

    await unlink(join(cwd, 'report.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs.report).toBe(2);
    expect(existsSync(join(cwd, 'report.md'))).toBe(true);
  });

  it('runs a finished inner graph again when its file is gone after a resume reused it and saved a send-back, from a compact record', async () => {
    const runs = { write: 0, polish: 0, review: 0 };
    const build = () => dag({
      name: 'outer',
      maxKickbacks: { polish: 1 },
      nodes: {
        inner: { retrySafe: true, job: innerWrite(runs) },
        polish: { needs: 'inner', retrySafe: true, job: fnJob('polish', () => { runs.polish += 1; }) },
        review: {
          needs: 'polish', acceptsKickbackTo: ['polish'], retrySafe: true,
          job: fnJob('review', (ctx) => {
            runs.review += 1;
            return (ctx.graph?.attempt ?? 1) < 2 ? kickback('polish', 'not yet') : undefined;
          }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('pass');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');

    // The worker dies after the inner graph finished; the resume reuses it.
    await cutAfter(path, nodeDone('inner'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 1, polish: 4, review: 4 });

    // That resume dies after it saved the send-back, and the file is then lost.
    await cutAfter(path, (event) => event.kind === 'interaction:checkpoint' && event.path.at(-1) === '@judge-kickback');
    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs.write).toBe(2);
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('runs a step again when the worker dies while it rebuilds a missing file', async () => {
    const runs = { write: 0, check: 0 };
    let checkFails = true;
    const path = recordTo();
    expect((await result(trio(runs, true, () => checkFails), { recordTo: path })).outcome.status).toBe('fail');

    await unlink(join(cwd, 'page.md'));
    expect((await result(trio(runs, true, () => checkFails), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 2, check: 2 });

    // The worker died after the rebuild started: the file is back, but the record has no result for the rebuild.
    await cutAfter(path, nodeStart('write'), (await recordEvents(path)).filter(nodeStart('write')).length);
    checkFails = false;
    expect((await result(trio(runs, true, () => checkFails), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 3, check: 3 });
  });

  it('reuses a finished inner graph whose skipped and failed optional steps never wrote their files', async () => {
    const runs = { write: 0, check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        inner: {
          job: dag({
            name: 'inner',
            nodes: {
              write: { file: 'page.md', job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
              extra: { file: 'extra.md', when: predicate(() => false, 'never'), job: fnJob('extra', (ctx) => { writeFileSync(join(ctx.workspace.dir, 'extra.md'), 'extra'); }) },
              notes: { file: 'notes.md', optional: true, job: fnJob('notes', () => ({ status: 'fail' as const, summary: 'no notes' })) },
            },
          }),
        },
        check: {
          needs: 'inner',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 1, check: 1 });

    checkFails = false;
    const resumed = await result(build(), { recordTo: path, resume: true, callbacks: createCallbackClient() });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 1, check: 2 });
  });

  it.each([
    ['as it is written', (event: LoopEvent) => event],
    ['written before it kept the skipped mark', (event: LoopEvent) => event.kind === 'dag:node' && event.phase === 'skip' && event.outcome
      ? { ...event, outcome: { status: event.outcome.status, summary: event.outcome.summary } }
      : event],
  ])('reuses a finished inner graph whose only step was skipped, from a compact record %s', async (_label, older) => {
    const runs = { check: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        inner: {
          job: dag({
            name: 'inner',
            nodes: {
              extra: { file: 'extra.md', when: predicate(() => false, 'never'), job: fnJob('extra', (ctx) => { writeFileSync(join(ctx.workspace.dir, 'extra.md'), 'extra'); }) },
            },
          }),
        },
        check: {
          needs: 'inner',
          job: fnJob('check', () => { runs.check += 1; return checkFails ? { status: 'fail' as const, summary: 'red' } : undefined; }),
        },
      },
    });
    expect((await result(build(), { recordTo: 'auto', runId: 'compact' })).outcome.status).toBe('fail');
    const path = join(cwd, '.obversa', 'records', 'compact.jsonl');
    const skip = (await recordEvents(path)).find((event) => event.kind === 'dag:node' && event.phase === 'skip');
    expect(skip?.kind === 'dag:node' && skip.outcome?.data).toEqual({ skipped: true });
    await writeFile(path, `${(await recordEvents(path)).map((event) => JSON.stringify(older(event))).join('\n')}\n`);

    checkFails = false;
    const resumed = await result(build(), { recordTo: path, resume: true, callbacks: createCallbackClient() });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ check: 2 });
    expect(existsSync(join(cwd, 'extra.md'))).toBe(false);
  });

  it('rebuilds a finished loop\'s missing file in the round the loop finished in', async () => {
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 3,
            body: dag({
              name: 'work',
              nodes: {
                write: { file: 'page.md', retrySafe: true, job: fnJob('write', (ctx) => { writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${ctx.iteration}`); }) },
                review: {
                  needs: 'write',
                  retrySafe: true,
                  job: fnJob('review', (ctx) => (ctx.iteration < 2 ? { status: 'fail' as const, summary: 'red' } : undefined)),
                },
              },
            }),
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');
  });

  it('rebuilds a finished loop\'s missing file when only the graph step around the loop declares it', async () => {
    const runs = { write: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          file: 'page.md',
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 3,
            body: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${ctx.iteration}`); }),
            until: predicate((ctx) => ctx.iteration >= 2, 'round 2'),
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs.write).toBe(2);

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs.write).toBe(3);
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');
  });

  it('rebuilds a finished loop\'s missing file when only the graph step around a loop with a graph body declares it', async () => {
    const runs = { write: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          file: 'page.md',
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 3,
            body: dag({
              name: 'work',
              nodes: {
                write: { retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${ctx.iteration}`); }) },
              },
            }),
            until: predicate((ctx) => ctx.iteration >= 2, 'round 2'),
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs.write).toBe(2);

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs.write).toBe(3);
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');
  });

  it('rebuilds a missing file when only the graph step around a loop with a graph body declares it and the worker dies after the loop saves the rebuild round', async () => {
    const runs = { write: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          file: 'page.md',
          retrySafe: true,
          job: loop({
            name: 'rounds',
            max: 3,
            body: dag({
              name: 'work',
              nodes: {
                write: { retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${ctx.iteration}`); }) },
              },
            }),
            until: predicate((ctx) => ctx.iteration >= 2, 'round 2'),
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    const bodySaved = (event: LoopEvent) => event.kind === 'interaction:checkpoint'
      && (event.data as { phase?: string } | null)?.phase === 'body';
    const savedBefore = (await recordEvents(path)).filter(bodySaved).length;

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs.write).toBe(3);

    // The worker died once the loop saved the round it rebuilds, before the write ran.
    await cutAfter(path, bodySaved, savedBefore + 1);
    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs.write).toBe(4);
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');
  });

  it('rebuilds a missing file when only the graph step around a graph declares it', async () => {
    const runs = { write: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          file: 'page.md',
          retrySafe: true,
          job: dag({
            name: 'work',
            nodes: {
              write: { retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
            },
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs.write).toBe(1);

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs.write).toBe(2);
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('rebuilds a missing file in the round a send-back passed in when only the graph step around the graph declares it', async () => {
    const runs = { write: 0, review: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          file: 'page.md',
          retrySafe: true,
          job: dag({
            name: 'rounds',
            maxKickbacks: { write: 2 },
            nodes: {
              write: {
                retrySafe: true,
                job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${ctx.graph?.attempt}`); }),
              },
              review: {
                needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
                job: fnJob('review', (ctx) => {
                  runs.review += 1;
                  return (ctx.graph?.attempt ?? 1) < 2 ? kickback('write', 'not yet') : undefined;
                }),
              },
            },
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(runs).toEqual({ write: 2, review: 2 });

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');
    expect(runs).toEqual({ write: 3, review: 3 });
  });

  it('rebuilds a missing file when only the graph step around a graph declares it and the worker dies while it rebuilds', async () => {
    const runs = { write: 0, prep: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          file: 'page.md',
          retrySafe: true,
          job: dag({
            name: 'work',
            nodes: {
              prep: { retrySafe: true, job: fnJob('prep', () => { runs.prep += 1; }) },
              write: { needs: 'prep', retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
            },
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('fail');
    expect(runs).toEqual({ prep: 2, write: 2 });

    // The worker died once the rebuild's first step finished, before the write ran.
    await cutAfter(path, nodeDone('prep'), 2);
    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    // The rebuild's finished step is reused; the write from before the rebuild is not.
    expect(runs).toEqual({ prep: 2, write: 3 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  it('keeps a rebuild when the worker dies during it and a person says a step that is not retry-safe did not finish', async () => {
    const runs = { write: 0, prep: 0 };
    let checkFails = true;
    const build = () => dag({
      name: 'outer',
      nodes: {
        draft: {
          file: 'page.md',
          job: dag({
            name: 'work',
            nodes: {
              prep: { retrySafe: true, job: fnJob('prep', () => { runs.prep += 1; }) },
              write: { retrySafe: true, job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), 'draft'); }) },
            },
          }),
        },
        check: {
          needs: 'draft',
          job: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)),
        },
      },
    });
    const answer = async (asks: string, approved: boolean) => {
      const question = (await callbacks.listPending()).find((request) => request.decisionText.includes(asks));
      const claim = await callbacks.claim(question!.requestId, 'person');
      if (!claim.ok) throw new Error('could not claim the question');
      expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { approved })).toMatchObject({ ok: true });
    };
    const path = recordTo();
    const callbacks = createCallbackClient();
    expect((await result(build(), { recordTo: path, callbacks })).outcome.status).toBe('fail');

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true, callbacks })).outcome.status).toBe('paused');
    await answer('page.md', true);
    expect((await result(build(), { recordTo: path, resume: true, callbacks })).outcome.status).toBe('fail');
    expect(runs).toEqual({ prep: 2, write: 2 });

    // The worker died as the rebuild started, before any step inside it ran.
    await cutAfter(path, (event) => nodeStart('draft')(event) && (event as { attempt?: number }).attempt === 2);
    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true, callbacks })).outcome.status).toBe('paused');
    await answer('finish', false);
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true, callbacks })).outcome.status).toBe('pass');
    // No step from before the rebuild stands in for it.
    expect(runs).toEqual({ prep: 3, write: 3 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);

    // The worker died again as that new attempt started.
    await cutAfter(path, (event) => nodeStart('draft')(event) && (event as { attempt?: number }).attempt === 2, 2);
    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true, callbacks })).outcome.status).toBe('paused');
    await answer('finish', false);
    expect((await result(build(), { recordTo: path, resume: true, callbacks })).outcome.status).toBe('pass');
    expect(runs).toEqual({ prep: 4, write: 4 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
  });

  const sentBack =(runs: { write: number; review: number }, retrySafe: boolean) => dag({
    name: 'rounds',
    maxKickbacks: { write: 2 },
    nodes: {
      write: {
        file: 'page.md',
        retrySafe,
        job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${runs.write}`); }),
      },
      review: {
        needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
        job: fnJob('review', (ctx) => {
          runs.review += 1;
          return (ctx.graph?.attempt ?? 1) < 2 ? kickback('write', 'not yet') : undefined;
        }),
      },
    },
  });

  it('runs a send-back\'s write again when its file is gone before the review resumes', async () => {
    const runs = { write: 0, review: 0 };
    const path = recordTo();
    expect((await result(sentBack(runs, true), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, review: 2 });

    // The worker dies once round 2's write is done and its review began.
    await cutAfter(path, nodeStart('review'), 2);
    await unlink(join(cwd, 'page.md'));
    const resumed = await result(sentBack(runs, true), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 3, review: 3 });
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
    const events = await recordEvents(path);
    expect(events.some((event) => event.kind === 'log' && event.message.includes('page.md'))).toBe(true);
    // The write runs again in round 2, not as a round 3.
    const writes = events.filter((event) => nodeStart('write')(event)) as Extract<LoopEvent, { kind: 'dag:node' }>[];
    expect(writes.map((event) => event.attempt)).toEqual([1, 2, 2]);
  });

  it('runs a send-back\'s write again when the worker dies while it rebuilds the missing file', async () => {
    const runs = { write: 0, review: 0 };
    const path = recordTo();
    expect((await result(sentBack(runs, true), { recordTo: path })).outcome.status).toBe('pass');

    await cutAfter(path, nodeStart('review'), 2);
    await unlink(join(cwd, 'page.md'));
    expect((await result(sentBack(runs, true), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 3, review: 3 });

    // The worker died once round 2's rebuild started: the file is back, but the record has no result for the rebuild.
    await cutAfter(path, nodeStart('write'), 3);
    const resumed = await result(sentBack(runs, true), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 4, review: 4 });
  });

  it('pauses a send-back for a person when its write is not retry-safe and its file is gone', async () => {
    const runs = { write: 0, review: 0 };
    const path = recordTo();
    expect((await result(sentBack(runs, false), { recordTo: path })).outcome.status).toBe('pass');

    await cutAfter(path, nodeStart('review'), 2);
    await unlink(join(cwd, 'page.md'));
    const paused = await result(sentBack(runs, false), { recordTo: path, resume: true, callbacks: createCallbackClient() });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/page\.md/);
    expect(runs).toEqual({ write: 2, review: 2 });
  });

  it('rebuilds a passed send-back\'s missing file in the round the graph passed in', async () => {
    const runs = { write: 0, review: 0 };
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 2 },
      nodes: {
        write: {
          file: 'page.md',
          retrySafe: true,
          job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${ctx.graph?.attempt}`); }),
        },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', (ctx) => {
            runs.review += 1;
            return (ctx.graph?.attempt ?? 1) < 2 ? kickback('write', 'not yet') : undefined;
          }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 2');
    // The rebuilt page is reviewed again.
    expect(runs).toEqual({ write: 3, review: 3 });
  });

  it('reviews a passed send-back\'s rebuilt file again, so a rebuild the review would refuse never passes', async () => {
    const runs = { write: 0, review: 0 };
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        write: {
          file: 'page.md',
          retrySafe: true,
          job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${runs.write}`); }),
        },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', (ctx) => {
            runs.review += 1;
            return readFileSync(join(ctx.workspace.dir, 'page.md'), 'utf8') === 'draft 2' ? undefined : kickback('write', 'not yet');
          }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, review: 2 });

    // The rebuild writes a page the review refuses.
    await unlink(join(cwd, 'page.md'));
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 3');
    expect(runs).toEqual({ write: 3, review: 3 });
    expect(resumed.outcome.status).not.toBe('pass');
  });

  it('reviews a passed send-back\'s rebuilt file again when the worker dies before the graph saves the rebuild', async () => {
    const runs = { write: 0, review: 0 };
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 1 },
      nodes: {
        write: {
          file: 'page.md',
          retrySafe: true,
          job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${runs.write}`); }),
        },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', (ctx) => {
            runs.review += 1;
            return readFileSync(join(ctx.workspace.dir, 'page.md'), 'utf8') === 'draft 2' ? undefined : kickback('write', 'not yet');
          }),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(runs).toEqual({ write: 2, review: 2 });

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).not.toBe('pass');
    expect(runs).toEqual({ write: 3, review: 3 });

    // The worker died once the rebuild finished, before the graph saved its rounds.
    await cutAfter(path, nodeDone('write'), 3);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('draft 3');
    expect(runs).toEqual({ write: 3, review: 4 });
    expect(resumed.outcome.status).not.toBe('pass');
  });

  it('rebuilds a passed send-back\'s missing file with the feedback its round read', async () => {
    const build = () => dag({
      name: 'rounds',
      maxKickbacks: { write: 2 },
      nodes: {
        write: {
          file: 'page.md',
          retrySafe: true,
          job: fnJob('write', (ctx) => {
            writeFileSync(join(ctx.workspace.dir, 'page.md'), ctx.lastReview ? 'corrected draft' : 'original draft');
          }),
        },
        review: {
          needs: 'write', acceptsKickbackTo: ['write'], retrySafe: true,
          job: fnJob('review', (ctx) =>
            (readFileSync(join(ctx.workspace.dir, 'page.md'), 'utf8') === 'corrected draft' ? undefined : kickback('write', 'say who it is for'))),
        },
      },
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('corrected draft');

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('corrected draft');
  });

  it('rebuilds a passed reviewed stage\'s missing file in the round it passed in', async () => {
    let checkFails = true;
    const writer = new MockEngine((request) => {
      writeFileSync(join(request.cwd!, 'page.md'), request.prompt.includes('the page never says who it is for') ? 'corrected draft' : 'original draft');
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine((request) => JSON.stringify(
      readFileSync(join(request.cwd!, 'page.md'), 'utf8') === 'corrected draft'
        ? { status: 'pass', summary: 'reads well' }
        : { status: 'revise', summary: 'not yet', findings: [{ severity: 'should-fix', evidence: 'the page never says who it is for' }] },
    ));
    const seat = (engine: MockEngine, model: string, tools: readonly string[] = []) =>
      ({ engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } });
    const build = () => workflow('rounds', {
      brief: 'Write the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [
        stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', retrySafe: true, refine: 1 }),
        stage('check', { fn: fnJob('check', () => (checkFails ? { status: 'fail' as const, summary: 'red' } : undefined)) }),
      ],
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('fail');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('corrected draft');

    await unlink(join(cwd, 'page.md'));
    checkFails = false;
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect(await readFile(join(cwd, 'page.md'), 'utf8')).toBe('corrected draft');
  });

  it('builds a reviewed stage\'s round again when its file is gone before the review resumes', async () => {
    let builds = 0;
    let reviews = 0;
    const writer = new MockEngine((request) => {
      builds += 1;
      writeFileSync(join(request.cwd!, 'page.md'), `draft ${builds}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine(() => {
      reviews += 1;
      return JSON.stringify(reviews < 2
        ? { status: 'revise', summary: 'not yet', findings: [{ severity: 'should-fix', evidence: 'the page never says who it is for' }] }
        : { status: 'pass', summary: 'reads well' });
    });
    const seat = (engine: MockEngine, model: string, tools: readonly string[] = []) =>
      ({ engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } });
    const build = () => workflow('rounds', {
      brief: 'Write the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', retrySafe: true, refine: 1 })],
    });
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');

    await cutAfter(path, (event) => event.kind === 'loop:condition' && event.which === 'until' && event.iteration === 2);
    await unlink(join(cwd, 'page.md'));
    reviews = 1;
    const resumed = await result(build(), { recordTo: path, resume: true });
    // Round 2 builds again: the stage's one refinement is not spent twice.
    expect(resumed.outcome.status).toBe('pass');
    expect({ builds, reviews }).toEqual({ builds: 3, reviews: 2 });
    const notes = (await recordEvents(path)).filter((event): event is Extract<LoopEvent, { kind: 'log' }> => event.kind === 'log');
    expect(notes.some((event) => event.message.includes('page.md'))).toBe(true);
  });

  it('builds a reviewed stage\'s first round again when the worker dies while it rebuilds the missing file', async () => {
    let builds = 0;
    let reviews = 0;
    const writer = new MockEngine((request) => {
      builds += 1;
      writeFileSync(join(request.cwd!, 'page.md'), `draft ${builds}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine(() => {
      reviews += 1;
      return JSON.stringify({ status: 'pass', summary: 'reads well' });
    });
    const seat = (engine: MockEngine, model: string, tools: readonly string[] = []) =>
      ({ engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } });
    const build = () => workflow('rounds', {
      brief: 'Write the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', retrySafe: true, refine: 1 })],
    });
    const writerAnswers = (event: LoopEvent) => event.kind === 'engine:usage' && event.role === 'writer';
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');
    expect({ builds, reviews }).toEqual({ builds: 1, reviews: 1 });

    // The worker dies once round 1's build is checked and its review began.
    await cutAfter(path, (event) => event.kind === 'loop:condition' && event.which === 'until' && event.iteration === 1);
    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).toBe('pass');
    expect({ builds, reviews }).toEqual({ builds: 2, reviews: 2 });

    // The worker died once the rebuild wrote the file, before the review: the build is not finished.
    await cutAfter(path, writerAnswers, 2);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(resumed.outcome.status).toBe('pass');
    expect({ builds, reviews }).toEqual({ builds: 3, reviews: 3 });
  });

  it('asks a person before building again when a stage waiting on a person\'s review lost its file', async () => {
    let builds = 0;
    const writer = new MockEngine((request) => {
      builds += 1;
      writeFileSync(join(request.cwd!, 'page.md'), `draft ${builds}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const build = () => workflow('reviewed', {
      brief: 'Write the page.',
      roles: {
        writer: { engine: writer, identity: { adapter: 'mock', provider: 'mock', modelFamily: 'writer-mock', model: 'writer-mock', tools: ['Write'] } },
        editor: person('Ready?', { interaction: { id: 'page-review', responseSchema: { type: 'object' } } }),
      },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'editor', refine: 1 })],
    });
    const path = recordTo();
    const callbacks = createCallbackClient();
    expect((await result(build(), { recordTo: path, callbacks })).outcome.status).toBe('paused');
    expect(builds).toBe(1);

    await unlink(join(cwd, 'page.md'));
    const paused = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(builds).toBe(1);
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/page\.md/);

    // Once the person says yes, the writer builds the page again.
    const question = (await callbacks.listPending()).find((request) => request.decisionText.includes('page.md'));
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('could not claim the question');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { approved: true })).toMatchObject({ ok: true });
    const rebuilt = await result(build(), { recordTo: path, resume: true, callbacks });
    expect(builds).toBe(2);
    expect(existsSync(join(cwd, 'page.md'))).toBe(true);
    expect(rebuilt.outcome).toMatchObject({ status: 'paused', summary: 'waiting for a person: Ready?' });
  });

  // A write the check passes only on its first draft.
  const firstDraftOnly = (runs: { write: number; check: number }) => ({
    write: {
      file: 'page.md',
      retrySafe: true,
      job: fnJob('write', (ctx) => { runs.write += 1; writeFileSync(join(ctx.workspace.dir, 'page.md'), `draft ${runs.write}`); }),
    },
    check: fnJob('check', (ctx) => {
      runs.check += 1;
      return readFileSync(join(ctx.workspace.dir, 'page.md'), 'utf8') === 'draft 1' ? undefined : { status: 'fail' as const, summary: 'red' };
    }),
  });

  it('checks a rebuilt file again inside a graph that needs the write', async () => {
    const runs = { write: 0, check: 0 };
    const build = () => {
      const { write, check } = firstDraftOnly(runs);
      return dag({
        name: 'outer',
        nodes: {
          write,
          review: { needs: 'write', job: dag({ name: 'review', nodes: { check: { job: check } } }) },
        },
      });
    };
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');

    await unlink(join(cwd, 'page.md'));
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(runs).toEqual({ write: 2, check: 2 });
    expect(resumed.outcome.status).not.toBe('pass');
  });

  it('checks a rebuilt file again inside a loop\'s review graph', async () => {
    const runs = { write: 0, check: 0 };
    const build = () => {
      const { write, check } = firstDraftOnly(runs);
      return loop({
        name: 'rounds',
        max: 1,
        body: dag({ name: 'body', nodes: { write } }),
        review: dag({ name: 'review', nodes: { check: { job: check } } }),
      });
    };
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');

    await unlink(join(cwd, 'page.md'));
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(runs).toEqual({ write: 2, check: 2 });
    expect(resumed.outcome.status).not.toBe('pass');
  });

  it('checks a rebuilt file again when the worker dies between the rebuild and the check', async () => {
    const runs = { write: 0, check: 0 };
    const build = () => {
      const { write, check } = firstDraftOnly(runs);
      return dag({ name: 'pair', nodes: { write, check: { needs: 'write', job: check } } });
    };
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).not.toBe('pass');
    expect(runs).toEqual({ write: 2, check: 2 });

    // The worker died once the rebuild finished, before the check started.
    await cutAfter(path, nodeDone('write'), 2);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(runs).toEqual({ write: 2, check: 3 });
    expect(resumed.outcome.status).not.toBe('pass');
    // The record says why the check ran again.
    const notes = (await recordEvents(path)).filter((event): event is Extract<LoopEvent, { kind: 'log' }> => event.kind === 'log');
    expect(notes.some((event) => event.message.includes('"check" needs write'))).toBe(true);
  });

  it('checks a rebuilt file again in a loop\'s review when the worker dies between the rebuild and the review', async () => {
    const runs = { write: 0, check: 0 };
    const build = () => {
      const { write, check } = firstDraftOnly(runs);
      return loop({
        name: 'rounds',
        max: 1,
        body: dag({ name: 'body', nodes: { write } }),
        review: dag({ name: 'review', nodes: { check: { job: check } } }),
      });
    };
    const path = recordTo();
    expect((await result(build(), { recordTo: path })).outcome.status).toBe('pass');

    await unlink(join(cwd, 'page.md'));
    expect((await result(build(), { recordTo: path, resume: true })).outcome.status).not.toBe('pass');
    expect(runs).toEqual({ write: 2, check: 2 });

    const full = await readFile(path, 'utf8');

    // The worker died once the rebuilt body finished, before the review started.
    await cutAfter(path, nodeDone('write'), 2);
    const resumed = await result(build(), { recordTo: path, resume: true });
    expect(runs).toEqual({ write: 2, check: 3 });
    expect(resumed.outcome.status).not.toBe('pass');

    // The worker died once the loop saved the rebuilt body, before the review started.
    await writeFile(path, full);
    await cutAfter(path, (event) => event.kind === 'interaction:checkpoint'
      && event.path.at(-1) === '@interaction-loop' && (event.data as { phase?: string } | null)?.phase === 'review', 3);
    const saved = await result(build(), { recordTo: path, resume: true });
    expect(runs).toEqual({ write: 2, check: 4 });
    expect(saved.outcome.status).not.toBe('pass');
  });
});

describe('a run with one round', () => {
  it('resumes as before, and its record carries no rounds', async () => {
    const runs = { one: 0, two: 0 };
    const build = (retrySafe: boolean) => dag({
      name: 'pair',
      nodes: {
        one: { job: fnJob('one', () => { runs.one += 1; }) },
        two: { needs: 'one', retrySafe, job: fnJob('two', () => { runs.two += 1; }) },
      },
    });
    const path = recordTo();
    expect((await result(build(false), { recordTo: path })).outcome.status).toBe('pass');
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain('"rounds"');

    await cutAfter(path, nodeStart('two'));
    const cut = await readFile(path, 'utf8');
    const paused = await result(build(false), { recordTo: path, resume: true, callbacks: createCallbackClient() });
    expect(paused.outcome.status).toBe('paused');
    expect(paused.outcome.summary).toMatch(/Did stage "two" finish/);
    expect(runs).toEqual({ one: 1, two: 1 });

    const safePath = recordTo('safe.jsonl');
    await writeFile(safePath, cut);
    expect((await result(build(true), { recordTo: safePath, resume: true })).outcome.status).toBe('pass');
    expect(runs).toEqual({ one: 1, two: 2 });
  });
});
