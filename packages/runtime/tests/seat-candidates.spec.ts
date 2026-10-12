/**
 * One seat's ordered candidates: a seat names the models it may run as, in
 * order, and a call that fails on billing or quota moves to the next
 * candidate in the same step. The record says what the step asked for,
 * which candidate it selected and why, and a remembered dead candidate is
 * skipped on later runs until its known reset.
 */
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentJob,
  dag,
  EngineError,
  fileAvailabilityStore,
  judge,
  LoopError,
  pipeline,
  review,
  run,
} from '../src/api.ts';
import type {
  AgentRequest,
  AvailabilityStore,
  AvailabilityTarget,
  LoopEvent,
  Outcome,
  TeamSeat,
  UnavailableEntry,
} from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const workDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-candidates-'));
  dirs.push(dir);
  return dir;
};

/** A seat whose declared family is the one `modelIdentity` derives from its model. */
const seat = (
  model: string,
  responder: (req: AgentRequest) => string | { text: string; model?: string },
  tools: readonly string[] = ['Read'],
): TeamSeat => ({
  engine: new MockEngine(responder),
  identity: {
    adapter: 'mock',
    provider: 'mock',
    modelFamily: model.split('-', 1)[0]!,
    model,
    tools,
  },
});

const PASS_TEXT = JSON.stringify({ status: 'pass', summary: 'done' });

const collect = () => {
  const events: LoopEvent[] = [];
  return { events, onEvent: (event: LoopEvent) => events.push(event) };
};

const routeEvents = (events: readonly LoopEvent[]) =>
  events.filter((event): event is Extract<LoopEvent, { kind: 'seat:route' }> => event.kind === 'seat:route');

const targetOf = (seat: TeamSeat) => ({
  adapter: seat.identity.adapter,
  provider: seat.identity.provider,
  modelFamily: seat.identity.modelFamily,
  model: seat.identity.model,
});

const key = (target: AvailabilityTarget) => `${target.adapter}/${target.provider}/${target.model}`;

/** An in-memory store that counts reads and remembers writes. */
const countingStore = (initial: readonly (readonly [AvailabilityTarget, UnavailableEntry])[] = []) => {
  const entries = new Map(initial.map(([target, entry]) => [key(target), entry] as const));
  const store = {
    reads: 0,
    marks: [] as (readonly [AvailabilityTarget, UnavailableEntry])[],
    unavailableUntil(target: AvailabilityTarget, now: number): UnavailableEntry | undefined {
      store.reads += 1;
      const entry = entries.get(key(target));
      return entry !== undefined && entry.until > now ? entry : undefined;
    },
    markUnavailable(target: AvailabilityTarget, entry: UnavailableEntry): void {
      store.marks.push([target, entry]);
      entries.set(key(target), entry);
    },
  };
  return store;
};

