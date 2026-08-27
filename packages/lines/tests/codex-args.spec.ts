import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { agentJob, costReport, run } from '../src/api.ts';
import { Stats } from '../src/core/stats.ts';
import { modelFor } from '../src/engines/engine.ts';
import { buildCodexArgs, CodexEngine } from '../src/engines/codex.ts';
import { preflightEngine } from '../src/engines/preflight.ts';
import { finalResultText } from '../src/runtime/result-parts.ts';

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

  it('does not inherit another engine default model', () => {
    const leaf = buildCodexArgs(
      { prompt: 'review with codex' },
      { defaultEngine: 'agent-sdk', defaultModel: 'claude-sonnet-4-5' },
      '/tmp/out.txt',
    );
    expect(leaf).not.toContain('-m');

    const root = buildCodexArgs(
      { prompt: 'review with codex' },
      { defaultEngine: 'codex', defaultModel: 'gpt-5.4' },
      '/tmp/out.txt',
    );
    expect(root[root.indexOf('-m') + 1]).toBe('gpt-5.4');
  });

  it('shares default models across Claude engines but not into Codex', () => {
    expect(
      modelFor(
        { prompt: 'judge' },
        { defaultEngine: 'agent-sdk', defaultModel: 'claude-opus-4-5' },
        'anthropic-api',
      ),
    ).toBe('claude-opus-4-5');
    expect(
      modelFor(
        { prompt: 'judge' },
        { defaultEngine: 'agent-sdk', defaultModel: 'claude-opus-4-5' },
        'codex',
      ),
    ).toBeUndefined();
    expect(
      modelFor(
        { prompt: 'judge' },
        { defaultEngine: 'codex', defaultModel: 'gpt-5.4' },
        'anthropic-api',
      ),
    ).toBeUndefined();
  });

  it('sends the composed prompt through stdin to the codex subprocess', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    const stdinFile = join(dir, 'stdin.txt');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
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
    expect(readFileSync(stdinFile, 'utf8')).toBe('system rules\n\n---\n\ndo the work');
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

  it('reports terminal JSONL usage without double-counting cached input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    writeFileSync(
      bin,
      `#!/usr/bin/env node
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
    const stats = new Stats();
    const result = await new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'do the work' },
      (event) => {
        usageEvents.push(event);
        if (event.type === 'usage') {
          stats.record({
            kind: 'engine:usage',
            ts: 0,
            path: [],
            model: event.model,
            usage: event.usage,
          });
        }
      },
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
      },
    ]);

    const snapshot = stats.snapshot();
    expect(snapshot.models).toEqual([
      {
        model: 'codex',
        calls: 1,
        reportedCalls: 1,
        unknownUsageCalls: 0,
        inputTokens: 42,
        outputTokens: 7,
        cacheReadInputTokens: 30,
      },
    ]);
    expect(
      costReport(
        snapshot,
        { codex: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 } },
        'codex',
      ),
    ).toMatchObject({
      spentUsd: undefined,
      baselineUsd: undefined,
      savedUsd: undefined,
      unpricedModels: ['codex'],
      models: [{ model: 'codex', usd: undefined }],
    });
  });

  it('preserves a completed result when the subprocess fails during teardown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    const secret = 'teardown-secret-value';
    writeFileSync(
      bin,
      `#!/usr/bin/env node
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

  it('retains a trailing Codex configuration diagnostic for preflight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lines-codex-stub-'));
    const bin = join(dir, 'codex-stub.mjs');
    const secret = 'sk-proj-codex-diagnostic-secret';
    writeFileSync(
      bin,
      `#!/usr/bin/env node
process.stderr.write('OpenAI Codex v0.144.4\\n' + 'startup detail '.repeat(40));
process.stdout.write(${JSON.stringify(secret)} + " HTTP 400: Invalid value: 'max'. Supported values are: none, low, high, xhigh\\n");
process.exit(1);
`,
    );
    chmodSync(bin, 0o755);

    const result = await preflightEngine(new CodexEngine({ cliBinary: bin }));

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('invalid-config');
    expect(result.detail).toContain("Invalid value: 'max'");
    expect(result.detail).toContain('Supported values');
    expect(result.detail).toContain('[redacted]');
    expect(result.detail).not.toContain(secret);
  });

});
