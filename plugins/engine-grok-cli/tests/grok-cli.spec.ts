import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalJson,
  digestJson,
  EngineError,
  engineSelection,
  type AgentRequest,
  type EngineStreamEvent,
  type EngineSelectionRecord,
} from '@obversa/engine';
import {
  runEngineAdmissionConformance,
  runEngineConformance,
} from '@obversa/engine/testing';
import {
  buildGrokArgs,
  GrokCliEngine,
  type GrokCliEngineOptions,
} from '../src/index.ts';

const roots: string[] = [];
const fixtureSource = fileURLToPath(
  new URL('fixtures/grok-cli.mjs', import.meta.url),
);

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  roots.push(root);
  return root;
}

function executable(): string {
  const directory = temporaryDirectory('lines-grok-cli-');
  const target = join(directory, 'grok-fixture');
  copyFileSync(fixtureSource, target);
  chmodSync(target, 0o755);
  return target;
}

function options(bin = executable()): GrokCliEngineOptions {
  return {
    executable: bin,
    version: '1.0.5',
    identity: {
      provider: 'xai',
      modelFamily: 'grok-4',
    },
    permissionMode: 'dontAsk',
  };
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
  const attemptId = digestJson({
    schemaVersion: 1,
    namespace: 'tenant-a',
    streamId: 'run-1',
    nodeId: 'reviewer',
    position: 'review/main',
  });
  return {
    prompt: 'Review the candidate.',
    system: 'Follow the fixture rules.',
    model: 'grok-4-fixture',
    tools: ['read_file', 'grep'],
    allowedTools: ['Read', 'Grep'],
    cwd: temporaryDirectory('lines-grok-cwd-'),
    workspaceMode: 'read',
    leaf: true,
    timeoutMs: 2_000,
    timeoutGraceMs: 200,
    maxOutputBytes: 64 * 1_024,
    maxMemoryBytes: 256 * 1_024 * 1_024,
    attempt: {
      leaf: true,
      runId: 'run-1',
      attemptId,
      leafId: 'reviewer',
      path: ['review/main'],
      label: 'reviewer',
      iteration: 0,
    },
    ...overrides,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  expect(existsSync(path)).toBe(true);
}

function valuesAfter(args: readonly string[], flag: string): string[] {
  return args.flatMap((value, index) =>
    value === flag && args[index + 1] !== undefined ? [args[index + 1]!] : [],
  );
}

interface FixtureInvocation {
  readonly kind: 'version' | 'model';
  readonly program: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly cwd: string;
  readonly promptFilePresent: boolean;
  readonly home: string | null;
  readonly grokHome: string | null;
  readonly parentSecret: string | null;
}

function invocations(path: string): FixtureInvocation[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureInvocation);
}

function admissionRequest(input: AgentRequest): Omit<AgentRequest, 'prompt'> {
  const { prompt: _prompt, ...rest } = input;
  return rest;
}

function admissionSelection(bin: string, input: AgentRequest): EngineSelectionRecord {
  return engineSelection({
    adapter: 'grok-cli', adapterVersion: '1.0.5', provider: 'xai', modelFamily: 'grok-4',
    executable: bin, model: input.model, capabilities: input.tools ?? [],
  });
}