describe('a seat with ordered candidates', () => {
  it('spills to the next candidate on billing and records both identities and the reset', async () => {
    const cwd = workDir();
    const resetAt = 1_800_000_000_000;
    const callsA: string[] = [];
    const callsB: string[] = [];
    const primary = seat('alpha-one', (req) => {
      callsA.push(req.prompt);
      throw new EngineError({ kind: 'billing', message: 'credit balance too low', resetAt });
    });
    const alternate = seat('alpha-two', (req) => {
      callsB.push(req.prompt);
      return 'made it on the second seat';
    });
    const { events, onEvent } = collect();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, onEvent },
    );

    expect(result.outcome.status).toBe('pass');
    expect(result.outcome.data).toBe('made it on the second seat');
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
    // The failed attempt is still in the record, marked failed, under its own model.
    const usage = events.filter((event): event is Extract<LoopEvent, { kind: 'engine:usage' }> => event.kind === 'engine:usage');
    expect(usage.some((event) => event.failed === true && event.model === 'alpha-one')).toBe(true);
    expect(usage.some((event) => event.failed === undefined && event.model === 'alpha-two')).toBe(true);
    expect(routeEvents(events)).toEqual([
      expect.objectContaining({
        requested: targetOf(primary),
        selected: targetOf(alternate),
        failure: 'billing',
        reset: resetAt,
      }),
    ]);
  });

  it('spills to the next candidate on quota', async () => {
    const cwd = workDir();
    const primary = seat('alpha-one', () => {
      throw new EngineError({ kind: 'quota', message: 'monthly usage limit reached' });
    });
    const alternate = seat('alpha-two', () => 'on quota hop');
    const { events, onEvent } = collect();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, onEvent },
    );

    expect(result.outcome.status).toBe('pass');
    expect(routeEvents(events)).toEqual([
      expect.objectContaining({ requested: targetOf(primary), selected: targetOf(alternate), failure: 'quota' }),
    ]);
  });

  it.each([
    ['an unrelated engine failure', new Error('socket exploded mid stream')],
    ['an unknown failure', new EngineError({ kind: 'unknown', message: 'mystery' })],
    ['an auth failure', new EngineError({ kind: 'auth', message: 'invalid api key' })],
  ])('does not spill on %s', async (_label, thrown) => {
    const cwd = workDir();
    const callsB: string[] = [];
    const primary = seat('alpha-one', () => {
      throw thrown;
    });
    const alternate = seat('alpha-two', (req) => {
      callsB.push(req.prompt);
      return 'never reached';
    });

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd },
    );

    expect(result.outcome.status).toBe('fail');
    expect(callsB).toHaveLength(0);
  });

  it('does not spill when the run is aborted', async () => {
    const cwd = workDir();
    const controller = new AbortController();
    const callsB: string[] = [];
    const primary = seat('alpha-one', () => {
      controller.abort();
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    });
    const alternate = seat('alpha-two', (req) => {
      callsB.push(req.prompt);
      return 'never reached';
    });

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, signal: controller.signal },
    );

    expect(callsB).toHaveLength(0);
    expect(result.outcome.status).toBe('aborted');
  });

  it('keeps the documented rate-limit behaviour: it spills under the default fallback policy and writes no memory', async () => {
    const cwd = workDir();
    const primary = seat('alpha-one', () => {
      throw new LoopError({ code: 'RATE_LIMIT', message: '429 too many requests', resetAt: 1_800_000_000_000, resetProven: true });
    });
    const alternate = seat('alpha-two', () => 'after the limit');
    const store = countingStore();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, availability: store },
    );

    expect(result.outcome.status).toBe('pass');
    expect(store.marks).toHaveLength(0);
  });

  it('runs each candidate with its own tool policy', async () => {
    const cwd = workDir();
    const seen: (readonly string[] | undefined)[] = [];
    const primary = seat('alpha-one', (req) => {
      seen.push(req.tools);
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    }, ['Read', 'Write']);
    const alternate = seat('alpha-two', (req) => {
      seen.push(req.tools);
      return 'on the other policy';
    }, ['Read', 'Bash']);

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd },
    );

    expect(result.outcome.status).toBe('pass');
    expect(seen).toEqual([['Read', 'Write'], ['Read', 'Bash']]);
  });

  it('refuses an empty candidate list and candidates without a declared identity', () => {
    const primary = seat('alpha-one', () => 'x');
    const alternate = seat('alpha-two', () => 'y');
    expect(() => agentJob({
      label: 'build',
      engine: primary.engine,
      model: primary.identity.model,
      identity: primary.identity,
      candidates: [],
      prompt: 'do the work',
    })).toThrow(TypeError);
    expect(() => agentJob({
      label: 'build',
      engine: primary.engine,
      model: primary.identity.model,
      candidates: [alternate],
      prompt: 'do the work',
    })).toThrow(TypeError);
    expect(() => agentJob({
      label: 'build',
      engine: primary.engine,
      model: primary.identity.model,
      identity: primary.identity,
      candidates: [{ engine: { name: 'not-an-engine' } as never, identity: alternate.identity }],
      prompt: 'do the work',
    })).toThrow(TypeError);
  });

  it('remembers a billing failure with a known reset and skips the candidate on the next run', async () => {
    const cwd = workDir();
    const resetAt = Date.now() + 60_000;
    const file = join(cwd, 'availability.json');
    const callsA: string[] = [];
    const callsB: string[] = [];
    const primary = seat('alpha-one', (req) => {
      callsA.push(req.prompt);
      // The adapter's structured field is a proven reset.
      throw new EngineError({ kind: 'billing', message: 'credit balance too low', resetAt, resetProven: true });
    });
    const alternate = seat('alpha-two', (req) => {
      callsB.push(req.prompt);
      return 'second seat answered';
    });
    const job = () => agentJob({
      label: 'build',
      engine: primary.engine,
      model: primary.identity.model,
      identity: primary.identity,
      candidates: [alternate],
      prompt: 'do the work',
    });

    const first = await run(job(), { cwd, availability: fileAvailabilityStore(file) });
    expect(first.outcome.status).toBe('pass');
    expect(callsA).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      entries: [{
        adapter: 'mock',
        provider: 'mock',
        model: 'alpha-one',
        until: resetAt,
        failure: 'billing',
      }],
    });

    // A second run in a fresh process, over the file the first wrote: the
    // dead candidate is skipped without a call, and the skip is recorded.
    const child = fork(fileURLToPath(new URL('./seat-candidates-skip-fixture.ts', import.meta.url)), [
      '--remembered-skip', cwd, file,
    ], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      signal: AbortSignal.timeout(45_000),
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(exit, stderr).toBe(0);
    // The parent's engines keep their own counts: the child's run touched
    // neither, and its own counters say the primary was never called.
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
    const second = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
      status: string;
      data: unknown;
      callsA: number;
      callsB: number;
      routes: Extract<LoopEvent, { kind: 'seat:route' }>[];
    };
    expect(second.status).toBe('pass');
    expect(second.data).toBe('second seat answered');
    expect(second.callsA).toBe(0);
    expect(second.callsB).toBe(1);
    expect(second.routes).toEqual([
      expect.objectContaining({
        requested: targetOf(primary),
        selected: targetOf(alternate),
        failure: 'billing',
        reset: resetAt,
        remembered: true,
      }),
    ]);
  }, 60_000);

  it('tries the candidate again once its reset has passed', async () => {
    const cwd = workDir();
    const file = join(cwd, 'availability.json');
    const resetAt = Date.parse('2030-01-01T13:34:00Z');
    const callsA: string[] = [];
    const primary = seat('alpha-one', (req) => {
      callsA.push(req.prompt);
      return 'primary answered';
    });
    const alternate = seat('alpha-two', () => 'never reached');
    const fileStore = fileAvailabilityStore(file);
    fileStore.markUnavailable(targetOf(primary), { until: resetAt, failure: 'billing' });
    // The store's clock is the `now` each read is asked with: a run can be
    // checked as of 11:30 and again as of 13:38 without touching the file.
    const asOf = (now: number): AvailabilityStore => ({
      unavailableUntil: (target, _now) => fileStore.unavailableUntil(target, now),
      markUnavailable: (target, entry) => fileStore.markUnavailable(target, entry),
    });
    const job = () => agentJob({
      label: 'build',
      engine: primary.engine,
      model: primary.identity.model,
      identity: primary.identity,
      candidates: [alternate],
      prompt: 'do the work',
    });

    const early = await run(job(), { cwd, availability: asOf(Date.parse('2030-01-01T11:30:00Z')) });
    expect(early.outcome.status).toBe('pass');
    expect(callsA).toHaveLength(0);

    const later = await run(job(), { cwd, availability: asOf(Date.parse('2030-01-01T13:38:00Z')) });
    expect(later.outcome.status).toBe('pass');
    expect(later.outcome.data).toBe('primary answered');
    expect(callsA).toHaveLength(1);
  });

  it('writes nothing durable for billing with no known reset', async () => {
    const cwd = workDir();
    const primary = seat('alpha-one', () => {
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    });
    const alternate = seat('alpha-two', () => 'second seat answered');
    const store = countingStore();
    const { events, onEvent } = collect();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, onEvent, availability: store },
    );

    expect(result.outcome.status).toBe('pass');
    expect(store.marks).toHaveLength(0);
    expect(routeEvents(events)[0]).not.toHaveProperty('reset');
  });

  it('writes nothing durable for a reset read out of error text: it is not proven', async () => {
    const cwd = workDir();
    const resetAt = 1_800_000_000_000;
    const primary = seat('alpha-one', () => {
      // A reset reported on the error but not marked proven, the way a reset
      // parsed out of message text arrives: it spills but is never written.
      throw new EngineError({ kind: 'billing', message: 'credit balance too low', resetAt });
    });
    const alternate = seat('alpha-two', () => 'second seat answered');
    const store = countingStore();
    const { events, onEvent } = collect();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, onEvent, availability: store },
    );

    expect(result.outcome.status).toBe('pass');
    expect(store.marks).toHaveLength(0);
    // The event still records the reset the failure reported.
    expect(routeEvents(events)[0]).toMatchObject({ reset: resetAt });
  });

  it('writes a reset the host supplies straight onto the store', async () => {
    const cwd = workDir();
    const resetAt = Date.now() + 60_000;
    const store = countingStore();
    // The host writes the reset it learned out of band (a provider notice,
    // a dashboard) onto the store it hands the run.
    store.markUnavailable(
      { adapter: 'mock', provider: 'mock', model: 'alpha-one' },
      { until: resetAt, failure: 'billing' },
    );
    const callsA: string[] = [];
    const primary = seat('alpha-one', (req) => {
      callsA.push(req.prompt);
      return 'never reached';
    });
    const alternate = seat('alpha-two', () => 'second seat answered');

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, availability: store },
    );

    expect(result.outcome.status).toBe('pass');
    expect(result.outcome.data).toBe('second seat answered');
    expect(callsA).toHaveLength(0);
  });

  it.each([
    ['auth', new EngineError({ kind: 'auth', message: 'invalid api key', resetAt: 1_800_000_000_000, resetProven: true })],
    ['invalid-config', new EngineError({ kind: 'invalid-config', message: 'bad config', resetAt: 1_800_000_000_000, resetProven: true })],
    ['model-unavailable', new EngineError({ kind: 'model-unavailable', message: 'model gone', resetAt: 1_800_000_000_000, resetProven: true })],
    ['rate-limit', new EngineError({ kind: 'rate-limit', message: '429', resetAt: 1_800_000_000_000, resetProven: true })],
    ['transient', new EngineError({ kind: 'transient', message: '503 service unavailable', resetAt: 1_800_000_000_000, resetProven: true })],
  ])('never remembers %s, even with a proven reset', async (_kind, thrown) => {
    const cwd = workDir();
    const primary = seat('alpha-one', () => {
      throw thrown;
    });
    const alternate = seat('alpha-two', () => 'second seat answered');
    const store = countingStore();

    await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, availability: store },
    );

    expect(store.marks).toHaveLength(0);
  });

  it('scopes remembered unavailability to the access route: adapter, provider and model', async () => {
    const cwd = workDir();
    const deadTarget = { adapter: 'mock', provider: 'mock', model: 'alpha-one' };
    const store = countingStore([[deadTarget, { until: Date.now() + 60_000, failure: 'billing' }]]);
    const alternate = seat('alpha-two', () => 'never reached');
    const via = (identity: Partial<TeamSeat['identity']>, responder: (req: AgentRequest) => string): TeamSeat => {
      const base = seat('alpha-one', responder);
      return { engine: base.engine, identity: { ...base.identity, ...identity } };
    };
    const callsA: string[] = [];
    // Another adapter on the same provider and model is its own account.
    const otherAdapter = via({ adapter: 'other-adapter' }, (req) => {
      callsA.push(req.prompt);
      return 'reached through the other adapter';
    });
    const first = await run(
      agentJob({
        label: 'build',
        engine: otherAdapter.engine,
        model: otherAdapter.identity.model,
        identity: otherAdapter.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, availability: store },
    );
    expect(first.outcome.status).toBe('pass');
    expect(first.outcome.data).toBe('reached through the other adapter');
    expect(callsA).toHaveLength(1);

    // And the same adapter through another provider is its own account.
    const callsB: string[] = [];
    const otherProvider = via({ provider: 'other-provider' }, (req) => {
      callsB.push(req.prompt);
      return 'reached through the other provider';
    });
    const second = await run(
      agentJob({
        label: 'build',
        engine: otherProvider.engine,
        model: otherProvider.identity.model,
        identity: otherProvider.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, availability: store },
    );
    expect(second.outcome.data).toBe('reached through the other provider');
    expect(callsB).toHaveLength(1);
  });

  it('fails the step loudly when every candidate is unavailable, recording no selected model', async () => {
    const cwd = workDir();
    const calls: string[] = [];
    const primary = seat('alpha-one', (req) => {
      calls.push(req.prompt);
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    });
    const alternate = seat('alpha-two', (req) => {
      calls.push(req.prompt);
      throw new EngineError({ kind: 'quota', message: 'monthly usage limit reached' });
    });
    const { events, onEvent } = collect();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, onEvent },
    );

    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.error?.code).toBe('QUOTA');
    expect(calls).toHaveLength(2);
    expect(routeEvents(events)).toEqual([
      expect.objectContaining({
        requested: targetOf(primary),
        selected: targetOf(alternate),
        failure: 'billing',
      }),
      // The last live candidate's death is the all-unavailable outcome: the
      // event names the failure and no selected model at all.
      expect.objectContaining({
        requested: targetOf(alternate),
        failure: 'quota',
      }),
    ]);
    expect(routeEvents(events)[1]).not.toHaveProperty('selected');

    // And when the memory says every candidate is dead, no call is spent at all.
    const resetAt = Date.now() + 60_000;
    const store = countingStore([
      [targetOf(primary), { until: resetAt, failure: 'billing' }],
      [targetOf(alternate), { until: resetAt, failure: 'quota' }],
    ]);
    const { events: deadEvents, onEvent: onDead } = collect();
    const deadResult = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, onEvent: onDead, availability: store },
    );
    expect(deadResult.outcome.status).toBe('fail');
    // The exhausted seat carries the earliest remembered reset.
    expect(deadResult.outcome.error?.code).toBe('QUOTA');
    expect(deadResult.outcome.error?.resetAt).toBe(resetAt);
    expect(calls).toHaveLength(2);
    const skips = routeEvents(deadEvents);
    expect(skips).toHaveLength(2);
    for (const skip of skips) expect(skip).not.toHaveProperty('selected');
  });

  it('keeps a single seat off the memory entirely: same route, same record, no reads or writes', async () => {
    const cwd = workDir();
    const primary = seat('alpha-one', () => 'only seat answered');
    const store = countingStore();
    const { events, onEvent } = collect();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        prompt: 'do the work',
      }),
      { cwd, onEvent, availability: store },
    );

    expect(result.outcome.status).toBe('pass');
    expect(routeEvents(events)).toHaveLength(0);
    expect(store.reads).toBe(0);
    expect(store.marks).toHaveLength(0);
  });

  it('keeps a one-seat node and a one-seat reviewer off the memory entirely', async () => {
    const cwd = workDir();
    // The seat-carrying callers always pass `identity`, so the store must be
    // gated on `candidates` alone: reads or writes here mean a single seat
    // touched supplied memory.
    const writer = seat('alpha-one', () => PASS_TEXT, ['Write']);
    const reviewer = seat('beta-one', () => PASS_TEXT);
    const store = countingStore();
    const { events, onEvent } = collect();
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: writer,
          writes: 'workspace',
          refine: review({ reviewers: [{ name: 'check', seat: reviewer }], rounds: 1 }),
        },
      },
    });

    const result = await run(job, { cwd, onEvent, availability: store });

    expect(result.outcome.status).toBe('pass');
    expect(store.reads).toBe(0);
    expect(store.marks).toHaveLength(0);
    expect(routeEvents(events)).toHaveLength(0);
  });

  it('does not change course when the caller mutates the candidate list after the job is built', async () => {
    const cwd = workDir();
    const primary = seat('alpha-one', () => {
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    });
    const alternate = seat('alpha-two', () => 'second seat answered');
    const candidates: TeamSeat[] = [alternate];
    const job = agentJob({
      label: 'build',
      engine: primary.engine,
      model: primary.identity.model,
      identity: primary.identity,
      candidates,
      prompt: 'do the work',
    });
    candidates.length = 0;

    const result = await run(job, { cwd });
    expect(result.outcome.status).toBe('pass');
    expect(result.outcome.data).toBe('second seat answered');
  });
});

