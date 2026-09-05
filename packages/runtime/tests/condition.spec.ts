import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import {
  run,
  loop,
  fnJob,
  agentCheck,
  gateJob,
  quorum,
  commandSucceeds,
  not,
  all,
  any,
} from '../src/api.ts';
import type {
  AgentRequest,
  Condition,
  ConditionResult,
  JobContext,
  LoopEvent,
  RunOptions,
} from '../src/api.ts';
import { MockEngine, mockVerdict } from '../src/testing.ts';

// A mock engine that is never expected to be called — lets engine-free
// conditions (predicates, quorum-of-predicates, commandSucceeds) run without
// constructing a real backend.
const noEngine: RunOptions = {
  engine: 'mock',
  engines: { mock: mockVerdict('no', 0) },
};

const withVerdict = (v: 'yes' | 'no', c: number): RunOptions => ({
  engine: 'mock',
  engines: { mock: mockVerdict(v, c) },
});

const failingBody = () =>
  fnJob('b', async () => ({ status: 'fail' as const, summary: 'work' }));

describe('conditions', () => {
  it('agentCheck opens the gate above threshold', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: agentCheck({ question: 'done?', threshold: 0.8 }),
        max: 5,
      }),
      withVerdict('yes', 0.9),
    );
    expect(outcome.status).toBe('pass');
  });

  it('agentCheck keeps looping below threshold', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: agentCheck({ question: 'done?', threshold: 0.8 }),
        max: 3,
      }),
      withVerdict('yes', 0.5),
    );
    expect(outcome.status).toBe('exhausted');
  });

  const withText = (text: string): RunOptions => ({
    engine: 'mock',
    engines: { mock: new MockEngine(() => text) },
  });

  it('agentCheck (confidenceTag) opens at/above the % threshold and carries findings', async () => {
    const { outcome } = await run(
      gateJob('review', agentCheck({ confidenceTag: true, question: 'sound?', threshold: 0.8 })),
      withText('store.mjs reuses a freed id at line 4.\n<confidence>90%</confidence>'),
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('90%');
    expect(outcome.summary).toContain('reuses a freed id'); // findings reach the gate reason
  });

  it('agentCheck (confidenceTag) stays closed below the threshold', async () => {
    const { outcome } = await run(
      gateJob('review', agentCheck({ confidenceTag: true, question: 'sound?', threshold: 0.8 })),
      withText('A concrete concern remains at line 9.\n<confidence>60%</confidence>'),
    );
    expect(outcome.status).toBe('fail');
  });

  it('agentCheck (confidenceTag) fails closed when the tag is missing', async () => {
    const { outcome } = await run(
      gateJob('review', agentCheck({ confidenceTag: true, question: 'sound?', threshold: 0.8 })),
      withText('Looks fine to me but I forgot to rate it.'),
    );
    expect(outcome.status).toBe('fail');
  });

  it('accepts one-or-many mixed conditions (predicate + agentCheck)', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        // a bare predicate AND an agent check — both must hold (default `all`)
        until: [() => true, agentCheck({ question: 'done?', threshold: 0.8 })],
        max: 5,
      }),
      withVerdict('yes', 0.95),
    );
    expect(outcome.status).toBe('pass');
  });

  it('one-or-many short-circuits when a deterministic member fails', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: [() => false, agentCheck({ question: 'done?', threshold: 0.1 })],
        max: 2,
      }),
      withVerdict('yes', 0.99),
    );
    expect(outcome.status).toBe('exhausted');
  });
});

describe('quorum', () => {
  it('opens when at least k of n hold', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: quorum(
          2,
          () => true,
          () => true,
          () => false,
        ),
        max: 5,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('pass');
  });

  it('keeps looping below k', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: quorum(
          2,
          () => true,
          () => false,
          () => false,
        ),
        max: 2,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('exhausted');
  });

  it('counts a throwing judge as a "no" vote rather than crashing', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: quorum(
          1,
          () => {
            throw new Error('boom');
          },
          () => true,
        ),
        max: 5,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('pass');
  });

  it('rejects an out-of-range k at definition time', () => {
    expect(() => quorum(3, () => true)).toThrow(/quorum requires/);
    expect(() => quorum(0, () => true)).toThrow(/quorum requires/);
  });
});