describe('Grok CLI adapter', () => {
  it('maps one request to an exact fresh 1.0.5 headless invocation', async () => {
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');
    const events: EngineStreamEvent[] = [];
    const input = request();
    const selectedOptions = options();

    const result = await new GrokCliEngine({
      ...selectedOptions,
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'invocation',
      },
    }).run(
      input,
      (event) => events.push(event),
      new AbortController().signal,
    );
    const call = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      args: string[];
      cwd: string;
      promptFile: string;
      prompt: string;
      attempt: { attemptId: string; runId: string; headless: string };
      environment: {
        home: string;
        grokHome: string;
        config: string;
        auth: string | null;
        subagents: string | null;
        parentSecret: string | null;
        poisonedHookVisible: boolean;
        compatDisabled: boolean;
      };
    };

    expect(call.cwd).toBe(input.cwd);
    expect(call.prompt).toBe('Review the candidate.');
    expect(basename(call.promptFile)).toBe('prompt.md');
    expect(existsSync(call.promptFile)).toBe(false);
    expect(valuesAfter(call.args, '--prompt-file')).toEqual([call.promptFile]);
    expect(valuesAfter(call.args, '--output-format')).toEqual([
      'streaming-messages-json',
    ]);
    expect(valuesAfter(call.args, '--cwd')).toEqual([input.cwd]);
    expect(valuesAfter(call.args, '--model')).toEqual(['grok-4-fixture']);
    expect(valuesAfter(call.args, '--permission-mode')).toEqual(['dontAsk']);
    expect(valuesAfter(call.args, '--sandbox')).toEqual(['strict']);
    expect(valuesAfter(call.args, '--tools')).toEqual(['read_file,grep']);
    expect(valuesAfter(call.args, '--allow')).toEqual(['Read', 'Grep']);
    expect(valuesAfter(call.args, '--rules')).toEqual([]);
    expect(valuesAfter(call.args, '--system-prompt-override')).toEqual([
      expect.stringContaining('Follow the fixture rules.'),
    ]);
    expect(call.args).toEqual(expect.arrayContaining([
      '--verbatim',
      '--no-auto-update',
      '--no-memory',
      '--no-subagents',
      '--disable-web-search',
    ]));
    expect(valuesAfter(call.args, '--disallowed-tools')).toEqual([
      'search_tool,use_tool,Agent',
    ]);
    expect(valuesAfter(call.args, '--deny')).toEqual(expect.arrayContaining([
      'MCPTool',
      'Edit',
      'Write',
    ]));
    expect(call.attempt).toEqual({
      attemptId: input.attempt?.attemptId,
      runId: 'run-1',
      headless: '1',
    });
    expect(call.environment).toMatchObject({
      parentSecret: null,
      poisonedHookVisible: false,
      compatDisabled: true,
      auth: null,
      subagents: '0',
    });
    expect(call.environment.config).toContain('load_envrc = false');
    expect(call.environment.config).toContain('[compat.claude]');
    expect(call.environment.config).toContain('[compat.cursor]');
    expect(call.environment.config).toContain('skills = false');
    expect(call.environment.home).not.toBe(process.env.HOME);
    expect(call.environment.grokHome).not.toBe(process.env.GROK_HOME);
    expect(existsSync(call.environment.home)).toBe(false);
    expect(existsSync(call.environment.grokHome)).toBe(false);

    expect(result.parts).toEqual([
      { kind: 'assistant', text: 'draft', final: false },
      { kind: 'assistant', text: 'answer', final: true },
    ]);
    expect(result.usage).toEqual({
      kind: 'reported',
      inputTokens: 5,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 3,
    });
    expect(result.requested).toEqual({
      adapter: 'grok-cli',
      adapterVersion: '1.0.5',
      provider: 'xai',
      modelFamily: 'grok-4',
      model: 'grok-4-fixture',
      executable: selectedOptions.executable,
      capabilities: ['read_file', 'grep'],
    });
    expect(result.effective).toMatchObject({
      model: 'grok-4-fixture-effective',
      executable: selectedOptions.executable,
    });
    expect(events).toEqual([
      { type: 'thinking', delta: 'considering' },
      { type: 'text', delta: 'draft' },
      { type: 'text', delta: 'answer' },
      {
        type: 'usage',
        usage: result.usage,
        model: 'grok-4-fixture-effective',
      },
    ]);
  });

  it('constructs a missing absolute executable before admit and run report missing-cli', async () => {
    const missing = join(temporaryDirectory('lines-grok-missing-'), 'grok');
    let engine: GrokCliEngine | undefined;
    expect(() => { engine = new GrokCliEngine(options(missing)); }).not.toThrow();
    const input = request();
    await expect(engine!.admit(admissionRequest(input), new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
    await expect(engine!.run(input, () => {}, new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
    await expect(new GrokCliEngine(options(missing)).run(input, () => {}, new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
  });

  it.each([
    'grok 1.0.5 (5115b46bc909) [stable]\n',
    'grok 1.0.5\n',
  ])('observes the version without a prompt file or model request (%j)', async (stdout) => {
    const bin = executable();
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const input = request();
    vi.stubEnv('OBVERSA_POISONED_PARENT_SECRET', 'must-not-cross');
    const engine = new GrokCliEngine({
      ...options(bin),
      environment: { OBVERSA_TEST_GROK_CALLS: calls, OBVERSA_TEST_GROK_VERSION_STDOUT: stdout },
    });
    const selected = await engine.admit(admissionRequest(input), new AbortController().signal);
    expect(selected).toEqual(admissionSelection(bin, input));
    expect(invocations(calls)).toEqual([expect.objectContaining({
      kind: 'version', program: realpathSync(bin), args: ['--version'], stdin: '',
      cwd: input.cwd, promptFilePresent: false, parentSecret: null,
    })]);
    const observed = invocations(calls)[0]!;
    expect(observed.home).not.toBe(process.env.HOME);
    expect(existsSync(observed.home!)).toBe(false);
    expect(existsSync(observed.grokHome!)).toBe(false);
  });

  it('retains an explicit symlink path through admission, replacement and run', async () => {
    const actual = executable();
    const link = join(temporaryDirectory('lines-grok-link-'), 'grok');
    symlinkSync(actual, link);
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const input = request();
    const selectedOptions = {
      ...options(link),
      environment: {
        OBVERSA_TEST_GROK_CALLS: calls,
        OBVERSA_TEST_GROK_EFFECTIVE_MODEL: input.model!,
      },
    };
    const first = new GrokCliEngine(selectedOptions);
    const selected = await first.admit(admissionRequest(input), new AbortController().signal);
    expect(selected.executable).toBe(link);
    expect(selected.executable).not.toBe(realpathSync(link));
    const replacement = new GrokCliEngine(selectedOptions);
    await expect(replacement.admit(admissionRequest(input), new AbortController().signal, selected))
      .resolves.toEqual(selected);
    const result = await replacement.run(input, () => {}, new AbortController().signal);
    expect(result.requested).toEqual(selected);
    expect(result.effective).toEqual(selected);
    expect(invocations(calls).filter((call) => call.kind === 'model').map((call) => call.program))
      .toEqual([realpathSync(actual)]);
  });

  it('checks each request configuration while reusing only its observed version', async () => {
    const bin = executable();
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const first = request();
    const second = request({ model: 'grok-other-request', tools: ['read_file'], allowedTools: ['Read'] });
    const engine = new GrokCliEngine({
      ...options(bin),
      environment: {
        OBVERSA_TEST_GROK_CALLS: calls,
        OBVERSA_TEST_GROK_EFFECTIVE_MODEL: second.model!,
      },
    });
    expect(await engine.admit(admissionRequest(first), new AbortController().signal))
      .toEqual(admissionSelection(bin, first));
    const selected = await engine.admit(admissionRequest(second), new AbortController().signal);
    expect(selected).toEqual(admissionSelection(bin, second));
    const result = await engine.run(second, () => {}, new AbortController().signal);
    expect(result.requested).toEqual(selected);
    expect(result.effective).toEqual(selected);
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version', 'model']);
    await expect(engine.admit(admissionRequest(request({ tools: ['write_file'] })), new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version', 'model']);
  });

  it.each([
    ['wrong-version', 'grok 1.0.6 (5115b46bc909) [stable]\n'],
    ['unparseable', 'scripted-secret-output-not-a-version\n'],
    ['extra-lines', 'grok 1.0.5\nscripted-secret-output-not-a-version\n'],
  ] as const)('refuses %s version output without exposing captured bytes', async (_label, stdout) => {
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({
      ...options(), environment: { OBVERSA_TEST_GROK_CALLS: calls, OBVERSA_TEST_GROK_VERSION_STDOUT: stdout },
    });
    let error: unknown;
    try { await engine.admit(admissionRequest(request()), new AbortController().signal); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ kind: 'invalid-config' });
    expect((error as Error).message).not.toContain(stdout.trim());
    expect((error as Error).message).not.toContain('scripted-secret-output');
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version']);
  });

  it.each(['exit', 'overflow'] as const)('refuses the %s version command without a model request', async (mode) => {
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({
      ...options(), environment: { OBVERSA_TEST_GROK_CALLS: calls, OBVERSA_TEST_GROK_VERSION_MODE: mode },
    });
    await expect(engine.admit(admissionRequest(request()), new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(invocations(calls).filter((call) => call.kind === 'model')).toEqual([]);
  });

  it('keeps version timeouts typed and starts no model request', async () => {
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({
      ...options(), environment: { OBVERSA_TEST_GROK_CALLS: calls, OBVERSA_TEST_GROK_VERSION_MODE: 'hang' },
    });
    await expect(engine.admit(admissionRequest(request({ timeoutMs: 250 })), new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'timeout' });
    expect(invocations(calls).filter((call) => call.kind === 'model')).toEqual([]);
  });

  it('shares one version observation across concurrent admission calls', async () => {
    const bin = executable();
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({ ...options(bin), environment: { OBVERSA_TEST_GROK_CALLS: calls } });
    const input = request();
    const results = await Promise.all([
      engine.admit(admissionRequest(input), new AbortController().signal),
      engine.admit(admissionRequest(input), new AbortController().signal),
    ]);
    expect(results).toEqual([admissionSelection(bin, input), admissionSelection(bin, input)]);
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version']);
  });

  it('allows a later explicit admission after a failed version observation', async () => {
    const bin = executable();
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({ ...options(bin), environment: {
      OBVERSA_TEST_GROK_CALLS: calls, OBVERSA_TEST_GROK_VERSION_MODE: 'fail-once',
    } });
    const input = request();
    await expect(engine.admit(admissionRequest(input), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'invalid-config' });
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version']);
    await expect(engine.admit(admissionRequest(input), new AbortController().signal))
      .resolves.toEqual(admissionSelection(bin, input));
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version', 'version']);
  });

  it('does not infer an absent executable from a different spawn failure', async () => {
    const root = temporaryDirectory('lines-grok-spawn-');
    const bin = join(root, 'grok');
    writeFileSync(bin, `#!${join(root, 'missing-interpreter')}\n`, { mode: 0o755 });
    const engine = new GrokCliEngine(options(bin));
    await expect(engine.admit(admissionRequest(request()), new AbortController().signal))
      .rejects.toMatchObject({ kind: 'unknown' });
    expect(existsSync(bin)).toBe(true);
  });

  it('keeps cancellation typed before and during a version command', async () => {
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({
      ...options(), environment: { OBVERSA_TEST_GROK_CALLS: calls, OBVERSA_TEST_GROK_VERSION_MODE: 'hang' },
    });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(engine.admit(admissionRequest(request()), alreadyAborted.signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'aborted' });
    expect(invocations(calls)).toEqual([]);
    const controller = new AbortController();
    const running = engine.admit(admissionRequest(request()), controller.signal);
    const outcome = expect(running).rejects.toMatchObject({ name: 'EngineError', kind: 'aborted' });
    await waitForFile(calls);
    controller.abort();
    await outcome;
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version']);
  });

  it.each([
    { model: undefined },
    { tools: ['write_file'] },
    { allowedTools: ['Bash(git status)'] },
    { env: { OBVERSA_REQUEST_SECRET: 'not-allowed' } },
    { timeoutMs: 0 },
  ] satisfies Partial<AgentRequest>[])('refuses invalid normal configuration before a version process (%j)', async (overrides) => {
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({ ...options(), environment: { OBVERSA_TEST_GROK_CALLS: calls } });
    await expect(engine.admit(admissionRequest(request(overrides)), new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(invocations(calls)).toEqual([]);
  });

  it('rechecks project guards after admission before a normal model call', async () => {
    const cwd = temporaryDirectory('lines-grok-admitted-project-');
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const engine = new GrokCliEngine({ ...options(), environment: { OBVERSA_TEST_GROK_CALLS: calls } });
    const input = request({ cwd });
    await engine.admit(admissionRequest(input), new AbortController().signal);
    writeFileSync(join(cwd, 'AGENTS.md'), 'scripted project instructions');
    await expect(engine.admit(admissionRequest(input), new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    await expect(engine.run(input, () => {}, new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version']);
  });

  it('reports missing-cli when the admitted executable is removed before run', async () => {
    const bin = executable();
    const engine = new GrokCliEngine(options(bin));
    const input = request();
    await engine.admit(admissionRequest(input), new AbortController().signal);
    rmSync(bin);
    await expect(engine.run(input, () => {}, new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
  });

  it('reports a non-executable file as missing-cli after construction', async () => {
    const bin = executable();
    chmodSync(bin, 0o600);
    const engine = new GrokCliEngine(options(bin));
    const input = request();
    await expect(engine.admit(admissionRequest(input), new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
    await expect(engine.run(input, () => {}, new AbortController().signal))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
  });

  it('refuses a replacement whose observed version no longer matches the saved selection', async () => {
    const bin = executable();
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const input = request();
    const first = new GrokCliEngine({ ...options(bin), environment: { OBVERSA_TEST_GROK_CALLS: calls } });
    const selected = await first.admit(admissionRequest(input), new AbortController().signal);
    const replacement = new GrokCliEngine({
      ...options(bin), environment: {
        OBVERSA_TEST_GROK_CALLS: calls,
        OBVERSA_TEST_GROK_VERSION_STDOUT: 'grok 1.0.6\n',
      },
    });
    await expect(replacement.admit(admissionRequest(input), new AbortController().signal, selected))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(invocations(calls).map((call) => call.kind)).toEqual(['version', 'version']);
  });

  it('passes the separate admission kit with actual process markers', async () => {
    const bin = executable();
    const other = executable();
    const missing = join(temporaryDirectory('lines-grok-missing-'), 'grok');
    const calls = join(temporaryDirectory('lines-grok-admission-'), 'calls.jsonl');
    const input = request({ tools: ['read_file'], allowedTools: ['Read'] });
    const open = (path: string): GrokCliEngine => new GrokCliEngine({
      ...options(path),
      environment: {
        OBVERSA_TEST_GROK_CALLS: calls,
        OBVERSA_TEST_GROK_EFFECTIVE_MODEL: input.model!,
      },
    });
    const report = await runEngineAdmissionConformance({
      request: input,
      selection: admissionSelection(bin, input),
      open: () => open(bin),
      modelCalls(path) {
        const models = invocations(calls).filter((call) => call.kind === 'model');
        if (path === undefined) return models.length;
        if (path === null) return 0;
        return models.filter((call) => call.program === realpathSync(path)).length;
      },
      cli: {
        moveLookup() { vi.stubEnv('PATH', `${dirname(other)}${delimiter}${process.env.PATH ?? ''}`); },
        openDifferent: () => open(other),
        openMissing: () => open(missing),
      },
    });
    expect('kind' in report).toBe(false);
    if ('kind' in report) throw new Error(`Grok admission is ${report.kind}`);
    expect(report).toEqual({ ok: true, cases: 11, failures: [] });
    expect(invocations(calls).filter((call) => call.kind === 'model').map((call) => call.program))
      .toEqual([realpathSync(bin), realpathSync(bin)]);
  });

  it('admits declared web and subagents but never substitutes Grok memory', () => {
    const promptFile = '/tmp/lines-grok-prompt.md';
    const restricted = buildGrokArgs(request(), options('/bin/echo'), promptFile);
    expect(restricted).toEqual(expect.arrayContaining([
      '--disable-web-search',
      '--no-subagents',
      '--no-memory',
    ]));

    const expanded = buildGrokArgs(request({
      tools: ['read_file', 'web_search', 'task'],
      workspaceMode: 'write',
      leaf: false,
    }), options('/bin/echo'), promptFile);
    expect(expanded).not.toContain('--disable-web-search');
    expect(expanded).not.toContain('--no-subagents');
    expect(expanded).toContain('--no-memory');
    expect(() => buildGrokArgs(
      { ...request(), memory: {} } as AgentRequest & { memory: unknown },
      options('/bin/echo'),
      promptFile,
    )).toThrow('does not bridge Lines memory');
  });

  it('passes a result schema and returns the native structured value', async () => {
    const schema = {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
      additionalProperties: false,
    } as const;
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');
    const result = await new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'structured',
      },
    }).run(
      request({
        jsonSchema: schema,
      }),
      () => {},
      new AbortController().signal,
    );
    const call = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      args: string[];
    };

    expect(valuesAfter(call.args, '--json-schema')).toEqual([
      canonicalJson(schema),
    ]);
    expect(valuesAfter(call.args, '--output-format')).toEqual(['json']);
    expect(result.parts).toEqual([
      { kind: 'structured', value: { answer: 42 }, final: true },
    ]);
  });

  it.each(['invocation', 'structured'] as const)(
    'does not record the Grok Build label from %s output as a model',
    async (scenario) => {
      const result = await new GrokCliEngine({
        ...options(),
        environment: {
          OBVERSA_TEST_GROK_EFFECTIVE_MODEL: 'Grok Build',
          OBVERSA_TEST_GROK_SCENARIO: scenario,
        },
      }).run(
        request(scenario === 'structured'
          ? { jsonSchema: { type: 'object' } }
          : {}),
        () => {},
        new AbortController().signal,
      );

      expect(result.effective.model).toBeNull();
    },
  );

  it('keeps an observed model substitution on a model-unavailable error', async () => {
    const selectedOptions = options();

    await expect(new GrokCliEngine({
      ...selectedOptions,
      environment: {
        OBVERSA_TEST_GROK_EFFECTIVE_MODEL: 'runtime-substitution',
        OBVERSA_TEST_GROK_SCENARIO: 'model-unavailable-after-init',
      },
    }).run(
      request(),
      () => {},
      new AbortController().signal,
    )).rejects.toMatchObject({
      kind: 'model-unavailable',
      effective: {
        adapter: 'grok-cli',
        model: 'runtime-substitution',
        executable: selectedOptions.executable,
      },
    });
  });

  it('enables declared subagents without guessing their parent model', async () => {
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');
    const result = await new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'structured-subagent',
      },
    }).run(
      request({
        tools: ['task'],
        workspaceMode: 'write',
        leaf: false,
        jsonSchema: { type: 'object' },
      }),
      () => {},
      new AbortController().signal,
    );
    const call = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      args: string[];
      environment: { subagents: string | null };
    };

    expect(valuesAfter(call.args, '--tools')).toEqual(['task']);
    expect(call.args).not.toContain('--no-subagents');
    expect(valuesAfter(call.args, '--disallowed-tools')).toEqual([
      'search_tool,use_tool',
    ]);
    expect(call.environment.subagents).toBe('1');
    expect(result.effective.model).toBeNull();
    expect(result.parts).toEqual([
      { kind: 'structured', value: { answer: 42 }, final: true },
    ]);
  });

  it('separates declared tools from scoped permission rules', () => {
    const args = buildGrokArgs(request({
      tools: ['read_file', 'grep'],
      allowedTools: ['Read(src/**)', 'Grep(src/**)'],
    }), options('/bin/echo'), '/tmp/lines-grok-prompt.md');

    expect(valuesAfter(args, '--tools')).toEqual(['read_file,grep']);
    expect(valuesAfter(args, '--allow')).toEqual([
      'Read(src/**)',
      'Grep(src/**)',
    ]);
  });

  it('maps every workspace mode and blocks write tools in read-only work', () => {
    const promptFile = '/tmp/lines-grok-prompt.md';
    expect(valuesAfter(buildGrokArgs(
      request({ workspaceMode: 'none' }),
      options('/bin/echo'),
      promptFile,
    ), '--sandbox')).toEqual(['strict']);
    expect(valuesAfter(buildGrokArgs(
      request({ workspaceMode: 'write' }),
      options('/bin/echo'),
      promptFile,
    ), '--sandbox')).toEqual(['workspace']);
    expect(() => buildGrokArgs(
      request({ workspaceMode: 'read', tools: ['write_file'] }),
      options('/bin/echo'),
      promptFile,
    )).toThrow('read-only workspace');
    expect(() => buildGrokArgs(
      request({ workspaceMode: 'read', tools: ['bash'] }),
      options('/bin/echo'),
      promptFile,
    )).toThrow('read-only workspace');
    expect(() => buildGrokArgs(
      request({ workspaceMode: 'read', allowedTools: ['Bash(git status)'] }),
      options('/bin/echo'),
      promptFile,
    )).toThrow('read-only workspace');
  });

  it('rejects an undeclared init capability before later work runs', async () => {
    const effectPath = join(temporaryDirectory('lines-grok-effect-'), 'ran');

    await expect(new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_SCENARIO: 'extra-capability',
        OBVERSA_TEST_GROK_EFFECT: effectPath,
      },
    }).run(
      request(),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('undeclared capability');
    expect(existsSync(effectPath)).toBe(false);
  });

  it('uses a fresh home and ignores a poisoned parent environment', async () => {
    const parentHome = temporaryDirectory('lines-grok-parent-home-');
    const hooks = join(parentHome, '.grok', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'poison.json'), '{"poison":true}');
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');
    vi.stubEnv('HOME', parentHome);
    vi.stubEnv('GROK_HOME', join(parentHome, '.grok'));
    vi.stubEnv('OBVERSA_POISONED_PARENT_SECRET', 'must-not-cross');

    await new GrokCliEngine({
      ...options(),
      environment: {
          OBVERSA_TEST_GROK_RECORD: recordPath,
          OBVERSA_TEST_GROK_SCENARIO: 'invocation',
      },
    }).run(
      request(),
      () => {},
      new AbortController().signal,
    );
    const call = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      environment: {
        parentSecret: string | null;
        poisonedHookVisible: boolean;
      };
    };

    expect(call.environment).toEqual(
      expect.objectContaining({
        parentSecret: null,
        poisonedHookVisible: false,
      }),
    );
  });

  it('passes only environment values selected when the engine is created', async () => {
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');
    vi.stubEnv('OBVERSA_POISONED_PARENT_SECRET', 'must-not-cross');

    await new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'invocation',
        OBVERSA_TEST_GROK_SELECTED: 'selected-by-host',
      },
    }).run(
      request(),
      () => {},
      new AbortController().signal,
    );
    const call = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      environment: {
        selected: string | null;
        requestSecret: string | null;
        parentSecret: string | null;
      };
    };

    expect(call.environment).toMatchObject({
      selected: 'selected-by-host',
      requestSecret: null,
      parentSecret: null,
    });
  });

  it('rejects per-request environment injection before spawn', async () => {
    await expect(new GrokCliEngine(options()).run(
      request({ env: { OBVERSA_TEST_GROK_REQUEST_SECRET: 'must-not-cross' } }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('constructor environment');
  });

  it('copies only an explicitly selected login file into the clean home', async () => {
    const authFile = join(temporaryDirectory('lines-grok-auth-'), 'auth.json');
    const auth = '{"fixture":"selected-auth"}';
    writeFileSync(authFile, auth, { mode: 0o600 });
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');

    const engine = new GrokCliEngine({
      ...options(),
      authFile,
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'invocation',
      },
    });
    writeFileSync(authFile, '{"fixture":"changed-after-selection"}');

    await engine.run(
      request(),
      () => {},
      new AbortController().signal,
    );
    const call = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      environment: { auth: string | null };
    };

    expect(call.environment.auth).toBe(auth);
  });

  it.each([
    'fixture-low-entropy-login-token',
    'short6',
  ])('scrubs selected login value %s out of failures', async (token) => {
    const authFile = join(temporaryDirectory('lines-grok-auth-'), 'auth.json');
    writeFileSync(authFile, JSON.stringify({ token }), { mode: 0o600 });
    let error: unknown;

    try {
      await new GrokCliEngine({
        ...options(),
        authFile,
        environment: { OBVERSA_TEST_GROK_SCENARIO: 'auth-echo' },
      }).run(request(), () => {}, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain('[redacted]');
  });

  it('scrubs selected login values from structured error messages', async () => {
    const authFile = join(temporaryDirectory('lines-grok-auth-'), 'auth.json');
    const token = 'fixture-structured-login-token';
    writeFileSync(authFile, JSON.stringify({ token }), { mode: 0o600 });
    let error: unknown;

    try {
      await new GrokCliEngine({
        ...options(),
        authFile,
        environment: {
          OBVERSA_TEST_GROK_SCENARIO: 'structured-error-auth-echo',
        },
      }).run(
        request({ jsonSchema: { type: 'object' } }),
        () => {},
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
    expect((error as Error).message).toContain('[redacted]');
  });

  it('rejects native project hooks and config before spawn', async () => {
    const cwd = temporaryDirectory('lines-grok-poisoned-project-');
    mkdirSync(join(cwd, '.grok', 'hooks'), { recursive: true });
    writeFileSync(join(cwd, '.grok', 'config.toml'), '[mcp_servers.poison]\n');
    writeFileSync(join(cwd, '.grok', 'hooks', 'poison.json'), '{}');
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');

    await expect(new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'invocation',
      },
    }).run(
      request({
        cwd,
      }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('project extension');
    expect(existsSync(recordPath)).toBe(false);
  });

  it('rejects a project language-server command before spawn', async () => {
    const cwd = temporaryDirectory('lines-grok-poisoned-lsp-');
    mkdirSync(join(cwd, '.grok'), { recursive: true });
    writeFileSync(join(cwd, '.grok', 'lsp.json'), '{"fixture":"spawn"}');
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');

    await expect(new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'invocation',
      },
    }).run(
      request({ cwd }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('.grok/lsp.json');
    expect(existsSync(recordPath)).toBe(false);
  });

  it.each([
    'AGENTS.md',
    '.grok/commands/poison.md',
    '.grok/roles/poison.toml',
    '.agents/commands/poison.md',
  ])('rejects ambient project input %s before spawn', async (relative) => {
    const cwd = temporaryDirectory('lines-grok-poisoned-project-');
    const target = join(cwd, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'poison');
    const recordPath = join(temporaryDirectory('lines-grok-record-'), 'call.json');

    await expect(new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_RECORD: recordPath,
        OBVERSA_TEST_GROK_SCENARIO: 'invocation',
      },
    }).run(
      request({ cwd }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('project extension');
    expect(existsSync(recordPath)).toBe(false);
  });

  it('requires an absolute executable, a version, and an explicit model', async () => {
    expect(() => new GrokCliEngine(options('grok'))).toThrow('absolute');
    expect(() => new GrokCliEngine({
      ...options('/bin/echo'),
      version: '',
    })).toThrow('version');
    expect(() => new GrokCliEngine({
      ...options('/bin/echo'),
      environment: { GROK_CONFIG: '/tmp/poison.toml' },
    })).toThrow('cannot replace GROK_CONFIG');
    expect(() => new GrokCliEngine({
      ...options('/bin/echo'),
      permissionMode: 'bypassPermissions',
    })).toThrow('dontAsk');

    const engine = new GrokCliEngine(options());
    await expect(engine.run(
      request({ model: undefined }),
      () => {},
      new AbortController().signal,
    )).rejects.toThrow('model');
  });

  it('does not classify words in a completed answer as transport failures', async () => {
    const result = await new GrokCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_GROK_SCENARIO: 'late-final' },
    }).run(
      request(),
      () => {},
      new AbortController().signal,
    );

    expect(result.parts.at(-1)).toEqual({
      kind: 'assistant',
      text: 'Quota advice belongs in the answer.',
      final: true,
    });
    expect(result.transportFailure?.kind).toBe('unknown');
  });

  it.each(['invocation', 'structured'] as const)('starts cleanup at the work deadline and keeps a completed result (%s)', async (mode) => {
    const marker = join(temporaryDirectory('lines-grok-final-'), 'written');
    const controller = new AbortController();
    let abortFired = false;
    const running = new GrokCliEngine({
      ...options(),
      environment: {
        OBVERSA_TEST_GROK_FINAL_MARKER: marker,
        OBVERSA_TEST_GROK_SCENARIO: mode === 'structured' ? 'timeout-final-structured' : 'timeout-final',
      },
    }).run(
      request({
        timeoutMs: 5_000,
        timeoutGraceMs: 500,
        ...(mode === 'structured'
          ? { jsonSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false } }
          : {}),
      }),
      () => {},
      controller.signal,
    );
    await waitForFile(marker);
    abortFired = true;
    controller.abort();
    const result = await running;

    expect(abortFired).toBe(true);
    expect(result.parts.at(-1)).toMatchObject(mode === 'structured'
      ? { kind: 'structured', value: { answer: 42 }, final: true }
      : { text: 'answer', final: true });
    expect(result.usage).toBeDefined();
    expect(result.transportFailure).toMatchObject({
      kind: 'aborted',
      exitCode: null,
    });
  });

  it.each([
    ['quota', 'quota'],
    ['ambiguous-limit', 'rate-limit'],
  ] as const)('classifies scripted %s through the process adapter', async (scenario, kind) => {
    await expect(new GrokCliEngine({
      ...options(),
      environment: { OBVERSA_TEST_GROK_SCENARIO: scenario },
    }).run(request(), () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: 'EngineError', kind,
    });
  });

  it('passes the public engine conformance kit through the real process adapter', async () => {
    const bin = executable();
    const report = await runEngineConformance({
      request: request({
        system: undefined,
        tools: ['read_file'],
        allowedTools: ['Read'],
      }),
      requested: {
        adapter: 'grok-cli',
        adapterVersion: '1.0.5',
        provider: 'xai',
        modelFamily: 'grok-4',
        model: 'grok-4-fixture',
        executable: bin,
        capabilities: ['read_file'],
      },
      effective: {
        adapter: 'grok-cli',
        adapterVersion: '1.0.5',
        provider: 'xai',
        modelFamily: 'grok-4',
        model: 'grok-4-fixture-effective',
        executable: bin,
        capabilities: ['read_file'],
      },
      open(scenario) {
        const binForScenario = scenario === 'missing-cli'
            ? join(temporaryDirectory('lines-grok-missing-'), 'grok')
            : bin;
        return new GrokCliEngine({
          ...options(binForScenario),
          environment: { OBVERSA_ENGINE_CONFORMANCE_SCENARIO: scenario },
        });
      },
    });

    expect(report).toEqual({ ok: true, cases: 16, failures: [] });
  });
});
