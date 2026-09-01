import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fnJob, loop, prove, run } from '../src/api.ts';
import type { LoopEvent } from '../src/api.ts';
import {
  formatEvent,
  readRunProgress,
  readRunStatus,
  runEventsPath,
  runEvidenceIndexPath,
  startSupervisor,
} from '../src/runtime/supervisor.ts';

let previousHome: string | undefined;
let testHome: string;

beforeEach(() => {
  previousHome = process.env.OBVERSA_HOME;
  testHome = mkdtempSync(join(tmpdir(), 'lines-supervisor-'));
  process.env.OBVERSA_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OBVERSA_HOME;
  else process.env.OBVERSA_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});

describe('run supervision', () => {
  it('records a run shape, live state, and bounded event stream', async () => {
    const result = await run(
      loop({
        name: 'one-step',
        body: fnJob('work', async () => ({ status: 'pass' })),
        until: async () => true,
        max: 1,
      }),
      { supervise: true, runId: 'one-step-run' },
    );

    expect(result.outcome.status).toBe('pass');
    expect(readRunStatus('one-step-run')).toMatchObject({
      runId: 'one-step-run',
      title: 'one-step',
      status: 'pass',
      alive: false,
      shape: { kind: 'loop', name: 'one-step' },
      live: {
        iteration: 1,
        lastGate: { which: 'until', met: true },
        lastOutcome: { status: 'pass' },
      },
    });
    const events = readFileSync(runEventsPath('one-step-run'), 'utf8');
    expect(events).toContain('"kind":"loop:start"');
    expect(events).toContain('"kind":"loop:end"');
  });

  it('reports the last failing gate as the blocker', async () => {
    await run(
      loop({
        name: 'not-ready',
        body: fnJob('work', async () => ({ status: 'fail' })),
        until: async () => false,
        max: 1,
      }),
      { supervise: true, runId: 'blocked-run' },
    );

    expect(readRunProgress('blocked-run')).toMatchObject({
      status: 'exhausted',
      stage: 'not-ready',
      iteration: 1,
      blocker: { kind: 'gate-failing' },
    });
  });

  it('tracks an active DAG node and its timeout', () => {
    const supervisor = startSupervisor({
      runId: 'active-run',
      cwd: process.cwd(),
      title: 'active',
    });
    const startedAt = Date.now() - 50;
    supervisor.sink({
      kind: 'dag:node',
      ts: startedAt,
      path: ['graph'],
      node: 'worker',
      phase: 'start',
      timeoutMs: 2_000,
    });

    const progress = readRunProgress('active-run');
    expect(progress?.current).toMatchObject({
      kind: 'dag-node',
      path: ['graph', 'worker'],
      node: 'worker',
      timeoutMs: 2_000,
    });
    expect(progress!.current!.elapsedMs).toBeGreaterThanOrEqual(50);
    expect(progress!.current!.remainingMs).toBeGreaterThan(0);
  });

  it('stores proof records as JSONL without generating an HTML page', async () => {
    await run(
      prove('test-output', async () => ({
        kind: 'json',
        title: 'Test output',
        data: { passed: true },
      })),
      { supervise: true, runId: 'proof-run' },
    );

    const proof = JSON.parse(
      readFileSync(runEvidenceIndexPath('proof-run'), 'utf8').trim(),
    );
    expect(proof).toMatchObject({
      name: 'test-output',
      artifact: { kind: 'json', data: { passed: true } },
    });
    expect(readRunStatus('proof-run')?.evidence).toMatchObject({ count: 1 });
  });

  it('sanitises control characters before rendering model text', () => {
    const event: LoopEvent = {
      kind: 'error',
      ts: Date.now(),
      path: [],
      code: 'ENGINE',
      message: 'safe\u001b]8;;https://example.invalid\u0007spoof',
    };

    expect(formatEvent(event)).toBe('✗ ENGINE: safe ]8;;https://example.invalid spoof');
  });

  it('marks late outcomes in formatted events', () => {
    expect(
      formatEvent({
        kind: 'job:end',
        ts: Date.now(),
        path: ['worker'],
        label: 'worker',
        outcome: { status: 'pass', late: true },
      }),
    ).toContain('pass late');
  });

  it('returns undefined for an unknown or unsafe run id', () => {
    expect(readRunStatus('missing-run')).toBeUndefined();
    expect(readRunStatus('../escape')).toBeUndefined();
  });
});
