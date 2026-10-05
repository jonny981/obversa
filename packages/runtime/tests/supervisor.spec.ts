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
  it('saves the same measured and unknown usage as the monitor and run result', async () => {
    const runId = 'usage-record-run';
    const events: LoopEvent[] = [];
    let reported: ReturnType<typeof readRunStatus>;
    let reportedState: { usage: unknown; status: string } | undefined;
    const result = await run(fnJob('spend', async (ctx) => {
      ctx.emit({
        kind: 'engine:usage', ts: 1, path: [], model: 'measured',
        usage: { kind: 'reported', inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30 },
      });
      reported = readRunStatus(runId);
      const monitor = events.find((event) => event.kind === 'monitor');
      if (monitor?.kind !== 'monitor') throw new Error('monitor URL was not emitted');
      const response = await fetch(`${monitor.url}state`);
      if (!response.ok) throw new Error(`monitor state returned ${response.status}`);
      reportedState = await response.json();
      ctx.emit({
        kind: 'engine:usage', ts: 2, path: [], model: 'unmeasured', usage: { kind: 'unknown' },
      });
    }), { cwd: testHome, supervise: true, monitor: true, runId, onEvent: (event) => events.push(event) });

    try {
      expect(result.outcome.status).toBe('pass');
      const expectedReported = {
        inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30,
        cacheCreationInputTokens: 0, unmeasuredCalls: 0,
      };
      expect(reported?.live.usage).toEqual({ ...expectedReported, calls: 1 });
      expect(reportedState).toMatchObject({ status: 'running', usage: expectedReported });
      expect(result.usage).toEqual({
        inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30,
        cacheCreationInputTokens: 0, unmeasuredCalls: 1,
      });
      const saved = JSON.parse(readFileSync(join(testHome, 'runs', runId, 'status.json'), 'utf8'));
      expect(saved.live.usage).toEqual({ ...result.usage, calls: 2 });
      expect(saved.live.usage).toHaveProperty('unmeasuredCalls', 1);
      expect(saved.live.usage).not.toHaveProperty('unknownUsageCalls');
      expect(readRunStatus(runId)?.live.usage).toEqual(saved.live.usage);
      expect(readRunProgress(runId)?.usage).toEqual(saved.live.usage);
      const response = await fetch(`${result.monitor!.url}state`);
      expect(response.status).toBe(200);
      const state = await response.json();
      expect(state.status).toBe('done');
      expect(state.usage).toEqual(result.usage);
    } finally {
      await result.monitor?.close();
    }
  });

  it('formats recent usage with the totals in the saved status being read', () => {
    const supervisor = startSupervisor({ runId: 'usage-lines-run', cwd: testHome, title: 'usage' });
    supervisor.sink({
      kind: 'engine:usage', ts: 1, path: [], model: 'measured',
      usage: { kind: 'reported', inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30 },
    });
    const reported = readRunProgress('usage-lines-run', { recent: 2 });
    expect(reported?.recent).toHaveLength(1);
    expect(reported!.recent[0]).toContain('measured: 100/20 tok');
    expect(reported!.recent[0]).toContain('run 100/20 tok');
    expect(reported!.recent[0]).toContain('30 tok from cache');
    expect(reported!.recent[0]).not.toContain('usage unknown');

    supervisor.sink({
      kind: 'engine:usage', ts: 2, path: [], model: 'unmeasured', usage: { kind: 'unknown' },
    });
    supervisor.finish({ status: 'pass' });
    const final = readRunProgress('usage-lines-run', { recent: 2 });
    expect(final?.recent).toHaveLength(2);
    expect(final!.recent[0]).toContain('measured: 100/20 tok');
    expect(final!.recent[1]).toContain('unmeasured: usage unknown');
    // Both lines describe the saved total at read time, including the later unknown call.
    for (const line of final!.recent) {
      expect(line).toContain('run 100/20 tok');
      expect(line).toContain('30 tok from cache');
      expect(line).toContain('usage unknown on 1 call');
    }
  });

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
    const recent = readRunProgress('one-step-run', { recent: 20 })?.recent;
    expect(recent).toContain('▸ run');
    expect(recent).toContain('◂ run pass (0/0 tok)');
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

