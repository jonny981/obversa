import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  agentCheck,
  agentJob,
  always,
  commandJob,
  createCallbackClient,
  dag,
  EngineError,
  EngineIncompleteResultError,
  fallbackEngine,
  fnJob,
  judge,
  loop,
  person,
  revisionRequest,
  run,
  stage,
  workflow,
} from '../src/api.ts';
import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineStreamEvent,
  LoopEvent,
  TeamSeat,
  UsageReceipt,
} from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { assistantResult, engineSelection, reportedUsage } from '../src/runtime/result-parts.ts';
import { readResumeRecord } from '../src/runtime/persist.ts';
import { cleanupRepos, tmpRepo } from './git-helpers.ts';

type UsageEvent = Extract<EngineStreamEvent, { type: 'usage' }>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanupRepos();
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'record-improve-'));
  dirs.push(dir);
  return dir;
}

function readRecord(path: string): Array<LoopEvent & { session?: number }> {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function only<K extends LoopEvent['kind']>(events: readonly LoopEvent[], kind: K): Extract<LoopEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<LoopEvent, { kind: K }> => event.kind === kind);
}

/** An engine that reports exactly the usage, figure and billing it is given. */
function engine(model: string, usage: UsageReceipt, extra: Pick<UsageEvent, 'cost' | 'billing'> = {}, text = 'done'): Engine {
  return {
    name: `engine-${model}`,
    async run(_request, onEvent) {
      onEvent({ type: 'usage', usage, model, ...extra });
      return assistantResult({
        text,
        usage,
        requested: engineSelection({ adapter: 'test', model }),
        ...extra,
      });
    },
  };
}

const SONNET = 'claude-sonnet-4-5-20250929';
const MILLION_IN = reportedUsage({ inputTokens: 1_000_000, outputTokens: 100_000 });

describe('cost per call', () => {
  it('estimates from the shipped price table and names the entry it used', async () => {
    const events: LoopEvent[] = [];
    await run(agentJob({ label: 'write', prompt: 'go', engine: engine(SONNET, MILLION_IN) }), {
      onEvent: (event) => events.push(event),
    });
    const [usage] = only(events, 'engine:usage');
    // 1M input at $3 and 100k output at $15 per million tokens.
    expect(usage!.cost).toEqual({ kind: 'estimated', usd: 4.5, entry: 'claude-sonnet-4-5' });
    expect(usage!.billing).toBe('unknown');
  });

  it('prices cache writes and reads at their own rates', async () => {
    const events: LoopEvent[] = [];
    const usage = reportedUsage({
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheCreationInputTokens: 100_000,
      cacheReadInputTokens: 400_000,
    });
    await run(agentJob({ prompt: 'go', engine: engine(SONNET, usage) }), { onEvent: (event) => events.push(event) });
    // 500k fresh input at $3, 100k cache writes at $3.75, 400k cache reads at $0.30.
    expect(only(events, 'engine:usage')[0]!.cost).toEqual({ kind: 'estimated', usd: 1.995, entry: 'claude-sonnet-4-5' });
  });

  it('uses an overridden price from the run option', async () => {
    const events: LoopEvent[] = [];
    await run(agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }), {
      prices: { 'claude-sonnet-4-5': { inputPerMTokUsd: 6, outputPerMTokUsd: 30 } },
      onEvent: (event) => events.push(event),
    });
    expect(only(events, 'engine:usage')[0]!.cost).toEqual({ kind: 'estimated', usd: 9, entry: 'claude-sonnet-4-5' });
  });

  it('records unknown with no tokens, and with no price for the model', async () => {
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'calls',
      nodes: {
        silent: agentJob({ prompt: 'go', engine: engine(SONNET, { kind: 'unknown' }) }),
        unpriced: agentJob({ prompt: 'go', engine: engine('model-with-no-price', MILLION_IN) }),
      },
    }), { onEvent: (event) => events.push(event) });
    expect(only(events, 'engine:usage').map((event) => event.cost)).toEqual([{ kind: 'unknown' }, { kind: 'unknown' }]);
  });

  it('records unknown for a model the table does not list, even when a listed id starts its name', async () => {
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'calls',
      nodes: {
        unlisted: agentJob({ prompt: 'go', engine: engine('gpt-5.6-luna', MILLION_IN) }),
        dated: agentJob({ prompt: 'go', engine: engine('gpt-5-2025-08-07', MILLION_IN) }),
      },
    }), { onEvent: (event) => events.push(event) });
    expect(only(events, 'engine:usage').map((event) => [event.model, event.cost])).toEqual([
      ['gpt-5.6-luna', { kind: 'unknown' }],
      // 1M input at $1.25 and 100k output at $10 per million tokens.
      ['gpt-5-2025-08-07', { kind: 'estimated', usd: 2.25, entry: 'gpt-5' }],
    ]);
  });

  it('keeps a figure the engine reported, with its billing', async () => {
    const events: LoopEvent[] = [];
    await run(agentJob({
      prompt: 'go',
      engine: engine(SONNET, MILLION_IN, { cost: { kind: 'reported', usd: 0.25 }, billing: 'subscription' }),
    }), { onEvent: (event) => events.push(event) });
    expect(only(events, 'engine:usage')[0]).toMatchObject({ cost: { kind: 'reported', usd: 0.25 }, billing: 'subscription' });
  });

  it("puts the call's cost and billing on the engine's result as well as on its record event", async () => {
    const events: LoopEvent[] = [];
    const results: AgentResult[] = [];
    const call = (engineValue: Engine) => fnJob('call', async (ctx) => {
      results.push(await ctx.resolveEngine(engineValue).run({ prompt: 'go' } as AgentRequest, (event) => {
        if (event.type !== 'usage') return;
        ctx.emit({ kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: event.model, usage: event.usage, cost: event.cost, billing: event.billing });
      }, ctx.signal));
      return 'done';
    });
    await run(dag({
      name: 'calls',
      nodes: {
        priced: call(engine(SONNET, MILLION_IN)),
        silent: { needs: 'priced', job: call(engine(SONNET, { kind: 'unknown' })) },
        reported: { needs: 'silent', job: call(engine(SONNET, MILLION_IN, { cost: { kind: 'reported', usd: 0.25 }, billing: 'api' })) },
      },
    }), {
      prices: { 'claude-sonnet-4-5': { inputPerMTokUsd: 6, outputPerMTokUsd: 30 } },
      onEvent: (event) => events.push(event),
    });
    expect(results.map((result) => [result.cost, result.billing])).toEqual([
      [{ kind: 'estimated', usd: 9, entry: 'claude-sonnet-4-5' }, 'unknown'],
      [{ kind: 'unknown' }, 'unknown'],
      [{ kind: 'reported', usd: 0.25 }, 'api'],
    ]);
    expect(only(events, 'engine:usage').map((event) => [event.cost, event.billing])).toEqual(
      results.map((result) => [result.cost, result.billing]),
    );
  });

  it('records the cost and billing an engine gives only on its result', async () => {
    const events: LoopEvent[] = [];
    let result: AgentResult | undefined;
    const resultOnly: Engine = {
      name: 'result-only',
      async run(_request, onEvent) {
        onEvent({ type: 'usage', usage: MILLION_IN, model: SONNET });
        return assistantResult({
          text: 'done',
          usage: MILLION_IN,
          requested: engineSelection({ adapter: 'test', model: SONNET }),
          cost: { kind: 'reported', usd: 7 },
          billing: 'api',
        });
      },
    };
    await run(fnJob('call', async (ctx) => {
      result = await ctx.resolveEngine(resultOnly).run({ prompt: 'go' } as AgentRequest, (event) => {
        if (event.type !== 'usage') return;
        ctx.emit({ kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: event.model, usage: event.usage, cost: event.cost, billing: event.billing });
      }, ctx.signal);
      return 'done';
    }), { onEvent: (event) => events.push(event) });
    expect([result!.cost, result!.billing]).toEqual([{ kind: 'reported', usd: 7 }, 'api']);
    expect(only(events, 'engine:usage').map((event) => [event.cost, event.billing])).toEqual([
      [{ kind: 'reported', usd: 7 }, 'api'],
    ]);
  });
});

