import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineError,
  EngineIncompleteResultError,
  finalResultText,
  type AgentRequest,
  type EngineStreamEvent,
} from '@obversa/api';
import { DevinCliEngine, buildDevinArgs, devin } from '../src/index.ts';

const source = fileURLToPath(new URL('./fixtures/devin-cli.mjs', import.meta.url));
const directories: string[] = [];
const signal = () => new AbortController().signal;
const files = { promptFile: '/tmp/prompt.md', exportFile: '/tmp/conversation.json', configFile: '/tmp/config.json' };

interface Invocation {
  kind: 'version' | 'model';
  args: string[];
  stdin: string;
  cwd: string;
  pid: number;
  prompt: string | null;
  config: string | null;
  env: Record<string, string | null>;
}

function fixture(scenario?: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'devin-cli-')));
  directories.push(dir);
  const bin = join(dir, 'devin');
  copyFileSync(source, bin);
  chmodSync(bin, 0o755);
  const calls = join(dir, 'calls.jsonl');
  const request: AgentRequest = {
    prompt: 'What does a.js export?', model: 'swe-2-max', tools: ['read'], allowedTools: ['read'],
    workspaceMode: 'read', cwd: dir, timeoutMs: 5_000, timeoutGraceMs: 100,
    env: { OBVERSA_TEST_DEVIN_CALLS: calls, OBVERSA_TEST_DEVIN_SCENARIO: scenario ?? '' },
  };
  const models = (): Invocation[] => (existsSync(calls)
    ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation)
    : []).filter((call) => call.kind === 'model');
  return { dir, bin, calls, request, models, engine: new DevinCliEngine({ cliBinary: bin }) };
}

/** A home folder for the test, holding a Devin config file with this text when one is given. */
function home(config?: string): { dir: string; configFile: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'devin-home-')));
  directories.push(dir);
  const configFile = join(dir, '.config', 'devin', 'config.json');
  if (config !== undefined) {
    mkdirSync(join(dir, '.config', 'devin'), { recursive: true });
    writeFileSync(configFile, config);
  }
  vi.stubEnv('HOME', dir);
  return { dir, configFile };
}

