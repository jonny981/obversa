import { describe, it, expect, onTestFinished, vi } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyEngineFailure, finalResultText } from '@obversa/api';
import { buildCodexArgs, codex, CodexEngine } from '../src/index.ts';

const VERSION_ONLY = `if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('codex-cli 0.153.2\\n');
  process.exit(0);
}
`;

describe('buildCodexArgs', () => {
  it('defaults to a read-only ephemeral exec and writes the last message', () => {
    const args = buildCodexArgs({ prompt: 'review this' }, {}, '/tmp/out.txt');
    expect(args.slice(0, 4)).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '--color']);
    expect(args).toContain('--json');
    expect(args).toContain('read-only');
    expect(args).toContain('-o');
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/out.txt');
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('review this');
  });

  it('runs clean by default, and on the person\'s own setup with clean: false', () => {
    for (const opts of [{}, { clean: true }]) {
      expect(buildCodexArgs({ prompt: 'go' }, opts, '/tmp/out.txt')).toContain('--ignore-user-config');
    }
    expect(buildCodexArgs({ prompt: 'go' }, { clean: false }, '/tmp/out.txt')).not.toContain('--ignore-user-config');
  });

  it('uses write-capable unattended mode only for bypassPermissions', () => {
    const args = buildCodexArgs(
      { prompt: 'edit files', cwd: '/repo' },
      { permissionMode: 'bypassPermissions' },
      '/tmp/out.txt',
    );
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('read-only');
    expect(args[args.indexOf('-C') + 1]).toBe('/repo');
  });

  it('passes the sandbox and approval policy to the CLI', () => {
    const args = buildCodexArgs(
      { prompt: 'edit files' },
      { sandbox: 'workspace-write', approvalPolicy: 'never' },
      '/tmp/out.txt',
    );
    expect(args).toContain('workspace-write');
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('approval_policy=never');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('folds system text into the prompt and passes model plus extra args', () => {
    const args = buildCodexArgs(
      { prompt: 'go', system: 'be careful', model: 'gpt-5.1-codex' },
      { defaultModel: 'ignored', cliArgs: ['--ignore-rules'] },
      '/tmp/out.txt',
    );
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.1-codex');
    expect(args).toContain('--ignore-rules');
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('be careful\n\n---\n\ngo');
  });

  it('uses the package default model when the request omits one', () => {
    const args = buildCodexArgs(
      { prompt: 'review with codex' },
      { defaultModel: 'gpt-5.4' },
      '/tmp/out.txt',
    );
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.4');
  });

  it('passes the engine effort as model_reasoning_effort, and a request effort over it', () => {
    const effortValue = (args: string[]) =>
      args.filter((arg, i) => args[i - 1] === '-c' && arg.startsWith('model_reasoning_effort='));
    expect(effortValue(buildCodexArgs({ prompt: 'go' }, { effort: 'low' }, '/tmp/out.txt')))
      .toEqual(['model_reasoning_effort=low']);
    expect(effortValue(buildCodexArgs({ prompt: 'go', effort: 'xhigh' }, { effort: 'low' }, '/tmp/out.txt')))
      .toEqual(['model_reasoning_effort=xhigh']);
    expect(buildCodexArgs({ prompt: 'go' }, {}, '/tmp/out.txt').join(' '))
      .not.toContain('model_reasoning_effort');
  });

  it('allows its own effort switch in a workspace mode, where extra CLI arguments are refused', () => {
    const args = buildCodexArgs(
      { prompt: 'review', tools: ['Read'], workspaceMode: 'read', effort: 'medium' },
      {},
      '/tmp/out.txt',
    );
    expect(args[args.indexOf('model_reasoning_effort=medium') - 1]).toBe('-c');
    expect(args).toContain('read-only');
  });

  it.each(['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'] as const)(
    'keeps %s permission mode read-only',
    (permissionMode) => {
      const args = buildCodexArgs(
        { prompt: 'review' },
        { permissionMode },
        '/tmp/out.txt',
      );
      expect(args).toContain('read-only');
      expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    },
  );

  it('sends the composed prompt through stdin to the codex subprocess', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    const stdinFile = join(dir, 'stdin.txt');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
${VERSION_ONLY}
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
writeFileSync(${JSON.stringify(stdinFile)}, readFileSync(0, 'utf8'));
writeFileSync(out, 'stub final');
`,
    );
    chmodSync(bin, 0o755);

    const engine = new CodexEngine({ cliBinary: bin });
    const result = await engine.run(
      { prompt: 'do the work', system: 'system rules' },
      () => {},
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('stub final');
    expect(result.requested.executable).toBe(bin);
    expect(readFileSync(stdinFile, 'utf8')).toBe('system rules\n\n---\n\ndo the work');
  });

  it('records the effort the codex() seat passed, and none when unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-effort-'));
    const bin = join(dir, 'codex');
    const argsFile = join(dir, 'args.json');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
${VERSION_ONLY}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
writeFileSync(args[args.indexOf('-o') + 1], 'stub final');
`,
    );
    chmodSync(bin, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${dir}:${previous ?? ''}`;
    try {
      const seat = codex('gpt-test', { effort: 'low' });
      const result = await seat.engine.run({ prompt: 'go' }, () => {}, new AbortController().signal);
      expect(result.requested.effort).toBe('low');
      expect(result.effective.effort).toBe('low');
      const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
      expect(args[args.indexOf('model_reasoning_effort=low') - 1]).toBe('-c');
      const plain = await new CodexEngine({ cliBinary: bin })
        .run({ prompt: 'go' }, () => {}, new AbortController().signal);
      expect('effort' in plain.requested).toBe(false);
    } finally {
      process.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an explicit empty tool set before spawning Codex', async () => {
    await expect(
      new CodexEngine({ cliBinary: join(tmpdir(), 'lines-codex-must-not-spawn') }).run(
        { prompt: 'select evidence', tools: [] },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      kind: 'invalid-config',
      message: 'codex cannot honor tools: []; choose an engine that supports disabling tools',
    });
  });

  it('refuses a read workspace without declared tools', () => {
    expect(() => buildCodexArgs(
      { prompt: 'review', tools: [], workspaceMode: 'read' },
      {},
      '/tmp/out.txt',
    )).toThrow('read workspace requires at least one declared tool');
  });

  it('reports terminal JSONL usage without double-counting cached input', async () => {
    // The person's own shell may set either key; the test decides them.
    vi.stubEnv('CODEX_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
${VERSION_ONLY}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
writeFileSync(out, 'stub final');
process.stdout.write(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 42, cached_input_tokens: 30, output_tokens: 7 },
}) + '\\n');
`,
    );
    chmodSync(bin, 0o755);

    const usageEvents: Array<{ type: string; usage?: unknown; model?: string }> = [];
    const result = await new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'do the work' },
      (event) => usageEvents.push(event),
      new AbortController().signal,
    );

    expect(result.usage).toEqual({
      kind: 'reported',
      inputTokens: 42,
      outputTokens: 7,
      cacheReadInputTokens: 30,
    });
    expect(usageEvents.filter((event) => event.type === 'usage')).toEqual([
      {
        type: 'usage',
        usage: {
          kind: 'reported',
          inputTokens: 42,
          outputTokens: 7,
          cacheReadInputTokens: 30,
        },
        model: 'codex',
        billing: 'subscription',
      },
    ]);
    expect(result.billing).toBe('subscription');

    // A key the process can see decides the billing, when it is one Codex runs on.
    const billingWith = async (env: Record<string, string>) => (await new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'do the work', env },
      () => {},
      new AbortController().signal,
    )).billing;
    expect(await billingWith({ CODEX_API_KEY: 'test-key' })).toBe('api');
    expect(await billingWith({ OPENAI_API_KEY: 'test-key' })).toBe('unknown');
  });

  it('preserves a completed result when the subprocess fails during teardown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    const secret = 'teardown-secret-value';
    writeFileSync(
      bin,
      `#!/usr/bin/env node
${VERSION_ONLY}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args[args.indexOf('-o') + 1];
writeFileSync(out, 'completed work');
console.error('transport teardown failed: ' + process.env.SECRET_TOKEN);
process.exit(1);
`,
    );
    chmodSync(bin, 0o755);

    const events: Array<{ type: string }> = [];
    const result = await new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'do the work', env: { SECRET_TOKEN: secret } },
      (event) => events.push(event),
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('completed work');
    expect(result.transportFailure?.message).toContain(
      'codex completed but exited 1 during teardown',
    );
    expect(result.transportFailure?.message).toContain('[redacted]');
    expect(result.transportFailure?.message).not.toContain(secret);
    expect(events.filter((event) => event.type === 'text')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
  });

  it('fails a non-zero exit that did not write a completed result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
${VERSION_ONLY}
console.error('transport failed before completion');
process.exit(1);
`,
    );
    chmodSync(bin, 0o755);

    await expect(
      new CodexEngine({ cliBinary: bin }).run(
        { prompt: 'do the work' },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('counts a call that fails with no answer under its tokens, configured model and billing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const failing = join(dir, 'codex-failing.mjs');
    writeFileSync(
      failing,
      `#!/usr/bin/env node
${VERSION_ONLY}
process.stdout.write(JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 1000, output_tokens: 200 },
}) + '\\n');
console.error('stream disconnected before completion');
process.exit(1);
`,
    );
    const hanging = join(dir, 'codex-hanging.mjs');
    writeFileSync(hanging, `#!/usr/bin/env node\n${VERSION_ONLY}setTimeout(() => {}, 60_000);\n`);
    chmodSync(failing, 0o755);
    chmodSync(hanging, 0o755);

    const usageOf = async (bin: string, timeoutMs?: number) => {
      const events: Array<{ type: string }> = [];
      const engine = new CodexEngine({ cliBinary: bin, defaultModel: 'gpt-5.4' });
      // The version check takes the call's timeout too; run it first so the timeout lands on the call.
      await engine.admit({}, new AbortController().signal);
      await expect(engine.run(
        { prompt: 'do the work', env: { CODEX_API_KEY: 'test-key' }, ...(timeoutMs ? { timeoutMs, timeoutGraceMs: 100 } : {}) },
        (event) => events.push(event),
        new AbortController().signal,
      )).rejects.toBeInstanceOf(Error);
      return events.filter((event) => event.type === 'usage');
    };

    expect(await usageOf(failing)).toEqual([{
      type: 'usage',
      usage: { kind: 'reported', inputTokens: 1000, outputTokens: 200 },
      model: 'gpt-5.4',
      billing: 'api',
    }]);
    expect(await usageOf(hanging, 200)).toEqual([{
      type: 'usage',
      usage: { kind: 'unknown' },
      model: 'gpt-5.4',
      billing: 'api',
    }]);
  });

  it('retains a trailing redacted Codex configuration diagnostic', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    const secret = 'sk-proj-codex-diagnostic-secret';
    writeFileSync(
      bin,
      `#!/usr/bin/env node
${VERSION_ONLY}
process.stderr.write('OpenAI Codex v0.144.4\\n' + 'startup detail '.repeat(40));
process.stdout.write(${JSON.stringify(secret)} + " HTTP 400: Invalid value: 'max'. Supported values are: none, low, high, xhigh\\n");
process.exit(1);
`,
    );
    chmodSync(bin, 0o755);

    let error: unknown;
    try {
      await new CodexEngine({ cliBinary: bin }).run(
        { prompt: 'check configuration', env: { OPENAI_API_KEY: secret } },
        () => {},
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught;
    }

    expect(classifyEngineFailure(error)).toBe('invalid-config');
    expect(error).toMatchObject({
      message: expect.stringContaining("Invalid value: 'max'"),
    });
    expect((error as Error).message).toContain('Supported values');
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).message).not.toContain(secret);
  });

  it.each([
    ['quota allowance reached', 'rate-limit'],
    ["You've hit your session limit", 'rate-limit'],
    ['monthly usage limit reached', 'quota'],
    ['402 payment required: exhausted credit balance', 'billing'],
  ] as const)('classifies scripted failed-process text: %s', async (text, kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'lines-codex-limit-'));
    const executable = join(directory, 'codex-fixture.mjs');
    try {
      writeFileSync(
        executable,
        `#!/usr/bin/env node\n${VERSION_ONLY}process.stderr.write(${JSON.stringify(`${text}\n`)});\nprocess.exit(1);\n`,
      );
      chmodSync(executable, 0o755);
      await expect(new CodexEngine({ cliBinary: executable }).run(
        { prompt: 'scripted limit check' },
        () => {},
        new AbortController().signal,
      )).rejects.toMatchObject({ name: 'EngineError', kind });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

});
