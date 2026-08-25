import { describe, it, expect, afterAll } from 'vitest';

import {
  run,
  loop,
  dag,
  fnJob,
  agentJob,
  agentCheck,
  withEnv,
  commandSucceeds,
  jobMeta,
  LoopError,
} from '../src/api.ts';
import type {
  AgentRequest,
  Condition,
  ConditionResult,
  Job,
  LoopEvent,
  RunOptions,
} from '../src/api.ts';
import { MockEngine, MockEnvironment } from '../src/testing.ts';
import { tmpRepo, write, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: () => new MockEngine(() => '') },
};

/** A loop that only converges when the sh gate sees the expected env. */
const gatedOn = (test: string, opts?: { env?: Record<string, string> }): Job =>
  loop({
    name: 'gated',
    body: fnJob('work', async () => ({ status: 'fail' })),
    until: commandSucceeds('sh', ['-c', test], opts),
    max: 2,
  });

describe('withEnv + deterministic gate', () => {
  it('pins vars for the gate command under the wrapped subtree', async () => {
    const repo = await tmpRepo();
    const job = withEnv(
      { TEST_WAVE3: 'pinned' },
      gatedOn('test "$TEST_WAVE3" = pinned'),
    );
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
  });

  it('without withEnv the same gate cannot pass (negative control)', async () => {
    const repo = await tmpRepo();
    const { outcome } = await run(gatedOn('test "$TEST_WAVE3" = pinned'), {
      ...base,
      cwd: repo,
    });
    expect(outcome.status).toBe('exhausted'); // gate never opens, hits max
  });
});

describe('precedence (most specific wins)', () => {
  it('the overlay wins over the environment vars', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment({ env: { TEST_WAVE3_K: 'env' } });
    const job = withEnv(
      { TEST_WAVE3_K: 'overlay' },
      gatedOn('test "$TEST_WAVE3_K" = overlay'),
    );
    const { outcome } = await run(job, {
      ...base,
      cwd: repo,
      environment: envir,
    });
    expect(outcome.status).toBe('pass');
  });

  it('per-call opts.env wins over the overlay (three-layer proof)', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment({ env: { TEST_WAVE3_K: 'env' } });
    const job = withEnv(
      { TEST_WAVE3_K: 'overlay' },
      gatedOn('test "$TEST_WAVE3_K" = call', {
        env: { TEST_WAVE3_K: 'call' },
      }),
    );
    const { outcome } = await run(job, {
      ...base,
      cwd: repo,
      environment: envir,
    });
    expect(outcome.status).toBe('pass');
  });

  it('nested withEnv merges inner-over-outer', async () => {
    const repo = await tmpRepo();
    const job = withEnv(
      { TEST_WAVE3_A: 'outer', TEST_WAVE3_B: 'outer' },
      withEnv(
        { TEST_WAVE3_B: 'inner' },
        gatedOn('test "$TEST_WAVE3_A" = outer && test "$TEST_WAVE3_B" = inner'),
      ),
    );
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
  });
});

describe('subtree reach', () => {
  it('reaches a dag node beneath the wrapper', async () => {
    const repo = await tmpRepo();
    let seen: Record<string, string> | undefined;
    const graph = dag({
      name: 'g',
      nodes: {
        probe: fnJob('probe', async (ctx) => {
          seen = ctx.envOverlay;
          return { status: 'pass' };
        }),
      },
    });
    const { outcome } = await run(withEnv({ TEST_WAVE3: 'pinned' }, graph), {
      ...base,
      cwd: repo,
    });
    expect(outcome.status).toBe('pass');
    expect(seen).toEqual({ TEST_WAVE3: 'pinned' });
  });

  it('survives the worktree boundary where a per-team environment replaces ctx.environment', async () => {
    const repo = await tmpRepo();
    const envir = new MockEnvironment(); // url derived from ws.branch
    let seenOverlay: string | undefined;
    let seenUrl: string | undefined;
    const graph = dag({
      name: 'fan',
      isolation: 'worktree',
      environment: envir,
      nodes: {
        api: fnJob('api', async (ctx) => {
          seenOverlay = ctx.envOverlay?.LINES_WAVE3;
          seenUrl = ctx.environment?.url;
          write(ctx.workspace.dir, 'api.ts', 'x\n');
          return { status: 'pass' };
        }),
      },
    });
    const { outcome } = await run(withEnv({ LINES_WAVE3: 'pinned' }, graph), {
      ...base,
      cwd: repo,
    });
    expect(outcome.status).toBe('pass');
    expect(seenUrl).toContain('lines/fan-api'); // the per-team env DID replace
    expect(seenOverlay).toBe('pinned'); // the pinning survived the swap
  });
});