describe('commandSucceeds', () => {
  it('honours pinned cwd and names the command timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'obversa-command-gate-'));
    const cwd = join(root, 'pinned');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'marker'), 'expected');
    try {
      const ready = await untilResult(
        commandSucceeds(
          process.execPath,
          ['-e', "if (require('node:fs').readFileSync('marker', 'utf8') !== 'expected') process.exit(1)"],
          { cwd },
        ),
        { ...noEngine, cwd: root },
      );
      expect(ready?.met).toBe(true);
      const timed = await untilResult(
        commandSucceeds(
          process.execPath,
          ['-e', 'setTimeout(() => process.exit(0), 1500)'],
          { cwd, timeoutMs: 500 },
        ),
        { ...noEngine, cwd: root },
      );
      expect(timed?.met).toBe(false);
      expect(timed?.reason).toBe(`\`${process.execPath}\` timed out after 500 ms`);
      const handled = await untilResult(
        commandSucceeds(
          process.execPath,
          ['-e', `
            const fs = require('node:fs');
            process.on('SIGTERM', () => {
              fs.writeFileSync('stopped', 'handled');
              process.exit(0);
            });
            fs.writeFileSync('ready', 'ready');
            setTimeout(() => process.exit(0), 1500);
          `],
          { cwd, timeoutMs: 500 },
        ),
        { ...noEngine, cwd: root },
      );
      expect(readFileSync(join(cwd, 'ready'), 'utf8')).toBe('ready');
      expect(readFileSync(join(cwd, 'stopped'), 'utf8')).toBe('handled');
      expect(handled?.met).toBe(false);
      expect(handled?.reason).toBe(`\`${process.execPath}\` timed out after 500 ms`);
      expect(handled?.output).toContain('exit: 0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is met when the command exits 0', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: commandSucceeds('node', ['-e', 'process.exit(0)']),
        max: 3,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('pass');
  });

  it('is not met when the command exits non-zero', async () => {
    const { outcome } = await run(
      loop({
        name: 'x',
        body: failingBody(),
        until: commandSucceeds('node', ['-e', 'process.exit(1)']),
        max: 2,
      }),
      noEngine,
    );
    expect(outcome.status).toBe('exhausted');
  });
});

/** Run a one-iteration loop and capture the `until` gate's ConditionResult. */
async function untilResult(
  until: Condition,
  opts: RunOptions,
): Promise<ConditionResult | undefined> {
  let result: ConditionResult | undefined;
  await run(loop({ name: 'x', body: failingBody(), until, max: 1 }), {
    ...opts,
    onEvent: (e: LoopEvent) => {
      if (e.kind === 'loop:condition' && e.which === 'until') result = e.result;
    },
  });
  return result;
}

