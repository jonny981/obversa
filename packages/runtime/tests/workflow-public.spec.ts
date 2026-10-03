import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { approval, briefFromFile, createStoredCallbackClient, person, run, stage, workflow } from '../src/api.js';
import type { AgentRequest, ApprovalAnswer, Outcome, TeamSeat } from '../src/api.js';
import { MockEngine } from '../src/testing.js';
import { createStoredRunFixture } from './stored-run-fixture.js';
import { storedQuestionJob } from './workflow-stored-question-fixture.js';

function mockSeat(engine: MockEngine, model: string): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools: [] } };
}

describe('the public workflow builder', () => {
  it('runs a declared command and pauses for a person through the runtime entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f66-workflow-'));
    const briefPath = join(directory, 'brief.md');
    await writeFile(briefPath, '---\nfiles: ["result.txt"]\n---\nWrite the result.\n');

    try {
      const job = workflow('one-result', {
        brief: briefFromFile(briefPath),
        roles: { approve: person('Approve the result?') },
        stages: [
          stage('write', {
            run: ['node', '-e', "require('node:fs').writeFileSync('result.txt', 'ready\\n')"],
            writes: 'result.txt',
          }),
          stage('approve', { input: 'approve' }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('paused');
      expect(await readFile(join(directory, 'result.txt'), 'utf8')).toBe('ready\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps one pending question when a new client resumes from the same store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-stored-question-'));
    const recordPath = join(directory, 'record.jsonl');
    const fixture = await createStoredRunFixture('f42-stored-question');
    try {
      const firstClient = await createStoredCallbackClient(fixture.storage, fixture.runId);
      expect((await run(storedQuestionJob(), {
        cwd: directory,
        recordTo: recordPath,
        callbacks: firstClient,
      })).outcome.status).toBe('paused');
      const firstPending = await firstClient.listPending();
      expect(firstPending).toHaveLength(1);

      const child = fork(fileURLToPath(new URL('./workflow-stored-question-fixture.ts', import.meta.url)), [
        '--resume-stored-question', fixture.directory, fixture.runId, directory, recordPath,
      ], {
        execArgv: ['--import', import.meta.resolve('tsx')],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        signal: AbortSignal.timeout(45_000),
      });
      let stderr = '';
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      expect(exit, stderr).toBe(0);

      const secondClient = await createStoredCallbackClient(fixture.reopen(), fixture.runId);
      expect((await secondClient.listPending()).map((request) => request.requestId)).toEqual([
        firstPending[0]!.requestId,
      ]);
      const history: Array<{ readonly type: string; readonly payload: unknown }> = [];
      for await (const event of fixture.storage.eventStore.read({
        namespace: fixture.storage.record.namespace,
        streamId: fixture.runId,
      })) history.push(event);
      expect(history.filter((event) => event.type === 'callback:history-recorded'
        && (event.payload as { event?: { kind?: string } }).event?.kind === 'callback-requested')).toHaveLength(1);
    } finally {
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('workflow reviewers', () => {
  it('get the reviewed stage\'s task and gate, on the first request and on the retry after an invalid decision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'reviewer-gate-'));
    try {
      const writer = (file: string) => mockSeat(new MockEngine((req) => {
        writeFileSync(join(req.cwd!, file), 'written');
        return JSON.stringify({ status: 'pass', summary: `wrote ${file}` });
      }), `${file}-writer`);
      const requests: Record<string, AgentRequest[]> = { draft: [], check: [] };
      const reviewer = (name: 'draft' | 'check'): TeamSeat => ({
        engine: new MockEngine((req) => {
          requests[name]!.push(req);
          return requests[name]!.length === 1 ? 'not a decision' : JSON.stringify({ status: 'pass', summary: 'meets the gate' });
        }),
        identity: { adapter: 'mock', provider: 'mock', modelFamily: `${name}-reviewer`, model: `${name}-reviewer`, tools: ['Read'] },
      });
      const job = workflow('reviewed-stages', {
        brief: 'Write a draft and a summary of it.',
        roles: {
          drafter: writer('draft.md'),
          summariser: writer('summary.md'),
          draftReviewers: [reviewer('draft')],
          checkReviewers: [reviewer('check')],
        },
        stages: [
          stage('draft', {
            agent: 'drafter', writes: 'draft.md', reviewedBy: 'draftReviewers',
            desc: 'Write the first draft from the brief.',
            gate: 'The draft answers every question in the brief.',
          }),
          stage('summarise', { agent: 'summariser', writes: 'summary.md' }),
          stage('check', {
            panel: 'checkReviewers',
            desc: 'Read the summary against the draft.',
            gate: 'The summary states nothing the draft does not.',
          }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      const expected = {
        draft: { own: ['Task: Write the first draft from the brief.', 'Gate: The draft answers every question in the brief.'], other: 'The summary states nothing the draft does not.' },
        check: { own: ['Task: Read the summary against the draft.', 'Gate: The summary states nothing the draft does not.'], other: 'The draft answers every question in the brief.' },
      };
      for (const name of ['draft', 'check'] as const) {
        const sent = requests[name]!;
        expect(sent).toHaveLength(2);
        expect(sent[1]!.prompt).toContain('Your previous response was not a valid decision.');
        for (const request of sent) {
          for (const line of expected[name].own) expect(request.prompt).toContain(line);
          expect(request.prompt).not.toContain(expected[name].other);
          expect(request.workspaceMode).toBe('read');
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('an agent stage with effort', () => {
  it('passes the stage effort to its seat for that stage only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stage-effort-'));
    try {
      const efforts: (string | undefined)[] = [];
      const writer = mockSeat(new MockEngine((req) => {
        efforts.push(req.effort);
        writeFileSync(join(req.cwd!, req.prompt.includes('may write only: a.txt') ? 'a.txt' : 'b.txt'), 'x');
        return JSON.stringify({ status: 'pass', summary: 'wrote it' });
      }), 'writer-mock');
      const job = workflow('stage-effort', {
        brief: 'write two files',
        roles: { writer },
        stages: [
          stage('first', { agent: 'writer', writes: 'a.txt', effort: 'low' }),
          stage('second', { agent: 'writer', writes: 'b.txt' }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(efforts).toEqual(['low', undefined]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('a plain-function stage', () => {
  it('runs between an agent stage and a command stage with the mock engine, and its outcome is on the record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f142-fn-between-'));
    try {
      const writer = mockSeat(new MockEngine((req) => {
        writeFileSync(join(req.cwd!, 'a.txt'), 'hello');
        return JSON.stringify({ status: 'pass', summary: 'wrote it' });
      }), 'writer-mock');
      const job = workflow('fn-between', {
        brief: 'write a file, count it, then check',
        roles: { writer },
        stages: [
          stage('write', { agent: 'writer', writes: 'a.txt' }),
          stage('count', {
            needs: 'write',
            fn: async (ctx) => {
              const content = await readFile(join(ctx.workspace.dir, 'a.txt'), 'utf8');
              return { status: 'pass', summary: 'counted', data: { length: content.length } };
            },
          }),
          stage('check', { needs: 'count', run: ['node', '-e', 'process.exit(0)'] }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      const data = result.outcome.data as Record<string, Outcome>;
      expect(data.count).toMatchObject({ status: 'pass', summary: 'counted', data: { length: 5 } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('a fail with sendsBackTo kicks the target back, and the target\'s next run sees lastReview', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f142-fn-sendback-'));
    try {
      let targetCalls = 0;
      let secondPrompt: string | undefined;
      const target = mockSeat(new MockEngine((req) => {
        targetCalls += 1;
        if (targetCalls === 1) {
          writeFileSync(join(req.cwd!, 'out.txt'), 'bad');
        } else {
          secondPrompt = req.prompt;
          writeFileSync(join(req.cwd!, 'out.txt'), 'good');
        }
        return JSON.stringify({ status: 'pass', summary: `attempt ${targetCalls}` });
      }), 'target-mock');
      const job = workflow('fn-sendback', {
        brief: 'write out.txt until it reads good',
        roles: { target },
        stages: [
          stage('target', { agent: 'target', writes: 'out.txt' }),
          stage('check', {
            needs: 'target',
            sendsBackTo: 'target',
            fn: async (ctx) => {
              const content = await readFile(join(ctx.workspace.dir, 'out.txt'), 'utf8');
              return content === 'good' ? { status: 'pass' } : { status: 'fail', summary: 'not good yet' };
            },
          }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('pass');
      expect(targetCalls).toBe(2);
      expect(secondPrompt).toContain('Previous review');
      expect(secondPrompt).toContain('not good yet');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails a fn stage by name when its declared write is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f142-fn-missing-write-'));
    try {
      const job = workflow('fn-missing-write', {
        brief: 'declare a write and never make it',
        roles: {},
        stages: [
          stage('produce', { writes: 'out.txt', fn: async () => ({ status: 'pass' }) }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      const data = result.outcome.data as Record<string, Outcome>;
      expect(data.produce!.status).toBe('fail');
      expect(data.produce!.summary).toContain('produce');
      expect(data.produce!.summary).toContain('out.txt');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('fails a fn stage when it touches another stage\'s declared file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f142-fn-forbidden-write-'));
    try {
      const job = workflow('fn-forbidden-write', {
        brief: 'one stage owns other.txt, another must not touch it',
        roles: {},
        stages: [
          stage('other', {
            writes: 'other.txt',
            fn: async (ctx) => { await writeFile(join(ctx.workspace.dir, 'other.txt'), 'x'); return { status: 'pass' }; },
          }),
          stage('mine', {
            needs: 'other',
            writes: 'mine.txt',
            fn: async (ctx) => {
              await writeFile(join(ctx.workspace.dir, 'mine.txt'), 'ok');
              await writeFile(join(ctx.workspace.dir, 'other.txt'), 'tampered');
              return { status: 'pass' };
            },
          }),
        ],
      });
      const result = await run(job, { cwd: directory });
      expect(result.outcome.status).toBe('fail');
      const data = result.outcome.data as Record<string, Outcome>;
      expect(data.mine!.status).toBe('fail');
      expect(data.mine!.summary).toContain('mine');
      expect(data.mine!.summary).toContain('other.txt');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returning approval(...) pauses the run, and resumes once the answer is available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f142-fn-approval-'));
    const makeJob = (answer?: () => ApprovalAnswer | Promise<ApprovalAnswer>) => workflow('fn-approval', {
      brief: 'ask a person through a plain function',
      roles: {},
      stages: [
        stage('ask', {
          fn: (ctx) => approval('ask', {
            question: 'Ship it?',
            input: { file: 'x' },
            ...(answer ? { answer } : {}),
          })(ctx),
        }),
      ],
    });
    try {
      const paused = await run(makeJob(), { cwd: directory });
      expect(paused.outcome.status).toBe('paused');

      const resumed = await run(makeJob(() => ({ approved: true })), { cwd: directory });
      expect(resumed.outcome.status).toBe('pass');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('a changed fn changes the resume identity, so a resumed run starts over instead of skipping', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f142-fn-resume-identity-'));
    const recordTo = join(directory, 'record.jsonl');
    let earlyCalls = 0;
    const makeJob = (lateReturnsExtra: boolean) => workflow('fn-resume-identity', {
      brief: 'two fn stages; the workflow already finished before either resume attempt',
      roles: {},
      stages: [
        stage('early', { fn: async () => { earlyCalls += 1; return { status: 'pass' }; } }),
        stage('late', {
          needs: 'early',
          fn: lateReturnsExtra
            ? async () => ({ status: 'pass', summary: 'v2' })
            : async () => ({ status: 'pass' }),
        }),
      ],
    });
    try {
      const first = await run(makeJob(false), { cwd: directory, recordTo });
      expect(first.outcome.status).toBe('pass');
      expect(earlyCalls).toBe(1);

      const resumedUnchanged = await run(makeJob(false), { cwd: directory, recordTo, resume: true });
      expect(resumedUnchanged.outcome.status).toBe('pass');
      expect(earlyCalls).toBe(1); // same identity, already finished: 'early' is skipped

      const resumedChanged = await run(makeJob(true), { cwd: directory, recordTo, resume: true });
      expect(resumedChanged.outcome.status).toBe('pass');
      expect(earlyCalls).toBe(2); // the changed fn changed the digest: 'early' runs again
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
