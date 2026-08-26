import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  run,
  agentJob,
  agentCheck,
  gateJob,
  defineAgent,
  defineSkill,
  fromFile,
  LoopError,
} from '../src/api.ts';
import type { Engine, RunOptions, AgentRequest, LoopEvent } from '../src/api.ts';
import { agentContract, resolveSystem } from '../src/core/agent.ts';
import { MockEngine } from '../src/testing.ts';
import { requestEnv } from '../src/engines/engine.ts';
import { tmpRepo, cleanupRepos } from './git-helpers.ts';
import { fixtureResult, fixtureUsage } from './engine-fixture.ts';

afterAll(cleanupRepos);

/** A mock engine that records the request it was handed. */
function capturing(reply = 'done'): { engine: MockEngine; req: () => AgentRequest } {
  let seen: AgentRequest | undefined;
  const engine = new MockEngine((r: AgentRequest) => {
    seen = r;
    return reply;
  });
  return { engine, req: () => seen! };
}

function warnedEngine(text: string, warning: string): Engine {
  return {
    name: 'warned',
    async run(_req, onEvent) {
      const usage = fixtureUsage();
      if (text) onEvent({ type: 'text', delta: text });
      onEvent({ type: 'usage', usage, model: 'warned' });
      return fixtureResult(text, {
        model: 'warned',
        usage,
        stopReason: 'end_turn',
        transportFailure: {
          kind: 'unknown',
          message: warning,
          exitCode: 1,
        },
      });
    },
  };
}

