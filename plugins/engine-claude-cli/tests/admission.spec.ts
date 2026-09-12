import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EngineError, engineSelection, finalResultText,
  runEngineAdmissionConformance,
  type AgentRequest, type EngineAdmissionConformanceFixture,
  type EngineSelectionRecord,
} from '@obversa/engine';
import { ClaudeCliEngine } from '../src/index.ts';

const directories: string[] = [];
const fixtureSource = fileURLToPath(new URL('./fixtures/claude-cli.mjs', import.meta.url));
const signal = () => new AbortController().signal;
interface Invocation {
  kind: 'version' | 'model';
  executable: string;
  args: string[];
  stdin: string;
  cwd: string;
}
function invocations(path: string): Invocation[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Invocation)
    : [];
}
function withoutPrompt(request: AgentRequest): Omit<AgentRequest, 'prompt'> {
  const { prompt: _prompt, ...rest } = request;
  return rest;
}
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-admission-')));
  directories.push(dir);
  const aDir = join(dir, 'a');
  const bDir = join(dir, 'b');
  mkdirSync(aDir);
  mkdirSync(bDir);
  const a = join(aDir, 'claude');
  const b = join(bDir, 'claude');
  for (const path of [a, b]) {
    copyFileSync(fixtureSource, path);
    chmodSync(path, 0o755);
  }
  const calls = join(dir, 'calls.jsonl');
  const request: AgentRequest = {
    prompt: 'Check the fixture.', model: 'claude-test',
    tools: ['Read'], allowedTools: ['Read'], workspaceMode: 'read',
    cwd: dir, timeoutMs: 5_000, timeoutGraceMs: 100, leaf: true,
    env: { OBVERSA_TEST_CLAUDE_CALLS: calls },
  };
  const selected = (path = a, input = request): EngineSelectionRecord => engineSelection({
    adapter: 'claude-cli', adapterVersion: '2.1.261', provider: 'anthropic',
    executable: path, model: input.model?.replace(/\s*\[[^\]]+\]\s*$/, '') ?? null,
    capabilities: input.tools ?? [],
  });
  const modelCalls = (path?: string | null) => invocations(calls)
    .filter((call) => call.kind === 'model'
      && (path === undefined || call.executable === path)).length;
  return { dir, aDir, bDir, a, b, calls, request, selected, modelCalls };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('Claude static admission', () => {
  it('ordinary run observes the version and records requested capabilities', async () => {
    const f = fixture();
    const result = await new ClaudeCliEngine({ cliBinary: f.a }).run(f.request, () => {}, signal());
    expect(finalResultText(result)).toBe('PONG');
    expect(result.requested).toEqual(f.selected());
    expect(result.effective).toEqual(f.selected());
    expect(invocations(f.calls).map((call) => call.kind)).toEqual(['version', 'model']);
  });

  it('passes all separate admission-kit cases with real process markers', async () => {
    const f = fixture();
    const previous = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${f.aDir}${delimiter}${previous}`);
    const input: EngineAdmissionConformanceFixture = {
      request: f.request, selection: f.selected(),
      open: () => new ClaudeCliEngine(), modelCalls: f.modelCalls,
      cli: {
        moveLookup() { vi.stubEnv('PATH', `${f.bDir}${delimiter}${previous}`); },
        openDifferent: () => new ClaudeCliEngine({ cliBinary: f.b }),
        openMissing: () => new ClaudeCliEngine({ cliBinary: join(f.dir, 'absent') }),
      },
    };
    const report = await runEngineAdmissionConformance(input);
    expect('kind' in report).toBe(false);
    if ('kind' in report) throw new Error(`Unexpected ${report.kind}`);
    expect(report).toMatchObject({ ok: true, cases: 11, failures: [] });
    expect(f.modelCalls()).toBe(2);
    expect(f.modelCalls(f.a)).toBe(2);
    expect(f.modelCalls(f.b)).toBe(0);
  }, 30_000);

  it('admits without a model request or ordinary flags and observes only the numeric version', async () => {
    const f = fixture();
    const engine = new ClaudeCliEngine({ cliBinary: f.a, permissionMode: 'auto', cliArgs: ['--debug'] });
    expect(await engine.admit(withoutPrompt(f.request), signal())).toEqual(f.selected());
    expect(invocations(f.calls)).toEqual([{
      kind: 'version', executable: f.a, args: ['--version'], stdin: '', cwd: f.dir,
    }]);
    expect(f.modelCalls()).toBe(0);
  });

  it('retains an explicit symlink through replacement and ordinary work', async () => {
    const f = fixture();
    const link = join(f.dir, 'selected-wrapper');
    symlinkSync(f.a, link);
    const selected = await new ClaudeCliEngine({ cliBinary: link })
      .admit(withoutPrompt(f.request), signal());
    expect(selected.executable).toBe(link);
    const replacement = new ClaudeCliEngine({ cliBinary: link });
    expect(await replacement.admit(withoutPrompt(f.request), signal(), selected)).toEqual(selected);
    const result = await replacement.run(f.request, () => {}, signal());
    expect(result.requested).toEqual(selected);
    expect(f.modelCalls(link)).toBe(1);
  });

  it('restores saved A in a fresh bare-name instance after PATH becomes B', async () => {
    const f = fixture();
    const previous = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${f.aDir}${delimiter}${previous}`);
    const first = new ClaudeCliEngine();
    const selected = await first.admit(withoutPrompt(f.request), signal());
    vi.stubEnv('PATH', `${f.bDir}${delimiter}${previous}`);
    expect(await first.admit(withoutPrompt(f.request), signal(), selected)).toEqual(selected);
    const replacement = new ClaudeCliEngine();
    expect(await replacement.admit(withoutPrompt(f.request), signal(), selected)).toEqual(selected);
    await replacement.run(f.request, () => {}, signal());
    expect(f.modelCalls(f.a)).toBe(1);
    expect(invocations(f.calls).some((call) => call.executable === f.b)).toBe(false);
    await expect(new ClaudeCliEngine({ cliBinary: f.b })
      .admit(withoutPrompt(f.request), signal(), selected))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(f.modelCalls(f.b)).toBe(0);
  });

  it('rebuilds model, tools, workspace and normal flags after successful admission', async () => {
    const f = fixture();
    const engine = new ClaudeCliEngine({ cliBinary: f.a, permissionMode: 'auto' });
    await engine.admit(withoutPrompt(f.request), signal());
    const cwd = join(f.dir, 'next-workspace');
    mkdirSync(cwd);
    const next: AgentRequest = { ...f.request, cwd, model: 'claude-other [1m]',
      tools: [], allowedTools: [], workspaceMode: 'none', purpose: 'preflight' };
    const selected = await engine.admit(withoutPrompt(next), signal());
    expect(selected).toEqual(f.selected(f.a, next));
    const result = await engine.run(next, () => {}, signal());
    expect(result.requested).toEqual(selected);
    const model = invocations(f.calls).find((call) => call.kind === 'model')!;
    expect(model.cwd).toBe(cwd);
    expect(model.args[model.args.indexOf('--model') + 1]).toBe('claude-other');
    expect(model.args[model.args.indexOf('--tools') + 1]).toBe('');
    expect(model.args).not.toContain('--allowedTools');
    expect(model.args[model.args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(model.args[model.args.indexOf('--disallowedTools') + 1]).toBe('Task,Agent');
    expect(invocations(f.calls).filter((call) => call.kind === 'version')).toHaveLength(1);
  });

  it.each([
    { cwd: 'relative' }, { timeoutMs: 0 }, { timeoutGraceMs: -1 },
    { maxOutputBytes: -1 }, { maxMemoryBytes: 0 },
    { tools: ['Read', 'Read'] }, { env: { INVALID: 3 } },
  ])('rechecks invalid request values after version caching: %j', async (change) => {
    const f = fixture();
    const engine = new ClaudeCliEngine({ cliBinary: f.a });
    await engine.admit(withoutPrompt(f.request), signal());
    await expect(engine.admit({ ...withoutPrompt(f.request), ...change } as never, signal()))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(f.modelCalls()).toBe(0);
    expect(invocations(f.calls)).toHaveLength(1);
  });

  it('observes a replacement version and refuses a saved different version', async () => {
    const f = fixture();
    const selected = await new ClaudeCliEngine({ cliBinary: f.a })
      .admit(withoutPrompt(f.request), signal());
    const changed = { ...f.request, env: { ...f.request.env,
      OBVERSA_TEST_CLAUDE_VERSION_STDOUT: '9.8.7 (Claude Code)\n' } };
    await expect(new ClaudeCliEngine({ cliBinary: f.a })
      .admit(withoutPrompt(changed), signal(), selected))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(f.modelCalls()).toBe(0);
  });

  it('does not let saved selection bypass an invalid configured relative path', async () => {
    const f = fixture();
    await expect(new ClaudeCliEngine({ cliBinary: 'relative/claude' })
      .admit(withoutPrompt(f.request), signal(), f.selected()))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(invocations(f.calls)).toEqual([]);
  });

  it('accepts another well-formed observed version without inventing a floor', async () => {
    const f = fixture();
    f.request.env!.OBVERSA_TEST_CLAUDE_VERSION_STDOUT = '1.0.0 (Claude Code)\n';
    expect((await new ClaudeCliEngine({ cliBinary: f.a })
      .admit(withoutPrompt(f.request), signal())).adapterVersion).toBe('1.0.0');
  });

  it.each([
    ['malformed', 'invalid-config'], ['exit', 'unknown'],
    ['overflow', 'unknown'], ['hang', 'timeout'],
  ] as const)('refuses version %s without model work', async (mode, kind) => {
    const f = fixture();
    f.request.env!.OBVERSA_TEST_CLAUDE_VERSION_MODE = mode;
    if (mode === 'malformed') f.request.env!.OBVERSA_TEST_CLAUDE_VERSION_STDOUT = 'not a version\n';
    f.request.timeoutMs = mode === 'hang' ? 100 : 5_000;
    await expect(new ClaudeCliEngine({ cliBinary: f.a })
      .admit(withoutPrompt(f.request), signal())).rejects.toMatchObject({ name: 'EngineError', kind });
    expect(f.modelCalls()).toBe(0);
  });

  it('shares one successful version observation across concurrent admission', async () => {
    const f = fixture();
    f.request.env!.OBVERSA_TEST_CLAUDE_VERSION_MODE = 'slow';
    const engine = new ClaudeCliEngine({ cliBinary: f.a });
    const [a, b] = await Promise.all([
      engine.admit(withoutPrompt(f.request), signal()),
      engine.admit(withoutPrompt(f.request), signal()),
    ]);
    expect(a).toEqual(f.selected());
    expect(b).toEqual(a);
    expect(invocations(f.calls).map((call) => call.kind)).toEqual(['version']);
  });

  it('retries a failed observation only on a later explicit admission call', async () => {
    const f = fixture();
    f.request.env!.OBVERSA_TEST_CLAUDE_VERSION_MODE = 'fail-once';
    const engine = new ClaudeCliEngine({ cliBinary: f.a });
    await expect(engine.admit(withoutPrompt(f.request), signal()))
      .rejects.toMatchObject({ kind: 'unknown' });
    expect(invocations(f.calls)).toHaveLength(1);
    expect(await engine.admit(withoutPrompt(f.request), signal())).toEqual(f.selected());
    expect(invocations(f.calls).map((call) => call.kind)).toEqual(['version', 'version']);
    expect(f.modelCalls()).toBe(0);
  });

  it('aborts an active version command without a model call', async () => {
    const f = fixture();
    f.request.env!.OBVERSA_TEST_CLAUDE_VERSION_MODE = 'hang';
    const controller = new AbortController();
    const pending = new ClaudeCliEngine({ cliBinary: f.a })
      .admit(withoutPrompt(f.request), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    const deadline = Date.now() + 4_000;
    while (invocations(f.calls).length === 0 && Date.now() < deadline) await delay(10);
    controller.abort();
    await rejected;
    expect(invocations(f.calls).map((call) => call.kind)).toEqual(['version']);
    expect(f.modelCalls()).toBe(0);
  });

  it('does not start a command for an already aborted admission', async () => {
    const f = fixture();
    await expect(new ClaudeCliEngine({ cliBinary: f.a })
      .admit(withoutPrompt(f.request), AbortSignal.abort()))
      .rejects.toMatchObject({ kind: 'aborted' });
    expect(invocations(f.calls)).toEqual([]);
  });

  it('reports a removed retained path as missing-cli without switching to B', async () => {
    const f = fixture();
    const engine = new ClaudeCliEngine({ cliBinary: f.a });
    const selected = await engine.admit(withoutPrompt(f.request), signal());
    rmSync(f.a);
    for (const action of [
      () => engine.admit(withoutPrompt(f.request), signal(), selected),
      () => engine.run(f.request, () => {}, signal()),
      () => new ClaudeCliEngine().admit(withoutPrompt(f.request), signal(), selected),
    ]) await expect(action()).rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
    expect(f.modelCalls()).toBe(0);
  });

  it('does not guess missing-cli when a runnable script has a missing interpreter', async () => {
    const f = fixture();
    const bad = join(f.dir, 'bad-interpreter');
    writeFileSync(bad, `#!${join(f.dir, 'absent-interpreter')}\n`);
    chmodSync(bad, 0o755);
    const engine = new ClaudeCliEngine({ cliBinary: bad });
    await expect(engine.admit(withoutPrompt(f.request), signal()))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'unknown' });
    expect(f.modelCalls()).toBe(0);
  });

  it.each([0, 2])('keeps the observed model and existing final evidence on exit %s', async (exit) => {
    const f = fixture();
    f.request.env!.OBVERSA_TEST_CLAUDE_EFFECTIVE_MODEL = 'observed-other-model';
    f.request.env!.OBVERSA_TEST_CLAUDE_MODEL_EXIT = String(exit);
    const result = await new ClaudeCliEngine({ cliBinary: f.a }).run(f.request, () => {}, signal());
    expect(finalResultText(result)).toBe('PONG');
    expect(result.requested).toEqual(f.selected());
    expect(result.effective).toEqual(engineSelection({ ...f.selected(), model: 'observed-other-model' }));
    expect(result.usage).toEqual({ kind: 'reported', inputTokens: 3, outputTokens: 1 });
    if (exit !== 0) expect(result.transportFailure).toMatchObject({ kind: 'unknown', exitCode: exit });
    else expect(result.transportFailure).toBeUndefined();
  });

  it('constructs a missing path and returns typed admit and run failures', async () => {
    const f = fixture();
    const missing = join(f.dir, 'missing');
    let engine: ClaudeCliEngine | undefined;
    expect(() => { engine = new ClaudeCliEngine({ cliBinary: missing }); }).not.toThrow();
    for (const action of [
      () => engine!.admit(withoutPrompt(f.request), signal()),
      () => engine!.run(f.request, () => {}, signal()),
      () => new ClaudeCliEngine({ cliBinary: missing }).run(f.request, () => {}, signal()),
    ]) {
      let failure: unknown;
      try { await action(); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(EngineError);
      expect(failure).toMatchObject({ kind: 'missing-cli' });
    }
    expect(invocations(f.calls)).toEqual([]);
  });
});