describe('commandSucceeds output capture', () => {
  it('captures exit/stdout/stderr as output on failure', async () => {
    const r = await untilResult(
      commandSucceeds('node', [
        '-e',
        'console.log("out marker"); console.error("err marker"); process.exit(1)',
      ]),
      noEngine,
    );
    expect(r?.met).toBe(false);
    expect(r?.output).toContain('exit: 1');
    expect(r?.output).toContain('stdout:\nout marker');
    expect(r?.output).toContain('stderr:\nerr marker');
  });

  it('leaves output undefined on success', async () => {
    const r = await untilResult(
      commandSucceeds('node', ['-e', 'console.log("ok"); process.exit(0)']),
      noEngine,
    );
    expect(r?.met).toBe(true);
    expect(r?.output).toBeUndefined();
  });

  it('does not append captured output to a successful command', async () => {
    const r = await untilResult(
      commandSucceeds(
        'node',
        ['-e', 'console.log("successful detail"); process.exit(0)'],
        { captureOutput: true },
      ),
      noEngine,
    );
    expect(r?.reason).toBe('`node` exited 0');
    expect(r?.output).toBeUndefined();
  });

  it('truncates long stream output with the … marker', async () => {
    const r = await untilResult(
      commandSucceeds('node', [
        '-e',
        'process.stdout.write("x".repeat(5000)); process.exit(1)',
      ]),
      noEngine,
    );
    expect(r?.output).toContain('x'.repeat(3998));
    expect(r?.output).not.toContain('x'.repeat(3999));
    expect(r?.output).toContain('\n…');
  });

  it('scrubs credential-shaped strings from the captured output', async () => {
    const r = await untilResult(
      commandSucceeds('node', [
        '-e',
        'console.error("token=hunter2secret"); process.exit(1)',
      ]),
      noEngine,
    );
    expect(r?.output).toContain('[redacted]');
    expect(r?.output).not.toContain('hunter2secret');
  });

  it('keeps the failure reason concise unless output capture is requested', async () => {
    const r = await untilResult(
      commandSucceeds('node', [
        '-e',
        'console.error("failure detail"); process.exit(1)',
      ]),
      noEngine,
    );
    expect(r?.reason).toBe('`node` exited 1');
    expect(r?.reason).not.toContain('failure detail');
    expect(r?.output).toContain('failure detail');
  });

  it('appends the bounded tail of combined output when requested', async () => {
    const r = await untilResult(
      commandSucceeds(
        'node',
        [
          '-e',
          [
            'process.stdout.write("BEGIN_MARKER\\n" + "x".repeat(5000))',
            'process.stderr.write("\\nSTDERR_MARKER\\n")',
            'setTimeout(() => { console.error("END_MARKER"); process.exit(1) }, 10)',
          ].join('; '),
        ],
        { captureOutput: true },
      ),
      noEngine,
    );
    expect(r?.reason).toContain('command output (tail):');
    expect(r?.reason).toContain('… [output truncated]');
    expect(r?.reason).toContain('STDERR_MARKER');
    expect(r?.reason).toContain('END_MARKER');
    expect(r?.reason).not.toContain('BEGIN_MARKER');
  });

  it('redacts the full combined stream before taking its tail', async () => {
    const injected = 's'.repeat(500);
    const r = await untilResult(
      commandSucceeds(
        'node',
        [
          '-e',
          [
            'process.stdout.write("p".repeat(500) + process.env.COMMAND_SECRET + "z".repeat(2800) + "\\n")',
            'console.error("token=hunter2secret")',
            'process.exit(1)',
          ].join('; '),
        ],
        { captureOutput: true, env: { COMMAND_SECRET: injected } },
      ),
      noEngine,
    );
    expect(r?.reason).toContain('[redacted]');
    expect(r?.reason).not.toContain('s'.repeat(50));
    expect(r?.reason).not.toContain('hunter2secret');
  });
});

describe('combinator output propagation', () => {
  // These combinators never read the context when their inputs don't, so a
  // bare stub keeps the tests direct and offline.
  const ctx = {} as JobContext;
  const pass =
    (output?: string): Condition =>
    async () => ({ met: true, reason: 'ok', output });
  const fail =
    (output?: string): Condition =>
    async () => ({ met: false, reason: 'bad', output });

  it('not() copies the inner output', async () => {
    const r = await not(fail('diag'))(ctx, undefined);
    expect(r.met).toBe(true);
    expect(r.output).toBe('diag');
  });

  it('all() failure carries the failing item output; success carries none', async () => {
    const failed = await all(pass('a'), fail('b'), fail('c'))(ctx, undefined);
    expect(failed.met).toBe(false);
    expect(failed.output).toBe('b');
    const ok = await all(pass('a'), pass('b'))(ctx, undefined);
    expect(ok.met).toBe(true);
    expect(ok.output).toBeUndefined();
  });

  it('any() success carries that item output; failure carries the first defined among failures', async () => {
    const ok = await any(fail('a'), pass('b'))(ctx, undefined);
    expect(ok.met).toBe(true);
    expect(ok.output).toBe('b');
    const failed = await any(fail(undefined), fail('second'), fail('third'))(
      ctx,
      undefined,
    );
    expect(failed.met).toBe(false);
    expect(failed.output).toBe('second');
  });

  it('quorum() failure carries a non-holding voter output; success carries none', async () => {
    const failed = await quorum(2, pass('y'), fail('no-vote'), fail(undefined))(
      ctx,
      undefined,
    );
    expect(failed.met).toBe(false);
    expect(failed.output).toBe('no-vote');
    const ok = await quorum(1, pass('y'), fail('no-vote'))(ctx, undefined);
    expect(ok.met).toBe(true);
    expect(ok.output).toBeUndefined();
  });

  it('gateJob() puts the output into Outcome.data', async () => {
    const { outcome } = await run(gateJob('g', fail('diag')), noEngine);
    expect(outcome.status).toBe('fail');
    expect(outcome.data).toBe('diag');
  });

  it('gateJob() leaves data unset when the condition has no output', async () => {
    const { outcome } = await run(gateJob('g', fail(undefined)), noEngine);
    expect(outcome.data).toBeUndefined();
  });
});