describe('AgentDef', () => {
  it('validates name and system', () => {
    expect(() => defineAgent({ name: '', system: 'x' })).toThrow();
    expect(() => defineAgent({ name: 'a', system: '   ' })).toThrow();
    expect(defineAgent({ name: 'a', system: 'hi' }).name).toBe('a');
  });

  it('accepts optional contract metadata without changing the agent runtime shape', () => {
    const agent = defineAgent({
      name: 'implementer',
      system: 'Build the change.',
      tier: 'worker',
      capabilities: ['code.implementation'],
      outputs: [{ name: 'patch' }, { name: 'test-report' }],
      requiresSkills: ['tdd'],
      usesSkills: [defineSkill({ name: 'small-diff', instructions: 'Keep changes focused.' })],
      failureModes: [
        {
          mode: 'over-scoping',
          recovery: 'Reduce the patch to the requested behaviour.',
          severity: 'should-fix',
        },
      ],
    });

    expect(agentContract(agent)).toEqual({
      tier: 'worker',
      capabilities: ['code.implementation'],
      outputs: ['patch', 'test-report'],
      requiresSkills: ['tdd'],
      usesSkills: ['small-diff'],
      failureModes: ['over-scoping'],
    });
  });

  it('validates malformed contract metadata', () => {
    expect(() =>
      defineAgent({
        name: 'bad-output',
        system: 'x',
        outputs: [{ name: '' }],
      }),
    ).toThrow(/outputs/);
    expect(() =>
      defineAgent({
        name: 'bad-skill',
        system: 'x',
        requiresSkills: [''],
      }),
    ).toThrow(/empty skill/);
    expect(() =>
      defineAgent({
        name: 'bad-failure',
        system: 'x',
        failureModes: [{ mode: 'drift', recovery: '' }],
      }),
    ).toThrow(/recovery/);
  });

  it('reads system and skills from markdown files (fromFile), folding skills in', async () => {
    const repo = await tmpRepo();
    writeFileSync(join(repo, 'sys.md'), '# Store engineer\n\nBuild the storage engine.');
    writeFileSync(join(repo, 'tdd.md'), 'Write the failing test first.');

    const tdd = defineSkill({ name: 'tdd', instructions: fromFile(join(repo, 'tdd.md')) });
    const agent = defineAgent({
      name: 'store',
      system: fromFile(join(repo, 'sys.md')),
      skills: [tdd],
    });
    expect(agent.system).toContain('Build the storage engine.');

    const sys = resolveSystem(agent);
    expect(sys).toContain('Build the storage engine.');
    expect(sys).toContain('Methodologies you apply');
    expect(sys).toContain('Write the failing test first.');
  });

  it('agentJob takes system, model, tools and label from the agent def', async () => {
    const repo = await tmpRepo();
    const agent = defineAgent({
      name: 'reviewer',
      system: 'You review code.',
      model: 'haiku',
      tools: ['read'],
      skills: [defineSkill({ name: 'adversarial', instructions: 'Try to REFUTE it.' })],
    });
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(agentJob({ agent, prompt: 'review the PR' }), opts);

    const req = cap.req();
    expect(req.system).toContain('You review code.');
    expect(req.system).toContain('Try to REFUTE it.'); // skill folded into the system
    expect(req.model).toBe('haiku');
    expect(req.tools).toEqual(['read']);
    expect(req.allowedTools).toEqual(['read']);
    expect(req.prompt).toBe('review the PR'); // the per-call task, not the persona
  });

  it('inline config overrides the agent def', async () => {
    const repo = await tmpRepo();
    const agent = defineAgent({ name: 'a', system: 'agent system', model: 'haiku' });
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(
      agentJob({ agent, prompt: 'go', system: 'override system', model: 'sonnet' }),
      opts,
    );
    const req = cap.req();
    expect(req.system).toBe('override system');
    expect(req.model).toBe('sonnet');
  });

  it('agentCheck takes a persona from an AgentDef, keeping the validator contract last', async () => {
    const repo = await tmpRepo();
    let seenSystem = '';
    let seenModel: string | undefined;
    const engine = new MockEngine((r: AgentRequest) => {
      seenSystem = r.system ?? '';
      seenModel = r.model;
      return JSON.stringify({ verdict: 'yes', confidence: 0.95, reason: 'ok' });
    });
    const reviewer = defineAgent({
      name: 'reviewer',
      system: 'You are an adversarial reviewer.',
      model: 'haiku',
      skills: [defineSkill({ name: 'refute', instructions: 'Try to REFUTE the claim.' })],
    });
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => engine }, cwd: repo };
    await run(gateJob('review', agentCheck({ agent: reviewer, question: 'Is it correct?' })), opts);

    expect(seenSystem).toContain('adversarial reviewer'); // persona
    expect(seenSystem).toContain('Try to REFUTE the claim.'); // skill folded in
    expect(seenSystem.indexOf('adversarial reviewer')).toBeLessThan(seenSystem.indexOf('JSON')); // validator contract comes last
    expect(seenModel).toBe('haiku'); // model falls back to the agent's
  });

  it('agentJob carries `leaf` from the agent def into the engine request', async () => {
    const repo = await tmpRepo();
    const leafAgent = defineAgent({ name: 'leafy', system: 'no fan-out', leaf: true });
    const cap = capturing();
    const opts: RunOptions = { engine: 'mock', engines: { mock: () => cap.engine }, cwd: repo };
    await run(agentJob({ agent: leafAgent, prompt: 'go' }), opts);
    expect(cap.req().leaf).toBe(true);
    // inline config can still set it directly
    const cap2 = capturing();
    await run(agentJob({ prompt: 'go', leaf: true }), {
      engine: 'mock',
      engines: { mock: () => cap2.engine },
      cwd: repo,
    });
    expect(cap2.req().leaf).toBe(true);
  });

  it('agentJob supplies Lines leaf metadata to every engine request', async () => {
    const repo = await tmpRepo();
    const cap = capturing();
    await run(agentJob({ label: 'leaf', prompt: 'go' }), {
      engine: 'mock',
      engines: { mock: () => cap.engine },
      cwd: repo,
    });
    expect(cap.req().lines).toMatchObject({
      leaf: true,
      leafId: 'leaf/0',
      path: [],
      label: 'leaf',
      iteration: 0,
    });
    expect(requestEnv(cap.req())).toMatchObject({
      LINES_LEAF: '1',
      LINES_LEAF_ID: 'leaf/0',
      LINES_LEAF_LABEL: 'leaf',
      LINES_LEAF_PATH: '',
      LINES_LEAF_ITERATION: '0',
    });
  });

  it('keeps a warned work result and emits one warning without an error', async () => {
    const repo = await tmpRepo();
    const events: LoopEvent[] = [];
    const { outcome } = await run(agentJob({ prompt: 'go', engine: 'warned' }), {
      engine: 'warned',
      engines: { warned: warnedEngine('completed work', 'transport teardown failed') },
      cwd: repo,
      onEvent: (event) => events.push(event),
    });

    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('completed work');
    expect(
      events.filter((event) => event.kind === 'log' && event.level === 'warn'),
    ).toMatchObject([{ message: 'transport teardown failed' }]);
    expect(events.filter((event) => event.kind === 'error')).toHaveLength(0);
  });

  it('runs bounded advisor consults and records the question and reply', async () => {
    const repo = await tmpRepo();
    const events: string[] = [];
    let workerCalls = 0;
    let advisorReq: AgentRequest | undefined;
    const worker = new MockEngine((req) => {
      workerCalls += 1;
      if (workerCalls === 1) {
        return [
          '<consult_advisor>',
          '<question>Which design?</question>',
          '<context>Two options.</context>',
          '</consult_advisor>',
        ].join('\n');
      }
      expect(req.prompt).toContain('Advisor reply:');
      expect(req.prompt).toContain('Use the smaller design.');
      return 'final answer';
    });
    const advisor = new MockEngine((req) => {
      advisorReq = req;
      return 'Use the smaller design.';
    });

    const { outcome } = await run(
      agentJob({
        label: 'worker',
        prompt: 'build',
        engine: 'worker',
        maxTokens: 50,
        timeoutMs: 1000,
        timeoutGraceMs: 200,
        advisor: { engine: 'advisor', model: 'fable', maxCalls: 1 },
      }),
      {
        engine: 'worker',
        engines: { worker: () => worker, advisor: () => advisor },
        cwd: repo,
        onEvent: (event) => {
          if (event.kind === 'advisor:consult') events.push(`${event.question} -> ${event.reply}`);
        },
      },
    );

    expect(outcome.status).toBe('pass');
    expect(workerCalls).toBe(2);
    expect(events).toEqual(['Which design? -> Use the smaller design.']);
    expect(advisorReq).toMatchObject({
      model: 'fable',
      maxTokens: 50,
      timeoutMs: 1000,
      timeoutGraceMs: 200,
      leaf: true,
    });
  });

  it('emits a warning from a completed advisor consult', async () => {
    const repo = await tmpRepo();
    let workerCalls = 0;
    const worker = new MockEngine(() => {
      workerCalls += 1;
      return workerCalls === 1
        ? '<consult_advisor><question>Which design?</question></consult_advisor>'
        : 'final answer';
    });
    const events: LoopEvent[] = [];

    const { outcome } = await run(
      agentJob({
        label: 'worker',
        prompt: 'build',
        engine: 'worker',
        advisor: { engine: 'advisor', maxCalls: 1 },
      }),
      {
        engine: 'worker',
        engines: {
          worker,
          advisor: warnedEngine('Use the smaller design.', 'advisor teardown failed'),
        },
        cwd: repo,
        onEvent: (event) => events.push(event),
      },
    );

    expect(outcome.status).toBe('pass');
    expect(
      events.filter((event) => event.kind === 'log' && event.level === 'warn'),
    ).toMatchObject([{ message: 'advisor teardown failed' }]);
    expect(events.filter((event) => event.kind === 'error')).toHaveLength(0);
  });

  it('only treats a whole reply consult block as an advisor request', async () => {
    const repo = await tmpRepo();
    let advisorCalls = 0;
    const worker = new MockEngine(() =>
      [
        'This is documentation, not a request.',
        '<consult_advisor>',
        '<question>Which design?</question>',
        '</consult_advisor>',
      ].join('\n'),
    );
    const advisor = new MockEngine(() => {
      advisorCalls += 1;
      return 'advisor reply';
    });

    const { outcome } = await run(
      agentJob({
        label: 'worker',
        prompt: 'build',
        engine: 'worker',
        advisor: { engine: 'advisor', maxCalls: 1 },
      }),
      {
        engine: 'worker',
        engines: { worker: () => worker, advisor: () => advisor },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('pass');
    expect(advisorCalls).toBe(0);
  });

  it('scrubs advisor consult questions and replies before forwarding or recording', async () => {
    const repo = await tmpRepo();
    const secret = 'super-secret-token';
    let workerCalls = 0;
    let advisorPrompt = '';
    let followupPrompt = '';
    const events: string[] = [];
    const worker = new MockEngine((req) => {
      workerCalls += 1;
      if (workerCalls === 1) {
        return [
          '<consult_advisor>',
          `<question>Should I use ${secret}?</question>`,
          '</consult_advisor>',
        ].join('\n');
      }
      followupPrompt = req.prompt;
      return 'final answer';
    });
    const advisor = new MockEngine((req) => {
      advisorPrompt = req.prompt;
      return `Do not use ${secret}.`;
    });

    const { outcome } = await run(
      agentJob({
        label: 'worker',
        prompt: 'build',
        engine: 'worker',
        env: { SECRET_TOKEN: secret },
        advisor: { engine: 'advisor', maxCalls: 1 },
      }),
      {
        engine: 'worker',
        engines: { worker: () => worker, advisor: () => advisor },
        cwd: repo,
        onEvent: (event) => {
          if (event.kind === 'advisor:consult') {
            events.push(`${event.question} -> ${event.reply}`);
          }
        },
      },
    );

    expect(outcome.status).toBe('pass');
    expect(advisorPrompt).not.toContain(secret);
    expect(followupPrompt).not.toContain(secret);
    expect(events.join('\n')).not.toContain(secret);
    expect(advisorPrompt).toContain('[redacted]');
    expect(followupPrompt).toContain('[redacted]');
    expect(events.join('\n')).toContain('[redacted]');
  });

  it('agentCheck supplies Lines leaf metadata to judge engine requests', async () => {
    const repo = await tmpRepo();
    let seen: AgentRequest | undefined;
    await run(gateJob('review', agentCheck({ question: 'Is it correct?' })), {
      engine: 'mock',
      engines: {
        mock: () =>
          new MockEngine((req) => {
            seen = req;
            return JSON.stringify({ verdict: 'yes', confidence: 1, reason: 'ok' });
          }),
      },
      cwd: repo,
    });
    expect(seen?.leaf).toBe(true);
    expect(requestEnv(seen!)).toMatchObject({
      LINES_LEAF: '1',
      LINES_LEAF_ID: 'agent-check/0',
      LINES_LEAF_LABEL: 'agent-check',
    });
  });

  it('keeps a warned judge result and emits one warning without an error', async () => {
    const repo = await tmpRepo();
    const events: LoopEvent[] = [];
    const verdict = JSON.stringify({ verdict: 'yes', confidence: 1, reason: 'ok' });
    const { outcome } = await run(
      gateJob('review', agentCheck({ question: 'Is it correct?', engine: 'warned' })),
      {
        engine: 'warned',
        engines: { warned: warnedEngine(verdict, 'judge teardown failed') },
        cwd: repo,
        onEvent: (event) => events.push(event),
      },
    );

    expect(outcome.status).toBe('pass');
    expect(
      events.filter((event) => event.kind === 'log' && event.level === 'warn'),
    ).toMatchObject([{ message: 'judge teardown failed' }]);
    expect(events.filter((event) => event.kind === 'error')).toHaveLength(0);
  });

  it('agentJob spills provider-limit failures to a fallback route', async () => {
    const repo = await tmpRepo();
    const calls: string[] = [];
    const primary: Engine = {
      name: 'primary',
      async run() {
        calls.push('primary');
        throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
      },
    };
    const fallback = new MockEngine((req) => {
      calls.push(`fallback:${req.model ?? 'no-model'}`);
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'go',
        engine: 'primary',
        fallback: { engine: 'fallback', model: 'gpt-5.4-mini' },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('pass');
    expect(calls).toEqual(['primary', 'fallback:gpt-5.4-mini']);
  });

  it('fallback routes without a model do not inherit the primary model', async () => {
    const repo = await tmpRepo();
    const primary: Engine = {
      name: 'primary',
      async run() {
        throw new LoopError({ code: 'RATE_LIMIT', message: 'throttled' });
      },
    };
    let fallbackModel: string | undefined;
    const fallback = new MockEngine((req) => {
      fallbackModel = req.model;
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'go',
        engine: 'primary',
        model: 'claude-sonnet-4-5',
        fallback: { engine: 'fallback' },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('pass');
    expect(fallbackModel).toBeUndefined();
  });

  it('agentJob does not spill non-provider failures to a fallback route', async () => {
    const repo = await tmpRepo();
    let fallbackCalls = 0;
    const primary: Engine = {
      name: 'primary',
      async run() {
        throw new LoopError({ code: 'CONFIG', message: 'bad config' });
      },
    };
    const fallback = new MockEngine(() => {
      fallbackCalls += 1;
      return 'fallback ok';
    });

    const { outcome } = await run(
      agentJob({
        label: 'work',
        prompt: 'go',
        engine: 'primary',
        fallback: { engine: 'fallback' },
      }),
      {
        engine: 'primary',
        engines: { primary, fallback: () => fallback },
        cwd: repo,
      },
    );

    expect(outcome.status).toBe('fail');
    expect(outcome.error?.code).toBe('CONFIG');
    expect(fallbackCalls).toBe(0);
  });
});