const REVIEW_COMMANDS = ['git diff', 'git log'];
const REVIEW_RULES = ['Exec(git diff)', 'Exec(git log)'];

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Devin arguments', () => {
  it('runs a read-only step with the auto permission mode', () => {
    expect(buildDevinArgs({ prompt: 'x', tools: ['read'], workspaceMode: 'read', model: 'swe-2-max' }, {}, files))
      .toEqual([
        '-p', '--prompt-file', files.promptFile, '--export', files.exportFile,
        '--permission-mode', 'auto', '--respect-workspace-trust', 'false',
        '--config', files.configFile, '--model', 'swe-2-max',
      ]);
  });

  it('runs a step that may write with the accept-edits permission mode', () => {
    const args = buildDevinArgs({ prompt: 'x', tools: ['read', 'edit'], workspaceMode: 'write' }, {}, files);
    expect(flag(args, '--permission-mode')).toBe('accept-edits');
  });

  it('keeps the default arguments for a step that may write', () => {
    expect(buildDevinArgs({ prompt: 'x', tools: ['read', 'edit'], workspaceMode: 'write', model: 'swe-2-max' }, {}, files))
      .toEqual([
        '-p', '--prompt-file', files.promptFile, '--export', files.exportFile,
        '--permission-mode', 'accept-edits', '--respect-workspace-trust', 'false',
        '--config', files.configFile, '--model', 'swe-2-max',
      ]);
  });

  it.each(['auto', 'accept-edits', 'smart', 'dangerous'] as const)(
    'passes the %s permission mode to a step that may write',
    (permissionMode) => {
      const args = buildDevinArgs({ prompt: 'x', tools: ['read', 'edit'], workspaceMode: 'write' }, { permissionMode }, files);
      expect(flag(args, '--permission-mode')).toBe(permissionMode);
    },
  );

  it('keeps a read step on auto when the permission mode is auto', () => {
    expect(flag(buildDevinArgs({ prompt: 'x', tools: ['read'], workspaceMode: 'read' }, { permissionMode: 'auto' }, files),
      '--permission-mode')).toBe('auto');
  });

  it.each([
    ['accept-edits', 'read'],
    ['smart', 'read'],
    ['dangerous', 'read'],
    ['dangerous', undefined],
  ] as const)('refuses the %s permission mode in a read step (workspace mode %s)', (permissionMode, workspaceMode) => {
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'], ...(workspaceMode ? { workspaceMode } : {}) },
      { permissionMode }, files)).toThrow(expect.objectContaining({
      kind: 'invalid-config',
      message: `devin permission mode ${permissionMode} can edit files or run commands, so a read step cannot use it; leave permissionMode unset or set it to auto`,
    }));
  });

  it('refuses a permission mode Devin does not have', () => {
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'], workspaceMode: 'write' },
      { permissionMode: 'bypassPermissions' as never }, files)).toThrow(expect.objectContaining({
      kind: 'invalid-config',
      message: 'devin permission mode must be auto, accept-edits, smart or dangerous',
    }));
  });

  it('uses the read-only mode when the step names no workspace mode', () => {
    expect(flag(buildDevinArgs({ prompt: 'x', tools: ['read'] }, {}, files), '--permission-mode')).toBe('auto');
  });

  it('passes the engine default model and leaves the default sentinel to Devin', () => {
    expect(flag(buildDevinArgs({ prompt: 'x', tools: ['read'] }, { defaultModel: 'gpt-6-sol-low' }, files), '--model'))
      .toBe('gpt-6-sol-low');
    expect(buildDevinArgs({ prompt: 'x', tools: ['read'] }, {}, files)).not.toContain('--model');
    expect(buildDevinArgs({ prompt: 'x', tools: ['read'], model: 'default' }, {}, files)).not.toContain('--model');
  });

  it('runs clean by default, and on the person\'s own setup with clean: false', () => {
    for (const opts of [{}, { clean: true }]) {
      expect(flag(buildDevinArgs({ prompt: 'x', tools: ['read'] }, opts, files), '--config')).toBe('/tmp/config.json');
    }
    expect(buildDevinArgs({ prompt: 'x', tools: ['read'] }, { clean: false }, files)).not.toContain('--config');
    expect(buildDevinArgs({ prompt: 'x', tools: ['read', 'edit'], workspaceMode: 'write' },
      { clean: false, commands: REVIEW_COMMANDS }, files)).not.toContain('--config');
    const withoutConfig = { promptFile: files.promptFile, exportFile: files.exportFile };
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'] }, {}, withoutConfig)).toThrow(
      expect.objectContaining({ kind: 'invalid-config', message: 'devin clean mode requires an empty config file' }),
    );
  });

  it('passes a config file to a read step with commands, in clean mode and with clean: false', () => {
    for (const clean of [true, false]) {
      expect(flag(buildDevinArgs({ prompt: 'x', tools: ['read'] }, { clean, commands: REVIEW_COMMANDS }, files), '--config'))
        .toBe(files.configFile);
    }
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'] }, { clean: false, commands: REVIEW_COMMANDS },
      { promptFile: files.promptFile, exportFile: files.exportFile })).toThrow(
      expect.objectContaining({ kind: 'invalid-config', message: 'devin needs a config file for this step' }),
    );
  });

  it('leaves a write step\'s arguments as they are when the engine has commands', () => {
    const write: AgentRequest = { prompt: 'x', tools: ['read', 'edit'], workspaceMode: 'write' };
    for (const clean of [true, false]) {
      expect(buildDevinArgs(write, { clean, commands: REVIEW_COMMANDS }, files)).toEqual(buildDevinArgs(write, { clean }, files));
    }
  });

  it.each(['&', ';', '|', '>', '<', '`', '$', '\n'])('refuses a command with the shell character %j', (character) => {
    const entry = `git diff ${character} touch x`;
    const message = `devin commands entry ${JSON.stringify(entry)} has a shell character `
      + '(&, ;, |, <, >, `, $ or a newline), so it cannot be a read-only command';
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'] }, { commands: ['git log', entry] }, files))
      .toThrow(expect.objectContaining({ kind: 'invalid-config', message }));
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'], allowedTools: ['Exec(git log)', `Exec(${entry})`] }, {}, files))
      .toThrow(expect.objectContaining({ kind: 'invalid-config', message }));
    expect(() => new DevinCliEngine({ commands: [entry] })).toThrow(message);
    expect(() => devin('swe-2-max', { commands: [entry] })).toThrow(message);
  });

  it.each(['', '  '])('refuses an empty command %j', (entry) => {
    const message = `devin commands entry ${JSON.stringify(entry)} is empty`;
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'] }, { commands: [entry] }, files))
      .toThrow(expect.objectContaining({ kind: 'invalid-config', message }));
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'], allowedTools: [`Exec(${entry})`] }, {}, files))
      .toThrow(expect.objectContaining({ kind: 'invalid-config', message }));
    expect(() => new DevinCliEngine({ commands: [entry] })).toThrow(message);
    expect(() => devin('swe-2-max', { commands: [entry] })).toThrow(message);
  });

  it.each<[string, AgentRequest]>([
    ['a step with no workspace', { prompt: 'x', tools: ['read'], workspaceMode: 'none' }],
    ['a step that turns every tool off', { prompt: 'x', tools: [] }],
    ['a read-only step with no tools', { prompt: 'x', tools: [], workspaceMode: 'read' }],
  ])('refuses %s', (_name, request) => {
    expect(() => buildDevinArgs(request, {}, files)).toThrow(
      expect.objectContaining({ name: 'EngineError', kind: 'invalid-config' }),
    );
  });
});

