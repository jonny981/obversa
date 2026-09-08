import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs, {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
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

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

  it('keeps every complete recent record when the final JSONL line is torn', () => {
    const supervisor = startSupervisor({
      runId: 'torn-run',
      cwd: testHome,
      title: 'torn',
    });
    for (const message of ['first complete', 'second complete', 'third complete', 'partial']) {
      supervisor.sink({ kind: 'log', ts: 1, path: [], level: 'info', message });
    }
    const eventsPath = runEventsPath('torn-run');
    truncateSync(eventsPath, statSync(eventsPath).size - 4);

    expect(readRunProgress('torn-run', { recent: 4 })?.recent).toEqual([
      'first complete',
      'second complete',
      'third complete',
    ]);
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

  it.each(['inside a record', 'at a line boundary'] as const)('reads a bounded tail cut %s without dropping complete records', (cut) => {
    const supervisor = startSupervisor({
      runId: 'large-run',
      cwd: testHome,
      title: 'large',
    });
    const tailBytes = 256 * 1024;
    const event = (message: string): LoopEvent => ({ kind: 'log', ts: 1, path: [], level: 'info', message });
    const tail = ['first tail record', 'last tail record'];
    if (cut === 'at a line boundary') {
      const overhead = [...tail, ''].reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(event(message))) + 1, 0);
      tail.splice(1, 0, 'x'.repeat(tailBytes - overhead));
      supervisor.sink(event('prefix outside the tail'));
    } else {
      supervisor.sink(event('x'.repeat(tailBytes + 1)));
    }
    for (const message of tail) supervisor.sink(event(message));
    const eventsPath = runEventsPath('large-run');
    const size = statSync(eventsPath).size;
    expect(size).toBeGreaterThan(tailBytes);

    // Observe real file reads; neither spy replaces the filesystem result.
    const open = vi.spyOn(fs, 'openSync');
    const read = vi.spyOn(fs, 'readSync');
    syncBuiltinESMExports();
    try {
      const progress = readRunProgress('large-run', { recent: 3 });
      const eventOpen = open.mock.calls.findIndex(([path]) => path === eventsPath);
      expect(eventOpen).toBeGreaterThanOrEqual(0);
      const openedAt = open.mock.invocationCallOrder[eventOpen]!;
      const reads: unknown[][] = read.mock.calls.filter(
        (_, index) => read.mock.invocationCallOrder[index]! > openedAt,
      );
      expect(reads.length).toBeGreaterThan(0);
      let requestedBytes = 0;
      for (const [, , , length, position] of reads) {
        expect(position).toBeGreaterThanOrEqual(size - tailBytes - 1);
        expect(Number(position) + Number(length)).toBeLessThanOrEqual(size);
        requestedBytes += Number(length);
      }
      expect(requestedBytes).toBeLessThanOrEqual(tailBytes + 1);
      const readable = (messages: string[]) => messages.map((message) => message.length > 100 ? 'padding' : message);
      expect(readable(progress?.recent ?? [])).toEqual(readable(tail));
    } finally {
      open.mockRestore();
      read.mockRestore();
      syncBuiltinESMExports();
    }
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