describe('fileAvailabilityStore', () => {
  it('persists an entry a fresh instance reads, and treats an expired one as absent', () => {
    const dir = workDir();
    const file = join(dir, 'availability.json');
    const target = { adapter: 'mock', provider: 'mock', model: 'alpha-one' };
    const first = fileAvailabilityStore(file);
    first.markUnavailable(target, { until: 1_800_000_000_000, failure: 'quota' });

    const second = fileAvailabilityStore(file);
    expect(second.unavailableUntil(target, 1_700_000_000_000)).toEqual({ until: 1_800_000_000_000, failure: 'quota' });
    expect(second.unavailableUntil(target, 1_900_000_000_000)).toBeUndefined();
    expect(second.unavailableUntil({ ...target, provider: 'elsewhere' }, 1_700_000_000_000)).toBeUndefined();
    expect(second.takeProblems?.() ?? []).toEqual([]);
  });

  it('reads a corrupt file as empty and reports the problem once', () => {
    const dir = workDir();
    const file = join(dir, 'availability.json');
    writeFileSync(file, 'this is not json{{{', 'utf8');
    const store = fileAvailabilityStore(file);
    expect(store.unavailableUntil({ adapter: 'a', provider: 'b', model: 'c' }, Date.now())).toBeUndefined();
    const problems = store.takeProblems?.() ?? [];
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/corrupt|unreadable|could not be read/);
    expect(store.takeProblems?.() ?? []).toEqual([]);
  });

  it('puts the corrupt-file warning in the run record, not only the store', async () => {
    const cwd = workDir();
    const file = join(cwd, 'availability.json');
    writeFileSync(file, 'this is not json{{{', 'utf8');
    const primary = seat('alpha-one', () => 'primary answered');
    const alternate = seat('alpha-two', () => 'never reached');
    const { events, onEvent } = collect();

    const result = await run(
      agentJob({
        label: 'build',
        engine: primary.engine,
        model: primary.identity.model,
        identity: primary.identity,
        candidates: [alternate],
        prompt: 'do the work',
      }),
      { cwd, onEvent, availability: fileAvailabilityStore(file) },
    );

    // The corrupt file reads as empty, so the primary still runs, and the
    // warning the store queued on that read reaches the record.
    expect(result.outcome.status).toBe('pass');
    expect(result.outcome.data).toBe('primary answered');
    const warnings = events.filter(
      (event): event is Extract<LoopEvent, { kind: 'log' }> =>
        event.kind === 'log' && event.level === 'warn',
    );
    expect(warnings.some((event) => /corrupt|unreadable|could not be read/.test(event.message))).toBe(true);
  });

  it('reads a missing file as empty without a warning', () => {
    const dir = workDir();
    const store = fileAvailabilityStore(join(dir, 'absent.json'));
    expect(store.unavailableUntil({ adapter: 'a', provider: 'b', model: 'c' }, Date.now())).toBeUndefined();
    expect(store.takeProblems?.() ?? []).toEqual([]);
  });
});

