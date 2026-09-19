import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fnJob, formatEvent, run } from '../src/api.ts';
import type { Job, LoopEvent } from '../src/api.ts';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'obversa-run-boundary-'));
  directories.push(directory);
  return directory;
}

function oneEvent<Kind extends LoopEvent['kind']>(events: LoopEvent[], kind: Kind): Extract<LoopEvent, { kind: Kind }> {
  const matches = events.filter((event): event is Extract<LoopEvent, { kind: Kind }> => event.kind === kind);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('run boundary events', () => {
  it('starts after the monitor and ends with the exact result and record identity', async () => {
    const events: LoopEvent[] = [];
    const directory = temporaryDirectory();
    const result = await run(
      fnJob('work', async () => ({ status: 'pass', summary: 'done', data: { private: true } })),
      {
        cwd: directory,
        monitor: true,
        recordTo: 'auto',
        onEvent: (event) => events.push(event),
      },
    );

    const monitorIndex = events.findIndex((event) => event.kind === 'monitor');
    const startIndex = events.findIndex((event) => event.kind === 'run:start');
    const jobIndex = events.findIndex((event) => event.kind === 'job:start');
    expect(monitorIndex).toBeGreaterThanOrEqual(0);
    expect(startIndex).toBe(monitorIndex + 1);
    expect(jobIndex).toBeGreaterThan(startIndex);

    const started = oneEvent(events, 'run:start');
    expect(started).toMatchObject({ path: [], runId: result.runId, recordPath: result.recordPath });

    const ended = oneEvent(events, 'run:end');
    expect(ended).toMatchObject({ path: [], runId: result.runId, recordPath: result.recordPath });
    expect(ended.outcome).toBe(result.outcome);
    expect(ended.usage).toEqual(result.usage);
    expect(events.at(-1)).toBe(ended);

    const record = readFileSync(result.recordPath!, 'utf8');
    expect(record).toContain('"kind":"run:start"');
    expect(record).toContain('"kind":"run:end"');
    expect(record).not.toContain('"private":true');
    await result.monitor?.close();
  });

  it('ends a root job that throws', async () => {
    const events: LoopEvent[] = [];
    const throwingJob: Job = async () => {
      throw new Error('root exploded');
    };

    const result = await run(throwingJob, { onEvent: (event) => events.push(event) });

    expect(result.outcome).toMatchObject({ status: 'fail', summary: 'root exploded' });
    const ended = oneEvent(events, 'run:end');
    expect(ended.outcome).toBe(result.outcome);
    expect(ended.usage).toEqual(result.usage);
    expect(events.at(-1)).toBe(ended);
  });

  it('ends when the environment cannot start and never dispatches the job', async () => {
    const events: LoopEvent[] = [];
    let ran = false;

    const result = await run(
      fnJob('never', async () => {
        ran = true;
        return { status: 'pass' };
      }),
      {
        environment: {
          name: 'broken',
          async up() {
            throw new Error('no daemon');
          },
        },
        onEvent: (event) => events.push(event),
      },
    );

    expect(ran).toBe(false);
    expect(result.outcome).toMatchObject({ status: 'fail', summary: 'environment failed to start: no daemon' });
    const ended = oneEvent(events, 'run:end');
    expect(ended.outcome).toBe(result.outcome);
    expect(ended.usage).toEqual(result.usage);
    expect(events.at(-1)).toBe(ended);
  });

  it('prints the two public events as run boundaries', () => {
    expect(formatEvent({ kind: 'run:start', ts: 1, path: [] })).toBe('▸ run');
    expect(formatEvent({
      kind: 'run:end',
      ts: 2,
      path: [],
      outcome: { status: 'pass' },
      usage: { inputTokens: 12, outputTokens: 3 },
    })).toBe('◂ run pass (12/3 tok)');
  });
});
