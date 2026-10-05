import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineError, type EngineStreamEvent } from '@obversa/api';
import { ClaudeCliEngine } from '../src/index.ts';

let dir: string;
let bin: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-cost-')));
  bin = join(dir, 'claude');
  copyFileSync(fileURLToPath(new URL('./fixtures/claude-cli.mjs', import.meta.url)), bin);
  chmodSync(bin, 0o755);
  // The person's own shell may set any of these; the test decides them.
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) {
    vi.stubEnv(name, '');
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function runOnce(env: Record<string, string>) {
  const events: EngineStreamEvent[] = [];
  const result = await new ClaudeCliEngine({ cliBinary: bin, permissionMode: 'bypassPermissions' }).run(
    { prompt: 'ping', model: 'claude-test', cwd: dir, leaf: true, timeoutMs: 10_000, env: { OBVERSA_TEST_CLAUDE_COST_USD: '0.0123', ...env } },
    (event) => events.push(event),
    new AbortController().signal,
  );
  return { result, usage: events.find((event) => event.type === 'usage') };
}

it('records the dollar figure Claude reports, billed to the person\'s plan', async () => {
  const { result, usage } = await runOnce({});
  expect(result.cost).toEqual({ kind: 'reported', usd: 0.0123 });
  expect(result.billing).toBe('subscription');
  expect(usage).toMatchObject({ cost: { kind: 'reported', usd: 0.0123 }, billing: 'subscription' });
});

it('records api billing when the process gets an API key', async () => {
  const { result, usage } = await runOnce({ ANTHROPIC_API_KEY: 'test-key' });
  expect(result.billing).toBe('api');
  expect(usage).toMatchObject({ billing: 'api' });
});

it('records no figure when Claude reports none', async () => {
  const { result } = await runOnce({ OBVERSA_TEST_CLAUDE_COST_USD: '' });
  expect(result.cost).toBeUndefined();
});

it('records the tokens and billing of a call that timed out after reporting tokens', async () => {
  const events: EngineStreamEvent[] = [];
  const failure = await new ClaudeCliEngine({ cliBinary: bin, permissionMode: 'bypassPermissions' }).run(
    { prompt: 'ping', model: 'claude-test', cwd: dir, leaf: true, timeoutMs: 1_000, timeoutGraceMs: 100, env: { OBVERSA_TEST_CLAUDE_STALL: '1' } },
    (event) => events.push(event),
    new AbortController().signal,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineError);
  expect((failure as EngineError).kind).toBe('timeout');
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    { type: 'usage', usage: { kind: 'reported', inputTokens: 7, outputTokens: 2 }, model: 'claude-test', billing: 'subscription' },
  ]);
});

it('records the tokens and billing of a call cancelled after reporting tokens', async () => {
  const events: EngineStreamEvent[] = [];
  const cancel = new AbortController();
  const failure = await new ClaudeCliEngine({ cliBinary: bin, permissionMode: 'bypassPermissions' }).run(
    { prompt: 'ping', model: 'claude-test', cwd: dir, leaf: true, timeoutMs: 10_000, timeoutGraceMs: 100, env: { OBVERSA_TEST_CLAUDE_STALL: '1' } },
    (event) => {
      events.push(event);
      // Cancel once the turn has reported its tokens and the call waits.
      if (event.type === 'text') setTimeout(() => cancel.abort(), 0);
    },
    cancel.signal,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineError);
  expect((failure as EngineError).kind).toBe('aborted');
  expect(events.filter((event) => event.type === 'usage')).toEqual([
    { type: 'usage', usage: { kind: 'reported', inputTokens: 7, outputTokens: 2 }, model: 'claude-test', billing: 'subscription' },
  ]);
});