describe('totals', () => {
  it('run:end sums the calls and names the models with no figure', async () => {
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'calls',
      nodes: {
        estimated: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }),
        reported: agentJob({ prompt: 'go', engine: engine('other-model', MILLION_IN, { cost: { kind: 'reported', usd: 0.25 } }) }),
        silent: agentJob({ prompt: 'go', engine: engine('mystery', { kind: 'unknown' }) }),
        unpriced: agentJob({ prompt: 'go', engine: engine('no-price-model', MILLION_IN) }),
      },
    }), { onEvent: (event) => events.push(event) });
    const [end] = only(events, 'run:end');
    expect(end!.cost).toEqual({
      usd: 4.75,
      reportedUsd: 0.25,
      estimatedUsd: 4.5,
      unknownCalls: 2,
      unknownModels: ['mystery', 'no-price-model'],
    });
  });

  it('each dag:node done event carries its own tokens, cost and time', async () => {
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'calls',
      nodes: {
        first: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }),
        second: { needs: 'first', job: agentJob({ prompt: 'go', engine: engine('mystery', { kind: 'unknown' }) }) },
      },
    }), { onEvent: (event) => events.push(event) });
    const done = only(events, 'dag:node').filter((event) => event.phase === 'done');
    expect(done.find((event) => event.node === 'first')).toMatchObject({
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, unmeasuredCalls: 0 },
      cost: { usd: 4.5, estimatedUsd: 4.5, reportedUsd: 0, unknownCalls: 0, unknownModels: [] },
      durationMs: expect.any(Number),
    });
    expect(done.find((event) => event.node === 'second')).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, unmeasuredCalls: 1 },
      cost: { usd: 0, unknownCalls: 1, unknownModels: ['mystery'] },
    });
  });

  it('a review a judge accepts keeps the tokens, cost and time of its attempt on the pass that replaces its failure, through two resumes', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const events: LoopEvent[] = [];
    const judgeSeat: TeamSeat = {
      engine: new MockEngine(() => JSON.stringify({ stop_reason: { choice: 'holds' } })),
      identity: { adapter: 'mock', provider: 'mock', modelFamily: 'judge', model: 'judge', tools: [] },
    };
    let reviewRuns = 0;
    const job = dag({
      name: 'judged-review',
      maxKickbacks: { implement: judge(judgeSeat, { cap: 2 }) },
      nodes: {
        implement: fnJob('implement', () => 'built'),
        review: {
          needs: 'implement',
          acceptsKickbackTo: ['implement'],
          job: fnJob('review', async (ctx) => {
            reviewRuns += 1;
            ctx.emit({ kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: SONNET, usage: reportedUsage({ inputTokens: 10, outputTokens: 5 }), cost: { kind: 'reported', usd: 2 } });
            await new Promise((resolve) => setTimeout(resolve, 30));
            return revisionRequest({ target: 'implement', reason: 'a nit', findings: [{ evidence: 'x', severity: 'should-fix' }] });
          }),
        },
      },
    });
    const options = { recordTo, engine: 'mock', engines: { mock: new MockEngine(() => '') } };
    const { outcome } = await run(job, { ...options, onEvent: (event) => events.push(event) });
    expect(outcome.status).toBe('pass');
    const done = (from: LoopEvent[]) => only(from, 'dag:node').filter((event) => event.node === 'review' && event.phase === 'done');
    const reviews = done(events);
    expect(reviews.map((event) => event.outcome?.status)).toEqual(['fail', 'pass']);
    expect(reviews[1]!.attempt).toBe(reviews[0]!.attempt);
    for (const field of ['usage', 'cost', 'durationMs'] as const) expect(reviews[1]![field]).toEqual(reviews[0]![field]);
    expect(reviews[1]!).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 }, cost: { usd: 2 } });
    // Each resume skips the accepted review and repeats its figures.
    for (let resume = 0; resume < 2; resume += 1) {
      const resumed: LoopEvent[] = [];
      await run(job, { ...options, resume: true, onEvent: (event) => resumed.push(event) });
      expect(done(resumed)).toEqual([expect.objectContaining({
        usage: reviews[1]!.usage,
        cost: reviews[1]!.cost,
        durationMs: reviews[1]!.durationMs,
      })]);
    }
    expect(reviewRuns).toBe(1);
  });

  it('a dag a loop runs again gives each round its own node tokens and cost', async () => {
    const events: LoopEvent[] = [];
    let round = 0;
    await run(loop({
      name: 'again',
      body: dag({
        name: 'step',
        nodes: {
          work: fnJob('work', (ctx) => {
            round += 1;
            ctx.emit({
              kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: SONNET,
              usage: reportedUsage({ inputTokens: 100 * round, outputTokens: 0 }),
              cost: { kind: 'reported', usd: round },
            });
            return 'done';
          }),
        },
      }),
      until: always,
      review: fnJob('review', () => (round === 1 ? { status: 'fail', summary: 'again' } : 'fine')),
      max: 3,
    }), { onEvent: (event) => events.push(event) });
    const done = only(events, 'dag:node').filter((event) => event.phase === 'done');
    expect(done.map((event) => event.attempt)).toEqual([1, 1]);
    expect(done.map((event) => [event.usage?.inputTokens, event.cost?.usd])).toEqual([[100, 1], [200, 2]]);
  });

  it("a dag:node done event counts the engine calls of the node's when check", async () => {
    const events: LoopEvent[] = [];
    const verdict = JSON.stringify({ verdict: 'yes', confidence: 0.95, reason: 'ready' });
    await run(dag({
      name: 'gated',
      nodes: {
        work: {
          when: agentCheck({ question: 'Is it ready?', engine: engine(SONNET, MILLION_IN, {}, verdict) }),
          job: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }),
        },
      },
    }), { onEvent: (event) => events.push(event) });
    const done = only(events, 'dag:node').find((event) => event.phase === 'done');
    expect(done).toMatchObject({
      usage: { inputTokens: 2_000_000, outputTokens: 200_000 },
      cost: { usd: 9, estimatedUsd: 9, unknownCalls: 0 },
    });
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ usd: 9 });
  });

  it("a dag:node done event carries the totals of a when check that failed", async () => {
    const events: LoopEvent[] = [];
    const broken: Engine = {
      name: 'broken',
      async run() {
        throw new Error('the check could not run');
      },
    };
    await run(dag({
      name: 'gated',
      nodes: {
        work: {
          when: agentCheck({ question: 'Is it ready?', engine: broken }),
          job: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }),
        },
      },
    }), { onEvent: (event) => events.push(event) });
    const done = only(events, 'dag:node').find((event) => event.phase === 'done');
    expect(done).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, unmeasuredCalls: 1 },
      cost: { usd: 0, unknownCalls: 1 },
    });
    expect(done).not.toHaveProperty('durationMs');
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ unknownCalls: 1 });
  });

  it("run:end on a resumed run counts every session's calls once, at the figures they recorded", async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const job = workflow('paid', {
      brief: 'two paid stages',
      roles: {},
      stages: [
        stage('write', { fn: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }) }),
        stage('check', { fn: agentJob({ prompt: 'go', engine: engine('mystery', { kind: 'unknown' }) }) }),
      ],
    });
    const ends: LoopEvent[][] = [[], [], []];
    await run(job, { recordTo, onEvent: (event) => ends[0]!.push(event) });
    // A changed price applies to new calls only, never to calls already recorded.
    const prices = { 'claude-sonnet-4-5': { inputPerMTokUsd: 6, outputPerMTokUsd: 30 } };
    await run(job, { recordTo, resume: true, prices, onEvent: (event) => ends[1]!.push(event) });
    await run(job, { recordTo, resume: true, prices, onEvent: (event) => ends[2]!.push(event) });
    const expected = { usd: 4.5, reportedUsd: 0, estimatedUsd: 4.5, unknownCalls: 1, unknownModels: ['mystery'] };
    for (const events of ends) expect(only(events, 'run:end')[0]!.cost).toEqual(expected);
    expect(only(readRecord(recordTo), 'engine:usage')).toHaveLength(2);
  });

  it('a failed node a resume runs again carries the cost of its new attempt', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    let tries = 0;
    const job = dag({
      name: 'retry',
      nodes: {
        work: fnJob('work', (ctx) => {
          tries += 1;
          ctx.emit({
            kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: SONNET,
            usage: reportedUsage({ inputTokens: 100 * tries, outputTokens: 0 }),
            cost: { kind: 'reported', usd: tries },
          });
          return tries === 1 ? { status: 'fail', summary: 'not yet' } : 'done';
        }),
      },
    });
    await run(job, { recordTo });
    const events: LoopEvent[] = [];
    const { outcome } = await run(job, { recordTo, resume: true, onEvent: (event) => events.push(event) });
    expect(outcome.status).toBe('pass');
    const done = only(events, 'dag:node').filter((event) => event.phase === 'done');
    expect(done.map((event) => [event.outcome?.status, event.usage?.inputTokens, event.cost?.usd])).toEqual([['pass', 200, 2]]);
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ usd: 3 });
  });

  it("a finished node whose when check fails on a resume carries the check's cost, not the earlier attempt's", async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    let checks = 0;
    const check: Engine = {
      name: 'check',
      async run(_request, onEvent) {
        checks += 1;
        const usage = reportedUsage({ inputTokens: 10 * checks, outputTokens: 0 });
        onEvent({ type: 'usage', usage, model: SONNET, cost: { kind: 'reported', usd: checks } });
        if (checks > 1) throw new Error('the check could not run');
        return assistantResult({
          text: JSON.stringify({ verdict: 'yes', confidence: 0.95, reason: 'ready' }),
          usage,
          requested: engineSelection({ adapter: 'test', model: SONNET }),
          cost: { kind: 'reported', usd: checks },
        });
      },
    };
    const job = dag({
      name: 'gated',
      nodes: { work: { when: agentCheck({ question: 'Is it ready?', engine: check }), job: fnJob('work', () => 'done') } },
    });
    await run(job, { recordTo });
    const events: LoopEvent[] = [];
    const { outcome } = await run(job, { recordTo, resume: true, onEvent: (event) => events.push(event) });
    expect(outcome.status).toBe('fail');
    const done = only(events, 'dag:node').filter((event) => event.phase === 'done');
    expect(done.map((event) => [event.outcome?.status, event.usage?.inputTokens, event.cost?.usd])).toEqual([['fail', 20, 2]]);
    expect(done[0]).not.toHaveProperty('durationMs');
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ usd: 3 });
  });

  it('a finished node a resume skips keeps the tokens, cost and time of the attempt that finished it', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    let tries = 0;
    const work = fnJob('work', async (ctx) => {
      tries += 1;
      ctx.emit({
        kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: SONNET,
        usage: reportedUsage({ inputTokens: 100 * tries, outputTokens: 0 }),
        cost: { kind: 'reported', usd: tries },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 'done';
    });
    const first: LoopEvent[] = [];
    const second: LoopEvent[] = [];
    await run(dag({ name: 'reuse', nodes: { work } }), { recordTo, onEvent: (event) => first.push(event) });
    await run(dag({ name: 'reuse', nodes: { work } }), { recordTo, resume: true, onEvent: (event) => second.push(event) });
    expect(tries).toBe(1);
    const done = (events: LoopEvent[]) => only(events, 'dag:node').filter((event) => event.phase === 'done' && event.node === 'work');
    const [firstDone] = done(first);
    expect(done(second)).toEqual([expect.objectContaining({
      usage: firstDone!.usage,
      cost: firstDone!.cost,
      durationMs: firstDone!.durationMs,
    })]);
    expect(firstDone!.cost).toMatchObject({ usd: 1 });
    // A changed shape runs the node again, so its done carries only the new attempt.
    const third: LoopEvent[] = [];
    await run(dag({ name: 'reuse', nodes: { work, also: fnJob('also', () => 'done') } }), { recordTo, resume: true, onEvent: (event) => third.push(event) });
    expect(tries).toBe(2);
    expect(done(third).map((event) => [event.usage?.inputTokens, event.cost?.usd])).toEqual([[200, 2]]);
  });

  it('a node a kickback ran again, which a resume skips, keeps the tokens, cost and time of the run that passed', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    let builds = 0;
    let checks = 0;
    const job = dag({
      name: 'build-and-check',
      maxKickbacks: 1,
      nodes: {
        implement: fnJob('implement', async (ctx) => {
          builds += 1;
          ctx.emit({
            kind: 'engine:usage', ts: Date.now(), path: [...ctx.path], model: SONNET,
            usage: reportedUsage({ inputTokens: 100 * builds, outputTokens: 0 }),
            cost: { kind: 'reported', usd: builds },
          });
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'built';
        }),
        check: {
          needs: 'implement',
          acceptsKickbackTo: ['implement'],
          job: fnJob('check', () => (checks++ === 0
            ? revisionRequest({ target: 'implement', reason: 'red', findings: [{ evidence: 'add(2, 2) returned 0' }] })
            : 'green')),
        },
      },
    });
    const first: LoopEvent[] = [];
    const second: LoopEvent[] = [];
    await run(job, { recordTo, onEvent: (event) => first.push(event) });
    await run(job, { recordTo, resume: true, onEvent: (event) => second.push(event) });
    expect(builds).toBe(2);
    const done = (events: LoopEvent[]) => only(events, 'dag:node').filter((event) => event.phase === 'done' && event.node === 'implement');
    const passed = done(first).at(-1)!;
    expect(passed).toMatchObject({ attempt: 2, usage: { inputTokens: 200 }, cost: { usd: 2 } });
    expect(done(second)).toEqual([expect.objectContaining({
      usage: passed.usage,
      cost: passed.cost,
      durationMs: passed.durationMs,
    })]);
    // A second resume replays the skip and keeps the same figures.
    const third: LoopEvent[] = [];
    await run(job, { recordTo, resume: true, onEvent: (event) => third.push(event) });
    expect(done(third)).toEqual([expect.objectContaining({ usage: passed.usage, cost: passed.cost, durationMs: passed.durationMs })]);
  });

  it("run:end on a resumed run carries every session's tokens in totalUsage, and usage keeps this session's", async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const job = workflow('paid', {
      brief: 'two paid stages',
      roles: {},
      stages: [
        stage('write', { fn: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }) }),
        stage('check', { fn: agentJob({ prompt: 'go', engine: engine('mystery', { kind: 'unknown' }) }) }),
      ],
    });
    const first: LoopEvent[] = [];
    const second: LoopEvent[] = [];
    await run(job, { recordTo, onEvent: (event) => first.push(event) });
    await run(job, { recordTo, resume: true, onEvent: (event) => second.push(event) });
    const expected = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, unmeasuredCalls: 1 };
    expect(only(first, 'run:end')[0]!.totalUsage).toEqual(expected);
    const [end] = only(second, 'run:end');
    expect(end!.totalUsage).toEqual(expected);
    // The resumed session made no engine call of its own.
    expect(end!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('counts the engine calls of a merge the dag synthesises in the run and in the node that landed it', async () => {
    const repo = await tmpRepo();
    const paid = engine(SONNET, MILLION_IN, { cost: { kind: 'reported', usd: 1.5 }, billing: 'api' });
    const events: LoopEvent[] = [];
    const result = await run(dag({
      name: 'parallel',
      isolation: 'worktree',
      onConflict: 'synthesize',
      nodes: {
        left: fnJob('left', (ctx) => writeFileSync(join(ctx.workspace.dir, 'README.md'), 'left\n')),
        right: fnJob('right', (ctx) => writeFileSync(join(ctx.workspace.dir, 'README.md'), 'right\n')),
      },
    }), { cwd: repo, engine: paid, onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    // One call resolves the conflicted file, one writes the merge body.
    expect(only(events, 'engine:usage')).toEqual([
      expect.objectContaining({ model: SONNET, cost: { kind: 'reported', usd: 1.5 }, billing: 'api' }),
      expect.objectContaining({ model: SONNET, cost: { kind: 'reported', usd: 1.5 }, billing: 'api' }),
    ]);
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ usd: 3, reportedUsd: 3, unknownCalls: 0 });
    const done = only(events, 'dag:node').filter((event) => event.phase === 'done');
    expect(done.map((event) => event.cost?.usd).sort()).toEqual([0, 3]);
  });

  it('each loop:review event carries the tokens and cost of its own round', async () => {
    const events: LoopEvent[] = [];
    let reviews = 0;
    await run(loop({
      name: 'refine',
      body: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }),
      until: always,
      review: fnJob('review', () => (reviews++ === 0 ? { status: 'fail', summary: 'again' } : 'fine')),
      max: 3,
    }), { onEvent: (event) => events.push(event) });
    const rounds = only(events, 'loop:review');
    expect(rounds).toHaveLength(2);
    for (const round of rounds) {
      expect(round).toMatchObject({
        usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
        cost: { usd: 4.5, unknownCalls: 0 },
      });
    }
  });
  it('counts a failed call that reported no usage as one unknown call, with its model', async () => {
    const events: LoopEvent[] = [];
    const failing: Engine = {
      name: 'engine-failing',
      async run() { throw new Error('timed out before the result'); },
    };
    await run(dag({
      name: 'calls',
      nodes: {
        paid: agentJob({ prompt: 'go', engine: engine(SONNET, MILLION_IN) }),
        failed: agentJob({ prompt: 'go', model: 'claude-opus-4-5', engine: failing }),
      },
    }), { onEvent: (event) => events.push(event) });
    expect(only(events, 'engine:usage').filter((event) => event.usage.kind === 'unknown')).toEqual([
      expect.objectContaining({ model: 'claude-opus-4-5', cost: { kind: 'unknown' }, billing: 'unknown' }),
    ]);
    const [end] = only(events, 'run:end');
    expect(end!.cost).toEqual({ usd: 4.5, reportedUsd: 0, estimatedUsd: 4.5, unknownCalls: 1, unknownModels: ['claude-opus-4-5'] });
    expect(end!.usage).toMatchObject({ unmeasuredCalls: 1 });
  });

  it('a failed call keeps the usage it already reported and adds no unknown call', async () => {
    const events: LoopEvent[] = [];
    const failing: Engine = {
      name: 'engine-failing',
      async run(_request, onEvent) {
        onEvent({ type: 'usage', usage: MILLION_IN, model: SONNET });
        throw new Error('failed after reporting usage');
      },
    };
    await run(agentJob({ prompt: 'go', engine: failing }), { onEvent: (event) => events.push(event) });
    expect(only(events, 'engine:usage')).toEqual([expect.objectContaining({ usage: MILLION_IN, failed: true })]);
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ usd: 4.5, unknownCalls: 0 });
  });

  it('marks the usage a fallback lane reported before it failed, and still tries the next lane', async () => {
    const events: LoopEvent[] = [];
    const outOfQuota: Engine = {
      name: 'engine-out-of-quota',
      async run(_request, onEvent) {
        onEvent({ type: 'usage', usage: MILLION_IN, model: SONNET });
        throw new EngineError({ kind: 'quota', message: 'quota used up' });
      },
    };
    const result = await run(
      agentJob({ prompt: 'go', engine: fallbackEngine([outOfQuota, engine('mystery', { kind: 'unknown' })]) }),
      { onEvent: (event) => events.push(event) },
    );
    expect(result.outcome.status).toBe('pass');
    expect(only(events, 'engine:usage').map((event) => [event.model, event.usage.kind, event.failed])).toEqual([
      [SONNET, 'reported', true],
      ['mystery', 'unknown', undefined],
    ]);
  });

  it('counts the tokens a failed call reported toward the token budget', async () => {
    const spent = reportedUsage({ inputTokens: 1_000, outputTokens: 100 });
    const reportedThenFailed: Engine = {
      name: 'engine-reported-then-failed',
      async run(_request, onEvent) {
        onEvent({ type: 'usage', usage: spent, model: SONNET });
        throw new Error('failed after reporting usage');
      },
    };
    const incomplete: Engine = {
      name: 'engine-incomplete',
      async run() {
        throw new EngineIncompleteResultError('no final answer', {
          usage: spent,
          effective: engineSelection({ adapter: 'test', model: SONNET }),
        } as ConstructorParameters<typeof EngineIncompleteResultError>[1]);
      },
    };
    for (const failing of [reportedThenFailed, incomplete]) {
      let nextCalls = 0;
      const next: Engine = {
        name: 'engine-next',
        async run(request, onEvent, signal) {
          nextCalls += 1;
          return engine(SONNET, spent).run(request, onEvent, signal);
        },
      };
      await run(dag({
        name: 'probes',
        concurrency: 1,
        stopOnError: false,
        nodes: {
          first: agentJob({ prompt: 'go', engine: failing }),
          second: { needs: [], job: agentJob({ prompt: 'go', engine: next }) },
        },
      }), { budget: 100 });
      expect(nextCalls).toBe(0);
    }
  });

  it('restores the tokens of a failed call on resume, and leaves out a failed call with no tokens', () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const spent = reportedUsage({ inputTokens: 1_000, outputTokens: 100 });
    writeFileSync(recordTo, [
      { kind: 'run:start', ts: 1, path: [] },
      { kind: 'engine:usage', ts: 2, path: [], model: SONNET, usage: spent, failed: true },
      { kind: 'engine:usage', ts: 3, path: [], model: 'mystery', usage: { kind: 'unknown' }, failed: true },
      { kind: 'engine:usage', ts: 4, path: [], model: SONNET, usage: spent },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    expect(readResumeRecord(recordTo).receipts).toEqual([spent, spent]);
  });

  it('a writer lane that failed is counted but is not an answer a reviewer must differ from', async () => {
    const dir = workDir();
    const recordTo = join(dir, 'record.jsonl');
    const events: LoopEvent[] = [];
    const outOfQuota: Engine = {
      name: 'engine-out-of-quota',
      async run(_request, onEvent) {
        onEvent({ type: 'usage', usage: MILLION_IN, model: SONNET });
        throw new EngineError({ kind: 'quota', message: 'quota used up' });
      },
    };
    const gpt = engine('gpt-5', MILLION_IN, {}, JSON.stringify({ status: 'pass', summary: 'wrote it' }));
    const writer: Engine = {
      name: gpt.name,
      async run(request, onEvent, signal) {
        writeFileSync(join(request.cwd!, 'page.md'), 'page\n');
        return gpt.run(request, onEvent, signal);
      },
    };
    const reviewer = engine(SONNET, MILLION_IN, {}, JSON.stringify({ status: 'pass', summary: 'ok' }));
    const family = (engineValue: Engine, model: string, modelFamily: string, tools: readonly string[]): TeamSeat => ({
      engine: engineValue, identity: { adapter: 'mock', provider: 'mock', modelFamily, model, tools },
    });
    const result = await run(workflow('fallback-writer', {
      brief: 'Write the page.',
      roles: {
        writer: family(fallbackEngine([outOfQuota, writer]), 'gpt-5', 'gpt', ['Write']),
        reviewer: [family(reviewer, SONNET, 'claude', ['Read'])],
      },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer' })],
    }), { cwd: dir, recordTo, onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    expect(only(events, 'engine:usage').filter((event) => event.role === 'writer').map((event) => [event.model, event.failed])).toEqual([
      [SONNET, true],
      ['gpt-5', undefined],
    ]);
    // The failed Claude call, the GPT writer and the Claude reviewer: 4.5 + 2.25 + 4.5.
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ usd: 11.25, unknownCalls: 0 });
    const writerAnswers = [...readResumeRecord(recordTo).usage.values()].flat().filter((answer) => answer.role === 'writer');
    expect(writerAnswers.map((answer) => answer.model)).toEqual(['gpt-5']);
  });

  it('a rate-limited call is counted but does not stop a budgeted run from trying its fallback route', async () => {
    const events: LoopEvent[] = [];
    const limited: Engine = {
      name: 'engine-limited',
      async run() { throw new EngineError({ kind: 'rate-limit', message: '429 try later' }); },
    };
    const result = await run(agentJob({
      prompt: 'go',
      model: 'claude-opus-4-5',
      engine: limited,
      fallback: { engine: engine(SONNET, reportedUsage({ inputTokens: 10, outputTokens: 5 })) },
    }), { budget: 100_000, onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    expect(only(events, 'engine:usage').map((event) => [event.model, event.usage.kind, event.failed])).toEqual([
      ['claude-opus-4-5', 'unknown', true],
      [SONNET, 'reported', undefined],
    ]);
    expect(only(events, 'run:end')[0]!.cost).toMatchObject({ unknownCalls: 1, unknownModels: ['claude-opus-4-5'] });
  });

  it('records a failed fallback lane\'s usage while the next lane is still running', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const outOfQuota: Engine = {
      name: 'engine-out-of-quota',
      async run(_request, onEvent) {
        onEvent({ type: 'usage', usage: MILLION_IN, model: SONNET });
        throw new EngineError({ kind: 'quota', message: 'quota used up' });
      },
    };
    let seenMidCall: LoopEvent[] = [];
    const next: Engine = {
      name: 'engine-next',
      async run(request, onEvent, signal) {
        // The record as it stands if the process stopped during this call.
        seenMidCall = only(readRecord(recordTo), 'engine:usage');
        return engine(SONNET, MILLION_IN).run(request, onEvent, signal);
      },
    };
    await run(agentJob({ prompt: 'go', engine: fallbackEngine([outOfQuota, next]) }), { recordTo });
    expect(seenMidCall).toEqual([
      expect.objectContaining({
        usage: MILLION_IN,
        cost: { kind: 'estimated', usd: 4.5, entry: 'claude-sonnet-4-5' },
        billing: 'unknown',
        failed: true,
      }),
    ]);
    // Each call is counted once, the failed lane included.
    expect(only(readRecord(recordTo), 'engine:usage').map((event) => event.failed)).toEqual([true, undefined]);
    expect(only(readRecord(recordTo), 'run:end')[0]!.cost).toMatchObject({ usd: 9, unknownCalls: 0 });
  });

  it('counts each call a fallback chain makes, the failed ones included', async () => {
    const events: LoopEvent[] = [];
    const outOfQuota: Engine = {
      name: 'engine-out-of-quota',
      async run() { throw new EngineError({ kind: 'quota', message: 'quota used up' }); },
    };
    const result = await run(
      agentJob({ prompt: 'go', model: 'claude-opus-4-5', engine: fallbackEngine([outOfQuota, engine(SONNET, MILLION_IN)]) }),
      { onEvent: (event) => events.push(event) },
    );
    expect(result.outcome.status).toBe('pass');
    expect(only(events, 'engine:usage').map((event) => [event.model, event.cost, event.failed])).toEqual([
      ['claude-opus-4-5', { kind: 'unknown' }, true],
      [SONNET, { kind: 'estimated', usd: 4.5, entry: 'claude-sonnet-4-5' }, undefined],
    ]);
    expect(only(events, 'run:end')[0]!.cost).toEqual({
      usd: 4.5, reportedUsd: 0, estimatedUsd: 4.5, unknownCalls: 1, unknownModels: ['claude-opus-4-5'],
    });
  });

  it('a round whose person review a resume finishes keeps the cost of the build before the stop', async () => {
    const dir = workDir();
    const recordTo = join(dir, 'record.jsonl');
    const callbacks = createCallbackClient();
    const paid = engine(SONNET, MILLION_IN, {}, JSON.stringify({ status: 'pass', summary: 'wrote it' }));
    const writer: Engine = {
      name: paid.name,
      async run(request, onEvent, signal) {
        writeFileSync(join(request.cwd!, 'draft.md'), 'draft\n');
        return paid.run(request, onEvent, signal);
      },
    };
    const job = workflow('reviewed', {
      brief: 'Write a draft.',
      roles: { writer: seat(writer, SONNET, ['Write']), editor: person('Ready?', { interaction: { id: 'draft-review', responseSchema: { type: 'object' } } }) },
      stages: [stage('write', { agent: 'writer', writes: 'draft.md', reviewedBy: 'editor' })],
    });
    const first = await run(job, { cwd: dir, recordTo, callbacks });
    expect(first.outcome.status).toBe('paused');
    const [request] = await callbacks.listPending();
    const claim = await callbacks.claim(request!.requestId, 'person');
    if (!claim.ok) throw new Error(`claim refused: ${claim.kind}`);
    const submitted = await callbacks.submit(request!.requestId, claim.claimToken, 'person', request!.digest, { decision: 'approved', feedback: {}, prompt: 'Ready.' });
    expect(submitted.ok).toBe(true);
    const events: LoopEvent[] = [];
    const second = await run(job, { cwd: dir, recordTo, callbacks, resume: true, onEvent: (event) => events.push(event) });
    expect(second.outcome.status).toBe('pass');
    expect(only(events, 'loop:iteration')).toEqual([]);
    expect(only(events, 'loop:review')).toEqual([expect.objectContaining({
      usage: expect.objectContaining({ inputTokens: 1_000_000, outputTokens: 100_000 }),
      cost: expect.objectContaining({ usd: 4.5, unknownCalls: 0 }),
    })]);
    expect(only(events, 'dag:node').filter((event) => event.phase === 'done')).toEqual([expect.objectContaining({
      node: 'write',
      usage: expect.objectContaining({ inputTokens: 1_000_000, outputTokens: 100_000 }),
      cost: expect.objectContaining({ usd: 4.5, unknownCalls: 0 }),
    })]);
  });
});

