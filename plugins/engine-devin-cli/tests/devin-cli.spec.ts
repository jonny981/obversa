import {
  chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync,
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
    const withoutConfig = { promptFile: files.promptFile, exportFile: files.exportFile };
    expect(() => buildDevinArgs({ prompt: 'x', tools: ['read'] }, {}, withoutConfig)).toThrow(
      expect.objectContaining({ kind: 'invalid-config', message: 'devin clean mode requires an empty config file' }),
    );
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

  it('fails clearly when a refused tool leaves Devin with no answer', async () => {
    const f = fixture('refused-tool');
    const error = await f.engine.run(f.request, () => {}, signal()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EngineIncompleteResultError);
    expect((error as Error).message).toContain('without a final answer under permission mode auto');
    expect((error as Error).message).toContain('rejected a tool call that requires confirmation');
    expect((error as EngineIncompleteResultError).evidence.parts).toEqual([]);
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
});
