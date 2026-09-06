import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EngineError,
  EngineIncompleteResultError,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
} from '../src/engines/engine.ts';
import { runOwnedCommand } from '../src/engines/command-runner.ts';
import { MockEngine } from '../src/testing.ts';
import {
  assistantResult,
  engineSelection,
  reportedUsage,
} from '../src/runtime/result-parts.ts';
import { canonicalJson, digestJson, type JsonValue } from '../src/graph/value.ts';
import type { ExecutionTarget } from '../src/graph/plan.ts';
import { createAttemptIdentity } from '../src/runtime/attempt.ts';
import {
  createTokenBudget,
  type AttemptBudgetPolicy,
} from '../src/runtime/budget.ts';
import {
  executeNodeAttempt,
  type ActionDecision,
  type ModelUnavailableFact,
  type PreparedEngineLane,
  type PreparedNodeAttempt,
} from '../src/runtime/node-lifecycle.ts';
import { defineResultContract } from '../src/runtime/result-contract.ts';
import type { GraphEngineIdentity } from '../src/graph/type.ts';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];
const childPids: number[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const pid of childPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The child normally exits before cleanup.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  roots.push(root);
  return root;
}

const identity = createAttemptIdentity({
  namespace: 'tenant-a',
  streamId: 'run-1',
  nodeId: 'worker',
  position: 'items/first',
});

const primarySelection = engineSelection({
  adapter: 'primary',
  adapterVersion: '1.0.0',
  provider: 'provider-a',
  modelFamily: 'family-a',
  model: 'model-a',
  capabilities: ['read'],
});

const fallbackSelection = engineSelection({
  adapter: 'fallback',
  adapterVersion: '2.0.0',
  provider: 'provider-b',
  modelFamily: 'family-b',
  model: 'model-b',
  capabilities: ['read'],
});

const primaryIdentity: GraphEngineIdentity = {
  adapter: 'primary',
  provider: 'provider-a',
  modelFamily: 'family-a',
  model: 'model-a',
};

const fallbackIdentity: GraphEngineIdentity = {
  adapter: 'fallback',
  provider: 'provider-b',
  modelFamily: 'family-b',
  model: 'model-b',
};

const defaultPolicy: AttemptBudgetPolicy = {
  inputBytes: 4_096,
  outputBytes: 4_096,
  timeoutMs: 1_000,
  teardownGraceMs: 50,
  memoryBytes: 64 * 1_024 * 1_024,
  filesChanged: 2,
  linesChanged: 8,
  callTokens: { mode: 'observed', tokens: 10 },
};

function engine(
  name: string,
  run: (
    request: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ) => Promise<AgentResult>,
): Engine {
  return { name, run: vi.fn(run) };
}

function success(
  text = 'done',
  selection = primarySelection,
): AgentResult {
  return assistantResult({
    text,
    usage: reportedUsage({ inputTokens: 2, outputTokens: 1 }),
    requested: selection,
    effective: selection,
  });
}

function lane(
  value: Engine,
  selection = primarySelection,
  hardTokenLimitEnforceable = true,
): PreparedEngineLane {
  return { engine: value, selection, hardTokenLimitEnforceable };
}

function prepared(
  overrides: Partial<PreparedNodeAttempt> = {},
): PreparedNodeAttempt {
  const scratchDirectory = temporaryDirectory('lines-attempt-scratch-');
  const primary = engine('primary', async () => success());
  return {
    identity,
    nodeId: 'worker',
    input: { task: 'answer' },
    memory: null,
    prompt: 'Answer the task.',
    scratchDirectory,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: { actor: 'owner', trust: 'local' },
    permissions: ['read'],
    policy: defaultPolicy,
    resultContract: null,
    engineRoute: [lane(primary)],
    runData: null,
    parseResult: null,
    tokenBudget: createTokenBudget(100),
    recordModelUnavailable: async () => {},
    decideAction: async () => ({ kind: 'allow' }),
    ...overrides,
  };
}

function git(directory: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
}

function repository(): string {
  const root = temporaryDirectory('lines-attempt-workspace-');
  git(root, 'init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'allowed.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'notes.md'), 'clean\n');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Test User',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'initial',
  );
  return root;
}