describe('time per step', () => {
  it('job:end and dag:node done carry durationMs', async () => {
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'slow',
      nodes: { wait: fnJob('wait', () => new Promise((resolve) => setTimeout(resolve, 40))) },
    }), { onEvent: (event) => events.push(event) });
    expect(only(events, 'job:end')[0]!.durationMs).toBeGreaterThanOrEqual(35);
    const done = only(events, 'dag:node').find((event) => event.phase === 'done')!;
    expect(done.durationMs).toBeGreaterThanOrEqual(35);
  });

  it('gives a job and a nested job with the same label each its own durationMs', async () => {
    const events: LoopEvent[] = [];
    await run(workflow('nested', {
      brief: 'Do the work.',
      roles: {},
      stages: [stage('work', { fn: fnJob('work', () => 'done') })],
    }), { onEvent: (event) => events.push(event) });
    const ends = only(events, 'job:end').filter((event) => event.label === 'work');
    expect(ends).toHaveLength(2);
    for (const end of ends) expect(end.durationMs).toEqual(expect.any(Number));
  });
});

describe('the workflow version', () => {
  it('records the source file path and its SHA-256 on run:start', async () => {
    const dir = workDir();
    const file = join(dir, 'flow.ts');
    writeFileSync(file, 'export const flow = 1;\n');
    const sha256 = createHash('sha256').update('export const flow = 1;\n').digest('hex');
    for (const source of [pathToFileURL(file).href, file, pathToFileURL(file)]) {
      const events: LoopEvent[] = [];
      await run(fnJob('work', () => 'done'), { source, onEvent: (event) => events.push(event) });
      expect(only(events, 'run:start')[0]!.source).toEqual({ path: file, sha256 });
    }
  });

  it('refuses a source it cannot read', async () => {
    await expect(run(fnJob('work', () => 'done'), { source: join(workDir(), 'missing.ts') })).rejects.toThrow(/source/);
  });
});