// The run monitor's record panel prints exactly this function's output (see
// monitor.ts), so a line proved here is a line proved for both the console
// and the browser. Every LoopEvent kind gets a case, so a kind added later
// without one falls into `default` here rather than going unnoticed.
describe('formatEvent renders every event kind as a line a person can read', () => {
  it('run:start and run:end', () => {
    expect(formatEvent({ kind: 'run:start', ts: 1, path: [] })).toBe('▸ run');
    expect(formatEvent({
      kind: 'run:end', ts: 1, path: [], outcome: { status: 'pass' }, usage: { inputTokens: 1, outputTokens: 1 },
    })).toBe('◂ run pass (1/1 tok)');
  });

  it('workflow:start (no dedicated case, so it falls through to its bare kind)', () => {
    expect(formatEvent({
      kind: 'workflow:start', ts: 1, path: ['a'], identity: 'writer', workspace: '/tmp/w', recordId: 'r1',
    })).toBe('a workflow:start');
  });

  it('loop:start, loop:iteration, loop:condition, condition:result, loop:review, loop:end', () => {
    expect(formatEvent({ kind: 'loop:start', ts: 1, path: ['loop'], depth: 0, max: 3 })).toBe('loop ▸ loop (max 3)');
    expect(formatEvent({ kind: 'loop:iteration', ts: 1, path: ['loop'], iteration: 2 })).toBe('loop · iteration 2');
    expect(formatEvent({
      kind: 'loop:condition', ts: 1, path: ['loop'], which: 'until', result: { met: true, reason: 'done' },
    })).toBe('loop · until met: done');
    expect(formatEvent({
      kind: 'condition:result', ts: 1, path: ['loop'], label: 'check', iteration: 1, result: { met: false, reason: 'not yet' },
    })).toBe('loop · check not met: not yet');
    expect(formatEvent({ kind: 'loop:review', ts: 1, path: ['loop'], outcome: { status: 'pass' } })).toBe('loop · review: pass');
    expect(formatEvent({
      kind: 'loop:end', ts: 1, path: ['loop'], outcome: { status: 'pass' }, iterations: 3,
    })).toBe('loop ◂ pass (3 iter)');
  });

  it('loop:stall, limit:wait, limit:pause', () => {
    expect(formatEvent({
      kind: 'loop:stall', ts: 1, path: ['loop'], iteration: 2,
      report: { window: 2, iterations: [1, 2], reason: 'no progress', evidence: [] },
    })).toBe('loop ⏹ stalled after 2 no-progress iterations: no progress');
    expect(formatEvent({
      kind: 'limit:wait', ts: 1, path: [], code: 'RATE_LIMIT', waitMs: 5000, resumeAt: 6000,
    })).toBe('⏸ limit RATE_LIMIT: waiting 5s');
    expect(formatEvent({
      kind: 'limit:pause', ts: 1, path: [], code: 'QUOTA', reason: 'out of budget',
    })).toBe('⏸ paused (QUOTA): out of budget');
  });

  it('refine:judge says the target, the round, the route, the rule and the status a stop gives the node', () => {
    expect(formatEvent({
      kind: 'refine:judge', ts: 1, path: ['write'], target: 'write', round: 1, answers: {},
      reason: 'the judge chose continue', route: 'again', rule: 'stop_reason: continue',
    })).toBe('write ◆ write round 1: again on stop_reason: continue: the judge chose continue');
    expect(formatEvent({
      kind: 'refine:judge', ts: 1, path: ['write'], target: 'write', round: 2, answers: {},
      reason: 'the judge says another round is not worth it (0.30)', route: 'stop', rule: 'worth_another_round: 0.30', status: 'fail',
    })).toBe('write ◆ write round 2: stop as fail on worth_another_round: 0.30: the judge says another round is not worth it (0.30)');
  });

  it('dag:start, dag:node, dag:end, monitor', () => {
    expect(formatEvent({ kind: 'dag:start', ts: 1, path: ['dag'], depth: 0, nodes: ['a', 'b'] })).toBe('dag ▸ dag (2 nodes)');
    expect(formatEvent({
      kind: 'dag:node', ts: 1, path: ['dag'], node: 'implement', phase: 'start',
    })).toBe('dag · node implement: start');
    expect(formatEvent({ kind: 'dag:end', ts: 1, path: ['dag'], outcome: { status: 'pass' } })).toBe('dag ◂ dag pass');
    // No dedicated case: the address goes out as its own `monitor` event, not
    // through this line-per-event formatter.
    expect(formatEvent({ kind: 'monitor', ts: 1, path: [], url: 'http://127.0.0.1:1/' })).toBe('monitor');
  });

  it('dag:kickback, job:start, advisor:consult, proof', () => {
    expect(formatEvent({
      kind: 'dag:kickback', ts: 1, path: ['dag'], from: 'review', to: 'implement',
      reason: 'missing header', accepted: true, count: 1, limit: 2,
    })).toBe('dag ↩ kickback accepted review -> implement [1/2]: missing header');
    expect(formatEvent({ kind: 'job:start', ts: 1, path: ['dag'], label: 'implement' })).toBe('dag • implement');
    expect(formatEvent({
      kind: 'advisor:consult', ts: 1, path: ['dag'], label: 'implement', call: 1, question: 'why?', reply: 'because',
    })).toBe('dag ◇ advisor implement #1: why?');
    expect(formatEvent({
      kind: 'proof', ts: 1, path: ['dag'], name: 'test-output', artifact: { kind: 'json', title: 'Result' },
    })).toBe('dag ◈ proof test-output: Result');
  });

  it('job:end carries the summary when the outcome has one, not just the status', () => {
    expect(formatEvent({
      kind: 'job:end', ts: 1, path: ['dag'], label: 'implement', outcome: { status: 'pass' },
    })).toBe('dag • implement: pass');
    expect(formatEvent({
      kind: 'job:end', ts: 1, path: ['dag'], label: 'implement', outcome: { status: 'pass', summary: 'wrote it' },
    })).toBe('dag • implement: pass  wrote it');
  });

  it('engine:text and engine:thinking produce no row: each event is a streamed chunk, and the summary carries the text', () => {
    expect(formatEvent({ kind: 'engine:text', ts: 1, path: ['dag'], delta: 'hello world' })).toBe('');
    expect(formatEvent({ kind: 'engine:text', ts: 1, path: [], delta: 'first\nsecond' })).toBe('');
    expect(formatEvent({ kind: 'engine:thinking', ts: 1, path: ['dag'], delta: '' })).toBe('');
    expect(formatEvent({ kind: 'engine:thinking', ts: 1, path: ['dag'], delta: 'weighing the options' })).toBe('');
  });

  it('engine:tool is the console\'s own line: tool, name, phase, and the target when the event carries one', () => {
    // No target: the event carries none, so the line stays exactly what it
    // was before F132 (the brief's own example, "tool Read use").
    expect(formatEvent({ kind: 'engine:tool', ts: 1, path: [], name: 'Read', phase: 'use' })).toBe('  tool Read use');
    expect(formatEvent({ kind: 'engine:tool', ts: 1, path: ['dag'], name: 'Read', phase: 'result' })).toBe('dag   tool Read result');
    // A target: it follows the phase on the same line.
    expect(formatEvent({
      kind: 'engine:tool', ts: 1, path: [], name: 'Read', phase: 'use', target: 'src/a.ts',
    })).toBe('  tool Read use src/a.ts');
    expect(formatEvent({
      kind: 'engine:tool', ts: 1, path: ['dag'], name: 'Bash', phase: 'use', target: 'npm test',
    })).toBe('dag   tool Bash use npm test');
  });

  it('engine:usage, log, error', () => {
    expect(formatEvent({
      kind: 'engine:usage', ts: 1, path: ['dag'], model: 'm', usage: { kind: 'reported', inputTokens: 5, outputTokens: 2 },
    })).toBe('dag   m: 5/2 tok');
    expect(formatEvent({ kind: 'log', ts: 1, path: ['dag'], level: 'info', message: 'hello' })).toBe('dag hello');
    expect(formatEvent({ kind: 'error', ts: 1, path: ['dag'], code: 'X', message: 'bad' })).toBe('dag ✗ X: bad');
  });
});