describe.runIf(process.platform !== 'win32')('Devin process', () => {
  it('runs one fresh devin -p process per attempt with the prompt in a file', async () => {
    const f = fixture();
    const request = { ...f.request, system: 'Answer briefly.' };
    await f.engine.run(request, () => {}, signal());
    await f.engine.run(request, () => {}, signal());
    const models = f.models();
    expect(models).toHaveLength(2);
    expect(models[0]!.pid).not.toBe(models[1]!.pid);
    for (const call of models) {
      expect(call.prompt).toBe('Answer briefly.\n\n---\n\nWhat does a.js export?');
      expect(call.stdin).toBe('');
      expect(call.cwd).toBe(f.dir);
      expect(call.args).not.toContain('-c');
      expect(call.args).not.toContain('-r');
    }
  });

  it('keeps the person\'s own environment and adds the step\'s values', async () => {
    vi.stubEnv('OBVERSA_TEST_PERSON', 'their-value');
    const f = fixture();
    await f.engine.run({
      ...f.request,
      env: { ...f.request.env, OBVERSA_TEST_REQUEST: 'step-value' },
      attempt: { leaf: true, leafId: 'leaf-1', label: 'review', path: ['review'], iteration: 1 },
    }, () => {}, signal());
    expect(f.models()[0]!.env).toEqual({
      HOME: process.env.HOME,
      OBVERSA_TEST_PERSON: 'their-value',
      OBVERSA_TEST_REQUEST: 'step-value',
      OBVERSA_LEAF_ID: 'leaf-1',
    });
  });

  it('returns the final agent message, the ordered parts and the reported model', async () => {
    const f = fixture('cached-usage');
    const events: EngineStreamEvent[] = [];
    const result = await f.engine.run(f.request, (event) => events.push(event), signal());
    expect(finalResultText(result)).toBe('answer');
    expect(result.parts).toEqual([
      { kind: 'assistant', text: 'draft', final: false },
      { kind: 'assistant', text: 'answer', final: true },
    ]);
    expect(result.usage).toEqual({
      kind: 'reported', inputTokens: 22833, outputTokens: 208, cacheReadInputTokens: 9216,
    });
    expect(result.requested).toMatchObject({
      adapter: 'devin-cli', provider: 'cognition', modelFamily: 'swe', model: 'swe-2-max',
      adapterVersion: '3000.11.3', executable: f.bin, capabilities: ['read'],
    });
    expect(result.effective).toEqual(result.requested);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
  });

  it('records the model Devin reports when it differs from the request', async () => {
    const f = fixture('other-model');
    const result = await f.engine.run(f.request, () => {}, signal());
    expect(result.effective).toMatchObject({ model: 'swe-1-7-lightning', modelFamily: 'swe' });
    expect(result.requested).toMatchObject({ model: 'swe-2-max' });
  });

  it('leaves usage unknown when Devin reports none', async () => {
    const f = fixture();
    const result = await f.engine.run(f.request, () => {}, signal());
    expect(result.usage).toEqual({ kind: 'unknown' });
  });

  it('runs a seat that leaves the model to Devin and records the model Devin reports', async () => {
    const f = fixture();
    const seat = devin();
    const engine = new DevinCliEngine({ cliBinary: f.bin });
    const result = await engine.run({ ...f.request, model: seat.identity.model }, () => {}, signal());
    expect(f.models()[0]!.args).not.toContain('--model');
    expect(result.requested).toMatchObject({ model: null, modelFamily: null });
    expect(result.effective).toMatchObject({ model: 'swe-2-max', modelFamily: 'swe' });
  });

  it('forwards Devin\'s tool calls in order', async () => {
    const f = fixture('tool-events');
    const events: EngineStreamEvent[] = [];
    await f.engine.run(f.request, (event) => events.push(event), signal());
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      { type: 'tool', name: 'read', phase: 'use' },
      { type: 'tool', name: 'read', phase: 'result' },
    ]);
  });

  it('answers a read step whose model only reads', async () => {
    const f = fixture('tool-events');
    const result = await f.engine.run(f.request, () => {}, signal());
    expect(flag(f.models()[0]!.args, '--permission-mode')).toBe('auto');
    expect(finalResultText(result)).toBe('answer');
  });

  it('passes the engine\'s permission mode to Devin for a step that may write', async () => {
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, permissionMode: 'dangerous' });
    const result = await engine.run({ ...f.request, tools: ['read', 'edit', 'exec'], workspaceMode: 'write' }, () => {}, signal());
    expect(flag(f.models()[0]!.args, '--permission-mode')).toBe('dangerous');
    expect(finalResultText(result)).toBe('answer');
  });

  it('runs a step that may write with accept-edits when no permission mode is set', async () => {
    const f = fixture();
    await f.engine.run({ ...f.request, workspaceMode: 'write' }, () => {}, signal());
    expect(flag(f.models()[0]!.args, '--permission-mode')).toBe('accept-edits');
  });

  it('refuses a read step under a permission mode that can write, before any process starts', async () => {
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, permissionMode: 'smart' });
    const error = await engine.run(f.request, () => {}, signal()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect((error as Error).message).toContain('a read step cannot use it');
    expect(existsSync(f.calls)).toBe(false);
  });

  it('with refusalRetries: 0, ends a read step after Devin refuses a tool and says why', async () => {
    const f = fixture('refused-tool');
    const engine = new DevinCliEngine({ cliBinary: f.bin, refusalRetries: 0 });
    const error = await engine.run(f.request, () => {}, signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineIncompleteResultError);
    expect((error as Error).message).toMatch(
      /^devin refused a tool in read mode 1 time, which ends its run without an answer; no file changed: /,
    );
    expect((error as Error).message).toContain('rejected a tool call that requires confirmation');
    expect((error as EngineIncompleteResultError).evidence.parts).toEqual([]);
    expect(f.models()).toHaveLength(1);
  });

  it('continues a read step\'s session after Devin refuses a command, and the continued run\'s answer is the step\'s', async () => {
    const f = fixture('refused-command-once');
    const events: EngineStreamEvent[] = [];
    const result = await f.engine.run(f.request, (event) => events.push(event), signal());
    expect(finalResultText(result)).toBe('answer');
    expect(result.parts).toEqual([
      { kind: 'assistant', text: 'Searching.', final: false },
      { kind: 'assistant', text: 'answer', final: true },
    ]);
    const [first, second] = f.models();
    expect(f.models()).toHaveLength(2);
    expect(flag(first!.args, '-r')).toBeUndefined();
    expect(flag(second!.args, '-r')).toBe(`session-${first!.pid}`);
    for (const name of ['--config', '--permission-mode', '--respect-workspace-trust', '--model']) {
      expect(flag(second!.args, name)).toBe(flag(first!.args, name));
    }
    expect(flag(second!.args, '--permission-mode')).toBe('auto');
    expect(second!.config).toBe(first!.config);
    expect(flag(second!.args, '--export')).not.toBe(flag(first!.args, '--export'));
    expect(events.filter((event) => event.type !== 'usage')).toEqual([
      { type: 'text', delta: 'Searching.' },
      { type: 'tool', name: 'exec', phase: 'use' },
      { type: 'tool', name: 'exec', phase: 'result' },
      { type: 'tool', name: 'devin --resume', phase: 'use', target: 'refused: rg word-' },
      { type: 'tool', name: 'devin --resume', phase: 'result', target: 'refused: rg word-' },
      { type: 'text', delta: 'answer' },
      { type: 'tool', name: 'read', phase: 'use' },
      { type: 'tool', name: 'read', phase: 'result' },
    ]);
  });

  it('reports the usage of every run in a continued attempt', async () => {
    const f = fixture('refused-command-once');
    const events: EngineStreamEvent[] = [];
    const result = await f.engine.run(f.request, (event) => events.push(event), signal());
    // The first run reports 5 and 3 tokens, the continued run 7 and 2.
    expect(result.usage).toEqual({ kind: 'reported', inputTokens: 12, outputTokens: 5 });
    expect(events.filter((event) => event.type === 'usage')).toEqual([
      { type: 'usage', usage: result.usage, model: 'swe-2-max' },
    ]);
  });

  it.each<[string, readonly string[] | undefined, string[] | undefined, string]>([
    ['no commands', undefined, undefined,
      'That tool call was refused: it is not allowed in this step. '
      + 'This step may run no shell command. Finish the task with your file reading tools only.'],
    ['the engine\'s commands', REVIEW_COMMANDS, undefined,
      'That tool call was refused: it is not allowed in this step. '
      + 'The only shell commands this step may run are `git diff`, `git log`. '
      + 'Finish the task with your file reading tools and those commands only.'],
    ['the step\'s own commands', REVIEW_COMMANDS, ['read', 'Exec(rg)'],
      'That tool call was refused: it is not allowed in this step. '
      + 'The only shell commands this step may run are `rg`. '
      + 'Finish the task with your file reading tools and those commands only.'],
  ])('names %s in the message that continues the session', async (_case, commands, allowedTools, message) => {
    const f = fixture('refused-command-once');
    const engine = new DevinCliEngine({ cliBinary: f.bin, ...(commands ? { commands } : {}) });
    await engine.run({ ...f.request, ...(allowedTools ? { allowedTools } : {}) }, () => {}, signal());
    expect(f.models()[1]!.prompt).toBe(message);
  });

  it.each([
    [undefined, 3],
    [1, 2],
  ] as const)('with refusalRetries %s, stops after %i refusals and says how many', async (refusalRetries, runs) => {
    const f = fixture('refused-tool');
    const engine = new DevinCliEngine({ cliBinary: f.bin, ...(refusalRetries === undefined ? {} : { refusalRetries }) });
    const error = await engine.run(f.request, () => {}, signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineIncompleteResultError);
    expect((error as Error).message).toMatch(new RegExp(
      `^devin refused a tool in read mode ${runs} times, which ends its run without an answer; no file changed: `,
    ));
    const models = f.models();
    expect(models).toHaveLength(runs);
    expect(models.slice(1).map((call) => flag(call.args, '-r'))).toEqual(models.slice(1).map(() => `session-${models[0]!.pid}`));
  });

  it('counts every continued run against the attempt\'s output limit', async () => {
    // Each refused run prints a 91-byte warning: the first fits, the second goes over what is left.
    const f = fixture('refused-tool');
    const error = await f.engine.run({ ...f.request, maxOutputBytes: 150 }, () => {}, signal())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(f.models()).toHaveLength(2);
  });

  it('counts every continued run against the attempt\'s time limit', async () => {
    // Each refused run takes 600 ms, so the second run starts with about 400 ms left and times out.
    const f = fixture('refused-tool');
    const error = await f.engine.run({
      ...f.request, timeoutMs: 1_000, env: { ...f.request.env, OBVERSA_TEST_DEVIN_DELAY_MS: '600' },
    }, () => {}, signal()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'EngineError', kind: 'timeout' });
    expect(f.models()).toHaveLength(2);
  });

  it.each([-1, 1.5, Number.NaN])('refuses refusalRetries %s', (refusalRetries) => {
    const message = 'devin refusalRetries must be a whole number of 0 or more';
    expect(() => new DevinCliEngine({ refusalRetries })).toThrow(message);
    expect(() => devin('swe-2-max', { refusalRetries })).toThrow(message);
  });

  it.each([
    ['a read step with no refused tool', 'no-answer', 'read', 'auto', undefined],
    ['a write step', 'refused-tool', 'write', 'accept-edits', undefined],
    ['a write step under its own permission mode', 'refused-tool', 'write', 'smart', 'smart'],
    ['a write step under auto', 'refused-tool', 'write', 'auto', 'auto'],
  ] as const)('keeps the general error, and never continues the session, when %s ends without an answer', async (_case, scenario, mode, permission, option) => {
    const f = fixture(scenario);
    const engine = new DevinCliEngine({ cliBinary: f.bin, ...(option ? { permissionMode: option } : {}) });
    const error = await engine.run({ ...f.request, workspaceMode: mode }, () => {}, signal())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineIncompleteResultError);
    expect((error as Error).message).toContain(`devin ended without a final answer under permission mode ${permission}`);
    expect(f.models()).toHaveLength(1);
  });

  it.each([
    ['missing-export', 'unknown', 'no readable conversation export'],
    ['malformed-export', 'unknown', 'no readable conversation export'],
    ['auth', 'auth', '401 unauthorized'],
    ['model-unavailable', 'model-unavailable', 'unknown model'],
  ] as const)('classifies the %s failure', async (scenario, kind, words) => {
    const f = fixture(scenario);
    const error = await f.engine.run(f.request, () => {}, signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineError);
    expect((error as EngineError).kind).toBe(kind);
    expect((error as Error).message).toContain(words);
  });

  it('times out a run that never ends', async () => {
    const f = fixture('timeout');
    const error = await f.engine.run({ ...f.request, timeoutMs: 300 }, () => {}, signal())
      .catch((caught: unknown) => caught);
    expect((error as EngineError).kind).toBe('timeout');
  });

  it('keeps a final answer and reports the later nonzero exit', async () => {
    const f = fixture('late-final');
    const result = await f.engine.run(f.request, () => {}, signal());
    expect(finalResultText(result)).toBe('answer');
    expect(result.transportFailure).toMatchObject({ kind: 'unknown', exitCode: 7 });
  });

  it('refuses a version it cannot read before any model call', async () => {
    const f = fixture();
    const error = await f.engine.run({
      ...f.request, env: { ...f.request.env, OBVERSA_TEST_DEVIN_VERSION_STDOUT: 'devin something\n' },
    }, () => {}, signal()).catch((caught: unknown) => caught);
    expect((error as EngineError).kind).toBe('invalid-config');
    expect(f.models()).toHaveLength(0);
  });

  it('reports a missing CLI', async () => {
    const f = fixture();
    const error = await new DevinCliEngine({ cliBinary: join(f.dir, 'absent') })
      .run(f.request, () => {}, signal()).catch((caught: unknown) => caught);
    expect((error as EngineError).kind).toBe('missing-cli');
  });

  it('refuses a step with no workspace before any process starts', async () => {
    const f = fixture();
    const error = await f.engine.run({ ...f.request, workspaceMode: 'none' }, () => {}, signal())
      .catch((caught: unknown) => caught);
    expect((error as EngineError).kind).toBe('invalid-config');
    expect(existsSync(f.calls)).toBe(false);
  });

  it('refuses effort on the seat and the engine, naming why', () => {
    const why = 'devin has no reasoning effort switch, so it cannot take effort; leave effort unset';
    expect(() => devin('swe-2-max', { effort: 'high' })).toThrow(why);
    expect(() => new DevinCliEngine({ effort: 'high' })).toThrow(why);
  });

  it('allows each command in the empty config file of a clean read step, and records only the step\'s tools', async () => {
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, commands: REVIEW_COMMANDS });
    const result = await engine.run(f.request, () => {}, signal());
    expect(JSON.parse(f.models()[0]!.config!)).toEqual({ permissions: { allow: REVIEW_RULES } });
    expect(result.requested.capabilities).toEqual(['read']);
    expect(result.effective.capabilities).toEqual(['read']);
  });

  it('adds the commands to a copy of the person\'s own config with clean: false, and never writes theirs', async () => {
    const own = JSON.stringify({ theme_mode: 'dark', permissions: { allow: ['Read(docs/**)'], deny: ['Exec(rm)'] } });
    const { configFile } = home(own);
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, clean: false, commands: REVIEW_COMMANDS });
    await engine.run(f.request, () => {}, signal());
    const call = f.models()[0]!;
    expect(flag(call.args, '--config')).not.toBe(configFile);
    expect(JSON.parse(call.config!)).toEqual({
      theme_mode: 'dark',
      permissions: { allow: ['Read(docs/**)', ...REVIEW_RULES], deny: ['Exec(rm)'] },
    });
    expect(readFileSync(configFile, 'utf8')).toBe(own);
  });

  it('allows the commands with clean: false when the person has no Devin config file', async () => {
    const { configFile } = home();
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, clean: false, commands: REVIEW_COMMANDS });
    await engine.run(f.request, () => {}, signal());
    expect(JSON.parse(f.models()[0]!.config!)).toEqual({ permissions: { allow: REVIEW_RULES } });
    expect(existsSync(configFile)).toBe(false);
  });

  it.each([
    ['is not JSON', '{ "theme_mode": '],
    ['is not an object', '[]'],
    ['has an allow entry that is not a list', '{ "permissions": { "allow": "Exec(ls)" } }'],
  ])('refuses commands with clean: false when the person\'s config file %s', async (_case, own) => {
    home(own);
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, clean: false, commands: REVIEW_COMMANDS });
    const error = await engine.run(f.request, () => {}, signal()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(f.models()).toHaveLength(0);
  });

  it('leaves the config as it is without commands', async () => {
    home(JSON.stringify({ theme_mode: 'dark' }));
    const f = fixture();
    await f.engine.run(f.request, () => {}, signal());
    await new DevinCliEngine({ cliBinary: f.bin, clean: false }).run(f.request, () => {}, signal());
    const [clean, own] = f.models();
    expect(clean!.config).toBe('{}\n');
    expect(own!.args).not.toContain('--config');
    expect(own!.config).toBeNull();
  });

  it('allows a read step\'s own Exec rules in place of the engine\'s commands, and the engine\'s when it has none', async () => {
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, commands: REVIEW_COMMANDS });
    await engine.run({ ...f.request, allowedTools: ['read', 'Exec(rg)', 'Exec(git status)'] }, () => {}, signal());
    await engine.run({ ...f.request, allowedTools: ['read', 'exec'] }, () => {}, signal());
    const [own, fallback] = f.models();
    expect(JSON.parse(own!.config!)).toEqual({ permissions: { allow: ['Exec(rg)', 'Exec(git status)'] } });
    expect(JSON.parse(fallback!.config!)).toEqual({ permissions: { allow: REVIEW_RULES } });
  });

  it('gives a write step no commands in its config file', async () => {
    const f = fixture();
    const engine = new DevinCliEngine({ cliBinary: f.bin, commands: REVIEW_COMMANDS });
    await engine.run({ ...f.request, workspaceMode: 'write', allowedTools: ['Exec(rg)'] }, () => {}, signal());
    expect(f.models()[0]!.config).toBe('{}\n');
  });

  it('declares the commands in the seat\'s tools, and a read or write step on the seat records exactly those tools', async () => {
    const f = fixture();
    const seat = devin('swe-2-max', { commands: [...REVIEW_COMMANDS, 'git diff'] });
    expect(seat.identity.tools).toEqual(['read', 'edit', 'exec', ...REVIEW_RULES]);
    const engine = new DevinCliEngine({ cliBinary: f.bin, commands: [...REVIEW_COMMANDS, 'git diff'] });
    const read = await engine.run({ ...f.request, tools: [...seat.identity.tools] }, () => {}, signal());
    const write = await engine.run(
      { ...f.request, tools: [...seat.identity.tools], workspaceMode: 'write' }, () => {}, signal(),
    );
    expect(read.requested.capabilities).toEqual(seat.identity.tools);
    expect(write.requested.capabilities).toEqual(seat.identity.tools);
    const [readCall, writeCall] = f.models();
    expect(JSON.parse(readCall!.config!)).toEqual({ permissions: { allow: REVIEW_RULES } });
    expect(writeCall!.config).toBe('{}\n');
  });

  it('refuses a step that sets effort before any process starts', async () => {
    const f = fixture();
    const error = await f.engine.run({ ...f.request, effort: 'high' }, () => {}, signal())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      kind: 'invalid-config',
      message: 'devin has no reasoning effort switch, so it cannot take effort; leave effort unset',
    });
    expect(existsSync(f.calls)).toBe(false);
  });
});