describe('candidate seats through dag, pipeline and review', () => {
  it('runs the second candidate of a dag node agent when the first is out of credit', async () => {
    const cwd = workDir();
    const callsB: string[] = [];
    const primary = seat('alpha-one', () => {
      throw new EngineError({ kind: 'billing', message: 'credit balance too low', resetAt: 1_800_000_000_000 });
    });
    const alternate = seat('alpha-two', (req) => {
      callsB.push(req.prompt);
      return PASS_TEXT;
    });
    const { events, onEvent } = collect();
    const job = dag({
      name: 'shape',
      nodes: {
        build: { agent: { seat: primary, candidates: [alternate] }, writes: 'workspace' },
      },
    });

    const result = await run(job, { cwd, onEvent });
    expect(result.outcome.status).toBe('pass');
    expect(callsB).toHaveLength(1);
    expect(routeEvents(events)).toEqual([
      expect.objectContaining({ requested: targetOf(primary), selected: targetOf(alternate), failure: 'billing' }),
    ]);
  });

  it('forwards stage candidates through pipeline()', async () => {
    const cwd = workDir();
    const primary = seat('alpha-one', () => {
      throw new EngineError({ kind: 'quota', message: 'monthly usage limit reached' });
    });
    const alternate = seat('alpha-two', () => PASS_TEXT);
    const job = pipeline('ship', [
      { name: 'build', agent: { seat: primary, candidates: [alternate] }, writes: 'workspace' },
    ]);

    const result = await run(job, { cwd });
    expect(result.outcome.status).toBe('pass');
  });

  it('runs a reviewer candidate when the first is out of credit, inside a refined node', async () => {
    const cwd = workDir();
    const callsB: string[] = [];
    const writer = seat('alpha-one', () => PASS_TEXT, ['Write']);
    const deadReviewer = seat('beta-one', () => {
      throw new EngineError({ kind: 'billing', message: 'credit balance too low', resetAt: 1_800_000_000_000 });
    });
    const liveReviewer = seat('beta-two', (req) => {
      callsB.push(req.prompt);
      return PASS_TEXT;
    });
    const { events, onEvent } = collect();
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: writer,
          writes: 'workspace',
          refine: review({
            reviewers: [{ name: 'check', seat: { seat: deadReviewer, candidates: [liveReviewer] } }],
            rounds: 1,
          }),
        },
      },
    });

    const result = await run(job, { cwd, onEvent });
    expect(result.outcome.status).toBe('pass');
    expect(callsB).toHaveLength(1);
    expect(routeEvents(events)).toEqual([
      expect.objectContaining({ requested: targetOf(deadReviewer), selected: targetOf(liveReviewer), failure: 'billing' }),
    ]);
  });

  it('pauses the panel when every candidate of a reviewer is remembered dead: an operational failure, never a verdict', async () => {
    const cwd = workDir();
    const calls: string[] = [];
    const writer = seat('alpha-one', () => PASS_TEXT, ['Write']);
    const first = seat('beta-one', (req) => {
      calls.push(req.prompt);
      return 'never reached';
    });
    const second = seat('beta-two', (req) => {
      calls.push(req.prompt);
      return 'never reached';
    });
    const resetAt = Date.now() + 60_000;
    const store = countingStore([
      [targetOf(first), { until: resetAt, failure: 'billing' }],
      [targetOf(second), { until: resetAt, failure: 'quota' }],
    ]);
    const { events, onEvent } = collect();
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: writer,
          writes: 'workspace',
          refine: review({
            reviewers: [{ name: 'check', seat: { seat: first, candidates: [second] } }],
            rounds: 1,
          }),
        },
      },
    });

    const result = await run(job, { cwd, onEvent, availability: store });
    // An operational failure is a pause, never a verdict: the node paused
    // on the engine error and produced no findings for the writer to act on.
    expect(result.outcome.status).toBe('paused');
    const node = (result.outcome.data as Record<string, Outcome> | undefined)?.['build'];
    expect(node?.status).toBe('paused');
    expect(node?.error?.code).toBe('QUOTA');
    expect((node?.data as { findings?: readonly unknown[] } | undefined)?.findings).toEqual([]);
    expect(calls).toHaveLength(0);
    const skips = routeEvents(events);
    expect(skips).toHaveLength(2);
    for (const skip of skips) expect(skip).not.toHaveProperty('selected');
  });

  it('pauses a refined builder when every candidate is remembered dead past the wait ceiling, keeping the skips', async () => {
    const cwd = workDir();
    const calls: string[] = [];
    let reviews = 0;
    let judgeCalls = 0;
    const first = seat('alpha-one', (req) => {
      calls.push(req.prompt);
      return 'never reached';
    }, ['Write']);
    const second = seat('alpha-two', (req) => {
      calls.push(req.prompt);
      return 'never reached';
    }, ['Write']);
    // Both resets are past the default five-minute wait ceiling.
    const resetAt = Date.now() + 3_600_000;
    const store = countingStore([
      [targetOf(first), { until: resetAt + 60_000, failure: 'billing' }],
      [targetOf(second), { until: resetAt, failure: 'quota' }],
    ]);
    const { events, onEvent } = collect();
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: { seat: first, candidates: [second] },
          writes: 'workspace',
          // An uncapped judge has no round budget to stop a retry: the
          // all-unavailable failure must end the rounds itself.
          refine: review({
            reviewers: [seat('beta-one', () => { reviews += 1; return PASS_TEXT; })],
            judge: judge(seat('judge-one', () => { judgeCalls += 1; return '{}'; })),
          }),
        },
      },
    });

    const result = await run(job, { cwd, onEvent, availability: store });
    // A single model out of quota past the ceiling pauses; so does the seat.
    expect(result.outcome.status).toBe('paused');
    const node = (result.outcome.data as Record<string, Outcome> | undefined)?.['build'];
    expect(node?.status).toBe('paused');
    expect(node?.error?.code).toBe('QUOTA');
    expect(node?.error?.resetAt).toBe(resetAt);
    expect(events.some((event) => event.kind === 'limit:pause')).toBe(true);
    // One attempt and not a call spent: the two skips are on the record
    // once each, and the reviewers and judge never ran.
    expect(calls).toHaveLength(0);
    expect(reviews).toBe(0);
    expect(judgeCalls).toBe(0);
    const skips = routeEvents(events);
    expect(skips).toHaveLength(2);
    for (const skip of skips) expect(skip).not.toHaveProperty('selected');

    // Under `onLimit: 'fail'` the seat fails at once, though a reset is
    // known: the error is never retryable, so the rounds cannot spin on
    // the same skips until the reset.
    const { events: failEvents, onEvent: onFail } = collect();
    const failed = await run(job, { cwd: workDir(), onEvent: onFail, availability: store, onLimit: 'fail' });
    expect(failed.outcome.status).toBe('fail');
    expect(routeEvents(failEvents)).toHaveLength(2);
    expect(calls).toHaveLength(0);
    expect(reviews).toBe(0);
    expect(judgeCalls).toBe(0);
  });

  it('waits for the earliest candidate reset, then runs the candidate that came back', async () => {
    const cwd = workDir();
    const callsA: string[] = [];
    const callsB: string[] = [];
    const first = seat('alpha-one', (req) => {
      callsA.push(req.prompt);
      return PASS_TEXT;
    }, ['Write']);
    const second = seat('alpha-two', (req) => {
      callsB.push(req.prompt);
      return PASS_TEXT;
    }, ['Write']);
    const soon = Date.now() + 150;
    const store = countingStore([
      [targetOf(first), { until: soon, failure: 'quota' }],
      [targetOf(second), { until: Date.now() + 3_600_000, failure: 'billing' }],
    ]);
    const { events, onEvent } = collect();
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: { seat: first, candidates: [second] },
          writes: 'workspace',
          refine: review({ reviewers: [seat('beta-one', () => PASS_TEXT)], rounds: 1 }),
        },
      },
    });

    const result = await run(job, { cwd, onEvent, availability: store });
    expect(result.outcome.status).toBe('pass');
    // The seat waited for the first candidate's reset, not the later one,
    // and the step ran again on the candidate that came back.
    const waits = events.filter((event): event is Extract<LoopEvent, { kind: 'limit:wait' }> => event.kind === 'limit:wait');
    expect(waits).toHaveLength(1);
    expect(waits[0]!.code).toBe('QUOTA');
    expect(waits[0]!.resumeAt).toBeLessThanOrEqual(soon + 50);
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(0);
  });

  it('pauses a refined builder after one call each when every candidate dies on billing with no reset', async () => {
    const cwd = workDir();
    const callsA: string[] = [];
    const callsB: string[] = [];
    let reviews = 0;
    let judgeCalls = 0;
    const first = seat('alpha-one', (req) => {
      callsA.push(req.prompt);
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    }, ['Write']);
    const second = seat('alpha-two', (req) => {
      callsB.push(req.prompt);
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    }, ['Write']);
    const { events, onEvent } = collect();
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: { seat: first, candidates: [second] },
          writes: 'workspace',
          // An uncapped judge has no round budget to stop a retry: the
          // all-unavailable failure must end the rounds itself, or the
          // loop spends a call on each dead candidate again every round.
          refine: review({
            reviewers: [seat('beta-one', () => { reviews += 1; return PASS_TEXT; })],
            judge: judge(seat('judge-one', () => { judgeCalls += 1; return '{}'; })),
          }),
        },
      },
    });

    const result = await run(job, { cwd, onEvent });
    // No reset is known, so the seat pauses, as a single model out of
    // quota with no reset does.
    expect(result.outcome.status).toBe('paused');
    const node = (result.outcome.data as Record<string, Outcome> | undefined)?.['build'];
    expect(node?.status).toBe('paused');
    expect(node?.error?.code).toBe('QUOTA');
    expect(node?.error?.retryable).toBe(false);
    expect(node?.error?.resetAt).toBeUndefined();
    // One round of calls, then terminal: the reviewers and judge never ran.
    expect(callsA).toHaveLength(1);
    expect(callsB).toHaveLength(1);
    expect(reviews).toBe(0);
    expect(judgeCalls).toBe(0);
    expect(routeEvents(events)).toEqual([
      expect.objectContaining({ requested: targetOf(first), selected: targetOf(second), failure: 'billing' }),
      // The last candidate's death is the all-unavailable outcome: no
      // selected model.
      expect.objectContaining({ requested: targetOf(second), failure: 'billing' }),
    ]);
    expect(routeEvents(events)[1]).not.toHaveProperty('selected');

    // Under `onLimit: 'fail'` the same seat fails after one more call each:
    // the error is never retryable, so the rounds cannot run it again.
    const failed = await run(job, { cwd: workDir(), onLimit: 'fail' });
    expect(failed.outcome.status).toBe('fail');
    expect(callsA).toHaveLength(2);
    expect(callsB).toHaveLength(2);
    expect(reviews).toBe(0);
    expect(judgeCalls).toBe(0);
  });

  it('still refuses a recorded reviewer answer in the writer family when it came from a candidate', async () => {
    const cwd = workDir();
    const writer = seat('alpha-one', () => PASS_TEXT, ['Write']);
    const deadReviewer = seat('beta-one', () => {
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    });
    // The declared family is beta, but the engine reports an alpha answer:
    // what actually answered is checked, not what was selected.
    const lyingReviewer = seat('beta-two', () => ({ text: PASS_TEXT, model: 'alpha-nine' }));
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: writer,
          writes: 'workspace',
          refine: review({
            reviewers: [{ name: 'check', seat: { seat: deadReviewer, candidates: [lyingReviewer] } }],
            rounds: 1,
          }),
        },
      },
    });

    const result = await run(job, { cwd });
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.summary ?? '').toMatch(/recorded model family collision/);
  });

  it('refuses two reviewers that can resolve to the same family on different models', () => {
    // The first choices are distinct families (gamma, beta); reviewer a can
    // still resolve to beta through its candidate, and that combination is
    // refused.
    expect(() => review({
      reviewers: [
        { name: 'a', seat: { seat: seat('gamma-one', () => 'x'), candidates: [seat('beta-three', () => 'z')] } },
        { name: 'b', seat: seat('beta-two', () => 'y') },
      ],
      rounds: 1,
    })).toThrow(TypeError);
  });

  it('refuses a reviewer candidate that collides with the fixer', () => {
    const writer = seat('alpha-one', () => 'x', ['Write']);
    const reviewer = seat('gamma-one', () => 'y');
    const reviewerAlternate = seat('beta-one', () => 'z');
    const fixer = seat('beta-two', () => 'w', ['Write']);
    expect(() => dag({
      name: 'shape',
      nodes: {
        build: {
          agent: writer,
          writes: 'workspace',
          refine: review({
            reviewers: [{ name: 'check', seat: { seat: reviewer, candidates: [reviewerAlternate] } }],
            fixer,
            rounds: 1,
          }),
        },
      },
    })).toThrow(TypeError);
  });

  it('refuses a builder whose fallback would leave only its own family reviewing', () => {
    const builder = seat('alpha-one', () => 'x', ['Write']);
    const builderAlternate = seat('beta-one', () => 'y', ['Write']);
    const reviewer = seat('beta-two', () => 'z');
    expect(() => dag({
      name: 'shape',
      nodes: {
        build: {
          agent: { seat: builder, candidates: [builderAlternate] },
          writes: 'workspace',
          refine: review({ reviewers: [reviewer], rounds: 1 }),
        },
      },
    })).toThrow(TypeError);
  });

  it('refuses a reviewer whose candidates could leave it in the builder family', () => {
    const builder = seat('alpha-one', () => 'x', ['Write']);
    const reviewer = seat('beta-one', () => 'y');
    const sameFamilyAsBuilder = seat('alpha-two', () => 'z');
    expect(() => dag({
      name: 'shape',
      nodes: {
        build: {
          agent: builder,
          writes: 'workspace',
          refine: review({
            reviewers: [{ seat: reviewer, candidates: [sameFamilyAsBuilder] }],
            rounds: 1,
          }),
        },
      },
    })).toThrow(TypeError);
  });

  it('refuses a named reviewer whose candidates sit next to its name instead of on its seat', () => {
    const reviewer = seat('beta-one', () => 'x');
    const alternate = seat('beta-two', () => 'y');
    expect(() => review({
      reviewers: [{ name: 'check', seat: reviewer, candidates: [alternate] }],
      rounds: 1,
    })).toThrow(/seat: \{ seat, candidates \}/);
  });

  it('refuses an empty candidate list on a seat and on a reviewer', () => {
    const writer = seat('alpha-one', () => 'x', ['Write']);
    const reviewer = seat('beta-one', () => 'y');
    expect(() => dag({
      name: 'shape',
      nodes: { build: { agent: { seat: writer, candidates: [] }, writes: 'workspace' } },
    })).toThrow(TypeError);
    expect(() => review({
      reviewers: [{ name: 'check', seat: { seat: reviewer, candidates: [] } }],
      rounds: 1,
    })).toThrow(TypeError);
  });

  it('allows candidates that share the seat family', async () => {
    const cwd = workDir();
    const writer = seat('alpha-one', () => PASS_TEXT, ['Write']);
    const deadReviewer = seat('beta-one', () => {
      throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
    });
    // Same family as the seat it backs up: allowed inside one seat.
    const sameFamilyAlternate = seat('beta-two', () => PASS_TEXT);
    const job = dag({
      name: 'shape',
      nodes: {
        build: {
          agent: writer,
          writes: 'workspace',
          refine: review({
            reviewers: [{ seat: deadReviewer, candidates: [sameFamilyAlternate] }],
            rounds: 1,
          }),
        },
      },
    });
    const result = await run(job, { cwd });
    expect(result.outcome.status).toBe('pass');
  });
});