describe('agentJob request env', () => {
  it('merges environment + overlay + config.env into req.env, most specific winning', async () => {
    const repo = await tmpRepo();
    const reqs: AgentRequest[] = [];
    const capture = new MockEngine((req) => {
      reqs.push(req);
      return 'ok';
    });
    const envir = new MockEnvironment({
      env: { TEST_WAVE3_K: 'env', TEST_WAVE3_E: 'env' },
    });
    const job = agentJob({
      label: 'leaf',
      prompt: 'do it',
      env: { TEST_WAVE3_K: 'call', TEST_WAVE3_L: 'leaf' },
    });
    const { outcome } = await run(
      withEnv({ TEST_WAVE3_K: 'overlay', TEST_WAVE3_O: 'overlay' }, job),
      { engine: 'mock', engines: { mock: () => capture }, cwd: repo, environment: envir },
    );
    expect(outcome.status).toBe('pass');
    // MockEnvironment also injects BASE_URL alongside its configured vars.
    expect(reqs[0]?.env).toMatchObject({
      TEST_WAVE3_K: 'call',
      TEST_WAVE3_E: 'env',
      TEST_WAVE3_O: 'overlay',
      TEST_WAVE3_L: 'leaf',
    });
  });

  it("scrubs the injected env values from the reply's outcome (summary + data)", async () => {
    const repo = await tmpRepo();
    const events: LoopEvent[] = [];
    // The agent echoes the credential it was handed — the most likely leak.
    const echo = new MockEngine(
      (req) => `connected using ${req.env?.TEST_WAVE3_CRED}, done`,
    );
    const { outcome } = await run(
      withEnv(
        { TEST_WAVE3_CRED: 'postgres://app:S3cretPw@db/prod' },
        agentJob({ label: 'leaf', prompt: 'migrate' }),
      ),
      {
        engine: 'mock',
        engines: { mock: () => echo },
        cwd: repo,
        onEvent: (e) => events.push(e),
      },
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('[redacted]');
    expect(outcome.summary).not.toContain('S3cretPw');
    expect(outcome.data).not.toContain('S3cretPw');
    // The job:end event (what the supervisor persists) is clean too.
    const end = events.find((e) => e.kind === 'job:end');
    expect(JSON.stringify(end)).not.toContain('S3cretPw');
  });

  it('req.env stays undefined when nothing is configured (no {} regression)', async () => {
    const repo = await tmpRepo();
    const reqs: AgentRequest[] = [];
    const capture = new MockEngine((req) => {
      reqs.push(req);
      return 'ok';
    });
    const { outcome } = await run(agentJob({ label: 'leaf', prompt: 'x' }), {
      engine: 'mock',
      engines: { mock: () => capture },
      cwd: repo,
    });
    expect(outcome.status).toBe('pass');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.env).toBeUndefined();
  });
});

describe('agentCheck judge request env', () => {
  it('carries the environment + overlay merge to the judge engine', async () => {
    const repo = await tmpRepo();
    const reqs: AgentRequest[] = [];
    const judge = new MockEngine((req) => {
      reqs.push(req);
      return JSON.stringify({ verdict: 'yes', confidence: 0.95, reason: 'ok' });
    });
    const envir = new MockEnvironment({ env: { TEST_WAVE3_E: 'env' } });
    const job = withEnv(
      { TEST_WAVE3_O: 'overlay' },
      loop({
        name: 'judged',
        body: fnJob('work', async () => ({ status: 'pass' })),
        until: agentCheck({ question: 'done?' }),
        max: 2,
      }),
    );
    const { outcome } = await run(job, {
      engine: 'mock',
      engines: { mock: () => judge },
      cwd: repo,
      environment: envir,
    });
    expect(outcome.status).toBe('pass');
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs[0]?.env).toMatchObject({
      TEST_WAVE3_E: 'env',
      TEST_WAVE3_O: 'overlay',
    });
  });
});

