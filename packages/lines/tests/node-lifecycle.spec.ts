import { execFileSync } from 'node:child_process';
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

import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
} from '../src/engines/engine.ts';
import {
  assistantResult,
  engineSelection,
  reportedUsage,
} from '../src/runtime/result-parts.ts';
import { canonicalJson, digestJson, type JsonValue } from '../src/graph/value.ts';
import { createAttemptIdentity } from '../src/runtime/attempt.ts';
import {
  createTokenBudget,
  type AttemptBudgetPolicy,
} from '../src/runtime/budget.ts';
import {
  executeNodeAttempt,
  type PreparedEngineLane,
  type PreparedNodeAttempt,
} from '../src/runtime/node-lifecycle.ts';
import { defineResultContract } from '../src/runtime/result-contract.ts';

const roots: string[] = [];

afterEach(() => {
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
      lines: {
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
      expect(request.lines?.leaf).toBe(false);
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
    expect(record.usage).toEqual({ kind: 'unknown' });
    expect(order).toEqual(['primary', 'record', 'fallback']);
    expect(budget.snapshot()).toMatchObject({
      spent: 3,
      reserved: 0,
      unknownUsageCalls: 1,
    });
  });

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