describe('agentCheck request options and output', () => {
  /** A mock engine that records the request it was handed. */
  const capturing = (text: string) => {
    let seen: AgentRequest | undefined;
    const engine = new MockEngine((r: AgentRequest) => {
      seen = r;
      return text;
    });
    return { engine, req: () => seen! };
  };
  const verdictJson = JSON.stringify({
    verdict: 'yes',
    confidence: 0.9,
    reason: 'ok',
  });

  it('passes cwd and timeoutMs through to the judge engine', async () => {
    const { engine, req } = capturing(verdictJson);
    await run(
      gateJob(
        'g',
        agentCheck({
          question: 'done?',
          engine,
          cwd: '/judge/dir',
          timeoutMs: 1234,
        }),
      ),
      noEngine,
    );
    expect(req().cwd).toBe('/judge/dir');
    expect(req().timeoutMs).toBe(1234);
  });

  it('leaves cwd/timeoutMs unset by default (engine default, not the workspace)', async () => {
    const { engine, req } = capturing(verdictJson);
    await run(gateJob('g', agentCheck({ question: 'done?', engine })), noEngine);
    expect(req().cwd).toBeUndefined();
    expect(req().timeoutMs).toBeUndefined();
  });

  const findings = `${'F'.repeat(300)}TAIL`;
  const review = `${findings}\n<confidence>10%</confidence>`;

  it('caps the findings excerpt in the reason at 280 chars by default', async () => {
    const { engine } = capturing(review);
    const { outcome } = await run(
      gateJob('g', agentCheck({ question: 'sound?', confidenceTag: true, engine })),
      noEngine,
    );
    expect(outcome.summary).toContain('F'.repeat(280));
    expect(outcome.summary).not.toContain('F'.repeat(281));
  });

  it('maxReasonChars changes the excerpt cap', async () => {
    const { engine } = capturing(review);
    const { outcome } = await run(
      gateJob(
        'g',
        agentCheck({
          question: 'sound?',
          confidenceTag: true,
          maxReasonChars: 50,
          engine,
        }),
      ),
      noEngine,
    );
    expect(outcome.summary).toContain('F'.repeat(50));
    expect(outcome.summary).not.toContain('F'.repeat(51));
  });

  it('output carries the FULL findings beyond the reason cap', async () => {
    const { engine } = capturing(review);
    const { outcome } = await run(
      gateJob('g', agentCheck({ question: 'sound?', confidenceTag: true, engine })),
      noEngine,
    );
    expect(outcome.data).toBe(findings); // untruncated, tag stripped
  });

  it('a parse failure sets output to the raw reply text', async () => {
    const { engine } = capturing('no tag here at all');
    const { outcome } = await run(
      gateJob('g', agentCheck({ question: 'sound?', confidenceTag: true, engine })),
      noEngine,
    );
    expect(outcome.status).toBe('fail');
    expect(outcome.data).toBe('no tag here at all');
  });

  it('scrubs a credential in the findings from both reason and output', async () => {
    const { engine } = capturing(
      'leaked token=hunter2secret in config\n<confidence>10%</confidence>',
    );
    const { outcome } = await run(
      gateJob('g', agentCheck({ question: 'sound?', confidenceTag: true, engine })),
      noEngine,
    );
    expect(outcome.summary).not.toContain('hunter2secret');
    expect(outcome.summary).toContain('[redacted]');
    expect(outcome.data).not.toContain('hunter2secret');
  });

  it('scrubs a credential in a plain-verdict reason', async () => {
    const { engine } = capturing(
      JSON.stringify({
        verdict: 'no',
        confidence: 0.3,
        reason: 'config echoes token=hunter2secret',
      }),
    );
    const { outcome } = await run(
      gateJob('g', agentCheck({ question: 'sound?', engine })),
      noEngine,
    );
    expect(outcome.summary).not.toContain('hunter2secret');
    expect(outcome.summary).toContain('[redacted]');
    expect(outcome.data).not.toContain('hunter2secret');
  });

  it('a tag-only reply leaves output undefined (no empty-string evidence)', async () => {
    const { engine } = capturing('<confidence>95%</confidence>');
    const { outcome } = await run(
      gateJob('g', agentCheck({ question: 'sound?', confidenceTag: true, engine })),
      noEngine,
    );
    expect(outcome.status).toBe('pass');
    expect(outcome.data).toBeUndefined();
  });
});