describe('captured output scrubbing', () => {
  /** Run a one-iteration loop under `withEnv` and capture the until gate's result. */
  const gateResult = async (
    overlay: Record<string, string>,
    until: Condition,
  ): Promise<ConditionResult | undefined> => {
    const repo = await tmpRepo();
    let result: ConditionResult | undefined;
    await run(
      withEnv(
        overlay,
        loop({
          name: 'leak',
          body: fnJob('work', async () => ({ status: 'fail' })),
          until,
          max: 1,
        }),
      ),
      {
        ...base,
        cwd: repo,
        onEvent: (e: LoopEvent) => {
          if (e.kind === 'loop:condition' && e.which === 'until') result = e.result;
        },
      },
    );
    return result;
  };

  it('scrubs pinned values the shape patterns cannot catch from gate output', async () => {
    // The var name is not secret-ish and the value carries no key=value shape,
    // so only the exact-value scrub can catch a failing command echoing it.
    const r = await gateResult(
      { TEST_WAVE3_DB: 'postgres://app:sw0rdfish9@db/prod' },
      commandSucceeds('sh', ['-c', 'echo "conn: $TEST_WAVE3_DB"; exit 1']),
    );
    expect(r?.met).toBe(false);
    expect(r?.output).toContain('[redacted]');
    expect(r?.output).not.toContain('sw0rdfish9');
  });

  it('leaves credential-free http URLs and short values readable', async () => {
    const r = await gateResult(
      { TEST_WAVE3_URL: 'http://localhost:3456', TEST_WAVE3_PORT: '3456' },
      commandSucceeds('sh', [
        '-c',
        'echo "url: $TEST_WAVE3_URL port: $TEST_WAVE3_PORT"; exit 1',
      ]),
    );
    expect(r?.output).toContain('url: http://localhost:3456');
    expect(r?.output).toContain('port: 3456');
  });

  it('scrubs pinned values a judge echoes before they reach reason/output', async () => {
    const repo = await tmpRepo();
    const judge = new MockEngine((req) =>
      JSON.stringify({
        verdict: 'no',
        confidence: 0.1,
        reason: `saw ${req.env?.TEST_WAVE3_T}`,
      }),
    );
    let result: ConditionResult | undefined;
    await run(
      withEnv(
        { TEST_WAVE3_T: 'hex-t0k3n-deadbeef' },
        loop({
          name: 'judged',
          body: fnJob('work', async () => ({ status: 'pass' })),
          until: agentCheck({ question: 'done?' }),
          max: 1,
        }),
      ),
      {
        engine: 'mock',
        engines: { mock: () => judge },
        cwd: repo,
        onEvent: (e: LoopEvent) => {
          if (e.kind === 'loop:condition' && e.which === 'until') result = e.result;
        },
      },
    );
    expect(result?.reason).toContain('[redacted]');
    expect(result?.reason).not.toContain('hex-t0k3n-deadbeef');
    expect(result?.output).not.toContain('hex-t0k3n-deadbeef');
  });
});

describe('withEnv construction', () => {
  it('throws CONFIG on a non-string value', () => {
    const inner = fnJob('x', async () => ({ status: 'pass' }));
    let thrown: unknown;
    try {
      withEnv({ PORT: 3000 as unknown as string }, inner);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LoopError);
    expect((thrown as LoopError).code).toBe('CONFIG');
    expect(() =>
      withEnv({ MISSING: undefined as unknown as string }, inner),
    ).toThrowError(/must be a string/);
  });

  it('throws CONFIG on an invalid key (empty, or containing "=")', () => {
    const inner = fnJob('x', async () => ({ status: 'pass' }));
    expect(() => withEnv({ '': 'v' }, inner)).toThrowError(
      /not a valid env var name/,
    );
    // 'SAFE=PATH' would produce the envp entry 'SAFE=PATH=v' — variable SAFE,
    // not the one the caller named.
    expect(() => withEnv({ 'SAFE=PATH': 'v' }, inner)).toThrowError(
      /not a valid env var name/,
    );
  });

  it('carries a key named __proto__ through to the merged request env', async () => {
    const repo = await tmpRepo();
    const reqs: AgentRequest[] = [];
    const capture = new MockEngine((req) => {
      reqs.push(req);
      return 'ok';
    });
    // A JSON-sourced overlay can carry an own '__proto__' data property; a
    // plain-object accumulator would silently drop it (inherited accessor).
    const overlay = JSON.parse(
      '{"__proto__":"kept","TEST_WAVE3_P":"ok"}',
    ) as Record<string, string>;
    const { outcome } = await run(
      withEnv(overlay, agentJob({ label: 'leaf', prompt: 'x' })),
      { engine: 'mock', engines: { mock: () => capture }, cwd: repo },
    );
    expect(outcome.status).toBe('pass');
    expect(reqs[0]?.env?.TEST_WAVE3_P).toBe('ok');
    expect(reqs[0]?.env?.['__proto__']).toBe('kept');
  });

  it('passes the wrapped job meta through, so describe/validate see the inner shape', () => {
    const inner = loop({
      name: 'shape',
      body: fnJob('x', async () => ({ status: 'pass' })),
      until: () => true,
      max: 1,
    });
    const wrapped = withEnv({}, inner);
    expect(jobMeta(wrapped)).toBe(jobMeta(inner));
    expect(jobMeta(wrapped)?.kind).toBe('loop');
  });
});