describe('why a record has no run:end', () => {
  it('writes heartbeats at the set interval, and none at 0', async () => {
    const waiting = fnJob('wait', () => new Promise((resolve) => setTimeout(resolve, 140)));
    const recordTo = join(workDir(), 'record.jsonl');
    await run(waiting, { recordTo, heartbeatMs: 30 });
    const beats = readRecord(recordTo).filter((event) => event.kind === 'heartbeat');
    // A slow machine spends longer in the run and writes more beats, so the
    // test bounds the count from below and the gap between beats.
    expect(beats.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < beats.length; index += 1) {
      expect(beats[index]!.ts - beats[index - 1]!.ts).toBeGreaterThanOrEqual(25);
    }
    expect(readRecord(recordTo).at(-1)!.kind).toBe('run:end');

    await run(waiting, { recordTo, heartbeatMs: 0 });
    expect(readRecord(recordTo).filter((event) => event.kind === 'heartbeat')).toHaveLength(0);
    await run(waiting, { recordTo });
    expect(readRecord(recordTo).filter((event) => event.kind === 'heartbeat')).toHaveLength(0);
  });

  it('writes run:abort with the signal when a host also listens for it', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const controller = new AbortController();
    const host = () => controller.abort();
    const listeners = process.listenerCount('SIGTERM');
    process.on('SIGTERM', host);
    try {
      let started!: () => void;
      const running = new Promise<void>((resolve) => { started = resolve; });
      const job = fnJob('wait', async (ctx) => {
        started();
        await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      });
      const result = run(job, { recordTo, signal: controller.signal });
      await running;
      process.emit('SIGTERM', 'SIGTERM');
      await result;
    } finally {
      process.off('SIGTERM', host);
    }
    const kinds = readRecord(recordTo).map((event) => event.kind);
    expect(readRecord(recordTo).find((event) => event.kind === 'run:abort')).toMatchObject({ signal: 'SIGTERM' });
    expect(kinds.indexOf('run:abort')).toBeLessThan(kinds.indexOf('run:end'));
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  });

  it('a SIGTERM to a run with no other listener writes run:abort and still stops the process', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const child = fork(fileURLToPath(new URL('./run-abort-fixture.ts', import.meta.url)), [recordTo], {
      execArgv: ['--import', import.meta.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    await new Promise<void>((resolve) => child.once('message', () => resolve()));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
    const record = readRecord(recordTo);
    expect(record.at(-1)).toMatchObject({ kind: 'run:abort', signal: 'SIGTERM', path: [] });
    expect(record.some((event) => event.kind === 'run:end')).toBe(false);
  }, 30_000);
});

describe('a red check', () => {
  it('a commandJob outcome carries its command, arguments, exit code and duration, pass or fail', async () => {
    const node = process.execPath;
    const red = await run(commandJob('test', [node, '-e', 'process.exit(3)']));
    expect(red.outcome.command).toEqual({ command: node, args: ['-e', 'process.exit(3)'], exitCode: 3, durationMs: expect.any(Number) });
    const green = await run(commandJob('test', [node, '-e', '0']));
    expect(green.outcome.command).toMatchObject({ command: node, args: ['-e', '0'], exitCode: 0 });
  });

  it('keeps the command in a compact record', async () => {
    const dir = workDir();
    const result = await run(commandJob('test', [process.execPath, '-e', 'process.exit(2)']), { cwd: dir, recordTo: 'auto' });
    const end = readRecord(result.recordPath!).find((event) => event.kind === 'job:end') as Extract<LoopEvent, { kind: 'job:end' }>;
    expect(end.outcome.command).toMatchObject({ exitCode: 2, args: ['-e', 'process.exit(2)'] });
  });
});

describe('sessions', () => {
  it('numbers each session of a record and stamps every event with it', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    const job = workflow('two', {
      brief: 'two stages',
      roles: {},
      stages: [stage('first', { fn: fnJob('first', () => 'done') }), stage('second', { fn: fnJob('second', () => 'done') })],
    });
    await run(job, { recordTo });
    await run(job, { recordTo, resume: true });
    await run(job, { recordTo, resume: true });
    const record = readRecord(recordTo);
    expect(only(record, 'run:start').map((event) => event.session)).toEqual([1, 2, 3]);
    let session = 0;
    for (const event of record) {
      if (event.kind === 'run:start') session += 1;
      expect(event.session).toBe(session);
    }
  });

  it('starts a fresh record at session 1', async () => {
    const recordTo = join(workDir(), 'record.jsonl');
    await run(fnJob('work', () => 'done'), { recordTo });
    await run(fnJob('work', () => 'done'), { recordTo });
    expect(only(readRecord(recordTo), 'run:start').map((event) => event.session)).toEqual([1]);
  });
});

