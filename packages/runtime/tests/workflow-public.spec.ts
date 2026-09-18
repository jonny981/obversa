import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { briefFromFile, createStoredCallbackClient, person, run, stage, workflow } from '../src/api.js';
import { createStoredRunFixture } from './stored-run-fixture.js';
import { storedQuestionJob } from './workflow-stored-question-fixture.js';

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
