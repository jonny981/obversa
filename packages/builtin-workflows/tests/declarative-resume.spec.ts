import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  briefFromFile,
  createCallbackClient,
  directRouter,
  passed,
  person,
  RECORDED_ENGINE_USAGE,
  run,
  stage,
  workflow,
  type Job,
  type RunOptions,
} from '@obversa/runtime';
import { pass, scriptedEngine, seat } from './scripted-engine.js';

/**
 * A declarative workflow with a person gate, run twice against one record.
 *
 * The record is reused only when the caller asks for resume and the
 * workflow and workspace still match. An interrupted side effect needs a
 * person's answer unless the stage is declared safe to retry.
 *
 * 1. Resume is asked for, never inferred: the second run passes
 *    `resume: true`, so an old record never changes behaviour quietly.
 * 2. A stage is the same stage when the workflow name, the workspace, the
 *    brief and the stage list all match; any change restarts from the top.
 * 3. A stage that started and did not finish re-runs only when it is
 *    declared safe to retry; otherwise the resumed run pauses and asks a
 *    person to reconcile before going on. A resumed run that silently
 *    repeats a deploy is worse than no resume.
 *
 * A declarative workflow resumes when you ask it to. An arbitrary job
 * does not.
 */
describe('a declarative workflow with a person gate, run twice on one record', () => {
  it('lets a separate panel review when its conditional writer was skipped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-skipped-writer-panel-'));
    const writer = scriptedEngine('writer', [async () => pass('written')]);
    const reviewer = scriptedEngine('reviewer', [async () => pass('accepted')], {
      usageModel: 'claude-sonnet-4-5',
    });
    const job = workflow('skipped-writer-panel', {
      brief: { brief: 'Review the available work.', files: ['note.md'] },
      roles: { writer: seat(writer, 'gpt'), review: [seat(reviewer, 'claude')] },
      stages: [
        stage('probe', { run: [process.execPath, '-e', 'process.exit(1)'], optional: true }),
        stage('write', { agent: 'writer', writes: 'note.md', when: passed('probe') }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect((result.outcome.data as { write: { data?: { skipped?: boolean } } }).write.data?.skipped).toBe(true);
      expect(writer.calls).toHaveLength(0);
      expect(reviewer.calls).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { writerModel: 'gpt-5', reviewerModel: 'claude-sonnet-4-5', expectedStatus: 'pass', expectedMessage: undefined, reviewerCalls: 2 },
    { writerModel: 'claude-sonnet-4-5', reviewerModel: 'claude-sonnet-4-5', expectedStatus: 'fail', expectedMessage: 'recorded model family collision', reviewerCalls: 0 },
  ])('compares the recorded $writerModel writer after reconciliation against $reviewerModel', async ({ writerModel, reviewerModel, expectedStatus, expectedMessage, reviewerCalls }) => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-reconciled-writer-panel-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const writer = scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('written');
    }], { usageModel: writerModel });
    const reviewer = scriptedEngine('reviewer', [async () => pass('accepted')], {
      usageModel: reviewerModel,
    });
    const job = workflow('reconciled-writer-panel', {
      brief: { brief: 'Write and review one note.', files: ['note.md'] },
      roles: { writer: seat(writer, 'gpt'), review: [seat(reviewer, 'claude')] },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks })).outcome.status).toBe(expectedStatus);
      await retainWriterUsageBeforeDone(recordPath, 'write');
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('paused');
      const request = callbacks.listPending()[0]!;
      expect((await directRouter(callbacks, request, 'operator', () => ({ approved: true }))).ok).toBe(true);

      const resumed = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(resumed.outcome.status).toBe(expectedStatus);
      if (expectedMessage !== undefined) {
        expect(JSON.stringify(resumed.outcome.data ?? resumed.outcome.summary)).toContain(expectedMessage);
      }
      expect(writer.calls).toHaveLength(1);
      expect(reviewer.calls).toHaveLength(reviewerCalls);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not restore the same recorded answer twice when one state object resumes again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-repeated-resume-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const state: Record<string, unknown> = {};
    const writer = scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('written');
    }], { usageModel: 'gpt-5' });
    const job = workflow('repeated-resume', {
      brief: { brief: 'Write and approve one note.', files: ['note.md'] },
      roles: { writer: seat(writer, 'gpt'), approver: person('Approve the note?') },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('approve', { input: 'approver' }),
      ],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks, state })).outcome.status).toBe('paused');
      expect(state[RECORDED_ENGINE_USAGE]).toHaveLength(1);
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks, state })).outcome.status).toBe('paused');
      expect(state[RECORDED_ENGINE_USAGE]).toHaveLength(1);
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks, state })).outcome.status).toBe('paused');
      expect(state[RECORDED_ENGINE_USAGE]).toHaveLength(1);
      expect(writer.calls).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs a stage skipped by when after its optional dependency recovers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-when-resume-'));
    const recordPath = join(directory, 'record.jsonl');
    const job = workflow('conditional-resume', {
      brief: 'Run after the optional probe passes.',
      roles: {},
      stages: [
        stage('probe', {
          run: [process.execPath, '-e', "if (!require('node:fs').existsSync('ready.txt')) process.exit(1)"],
          optional: true,
        }),
        stage('after', {
          run: [process.execPath, '-e', "require('node:fs').writeFileSync('after.txt', 'ran\\n')"],
          when: passed('probe'),
        }),
      ],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath })).outcome.status).toBe('pass');
      await expect(readFile(join(directory, 'after.txt'), 'utf8')).rejects.toThrow();
      await writeFile(join(directory, 'ready.txt'), 'ready\n');
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true })).outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'after.txt'), 'utf8')).toBe('ran\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a pending person question after a resumed start has no done event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-paused-start-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const job = workflow('pending-resume', {
      brief: 'Ask once.',
      roles: { approver: person('Approve this?') },
      stages: [stage('approve', { input: 'approver' })],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks })).outcome.status).toBe('paused');
      const requestId = callbacks.listPending()[0]!.requestId;
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('paused');
      expect(callbacks.listPending().map((request) => request.requestId)).toEqual([requestId]);
      const events = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
        kind: string;
        node?: string;
        phase?: string;
        attempt?: number;
      });
      const start = events.findLast((event) => event.kind === 'dag:node'
        && event.node === 'approve' && event.phase === 'start');
      expect(start).toBeDefined();
      await appendFile(recordPath, `${JSON.stringify(start)}\n`);

      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('paused');
      expect(callbacks.listPending().map((request) => request.requestId)).toEqual([requestId]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not mistake a previously skipped stage for completed work after a start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-skipped-start-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const job = workflow('skipped-start', {
      brief: 'Run after the probe recovers.',
      roles: {},
      stages: [
        stage('probe', {
          run: [process.execPath, '-e', "if (!require('node:fs').existsSync('ready.txt')) process.exit(1)"],
          optional: true,
        }),
        stage('after', {
          run: [process.execPath, '-e', "require('node:fs').writeFileSync('after.txt', 'ran\\n')"],
          when: passed('probe'),
        }),
      ],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks })).outcome.status).toBe('pass');
      await expect(readFile(join(directory, 'after.txt'), 'utf8')).rejects.toThrow();
      const events = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
        kind: string;
        path: string[];
        node?: string;
        phase?: string;
      });
      const skipped = events.find((event) => event.kind === 'dag:node'
        && event.node === 'after' && event.phase === 'skip');
      expect(skipped).toBeDefined();
      await writeFile(join(directory, 'ready.txt'), 'ready\n');
      await appendFile(recordPath, `${JSON.stringify({
        kind: 'dag:node', ts: Date.now(), path: skipped!.path, node: 'after', phase: 'start', attempt: 1,
      })}\n`);

      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('paused');
      expect(callbacks.listPending()[0]!.decisionText).toContain('after');
      await expect(readFile(join(directory, 'after.txt'), 'utf8')).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not re-run the stage that finished before the gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-resume-'));
    const recordPath = join(directory, 'record.jsonl');
    const briefPath = join(directory, 'brief.md');
    await writeFile(briefPath, '---\nfiles: ["count.txt"]\n---\nCount once, then ask.\n');

    const counter = workflow('counter', {
      brief: briefFromFile(briefPath),
      roles: { approver: person('Approve the count?') },
      stages: [
        stage('count', {
          run: ['node', '-e', "require('node:fs').appendFileSync('count.txt', 'one\\n')"],
          writes: ['count.txt'],
        }),
        stage('approve', { input: 'approver' }),
      ],
    });

    const first = await run(counter, { cwd: directory, recordTo: recordPath });
    expect(first.outcome.status).toBe('paused');

    const afterFirst = await readFile(join(directory, 'count.txt'), 'utf8');
    expect(afterFirst).toBe('one\n');
    const events = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      kind: string;
      phase?: string;
      outcome?: { data?: Record<string, unknown> };
    });
    const completed = events.filter((event) => event.kind === 'dag:node' && event.phase === 'done');
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.every((event) => event.outcome?.data?.resumeIdentity === undefined)).toBe(true);

    // The finished count is reused; the person gate is still pending.
    const second = await run(counter, { cwd: directory, recordTo: recordPath, resume: true } as RunOptions);
    expect(second.outcome.status).toBe('paused');

    const afterSecond = await readFile(join(directory, 'count.txt'), 'utf8');
    expect(afterSecond).toBe('one\n');
  });

  it('checks a resumed writer’s recorded model before a separate panel runs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-recorded-family-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const writer = scriptedEngine('writer', [async (request) => {
      await writeFile(join(request.cwd!, 'note.md'), 'written\n');
      return pass('note written');
    }], { usageModel: 'claude-sonnet-4-5' });
    const reviewer = scriptedEngine('reviewer', [async () => pass('accepted')], {
      usageModel: 'claude-sonnet-4-5',
    });
    const job = workflow('resumed-recorded-family', {
      brief: { brief: 'Write and review one note.', files: ['note.md'] },
      roles: {
        writer: seat(writer, 'gpt'),
        approver: person('Review the note?'),
        review: [seat(reviewer, 'claude')],
      },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md' }),
        stage('approve', { input: 'approver' }),
        stage('review', { panel: 'review', agree: 1 }),
      ],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks })).outcome.status).toBe('paused');
      expect(writer.calls).toHaveLength(1);
      const request = callbacks.listPending()[0]!;
      expect((await directRouter(callbacks, request, 'approver', () => ({ approved: true }))).ok).toBe(true);

      const resumed = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(resumed.outcome.status).toBe('fail');
      expect(JSON.stringify(resumed.outcome.data ?? resumed.outcome.summary)).toMatch(/recorded model family collision/);
      expect(writer.calls).toHaveLength(1);
      expect(reviewer.calls).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('re-runs a recorded writer when a person sends its work back during resume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-kickback-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const writer = scriptedEngine('writer', [async (request, call) => {
      await writeFile(join(request.cwd!, 'note.md'), `version ${call}\n`);
      return pass(`version ${call}`);
    }]);
    const job = workflow('revise-note', {
      brief: { brief: 'Write a note for approval.', files: ['note.md'] },
      roles: { writer: seat(writer, 'writer'), approver: person('Approve the note?') },
      stages: [
        stage('write', { agent: 'writer', writes: 'note.md', retry: 1 }),
        stage('approve', { input: 'approver', sendsBackTo: 'write' }),
      ],
    });

    try {
      const first = await run(job, { cwd: directory, recordTo: recordPath, callbacks });
      expect(first.outcome.status).toBe('paused');
      expect(writer.calls).toHaveLength(1);

      const request = callbacks.listPending()[0]!;
      const answered = await directRouter(callbacks, request, 'approver', () => ({
        approved: false,
        note: 'rewrite the note',
      }));
      expect(answered.ok).toBe(true);

      const second = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(writer.calls).toHaveLength(2);
      expect(second.outcome.status).toBe('paused');
      expect(await readFile(join(directory, 'note.md'), 'utf8')).toBe('version 2\n');
      const events = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
        kind: string;
        node?: string;
        phase?: string;
        attempt?: number;
      });
      expect(events.some((event) => event.kind === 'dag:kickback')).toBe(true);
      expect(events.some((event) => event.kind === 'dag:node'
        && event.node === 'write' && event.phase === 'done' && event.attempt === 2)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not infer resume from a state object reused by the caller', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-explicit-'));
    const recordPath = join(directory, 'record.jsonl');
    const state: Record<string, unknown> = { shared: 'kept' };
    const workflowJob = workflow('count-explicit', {
      brief: 'Count once per fresh run.',
      roles: {},
      stages: [stage('count', {
        run: ['node', '-e', "require('node:fs').appendFileSync('count.txt', 'one\\n')"],
      })],
    });
    const job: Job = async (ctx) => {
      ctx.state.calls = (ctx.state.calls as number | undefined ?? 0) + 1;
      return workflowJob(ctx);
    };

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, state })).outcome.status).toBe('pass');
      expect(state).toEqual({ shared: 'kept', calls: 1 });
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, state })).outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'count.txt'), 'utf8')).toBe('one\n');
      expect(state).toEqual({ shared: 'kept', calls: 2 });

      expect((await run(job, { cwd: directory, recordTo: recordPath, state })).outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'count.txt'), 'utf8')).toBe('one\none\n');
      expect(state).toEqual({ shared: 'kept', calls: 3 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs an arbitrary job again even when resume is requested', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-ordinary-'));
    const recordPath = join(directory, 'record.jsonl');
    let calls = 0;
    const job: Job = async () => {
      calls += 1;
      return { status: 'pass' };
    };

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath })).outcome.status).toBe('pass');
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true })).outcome.status).toBe('pass');
      expect(calls).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs the stage in a new workspace even when another workspace used the same record', async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), 'f42-workspace-a-'));
    const secondDirectory = await mkdtemp(join(tmpdir(), 'f42-workspace-b-'));
    const recordPath = join(firstDirectory, 'record.jsonl');
    const job = workflow('workspace-check', {
      brief: 'Write the local marker.',
      roles: {},
      stages: [stage('write', {
        run: ['node', '-e', "require('node:fs').writeFileSync('local.txt', 'here\\n')"],
        writes: 'local.txt',
      })],
    });

    try {
      const first = await run(job, { cwd: firstDirectory, recordTo: recordPath });
      expect(first.outcome.status).toBe('pass');
      const second = await run(job, { cwd: secondDirectory, recordTo: recordPath, resume: true });
      expect(second.outcome.status).toBe('pass');
      expect(await readFile(join(secondDirectory, 'local.txt'), 'utf8')).toBe('here\n');
    } finally {
      await rm(firstDirectory, { recursive: true, force: true });
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });

  it('pauses an interrupted deploy without repeating it or asking twice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-interrupted-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const job = workflow('deploy', {
      brief: 'Deploy this release.',
      roles: {},
      stages: [stage('deploy', {
        run: ['node', '-e', "require('node:fs').appendFileSync('deployments.txt', 'deployed\\n')"],
      })],
    });

    try {
      const first = await run(job, { cwd: directory, recordTo: recordPath, callbacks });
      expect(first.outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'deployments.txt'), 'utf8')).toBe('deployed\n');
      await retainStageStart(recordPath, 'deploy');

      const resumed = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(resumed.outcome.status).toBe('paused');
      expect(callbacks.listPending()).toHaveLength(1);
      expect(callbacks.listPending()[0]!.decisionText).toContain('deploy');
      expect(await readFile(join(directory, 'deployments.txt'), 'utf8')).toBe('deployed\n');

      const repeated = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(repeated.outcome.status).toBe('paused');
      expect(callbacks.listPending()).toHaveLength(1);
      expect(await readFile(join(directory, 'deployments.txt'), 'utf8')).toBe('deployed\n');

      const request = callbacks.listPending()[0]!;
      const answered = await directRouter(callbacks, request, 'operator', () => ({ approved: true }));
      expect(answered.ok).toBe(true);
      const reconciled = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(reconciled.outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'deployments.txt'), 'utf8')).toBe('deployed\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('reuses a completed stage when a later cached skip stopped after its start event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-cached-start-'));
    const recordPath = join(directory, 'record.jsonl');
    const job = workflow('cached-count', {
      brief: 'Count once.',
      roles: {},
      stages: [stage('count', {
        run: ['node', '-e', "require('node:fs').appendFileSync('count.txt', 'one\\n')"],
      })],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath })).outcome.status).toBe('pass');
      const events = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
        kind: string;
        node?: string;
        phase?: string;
        attempt?: number;
      });
      const start = events.find((event) => event.kind === 'dag:node'
        && event.node === 'count' && event.phase === 'start');
      expect(start).toBeDefined();
      await appendFile(recordPath, `${JSON.stringify(start)}\n`);

      const resumed = await run(job, { cwd: directory, recordTo: recordPath, resume: true });
      expect(resumed.outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'count.txt'), 'utf8')).toBe('one\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('still reconciles a later attempt that stopped after its start event', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-later-attempt-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const job = workflow('later-attempt', {
      brief: 'Count again only after a person checks.',
      roles: {},
      stages: [stage('count', {
        run: ['node', '-e', "require('node:fs').appendFileSync('count.txt', 'one\\n')"],
      })],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath })).outcome.status).toBe('pass');
      const events = (await readFile(recordPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
        kind: string;
        node?: string;
        phase?: string;
        attempt?: number;
      });
      const start = events.find((event) => event.kind === 'dag:node'
        && event.node === 'count' && event.phase === 'start');
      expect(start).toBeDefined();
      await appendFile(recordPath, `${JSON.stringify({ ...start, attempt: 2 })}\n`);

      const resumed = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(resumed.outcome.status).toBe('paused');
      expect(callbacks.listPending()).toHaveLength(1);
      expect(await readFile(join(directory, 'count.txt'), 'utf8')).toBe('one\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not carry an interrupted stage into a different workspace', async () => {
    const firstDirectory = await mkdtemp(join(tmpdir(), 'f42-interrupted-a-'));
    const secondDirectory = await mkdtemp(join(tmpdir(), 'f42-interrupted-b-'));
    const recordPath = join(firstDirectory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const job = workflow('local-deploy', {
      brief: 'Deploy in this workspace.',
      roles: {},
      stages: [stage('deploy', {
        run: ['node', '-e', "require('node:fs').writeFileSync('deployed.txt', 'done\\n')"],
      })],
    });

    try {
      expect((await run(job, { cwd: firstDirectory, recordTo: recordPath })).outcome.status).toBe('pass');
      await retainStageStart(recordPath, 'deploy');
      const second = await run(job, { cwd: secondDirectory, recordTo: recordPath, resume: true, callbacks });
      expect(second.outcome.status).toBe('pass');
      expect(callbacks.listPending()).toHaveLength(0);
      expect(await readFile(join(secondDirectory, 'deployed.txt'), 'utf8')).toBe('done\n');
    } finally {
      await rm(firstDirectory, { recursive: true, force: true });
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });

  it('re-runs an interrupted stage declared retry-safe', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-retry-safe-'));
    const recordPath = join(directory, 'record.jsonl');
    const job = workflow('prepare', {
      brief: 'Prepare a replaceable file.',
      roles: {},
      stages: [stage('prepare', {
        run: ['node', '-e', "require('node:fs').writeFileSync('prepared.txt', 'ready\\n')"],
        writes: 'prepared.txt',
        retrySafe: true,
      })],
    });

    try {
      const first = await run(job, { cwd: directory, recordTo: recordPath });
      expect(first.outcome.status).toBe('pass');
      await retainStageStart(recordPath, 'prepare');
      await writeFile(join(directory, 'prepared.txt'), 'stale\n');

      const resumed = await run(job, { cwd: directory, recordTo: recordPath, resume: true });
      expect(resumed.outcome.status).toBe('pass');
      expect(await readFile(join(directory, 'prepared.txt'), 'utf8')).toBe('ready\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a retry-safe declaration that is not a boolean', () => {
    expect(() => workflow('invalid-retry-safe', {
      brief: 'Test the declaration.',
      roles: {},
      stages: [stage('work', {
        run: ['node', '-e', 'process.exit(0)'],
        retrySafe: 'yes',
      } as unknown as Parameters<typeof stage>[1])],
    })).toThrow(/retrySafe must be a boolean/);
  });

  it('does not retry an interrupted stage after a person refuses reconciliation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-refused-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const job = workflow('deploy-refused', {
      brief: 'Deploy this release.',
      roles: {},
      stages: [stage('deploy', {
        run: ['node', '-e', "require('node:fs').appendFileSync('deployments.txt', 'deployed\\n')"],
      })],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks })).outcome.status).toBe('pass');
      await retainStageStart(recordPath, 'deploy');
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('paused');
      const request = callbacks.listPending()[0]!;
      expect((await directRouter(callbacks, request, 'operator', () => ({ approved: false }))).ok).toBe(true);

      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('fail');
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('fail');
      expect(await readFile(join(directory, 'deployments.txt'), 'utf8')).toBe('deployed\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('asks again for a later interruption even when the same stage was reconciled before', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-new-interruption-'));
    const recordPath = join(directory, 'record.jsonl');
    const callbacks = createCallbackClient();
    const job = workflow('repeat-deploy', {
      brief: 'Deploy this release.',
      roles: {},
      stages: [stage('deploy', {
        run: ['node', '-e', "require('node:fs').appendFileSync('deployments.txt', 'deployed\\n')"],
      })],
    });

    try {
      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks })).outcome.status).toBe('pass');
      await retainStageStart(recordPath, 'deploy');
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('paused');
      const firstRequest = callbacks.listPending()[0]!;
      expect((await directRouter(callbacks, firstRequest, 'operator', () => ({ approved: true }))).ok).toBe(true);
      expect((await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks })).outcome.status).toBe('pass');

      expect((await run(job, { cwd: directory, recordTo: recordPath, callbacks })).outcome.status).toBe('pass');
      await retainStageStart(recordPath, 'deploy');
      const later = await run(job, { cwd: directory, recordTo: recordPath, resume: true, callbacks });
      expect(later.outcome.status).toBe('paused');
      expect(callbacks.listPending()).toHaveLength(1);
      expect(callbacks.listPending()[0]!.requestId).not.toBe(firstRequest.requestId);
      expect(await readFile(join(directory, 'deployments.txt'), 'utf8')).toBe('deployed\ndeployed\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function retainStageStart(recordPath: string, stageName: string): Promise<void> {
  const lines = (await readFile(recordPath, 'utf8')).trim().split('\n');
  const index = lines.findIndex((line) => {
    const event = JSON.parse(line) as { kind: string; node?: string; phase?: string };
    return event.kind === 'dag:node' && event.node === stageName && event.phase === 'start';
  });
  expect(index).toBeGreaterThanOrEqual(0);
  await writeFile(recordPath, `${lines.slice(0, index + 1).join('\n')}\n`);
}

async function retainWriterUsageBeforeDone(recordPath: string, stageName: string): Promise<void> {
  const lines = (await readFile(recordPath, 'utf8')).trim().split('\n');
  const index = lines.findIndex((line) => {
    const event = JSON.parse(line) as { kind: string; role?: string; stage?: string };
    return event.kind === 'engine:usage' && event.role === 'writer' && event.stage === stageName;
  });
  expect(index).toBeGreaterThanOrEqual(0);
  await writeFile(recordPath, `${lines.slice(0, index + 1).join('\n')}\n`);
}