function seat(engineValue: Engine, model: string, tools: readonly string[] = []): TeamSeat {
  return { engine: engineValue, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}

/** A judge that acts on a finding marked REAL and skips the rest. */
function actOnReal(prompt: string) {
  const { questions } = JSON.parse(prompt) as { questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
  const answers: Record<string, unknown> = { stop_reason: { choice: 'continue' } };
  for (const [key, question] of Object.entries(questions)) {
    if (!('act' in question.criteria)) continue;
    answers[key] = question.instructions.includes('REAL')
      ? { choice: 'act', reason: 'a reader would stumble' }
      : { choice: 'skip', reason: 'taste' };
  }
  return answers;
}

describe('what each round changed', () => {
  it('records the files, lines and answered finding ids of each build round of a refine loop', async () => {
    const repo = await tmpRepo();
    const recordTo = join(repo, '.obversa', 'records', 'refine.jsonl');
    let round = 0;
    const writer = new MockEngine((request: AgentRequest) => {
      round += 1;
      writeFileSync(join(request.cwd!, 'page.md'), round === 1 ? 'one\ntwo\n' : 'one\nthree\nfour\n');
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    let reviews = 0;
    const reviewer = new MockEngine(() => JSON.stringify(reviews++ === 0
      ? { status: 'revise', summary: 'two findings', findings: [{ severity: 'nice-to-have', evidence: 'taste: warmer tone' }, { severity: 'should-fix', evidence: 'REAL: no audience named' }] }
      : { status: 'pass', summary: 'fine' }));
    const judgeEngine = new MockEngine((request) => JSON.stringify(actOnReal(request.prompt)));
    const job = workflow('refine', {
      brief: 'Use case: a reader gets a short page.\n\nWrite the page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine: judge(seat(judgeEngine, 'judge-mock')) })],
    });
    const events: LoopEvent[] = [];
    const result = await run(job, { cwd: repo, recordTo, onEvent: (event) => events.push(event) });
    expect(result.outcome.status).toBe('pass');
    const changes = only(events, 'round:change');
    expect(changes).toEqual([
      expect.objectContaining({ round: 1, files: [{ path: 'page.md', added: 2, removed: 0 }], added: 2, removed: 0, findings: [] }),
      expect.objectContaining({ round: 2, files: [{ path: 'page.md', added: 2, removed: 1 }], added: 2, removed: 1, findings: ['finding-2'] }),
    ]);
    // The ids are the ones the judge's own event used for the same findings.
    const judged = only(events, 'refine:judge')[0]!;
    expect(judged.findings?.filter((finding) => finding.decision === 'act').map((finding) => finding.id)).toEqual(['finding-2']);
  });

  it('records the change of a node a dag kickback ran again, with the findings it answered', async () => {
    const repo = await tmpRepo();
    let builds = 0;
    let checks = 0;
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'build-and-check',
      maxKickbacks: 1,
      nodes: {
        implement: fnJob('implement', (ctx) => {
          builds += 1;
          writeFileSync(join(ctx.workspace.dir, 'add.js'), builds === 1 ? 'return 0\n' : 'return a + b\n');
        }),
        check: {
          needs: 'implement',
          acceptsKickbackTo: ['implement'],
          job: fnJob('check', () => (checks++ === 0
            ? revisionRequest({ target: 'implement', reason: 'red', findings: [{ evidence: 'add(2, 2) returned 0' }] })
            : 'green')),
        },
      },
    }), { cwd: repo, onEvent: (event) => events.push(event) });
    const changes = only(events, 'round:change');
    expect(changes).toEqual([
      expect.objectContaining({ node: 'implement', round: 2, files: [{ path: 'add.js', added: 1, removed: 1 }], findings: ['finding-1'] }),
      expect.objectContaining({ node: 'check', round: 2, files: [], findings: [] }),
    ]);
  });

  it('records the change of an isolated node a kickback ran again, when that run fails', async () => {
    const repo = await tmpRepo();
    let builds = 0;
    let checks = 0;
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'build-and-check',
      isolation: 'worktree',
      maxKickbacks: 1,
      nodes: {
        implement: fnJob('implement', (ctx) => {
          builds += 1;
          writeFileSync(join(ctx.workspace.dir, 'add.js'), builds === 1 ? 'return 0\n' : 'return a + b\n');
          return builds === 1 ? 'built' : { status: 'fail', summary: 'still red' };
        }),
        check: {
          needs: 'implement',
          acceptsKickbackTo: ['implement'],
          job: fnJob('check', () => (checks++ === 0
            ? revisionRequest({ target: 'implement', reason: 'red', findings: [{ evidence: 'add(2, 2) returned 0' }] })
            : 'green')),
        },
      },
    }), { cwd: repo, onEvent: (event) => events.push(event) });
    expect(builds).toBe(2);
    expect(only(events, 'round:change').filter((event) => event.node === 'implement')).toEqual([
      expect.objectContaining({ round: 2, files: [{ path: 'add.js', added: 1, removed: 1 }], added: 1, removed: 1, findings: ['finding-1'] }),
    ]);
  });

  it('records the change of a node a kickback ran again, when that run edits files and then throws', async () => {
    const repo = await tmpRepo();
    let builds = 0;
    let checks = 0;
    const events: LoopEvent[] = [];
    await run(dag({
      name: 'build-and-check',
      maxKickbacks: 1,
      nodes: {
        implement: async (ctx) => {
          builds += 1;
          writeFileSync(join(ctx.workspace.dir, 'add.js'), builds === 1 ? 'return 0\n' : 'return a + b\n');
          if (builds === 2) throw new Error('crashed after the edit');
          return { status: 'pass', summary: 'built' };
        },
        check: {
          needs: 'implement',
          acceptsKickbackTo: ['implement'],
          job: fnJob('check', () => (checks++ === 0
            ? revisionRequest({ target: 'implement', reason: 'red', findings: [{ evidence: 'add(2, 2) returned 0' }] })
            : 'green')),
        },
      },
    }), { cwd: repo, onEvent: (event) => events.push(event) });
    expect(builds).toBe(2);
    expect(only(events, 'round:change').filter((event) => event.node === 'implement')).toEqual([
      expect.objectContaining({ round: 2, files: [{ path: 'add.js', added: 1, removed: 1 }], findings: ['finding-1'] }),
    ]);
  });

  it('records nothing outside a git repository', async () => {
    const events: LoopEvent[] = [];
    let reviews = 0;
    await run(workflow('plain', {
      brief: 'Write the page.',
      roles: {
        writer: seat(new MockEngine((request) => {
          writeFileSync(join(request.cwd!, 'page.md'), 'x\n');
          return JSON.stringify({ status: 'pass', summary: 'wrote it' });
        }), 'writer-mock', ['Write']),
        reviewer: [seat(new MockEngine(() => JSON.stringify(reviews++ === 0 ? { status: 'revise', summary: 'no', findings: [{ evidence: 'fix' }] } : { status: 'pass', summary: 'ok' })), 'reviewer-mock', ['Read'])],
      },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer' })],
    }), { cwd: workDir(), onEvent: (event) => events.push(event) });
    expect(only(events, 'round:change')).toHaveLength(0);
  });
});