describe('node attempt lifecycle', () => {
  it('rejects missing engine input and cancellation before an engine starts', async () => {
    const run = vi.fn(async (
      _request: AgentRequest,
      _onEvent: EngineEventSink,
      _signal: AbortSignal,
    ) => success());
    const selected = engine('primary', run);

    const missing = await executeNodeAttempt(prepared({
      prompt: null,
      engineRoute: [lane(selected)],
    }), new AbortController().signal);
    expect(missing.status).toBe('failed');
    expect(missing.failure?.code).toBe('INVALID_ATTEMPT');

    const controller = new AbortController();
    controller.abort();
    const aborted = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
    }), controller.signal);
    expect(aborted.status).toBe('failed');
    expect(aborted.failure?.code).toBe('ABORTED');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs only allow; wait pauses and deny records refusal', async () => {
    const run = vi.fn(async (
      _request: AgentRequest,
      _onEvent: EngineEventSink,
      _signal: AbortSignal,
    ) => success());
    const selected = engine('primary', run);

    const waiting = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      decideAction: async () => ({
        kind: 'wait',
        reason: 'owner approval required',
        request: { interaction: 'approve-write' },
      }),
    }), new AbortController().signal);
    expect(waiting.status).toBe('paused');
    expect(waiting.decision).toMatchObject({ kind: 'wait' });

    const denied = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      decideAction: async () => ({ kind: 'deny', reason: 'not admitted' }),
    }), new AbortController().signal);
    expect(denied.status).toBe('denied');

    const allowedAttempt = prepared({
      permissions: ['Read(src/**)'],
      engineRoute: [lane(selected)],
    });
    const allowed = await executeNodeAttempt(
      allowedAttempt,
      new AbortController().signal,
    );
    expect(allowed.status).toBe('completed');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'Answer the task.',
      model: 'model-a',
      maxTokens: 10,
      tools: ['read'],
      allowedTools: ['Read(src/**)'],
      cwd: allowedAttempt.scratchDirectory,
      workspaceMode: 'none',
      timeoutMs: 1_000,
      timeoutGraceMs: 50,
      maxOutputBytes: 4_096,
      maxMemoryBytes: 64 * 1_024 * 1_024,
      leaf: true,
      attempt: {
        leaf: true,
        runId: 'run-1',
        attemptId: identity.attemptId,
        leafId: 'worker',
        path: ['items/first'],
        label: 'worker',
        iteration: 0,
      },
    });
  });

  it('derives subagent access from the prepared lane capabilities', async () => {
    const subagentSelection = engineSelection({
      ...primarySelection,
      capabilities: ['task'],
    });
    const run = vi.fn(async (request: AgentRequest) => {
      expect(request.leaf).toBe(false);
      expect(request.attempt?.leaf).toBe(false);
      return success('done', subagentSelection);
    });

    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(engine('subagent', run), subagentSelection)],
    }), new AbortController().signal);

    expect(result.status).toBe('completed');
    expect(run).toHaveBeenCalledOnce();
  });

  it('copies trusted fields before policy waits and gives data jobs only scratch', async () => {
    const trusted = { actor: 'owner', nested: { role: 'admin' } };
    const permissions = ['read'];
    let release!: () => void;
    const decision = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: unknown[] = [];
    const scratch = temporaryDirectory('lines-data-only-');
    const attempt = prepared({
      prompt: null,
      scratchDirectory: scratch,
      trustedCaller: trusted,
      permissions,
      engineRoute: null,
      tokenBudget: null,
      runData: async (context) => {
        seen.push(context);
        writeFileSync(join(context.scratchDirectory, 'answer.json'), '{}\n');
        return { trustedCaller: { actor: 'model' }, answer: 42 };
      },
      decideAction: async () => {
        await decision;
        return { kind: 'allow' };
      },
    });

    const pending = executeNodeAttempt(attempt, new AbortController().signal);
    trusted.nested.role = 'model';
    permissions[0] = 'write';
    release();
    const record = await pending;

    expect(record.status).toBe('completed');
    expect(record.trustedCaller).toEqual({
      actor: 'owner',
      nested: { role: 'admin' },
    });
    expect(record.permissions).toEqual(['read']);
    expect(record.result).toEqual({
      trustedCaller: { actor: 'model' },
      answer: 42,
    });
    expect(seen).toEqual([
      expect.objectContaining({
        input: { task: 'answer' },
        scratchDirectory: scratch,
        workspaceDirectory: null,
        trustedCaller: { actor: 'owner', nested: { role: 'admin' } },
        permissions: ['read'],
      }),
    ]);
  });

  it('enforces exact input and output byte boundaries', async () => {
    const input = { task: 'answer' } as const;
    const inputBytes = Buffer.byteLength(canonicalJson(input), 'utf8');
    const dataRun = vi.fn(async () => 'ok' as const);

    const accepted = await executeNodeAttempt(prepared({
      input,
      prompt: null,
      engineRoute: null,
      runData: dataRun,
      tokenBudget: null,
      policy: { ...defaultPolicy, inputBytes, callTokens: null },
    }), new AbortController().signal);
    expect(accepted.status).toBe('completed');

    const rejected = await executeNodeAttempt(prepared({
      input,
      prompt: null,
      engineRoute: null,
      runData: dataRun,
      tokenBudget: null,
      policy: { ...defaultPolicy, inputBytes: inputBytes - 1, callTokens: null },
    }), new AbortController().signal);
    expect(rejected.failure?.code).toBe('INPUT_LIMIT');
    expect(dataRun).toHaveBeenCalledTimes(1);

    const selected = engine('primary', async () => success('done'));
    const outputAccepted = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      policy: { ...defaultPolicy, outputBytes: 4 },
    }), new AbortController().signal);
    expect(outputAccepted.status).toBe('completed');

    const outputRejected = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      policy: { ...defaultPolicy, outputBytes: 3 },
    }), new AbortController().signal);
    expect(outputRejected.failure?.code).toBe('OUTPUT_LIMIT');
    expect(outputRejected.parts).toEqual([
      { kind: 'assistant', text: 'done', final: true },
    ]);
  });

  it('requires hard token enforcement and records an observed overrun', async () => {
    const run = vi.fn(async () => success());
    const selected = engine('primary', run);
    const hardBudget = createTokenBudget(20);
    const hard = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected, primarySelection, false)],
      tokenBudget: hardBudget,
      policy: {
        ...defaultPolicy,
        callTokens: { mode: 'hard', tokens: 5 },
      },
    }), new AbortController().signal);
    expect(hard.failure?.code).toBe('TOKEN_BUDGET');
    expect(run).not.toHaveBeenCalled();
    expect(hardBudget.snapshot().reserved).toBe(0);

    const observedBudget = createTokenBudget(5);
    const overrun = engine('observed', async () => assistantResult({
      text: 'done',
      usage: reportedUsage({ inputTokens: 4, outputTokens: 3 }),
      requested: primarySelection,
    }));
    const observed = await executeNodeAttempt(prepared({
      engineRoute: [lane(overrun, primarySelection, false)],
      tokenBudget: observedBudget,
      policy: {
        ...defaultPolicy,
        callTokens: { mode: 'observed', tokens: 5 },
      },
    }), new AbortController().signal);
    expect(observed.status).toBe('completed');
    expect(observedBudget.snapshot()).toMatchObject({ spent: 7, reserved: 0 });
  });

  it('records a hard-token overrun without leaving a reservation behind', async () => {
    const budget = createTokenBudget(20);
    const overrun = engine('hard-overrun', async () => assistantResult({
      text: 'done',
      usage: reportedUsage({ inputTokens: 4, outputTokens: 3 }),
      requested: primarySelection,
    }));

    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(overrun)],
      tokenBudget: budget,
      policy: {
        ...defaultPolicy,
        callTokens: { mode: 'hard', tokens: 5 },
      },
    }), new AbortController().signal);

    expect(record.status).toBe('failed');
    expect(record.failure?.code).toBe('TOKEN_BUDGET');
    expect(record.parts).toEqual([
      { kind: 'assistant', text: 'done', final: true },
    ]);
    expect(record.usage).toEqual({
      kind: 'reported',
      inputTokens: 4,
      outputTokens: 3,
    });
    expect(budget.snapshot()).toMatchObject({
      spent: 7,
      reserved: 0,
      unknownUsageCalls: 0,
    });
  });

  it('validates native and explicitly parsed structured results', async () => {
    const schema = { type: 'object', required: ['answer'] } as const;
    const contract = defineResultContract({
      record: {
        name: 'answer',
        version: 1,
        schemaDigest: digestJson(schema),
      },
      schema,
      validate(value: unknown) {
        if (
          typeof value !== 'object' ||
          value === null ||
          !('answer' in value) ||
          typeof value.answer !== 'number'
        ) {
          throw new TypeError('answer must be a number');
        }
        return { answer: value.answer };
      },
    });
    const native = engine('native', async (request) => {
      expect(request.jsonSchema).toEqual(schema);
      return {
        parts: [{ kind: 'structured', value: { answer: 42 }, final: true }],
        usage: { kind: 'unknown' },
        requested: primarySelection,
        effective: primarySelection,
      };
    });
    const nativeRecord = await executeNodeAttempt(prepared({
      engineRoute: [lane(native)],
      resultContract: contract,
    }), new AbortController().signal);
    expect(nativeRecord.status).toBe('completed');
    expect(nativeRecord.result).toEqual({ answer: 42 });

    const text = engine('text', async () => success('42'));
    const parsedRecord = await executeNodeAttempt(prepared({
      engineRoute: [lane(text)],
      resultContract: contract,
      parseResult: (part) => ({
        answer: Number(part.kind === 'assistant' ? part.text : Number.NaN),
      }),
    }), new AbortController().signal);
    expect(parsedRecord.status).toBe('completed');
    expect(parsedRecord.result).toEqual({ answer: 42 });

    const invalid = await executeNodeAttempt(prepared({
      engineRoute: [lane(text)],
      resultContract: contract,
      parseResult: () => ({ wrong: true }),
    }), new AbortController().signal);
    expect(invalid.failure?.code).toBe('RESULT_INVALID');
    expect(invalid.parts).toEqual([
      { kind: 'assistant', text: '42', final: true },
    ]);
  });

  it('records a visible model substitution from the scripted engine', async () => {
    const requested = engineSelection({
      adapter: 'mock',
      model: 'declared-model',
    });
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(
        new MockEngine(() => ({
          text: 'done',
          model: 'effective-model',
        })),
        requested,
      )],
    }), new AbortController().signal);

    expect(result.status).toBe('completed');
    expect(result.requestedEngine?.model).toBe('declared-model');
    expect(result.effectiveEngine?.model).toBe('effective-model');
  });

  it('records a dead model before starting exactly one declared fallback', async () => {
    const order: string[] = [];
    const primary = engine('primary', async () => {
      order.push('primary');
      throw new Error('401 unauthorized');
    });
    const fallback = engine('fallback', async () => {
      order.push('fallback');
      expect(order).toEqual(['primary', 'record', 'fallback']);
      return success('recovered', fallbackSelection);
    });
    const budget = createTokenBudget(30);
    const record = await executeNodeAttempt(prepared({
      engineRoute: [
        lane(primary),
        lane(fallback, fallbackSelection),
      ],
      tokenBudget: budget,
      recordModelUnavailable: async (fact) => {
        expect(fact.selection).toEqual(primarySelection);
        expect(fact.failure).toBe('auth');
        order.push('record');
      },
    }), new AbortController().signal);

    expect(record.status).toBe('completed');
    expect(record.requestedEngine).toEqual(primarySelection);
    expect(record.effectiveEngine).toEqual(fallbackSelection);
    expect(record.unavailableModels).toEqual([primarySelection]);
    expect(record.usage).toEqual({
      kind: 'reported',
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(order).toEqual(['primary', 'record', 'fallback']);
    expect(budget.snapshot()).toMatchObject({
      spent: 3,
      reserved: 0,
      unknownUsageCalls: 1,
    });
  });

  it.each(['missing-cli', 'invalid-config', 'auth'] as const)(
    '%s permits another adapter for the same provider and model', async (kind) => {
      const alternate = engineSelection({ ...primarySelection, adapter: 'alternate' });
      const primary = engine('primary', async () => {
        throw new EngineError({ kind, message: 'scripted adapter failure' });
      });
      const fallback = engine('alternate', async () => success('fallback', alternate));
      const recordModelUnavailable = vi.fn(async () => {});
      const result = await executeNodeAttempt(prepared({
        engineRoute: [lane(primary), lane(fallback, alternate)],
        declaredTargets: [],
        recordModelUnavailable,
      }), new AbortController().signal);
      expect(result.status).toBe('completed');
      expect(primary.run).toHaveBeenCalledTimes(1);
      expect(fallback.run).toHaveBeenCalledTimes(1);
      expect(recordModelUnavailable).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['model-unavailable', 'billing', 'quota'] as const)(
    '%s skips a prepared same-provider/model fallback and releases its reservation', async (kind) => {
      const alternate = engineSelection({ ...primarySelection, adapter: 'alternate' });
      const primary = engine('primary', async () => {
        throw new EngineError({ kind, message: 'scripted provider/model failure' });
      });
      const fallback = engine('alternate', async () => success('wrong', alternate));
      const budget = createTokenBudget(100);
      const result = await executeNodeAttempt(prepared({
        engineRoute: [lane(primary), lane(fallback, alternate)],
        declaredTargets: [],
        tokenBudget: budget,
      }), new AbortController().signal);
      expect(result.failure?.code).toBe('ENGINE_UNAVAILABLE');
      expect(primary.run).toHaveBeenCalledTimes(1);
      expect(fallback.run).not.toHaveBeenCalled();
      expect(budget.snapshot()).toEqual({
        limit: 100, spent: 0, reserved: 0, unknownUsageCalls: 1,
      });
    },
  );

  it('auth skips another model on the same adapter', async () => {
    const alternate = engineSelection({ ...primarySelection, model: 'other-model' });
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'auth', message: 'scripted auth failure' });
    });
    const fallback = engine('primary', async () => success('wrong', alternate));
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(primary), lane(fallback, alternate)],
      declaredTargets: [],
    }), new AbortController().signal);
    expect(result.failure?.code).toBe('ENGINE_UNAVAILABLE');
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it('quota keeps the same model on another provider usable', async () => {
    const alternate = engineSelection({ ...primarySelection, provider: 'other-provider' });
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'quota', message: 'scripted quota failure' });
    });
    const fallback = engine('primary', async () => success('other provider', alternate));
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(primary), lane(fallback, alternate)],
      declaredTargets: [],
    }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(fallback.run).toHaveBeenCalledTimes(1);
  });

  it('keeps successful standalone null-provider calls valid without a target', async () => {
    const observed = engineSelection({ ...primarySelection, provider: null, modelFamily: null });
    const primary = engine('primary', async () => success('done', observed));
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(primary, observed)],
    }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(result.effectiveEngine).toEqual(observed);
  });

  it('records exact routing beside null observations before skipping a fallback', async () => {
    const target: ExecutionTarget = {
      adapter: 'primary', provider: 'provider-a', modelFamily: 'family-a',
      model: 'model-a', tools: ['read'],
    };
    const alternateTarget: ExecutionTarget = { ...target, adapter: 'alternate' };
    const observed = engineSelection({ ...primarySelection, provider: null, modelFamily: null });
    const alternate = engineSelection({ ...observed, adapter: 'alternate' });
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'quota', message: 'scripted quota', effective: observed });
    });
    const fallback = engine('alternate', async () => success('wrong', alternate));
    const facts: ModelUnavailableFact[] = [];
    const result = await executeNodeAttempt(prepared({
      engineRoute: [
        { ...lane(primary, observed), target },
        { ...lane(fallback, alternate), target: alternateTarget },
      ],
      declaredTargets: [target, alternateTarget],
      recordModelUnavailable: async (fact) => { facts.push(fact); },
    }), new AbortController().signal);
    expect(result.failure?.code).toBe('ENGINE_UNAVAILABLE');
    expect(fallback.run).not.toHaveBeenCalled();
    expect(facts).toEqual([{
      schemaVersion: 1, identity, target, selection: observed, effective: observed, failure: 'quota',
    }]);
    expect(result.unavailableModels).toEqual([observed]);
  });

  it.each(['missing', 'ambiguous'] as const)('preserves a %s effective provider before refusing fallback', async (resolution) => {
    const target: ExecutionTarget = {
      adapter: 'primary', provider: 'provider-a', modelFamily: 'family-a',
      model: 'model-a', tools: ['read'],
    };
    const effective = engineSelection({ ...primarySelection, model: 'undeclared', provider: null });
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'quota', message: 'scripted substitution', effective });
    });
    const fallback = engine('fallback', async () => success('wrong', fallbackSelection));
    const facts: ModelUnavailableFact[] = [];
    const budget = createTokenBudget(100);
    const result = await executeNodeAttempt(prepared({
      engineRoute: [{ ...lane(primary), target }, lane(fallback, fallbackSelection)],
      declaredTargets: resolution === 'missing' ? [target] : [
        target,
        { ...target, model: 'undeclared', provider: 'provider-b' },
        { ...target, model: 'undeclared', provider: 'provider-c' },
      ],
      tokenBudget: budget,
      recordModelUnavailable: async (fact) => { facts.push(fact); },
    }), new AbortController().signal);
    expect(result.failure?.code).toBe('ENGINE_IDENTITY_UNRESOLVED');
    expect(facts).toEqual([{
      schemaVersion: 1, identity, target,
      selection: primarySelection, effective, failure: 'quota',
    }]);
    expect(result.unavailableModels).toEqual([effective]);
    expect(fallback.run).not.toHaveBeenCalled();
    expect(budget.snapshot().reserved).toBe(0);
  });

  it('does not fall back when the lasting-failure append fails', async () => {
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'auth', message: 'scripted auth' });
    });
    const fallback = engine('fallback', async () => success('wrong', fallbackSelection));
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(primary), lane(fallback, fallbackSelection)],
      recordModelUnavailable: async () => { throw new Error('scripted append failure'); },
    }), new AbortController().signal);
    expect(result.failure?.code).toBe('MODEL_UNAVAILABLE_RECORD');
    expect(fallback.run).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['object', {}],
    ['iterable', new Set()],
    ['sparse array', new Array(1)],
  ] as const)('rejects %s declarations before an engine call', async (_label, invalid) => {
    const primary = engine('primary', async () => success('not called', primarySelection));
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(primary)],
      declaredTargets: invalid as unknown as readonly ExecutionTarget[],
    }), new AbortController().signal);
    expect(result.failure?.code).toBe('INVALID_ATTEMPT');
    expect(primary.run).not.toHaveBeenCalled();
  });

  it('resolves a changed null-provider effective model from full lane declarations', async () => {
    const target: ExecutionTarget = {
      adapter: 'primary', provider: 'provider-a', modelFamily: 'family-a',
      model: 'model-a', tools: ['read'],
    };
    const declaredEffective: ExecutionTarget = { ...target, provider: 'provider-b', model: 'model-b' };
    const fallbackTarget: ExecutionTarget = { ...declaredEffective, adapter: 'fallback' };
    const effective = engineSelection({ ...primarySelection, model: 'model-b', provider: null });
    const fallbackObserved = engineSelection({
      ...primarySelection, adapter: 'fallback', provider: 'provider-b', model: 'model-b',
    });
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'billing', message: 'scripted substitution', effective });
    });
    const fallback = engine('fallback', async () => success('wrong', fallbackObserved));
    const result = await executeNodeAttempt(prepared({
      engineRoute: [
        { ...lane(primary), target },
        { ...lane(fallback, fallbackObserved), target: fallbackTarget },
      ],
      declaredTargets: [target, fallbackTarget, declaredEffective],
    }), new AbortController().signal);
    expect(result.failure?.code).toBe('ENGINE_UNAVAILABLE');
    expect(fallback.run).not.toHaveBeenCalled();
    expect(result.unavailableModels).toEqual([effective]);
  });

  it.each([null, 'provider-a'] as const)('preserves standalone fallback with provider %s when declarations are omitted', async (provider) => {
    const observed = engineSelection({ ...primarySelection, provider });
    const alternate = engineSelection({ ...observed, adapter: 'fallback' });
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'quota', message: 'scripted quota' });
    });
    const fallback = engine('fallback', async () => success('compatible', alternate));
    const facts: ModelUnavailableFact[] = [];
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(primary, observed), lane(fallback, alternate)],
      recordModelUnavailable: async (fact) => { facts.push(fact); },
    }), new AbortController().signal);
    expect(result.status).toBe('completed');
    expect(fallback.run).toHaveBeenCalledTimes(1);
    expect(facts).toEqual([{
      schemaVersion: 1, identity, selection: observed, effective: observed, failure: 'quota',
    }]);
  });

  it('does not reset the attempt deadline for a fallback lane', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const primary = engine('primary', async () => {
      started();
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
      throw new EngineError({
        kind: 'model-unavailable',
        message: 'primary disappeared',
      });
    });
    const fallback = engine('fallback', async () =>
      await new Promise<AgentResult>((resolve) => {
        setTimeout(() => resolve(success('too late', fallbackSelection)), 20);
      }));
    const running = executeNodeAttempt(prepared({
      engineRoute: [
        lane(primary),
        lane(fallback, fallbackSelection),
      ],
      policy: {
        ...defaultPolicy,
        timeoutMs: 20,
        teardownGraceMs: 10,
      },
    }), new AbortController().signal);

    await didStart;
    await vi.advanceTimersByTimeAsync(35);
    const record = await running;

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({ code: 'TIMEOUT' });
  });

  it('records the effective model that became unavailable beside its lane', async () => {
    const effective = engineSelection({
      ...primarySelection,
      model: 'runtime-substitution',
    });
    const unavailable = vi.fn(async () => {});
    const selected = engine('primary', async () => {
      throw new EngineError({
        kind: 'model-unavailable',
        message: 'runtime substitution disappeared',
        effective,
      });
    });

    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      recordModelUnavailable: unavailable,
    }), new AbortController().signal);

    expect(record.status).toBe('failed');
    expect(record.unavailableModels).toEqual([effective]);
    expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({
      selection: primarySelection,
      effective,
      failure: 'model-unavailable',
    }));
  });

  it('bounds an engine that ignores both its timeout and abort signal', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    let finish!: (value: AgentResult) => void;
    const selected = engine('stuck', async (_request, _onEvent, signal) => {
      started();
      signal.addEventListener('abort', () => {
        aborted = true;
      }, { once: true });
      return await new Promise<AgentResult>((resolve) => { finish = resolve; });
    });
    const recordEngineAttempt = vi.fn(async () => {});
    const running = executeNodeAttempt(prepared({
      recordEngineAttempt,
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 20,
        teardownGraceMs: 10,
      },
    }), new AbortController().signal);

    await didStart;
    await vi.runAllTimersAsync();
    const record = await running;

    expect(aborted).toBe(true);
    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({ code: 'TIMEOUT' });
    finish(success('answer after the attempt already settled'));
    await vi.runAllTimersAsync();
    expect(recordEngineAttempt.mock.calls).toEqual([[{
      requested: primaryIdentity,
      effective: null,
    }]]);
  });

  it('keeps a final result returned during timeout cleanup', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const selected = engine('late', async () => {
      started();
      return await new Promise<AgentResult>((resolve) => {
        setTimeout(() => resolve(success('late answer')), 25);
      });
    });
    const running = executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 20,
        teardownGraceMs: 10,
      },
    }), new AbortController().signal);

    await didStart;
    await vi.advanceTimersByTimeAsync(25);
    const record = await running;

    expect(record.status).toBe('completed');
    expect(record.parts.at(-1)).toMatchObject({ text: 'late answer' });
    expect(record.transportFailure).toMatchObject({ kind: 'timeout' });
  });

  it('rejects an unmarked result returned after the final-result deadline', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const selected = engine('too-late', async () => {
      started();
      return await new Promise<AgentResult>((resolve) => {
        setTimeout(() => resolve(success('too late')), 31);
      });
    });
    const recordEngineAttempt = vi.fn(async () => {});
    const running = executeNodeAttempt(prepared({
      recordEngineAttempt,
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 20,
        teardownGraceMs: 10,
      },
    }), new AbortController().signal);

    await didStart;
    await vi.advanceTimersByTimeAsync(31);
    const record = await running;

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({ code: 'TIMEOUT' });
    expect(recordEngineAttempt.mock.calls).toEqual([[{
      requested: primaryIdentity,
      effective: primaryIdentity,
    }]]);
  });

  it('rejects a timeout-marked result returned after the final-result deadline', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const selected = engine('too-late', async () => {
      started();
      return await new Promise<AgentResult>((resolve) => {
        setTimeout(() => resolve({
          ...success('too late'),
          transportFailure: {
            kind: 'timeout',
            message: 'reported after the deadline',
            exitCode: null,
          },
        }), 31);
      });
    });
    const running = executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 20,
        teardownGraceMs: 10,
      },
    }), new AbortController().signal);

    await didStart;
    await vi.advanceTimersByTimeAsync(31);
    const record = await running;

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects a result after the final deadline even when the engine blocks timers', async () => {
    const selected = engine('blocking', async () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      return success('too late');
    });
    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 5,
        teardownGraceMs: 5,
      },
    }), new AbortController().signal);

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({ code: 'TIMEOUT' });
    expect(record.result).toBeNull();
  });

  it('keeps incomplete evidence but fails as timeout after the final deadline', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const selected = engine('incomplete-too-late', async () => {
      started();
      return await new Promise<AgentResult>((_resolve, reject) => {
        setTimeout(() => reject(new EngineIncompleteResultError(
          'partial result arrived too late',
          success('partial answer'),
        )), 31);
      });
    });
    const recordEngineAttempt = vi.fn(async () => {});
    const running = executeNodeAttempt(prepared({
      recordEngineAttempt,
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 20,
        teardownGraceMs: 10,
      },
    }), new AbortController().signal);

    await didStart;
    await vi.advanceTimersByTimeAsync(31);
    const record = await running;

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({
      code: 'TIMEOUT',
      message: 'partial result arrived too late',
    });
    expect(record.parts).toEqual([
      { kind: 'assistant', text: 'partial answer', final: true },
    ]);
    expect(record.transportFailure).toMatchObject({ kind: 'timeout' });
    expect(recordEngineAttempt.mock.calls).toEqual([[{
      requested: primaryIdentity,
      effective: primaryIdentity,
    }]]);
  });

  it('keeps a parent abort distinct after the soft timeout', async () => {
    vi.useFakeTimers();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const selected = engine('aborted', async (_request, _onEvent, signal) => {
      started();
      return await new Promise<AgentResult>((resolve) => {
        signal.addEventListener(
          'abort',
          () => resolve(success('discarded')),
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const recordEngineAttempt = vi.fn(async () => {});
    const running = executeNodeAttempt(prepared({
      recordEngineAttempt,
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 20,
        teardownGraceMs: 10,
      },
    }), controller.signal);

    await didStart;
    await vi.advanceTimersByTimeAsync(20);
    controller.abort();
    const record = await running;

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({ code: 'ABORTED' });
    expect(record.result).toBeNull();
    expect(recordEngineAttempt.mock.calls).toEqual([[{
      requested: primaryIdentity,
      effective: primaryIdentity,
    }]]);
  });

  it('waits for process cleanup before keeping a final result during grace', async () => {
    let childPid: number | undefined;
    const selected = engine('process-backed', async (request) => {
      const child = spawn(
        process.execPath,
        ['-e', "process.send?.('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      childPid = child.pid;
      if (childPid !== undefined) childPids.push(childPid);
      const ready = once(child, 'message');
      const deadline = new Promise<void>((resolve) => {
        setTimeout(
          resolve,
          request.timeoutMs ?? 0,
        );
      });
      await ready;
      await deadline;
      child.kill('SIGTERM');
      await once(child, 'exit');
      return {
        ...success('late answer'),
        transportFailure: {
          kind: 'timeout',
          message: 'process cleanup followed the final result',
          exitCode: null,
        },
      };
    });
    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      policy: {
        ...defaultPolicy,
        timeoutMs: 500,
        teardownGraceMs: 100,
      },
    }), new AbortController().signal);

    expect(record.status).toBe('completed');
    expect(record.parts.at(-1)).toMatchObject({ text: 'late answer' });
    expect(record.transportFailure).toMatchObject({ kind: 'timeout' });
    expect(childPid).toBeTypeOf('number');
    expect(() => process.kill(childPid!, 0)).toThrow();
  });

  it.runIf(process.platform !== 'win32')(
    'keeps final evidence captured before a SIGTERM-ignoring command times out',
    async () => {
      const budget = createTokenBudget(20);
      const selected = engine('process-backed', async (request, _onEvent, signal) => {
        let captured: AgentResult | undefined;
        const command = await runOwnedCommand({
          executable: process.execPath,
          args: [
            '-e',
            "process.on('SIGTERM', () => {}); process.stdout.write('FINAL'); setInterval(() => {}, 1000)",
          ],
          cwd: request.cwd!,
          env: {},
          stdin: '',
          attemptId: identity.attemptId,
          runId: identity.streamId,
          timeoutMs: request.timeoutMs!,
          teardownGraceMs: request.timeoutGraceMs!,
          maxOutputBytes: request.maxOutputBytes!,
          maxMemoryBytes: request.maxMemoryBytes!,
        }, signal, {
          onStdout: () => {
            captured ??= assistantResult({
              text: 'captured answer',
              usage: reportedUsage({ inputTokens: 7, outputTokens: 3 }),
              requested: primarySelection,
              effective: primarySelection,
            });
          },
        });
        if (captured === undefined) throw new Error('final output was not captured');
        return {
          ...captured,
          transportFailure: {
            kind: 'timeout',
            message: 'command timed out after producing its final result',
            exitCode: command.exitCode,
          },
        };
      });

      const record = await executeNodeAttempt(prepared({
        engineRoute: [lane(selected)],
        tokenBudget: budget,
        policy: {
          ...defaultPolicy,
          timeoutMs: 300,
          teardownGraceMs: 100,
        },
      }), new AbortController().signal);

      expect(record.status).toBe('failed');
      expect(record.failure).toMatchObject({ code: 'TIMEOUT' });
      expect(record.result).toBeNull();
      expect(record.parts).toEqual([
        { kind: 'assistant', text: 'captured answer', final: true },
      ]);
      expect(record.usage).toEqual({
        kind: 'reported',
        inputTokens: 7,
        outputTokens: 3,
      });
      expect(record.effectiveEngine).toEqual(primarySelection);
      expect(record.transportFailure).toMatchObject({ kind: 'timeout' });
      expect(budget.snapshot()).toMatchObject({
        spent: 10,
        reserved: 0,
        unknownUsageCalls: 0,
      });
    },
  );

  it('fails typed after the last unavailable model and never invents a lane', async () => {
    const primary = engine('primary', async () => {
      throw new Error('unknown model');
    });
    const unavailable = vi.fn(async () => {});
    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(primary)],
      recordModelUnavailable: unavailable,
    }), new AbortController().signal);

    expect(record.status).toBe('failed');
    expect(record.failure?.code).toBe('ENGINE_UNAVAILABLE');
    expect(record.unavailableModels).toEqual([primarySelection]);
    expect(unavailable).toHaveBeenCalledTimes(1);
  });

  it('keeps a final result and a later transport failure as separate facts', async () => {
    const selected = engine('primary', async () => ({
      ...success('late answer'),
      transportFailure: {
        kind: 'timeout',
        message: 'helper did not stop cleanly',
        exitCode: null,
      },
    }));
    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
    }), new AbortController().signal);

    expect(record.status).toBe('completed');
    expect(record.parts.at(-1)).toEqual({
      kind: 'assistant',
      text: 'late answer',
      final: true,
    });
    expect(record.transportFailure).toMatchObject({ kind: 'timeout' });
  });

  it('keeps partial result evidence when an engine ends at its token limit', async () => {
    const partial = {
      ...success('partial answer'),
      stopReason: 'length',
    };
    const selected = engine('primary', async () => {
      throw new EngineIncompleteResultError(
        'engine output ended at the token limit',
        partial,
      );
    });
    const budget = createTokenBudget(10);
    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      tokenBudget: budget,
    }), new AbortController().signal);

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({
      code: 'EFFECT_FAILED',
      message: expect.stringContaining('token limit'),
    });
    expect(record.parts).toEqual([
      { kind: 'assistant', text: 'partial answer', final: true },
    ]);
    expect(record.usage).toEqual({
      kind: 'reported',
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(record.effectiveEngine).toEqual(primarySelection);
    expect(record.outputBytes).toBe(14);
    expect(budget.snapshot()).toMatchObject({ spent: 3, reserved: 0 });
  });

  it('keeps measured incomplete evidence when no result part was produced', async () => {
    const selected = engine('primary', async () => {
      throw new EngineIncompleteResultError(
        'engine output ended at the token limit',
        {
          ...success('unused'),
          parts: [],
          stopReason: 'length',
        },
      );
    });
    const budget = createTokenBudget(10);
    const record = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      tokenBudget: budget,
    }), new AbortController().signal);

    expect(record.status).toBe('failed');
    expect(record.failure).toMatchObject({
      code: 'EFFECT_FAILED',
      message: expect.stringContaining('token limit'),
    });
    expect(record.parts).toEqual([]);
    expect(record.usage).toEqual({
      kind: 'reported',
      inputTokens: 2,
      outputTokens: 1,
    });
    expect(record.unavailableModels).toEqual([]);
    expect(budget.snapshot()).toMatchObject({ spent: 3, reserved: 0 });
  });

  it('fails on foreign writes and workspace limits without deleting them', async () => {
    const root = repository();
    const runData = vi.fn(async () => {
      writeFileSync(join(root, 'src', 'allowed.ts'), 'export const value = 2;\n');
      writeFileSync(join(root, 'notes.md'), 'foreign\n');
      return { answer: 42 } as const;
    });
    const record = await executeNodeAttempt(prepared({
      prompt: null,
      workspace: {
        mode: 'write',
        directory: root,
        allowedPaths: ['src/**'],
      },
      engineRoute: null,
      runData,
      tokenBudget: null,
      policy: {
        ...defaultPolicy,
        filesChanged: 1,
        linesChanged: 2,
        callTokens: null,
      },
    }), new AbortController().signal);

    expect(record.status).toBe('failed');
    expect(record.failure?.code).toBe('WORKSPACE_VIOLATION');
    expect(record.changedPaths).toEqual(['notes.md', 'src/allowed.ts']);
    expect(record.foreignPaths).toEqual(['notes.md']);
    expect(record.result).toEqual({ answer: 42 });
    expect(runData).toHaveBeenCalledTimes(1);
    expect(() => execFileSync('git', ['diff', '--quiet'], { cwd: root })).toThrow();
  });

  it('gives an effect the normalized workspace path that was inspected', async () => {
    const root = repository();
    const supplied = `${root}/src/..`;
    const seen: string[] = [];

    const record = await executeNodeAttempt(prepared({
      prompt: null,
      workspace: {
        mode: 'read',
        directory: supplied,
        allowedPaths: [],
      },
      engineRoute: null,
      runData: async (context) => {
        seen.push(context.workspaceDirectory!);
        return { answer: 42 } as const;
      },
      tokenBudget: null,
      policy: { ...defaultPolicy, callTokens: null },
    }), new AbortController().signal);

    expect(record.status).toBe('completed');
    expect(seen).toEqual([root]);
  });
});

