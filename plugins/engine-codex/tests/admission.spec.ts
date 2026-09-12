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
  engineSelection, finalResultText, runEngineAdmissionConformance,
  type AgentRequest, type EngineAdmissionConformanceFixture,
  type EngineSelectionRecord,
} from '@obversa/engine';
import { CodexEngine } from '../src/index.ts';

const directories: string[] = [];
const source = fileURLToPath(new URL('./fixtures/codex-cli.mjs', import.meta.url));
const signal = () => new AbortController().signal;
const emptyToolsMessage = 'codex cannot honor tools: []; choose an engine that supports disabling tools';
interface Invocation {
  kind: 'version' | 'model'; executable: string; args: string[]; stdin: string; cwd: string;
}
function invocations(path: string): Invocation[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation) : [];
}
function withoutPrompt(request: AgentRequest): Omit<AgentRequest, 'prompt'> {
  const { prompt: _prompt, ...rest } = request;
  return rest;
}
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-admission-')));
  directories.push(dir);
  const aDir = join(dir, 'a');
  const bDir = join(dir, 'b');
  mkdirSync(aDir); mkdirSync(bDir);
  const a = join(aDir, 'codex');
  const b = join(bDir, 'codex');
  for (const path of [a, b]) { copyFileSync(source, path); chmodSync(path, 0o755); }
  const calls = join(dir, 'calls.jsonl');
  const request: AgentRequest = {
    prompt: 'Check this fixture.', model: 'gpt-test', tools: ['Read'], allowedTools: ['Read'],
    workspaceMode: 'read', cwd: dir, timeoutMs: 5_000, timeoutGraceMs: 100, leaf: true,
    env: { OBVERSA_TEST_CODEX_CALLS: calls },
  };
  const selected = (path = a, input = request): EngineSelectionRecord => engineSelection({
    adapter: 'codex', adapterVersion: '0.153.2', provider: 'openai', executable: path,
    model: input.model ?? 'codex', capabilities: input.tools ?? [],
  });
  const modelCalls = (path?: string | null) => invocations(calls).filter((call) =>
    call.kind === 'model' && (path === undefined || call.executable === path)).length;
  return { dir, aDir, bDir, a, b, calls, request, selected, modelCalls };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('Codex static admission', () => {
  it('ordinary run observes the version and records declared capabilities', async () => {
    const f = fixture();
    const result = await new CodexEngine({ cliBinary: f.a }).run(f.request, () => {}, signal());
    expect(finalResultText(result)).toBe('PONG');
    expect(result.requested).toEqual(f.selected());
    expect(result.effective).toEqual(f.selected());
    expect(invocations(f.calls).map((call) => call.kind)).toEqual(['version', 'model']);
  });

  it('passes the separate 11-case kit using a normal nonempty tools request', async () => {
    const f = fixture();
    const previous = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${f.aDir}${delimiter}${previous}`);
    const input: EngineAdmissionConformanceFixture = {
      request: f.request, selection: f.selected(), open: () => new CodexEngine(), modelCalls: f.modelCalls,
      cli: {
        moveLookup() { vi.stubEnv('PATH', `${f.bDir}${delimiter}${previous}`); },
        openDifferent: () => new CodexEngine({ cliBinary: f.b }),
        openMissing: () => new CodexEngine({ cliBinary: join(f.dir, 'absent') }),
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

  it('observes numeric version without normal arguments or output-file creation', async () => {
    const f = fixture();
    const engine = new CodexEngine({ cliBinary: f.a, cliArgs: ['--debug'], permissionMode: 'bypassPermissions' });
    expect(await engine.admit(withoutPrompt(f.request), signal())).toEqual(f.selected());
    expect(invocations(f.calls)).toEqual([{
      kind: 'version', executable: f.a, args: ['--version'], stdin: '', cwd: f.dir,
    }]);
    expect(existsSync(join(f.dir, '.obversa-codex-admission-output'))).toBe(false);
    expect(f.modelCalls()).toBe(0);
  });

  it('restores saved A after PATH moves to B and refuses explicitly configured B', async () => {
    const f = fixture();
    const previous = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${f.aDir}${delimiter}${previous}`);
    const first = new CodexEngine();
    const selected = await first.admit(withoutPrompt(f.request), signal());
    vi.stubEnv('PATH', `${f.bDir}${delimiter}${previous}`);
    expect(await first.admit(withoutPrompt(f.request), signal(), selected)).toEqual(selected);
    const replacement = new CodexEngine();
    expect(await replacement.admit(withoutPrompt(f.request), signal(), selected)).toEqual(selected);
    await replacement.run(f.request, () => {}, signal());
    expect(f.modelCalls(f.a)).toBe(1);
    expect(invocations(f.calls).some((call) => call.executable === f.b)).toBe(false);
    await expect(new CodexEngine({ cliBinary: f.b }).admit(withoutPrompt(f.request), signal(), selected))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(f.modelCalls(f.b)).toBe(0);
  });

  it('retains an explicit symlink path through replacement and model work', async () => {
    const f = fixture();
    const link = join(f.dir, 'selected-wrapper');
    symlinkSync(f.a, link);
    const selected = await new CodexEngine({ cliBinary: link }).admit(withoutPrompt(f.request), signal());
    expect(selected.executable).toBe(link);
    const replacement = new CodexEngine({ cliBinary: link });
    expect(await replacement.admit(withoutPrompt(f.request), signal(), selected)).toEqual(selected);
    expect((await replacement.run(f.request, () => {}, signal())).requested).toEqual(selected);
    expect(f.modelCalls(link)).toBe(1);
  });

  it.each([false, true])('keeps the exact empty-tools refusal before abort (aborted=%s)', async (aborted) => {
    const f = fixture();
    const engine = new CodexEngine({ cliBinary: f.a });
    await engine.admit(withoutPrompt(f.request), signal());
    const count = invocations(f.calls).length;
    const input: AgentRequest = { ...f.request, purpose: 'preflight', tools: [], allowedTools: [] };
    const refusal = { name: 'EngineError', kind: 'invalid-config', message: emptyToolsMessage };
    await expect(engine.admit(withoutPrompt(input), aborted ? AbortSignal.abort() : signal()))
      .rejects.toMatchObject(refusal);
    await expect(engine.run(input, () => {}, aborted ? AbortSignal.abort() : signal()))
      .rejects.toMatchObject(refusal);
    expect(invocations(f.calls)).toHaveLength(count);
    expect(f.modelCalls()).toBe(0);
  });

  it('refuses empty tools in a fresh engine before any version command', async () => {
    const f = fixture();
    const input = { ...f.request, tools: [] };
    for (const action of [
      () => new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(input), signal()),
      () => new CodexEngine({ cliBinary: f.a }).run(input, () => {}, signal()),
    ]) await expect(action()).rejects.toMatchObject({ kind: 'invalid-config', message: emptyToolsMessage });
    expect(invocations(f.calls)).toEqual([]);
  });

  it('rebuilds model, capabilities, workspace and normal arguments after admission', async () => {
    const f = fixture();
    const engine = new CodexEngine({ cliBinary: f.a, permissionMode: 'bypassPermissions', cliArgs: ['--debug'] });
    await engine.admit(withoutPrompt(f.request), signal());
    const cwd = join(f.dir, 'next-workspace'); mkdirSync(cwd);
    const next: AgentRequest = { ...f.request, cwd, model: 'gpt-other', tools: ['Bash'], allowedTools: ['Bash'] };
    const selected = await engine.admit(withoutPrompt(next), signal());
    expect(selected).toEqual(f.selected(f.a, next));
    const result = await engine.run(next, () => {}, signal());
    expect(result.requested).toEqual(selected);
    expect(result.effective).toEqual(selected);
    const call = invocations(f.calls).find((entry) => entry.kind === 'model')!;
    expect(call.cwd).toBe(cwd);
    expect(call.args[call.args.indexOf('-m') + 1]).toBe('gpt-other');
    expect(call.args[call.args.indexOf('-C') + 1]).toBe(cwd);
    expect(call.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(call.args).toContain('--debug');
    const out = call.args[call.args.indexOf('-o') + 1]!;
    expect(out).not.toBe(join(cwd, '.obversa-codex-admission-output'));
    expect(existsSync(out)).toBe(false);
    expect(invocations(f.calls).filter((entry) => entry.kind === 'version')).toHaveLength(1);
  });

  it('keeps the default-model and fallback-model selection behavior', async () => {
    const f = fixture();
    const { model: _model, ...input } = f.request;
    const fallback = await new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(input), signal());
    expect(fallback.model).toBe('codex');
    const selected = await new CodexEngine({ cliBinary: f.a, defaultModel: 'gpt-default' })
      .admit(withoutPrompt(input), signal());
    expect(selected.model).toBe('gpt-default');
    expect(selected.modelFamily).toBeNull();
  });

  it.each([
    { cwd: 'relative' }, { timeoutMs: 0 }, { timeoutGraceMs: -1 },
    { maxOutputBytes: -1 }, { maxMemoryBytes: 0 },
    { tools: ['Read', 'Read'] }, { env: { INVALID: 3 } },
  ])('rechecks invalid request values after version caching: %j', async (change) => {
    const f = fixture();
    const engine = new CodexEngine({ cliBinary: f.a });
    await engine.admit(withoutPrompt(f.request), signal());
    await expect(engine.admit({ ...withoutPrompt(f.request), ...change } as never, signal()))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'invalid-config' });
    expect(invocations(f.calls)).toHaveLength(1);
    expect(f.modelCalls()).toBe(0);
  });

  it('does not let saved selection bypass a configured relative path', async () => {
    const f = fixture();
    await expect(new CodexEngine({ cliBinary: 'relative/codex' }).admit(withoutPrompt(f.request), signal(), f.selected()))
      .rejects.toMatchObject({ kind: 'invalid-config' });
    expect(invocations(f.calls)).toEqual([]);
  });

  it('observes changed replacement versions without inventing a version floor', async () => {
    const f = fixture();
    const selected = await new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(f.request), signal());
    f.request.env!.OBVERSA_TEST_CODEX_VERSION_STDOUT = 'codex-cli 0.1.0\n';
    await expect(new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(f.request), signal(), selected))
      .rejects.toMatchObject({ kind: 'invalid-config' });
    expect((await new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(f.request), signal())).adapterVersion)
      .toBe('0.1.0');
    expect(f.modelCalls()).toBe(0);
  });

  it.each([
    ['malformed', 'invalid-config'], ['exit', 'unknown'], ['overflow', 'unknown'], ['hang', 'timeout'],
  ] as const)('refuses version %s without model work', async (mode, kind) => {
    const f = fixture();
    f.request.env!.OBVERSA_TEST_CODEX_VERSION_MODE = mode;
    if (mode === 'malformed') f.request.env!.OBVERSA_TEST_CODEX_VERSION_STDOUT = 'not a version\n';
    f.request.timeoutMs = mode === 'hang' ? 100 : 5_000;
    await expect(new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(f.request), signal()))
      .rejects.toMatchObject({ name: 'EngineError', kind });
    expect(f.modelCalls()).toBe(0);
  });

  it('shares one version command for concurrent successful admission', async () => {
    const f = fixture(); f.request.env!.OBVERSA_TEST_CODEX_VERSION_MODE = 'slow';
    const engine = new CodexEngine({ cliBinary: f.a });
    const [a, b] = await Promise.all([
      engine.admit(withoutPrompt(f.request), signal()), engine.admit(withoutPrompt(f.request), signal()),
    ]);
    expect(a).toEqual(f.selected()); expect(b).toEqual(a);
    expect(invocations(f.calls).map((entry) => entry.kind)).toEqual(['version']);
  });

  it('retries failed version observation only on a later explicit admission call', async () => {
    const f = fixture(); f.request.env!.OBVERSA_TEST_CODEX_VERSION_MODE = 'fail-once';
    const engine = new CodexEngine({ cliBinary: f.a });
    await expect(engine.admit(withoutPrompt(f.request), signal())).rejects.toMatchObject({ kind: 'unknown' });
    expect(invocations(f.calls)).toHaveLength(1);
    expect(await engine.admit(withoutPrompt(f.request), signal())).toEqual(f.selected());
    expect(invocations(f.calls).map((entry) => entry.kind)).toEqual(['version', 'version']);
  });

  it('aborts an active version command and does no model work', async () => {
    const f = fixture(); f.request.env!.OBVERSA_TEST_CODEX_VERSION_MODE = 'hang';
    const controller = new AbortController();
    const pending = new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(f.request), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ kind: 'aborted' });
    const deadline = Date.now() + 4_000;
    while (invocations(f.calls).length === 0 && Date.now() < deadline) await delay(10);
    controller.abort(); await rejected;
    expect(invocations(f.calls).map((entry) => entry.kind)).toEqual(['version']);
    expect(f.modelCalls()).toBe(0);
  });

  it('makes no command for an already aborted valid request', async () => {
    const f = fixture();
    await expect(new CodexEngine({ cliBinary: f.a }).admit(withoutPrompt(f.request), AbortSignal.abort()))
      .rejects.toMatchObject({ kind: 'aborted' });
    expect(invocations(f.calls)).toEqual([]);
  });

  it('constructs a missing path and returns typed admit and run failures', async () => {
    const f = fixture(); const missing = join(f.dir, 'missing');
    let engine: CodexEngine | undefined;
    expect(() => { engine = new CodexEngine({ cliBinary: missing }); }).not.toThrow();
    for (const action of [
      () => engine!.admit(withoutPrompt(f.request), signal()),
      () => engine!.run(f.request, () => {}, signal()),
      () => new CodexEngine({ cliBinary: missing }).run(f.request, () => {}, signal()),
    ]) await expect(action()).rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
    expect(invocations(f.calls)).toEqual([]);
  });

  it('refuses a removed retained path without finding a replacement through PATH', async () => {
    const f = fixture(); const engine = new CodexEngine({ cliBinary: f.a });
    const selected = await engine.admit(withoutPrompt(f.request), signal());
    rmSync(f.a);
    vi.stubEnv('PATH', `${f.bDir}${delimiter}${process.env.PATH ?? ''}`);
    for (const action of [
      () => engine.admit(withoutPrompt(f.request), signal(), selected),
      () => engine.run(f.request, () => {}, signal()),
      () => new CodexEngine().admit(withoutPrompt(f.request), signal(), selected),
    ]) await expect(action()).rejects.toMatchObject({ name: 'EngineError', kind: 'missing-cli' });
    expect(f.modelCalls()).toBe(0);
    expect(invocations(f.calls).some((entry) => entry.executable === f.b)).toBe(false);
  });

  it('keeps runnable-path spawn failure unknown instead of guessing missing-cli', async () => {
    const f = fixture(); const bad = join(f.dir, 'bad-interpreter');
    writeFileSync(bad, `#!${join(f.dir, 'absent-interpreter')}\n`); chmodSync(bad, 0o755);
    await expect(new CodexEngine({ cliBinary: bad }).admit(withoutPrompt(f.request), signal()))
      .rejects.toMatchObject({ name: 'EngineError', kind: 'unknown' });
    expect(f.modelCalls()).toBe(0);
  });

  it.each([0, 2])('preserves terminal usage, final output and transport behavior on exit %s', async (exit) => {
    const f = fixture(); f.request.env!.OBVERSA_TEST_CODEX_MODEL_EXIT = String(exit);
    const result = await new CodexEngine({ cliBinary: f.a }).run(f.request, () => {}, signal());
    expect(finalResultText(result)).toBe('PONG');
    expect(result.requested).toEqual(f.selected()); expect(result.effective).toEqual(f.selected());
    expect(result.usage).toEqual({ kind: 'reported', inputTokens: 42, outputTokens: 7, cacheReadInputTokens: 30 });
    if (exit === 0) expect(result.transportFailure).toBeUndefined();
    else expect(result.transportFailure).toMatchObject({ kind: 'unknown', exitCode: exit });
  });
});
