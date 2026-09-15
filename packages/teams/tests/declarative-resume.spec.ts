import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run, type RunOptions } from '@obversa/runtime';

import { fromFile, person, stage, workflow } from '../src/declarative.js';

/**
 * A declarative workflow with a person gate, run twice against one record.
 *
 * This is the red test for the F42 seam. It proves the defect first: the
 * earlier stage runs again on the second run, because the plain run path
 * truncates its record on start (packages/runtime/src/runtime/persist.ts:26)
 * and nothing reads one back. The contract it names, from the F42 ruling:
 *
 * 1. Resume is asked for, never inferred: the second run passes
 *    `resume: true`, so an old record never changes behaviour quietly.
 * 2. A stage is the same stage when the workflow name, the workspace, the
 *    brief and the stage list all match; any change restarts from the top,
 *    and the result says so.
 * 3. A stage that started and did not finish re-runs only when it is
 *    declared safe to retry; otherwise the resumed run pauses and asks a
 *    person to reconcile before going on. A resumed run that silently
 *    repeats a deploy is worse than no resume.
 *
 * A declarative workflow resumes when you ask it to. An arbitrary job
 * does not.
 */
describe('a declarative workflow with a person gate, run twice on one record', () => {
  it('does not re-run the stage that finished before the gate', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'f42-resume-'));
    const recordPath = join(directory, 'record.jsonl');
    const briefPath = join(directory, 'brief.md');
    await writeFile(briefPath, '---\nfiles: ["count.txt"]\n---\nCount once, then ask.\n');

    const counter = workflow('counter', {
      brief: fromFile(briefPath),
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

    // The second run asks to resume the record the first run wrote.
    // Today this re-runs the count stage: the recorder truncates the
    // record on start and the workflow starts from the top. The contract
    // this test names instead: the finished stage is not repeated, the
    // run returns to the person gate at its recorded position, and the
    // counter still says one.
    const second = await run(counter, { cwd: directory, recordTo: recordPath, resume: true } as RunOptions);
    expect(second.outcome.status).toBe('paused');

    const afterSecond = await readFile(join(directory, 'count.txt'), 'utf8');
    expect(afterSecond).toBe('one\n');
  });
});