describe('engine attempt recording', () => {
  it.each([
    'result', 'incomplete', 'rate-limit', 'model-unavailable', 'timeout', 'aborted',
    'invalid-result', 'unknown', 'invalid-identity',
  ] as const)('records the reported identity for %s exactly once', async (outcome) => {
    const reported = { ...success(), effective: fallbackSelection };
    const selected = engine('reported', async () => {
      if (outcome === 'result') return reported;
      if (outcome === 'incomplete') {
        throw new EngineIncompleteResultError('partial answer', reported);
      }
      if (outcome === 'invalid-result') return { ...reported, parts: [] };
      if (outcome === 'invalid-identity') {
        return { ...reported, effective: { ...fallbackSelection, model: 42 } } as unknown as AgentResult;
      }
      if (outcome === 'unknown') throw new Error('no answer');
      throw new EngineError({ kind: outcome, message: 'reported failure', effective: fallbackSelection });
    });
    const recordEngineAttempt = vi.fn(async () => {});
    const result = await executeNodeAttempt(prepared({
      engineRoute: [lane(selected)],
      recordEngineAttempt,
    }), new AbortController().signal);

    expect(selected.run).toHaveBeenCalledTimes(1);
    expect(recordEngineAttempt.mock.calls).toEqual([[{
      requested: primaryIdentity,
      effective: outcome === 'unknown' || outcome === 'invalid-identity' ? null : fallbackIdentity,
    }]]);
    expect(result.status).toBe(outcome === 'result' ? 'completed' : 'failed');
  });

  it('awaits the primary receipt before calling the fallback and records both calls', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let recording!: () => void;
    const didRecord = new Promise<void>((resolve) => { recording = resolve; });
    const receipts: { requested: GraphEngineIdentity; effective: GraphEngineIdentity | null }[] = [];
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'auth', message: 'no reported answer' });
    });
    const fallback = engine('fallback', async () => success('fallback answer', fallbackSelection));
    const running = executeNodeAttempt(prepared({
      engineRoute: [lane(primary), lane(fallback, fallbackSelection)],
      recordEngineAttempt: async (fact) => {
        receipts.push(fact);
        if (receipts.length === 1) {
          recording();
          await released;
        }
      },
    }), new AbortController().signal);

    await Promise.race([didRecord, running.then(() => {
      throw new Error('engine attempt finished before its receipt was recorded');
    })]);
    expect(fallback.run).not.toHaveBeenCalled();
    release();
    expect((await running).status).toBe('completed');
    expect(receipts).toEqual([
      { requested: primaryIdentity, effective: null },
      { requested: fallbackIdentity, effective: fallbackIdentity },
    ]);
  });

  it.each(['result', 'unavailable'] as const)('propagates receipt storage failure after %s without fallback', async (outcome) => {
    const unavailable = vi.fn(async () => {});
    const primary = engine('primary', async () => {
      if (outcome === 'result') return success();
      throw new EngineError({ kind: 'auth', message: 'primary unavailable' });
    });
    const fallback = engine('fallback', async () => success('fallback', fallbackSelection));
    const budget = createTokenBudget(30);
    const storageError = new Error('engine receipt could not be stored');
    const recordEngineAttempt = vi.fn(async () => { throw storageError; });

    await expect(executeNodeAttempt(prepared({
      engineRoute: [lane(primary), lane(fallback, fallbackSelection)],
      tokenBudget: budget,
      recordModelUnavailable: unavailable,
      recordEngineAttempt,
    }), new AbortController().signal)).rejects.toBe(storageError);
    expect(primary.run).toHaveBeenCalledTimes(1);
    expect(recordEngineAttempt).toHaveBeenCalledTimes(1);
    expect(fallback.run).not.toHaveBeenCalled();
    expect(unavailable).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({
      spent: outcome === 'result' ? 3 : 0,
      reserved: 0,
      unknownUsageCalls: outcome === 'result' ? 0 : 1,
    });
  });

  it('preserves an undefined recorder rejection without fallback or reserved tokens', async () => {
    const primary = engine('primary', async () => {
      throw new EngineError({ kind: 'auth', message: 'primary unavailable' });
    });
    const fallback = engine('fallback', async () => success('fallback', fallbackSelection));
    const budget = createTokenBudget(30);
    const recordModelUnavailable = vi.fn(async () => {});
    const recordEngineAttempt = vi.fn(() => Promise.reject(undefined));

    await expect(executeNodeAttempt(prepared({
      engineRoute: [lane(primary), lane(fallback, fallbackSelection)],
      tokenBudget: budget,
      recordModelUnavailable,
      recordEngineAttempt,
    }), new AbortController().signal)).rejects.toBeUndefined();
    expect(primary.run).toHaveBeenCalledTimes(1);
    expect(recordEngineAttempt).toHaveBeenCalledTimes(1);
    expect(fallback.run).not.toHaveBeenCalled();
    expect(recordModelUnavailable).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({ spent: 0, reserved: 0, unknownUsageCalls: 1 });
  });

  it.each(['wait', 'deny', 'data', 'pre-aborted'] as const)('records no engine attempt for %s without an engine call', async (mode) => {
    const primary = engine('primary', async () => success());
    const recordEngineAttempt = vi.fn(async () => {});
    const controller = new AbortController();
    if (mode === 'pre-aborted') controller.abort();
    await executeNodeAttempt(prepared({
      engineRoute: mode === 'data' ? null : [lane(primary)],
      runData: mode === 'data' ? async () => ({ answer: 42 }) : null,
      decideAction: async (): Promise<ActionDecision> => mode === 'wait'
        ? { kind: 'wait', reason: 'approval', request: {} }
        : mode === 'deny' ? { kind: 'deny', reason: 'refused' } : { kind: 'allow' },
      recordEngineAttempt,
    }), controller.signal);

    expect(primary.run).not.toHaveBeenCalled();
    expect(recordEngineAttempt).not.toHaveBeenCalled();
  });
});
