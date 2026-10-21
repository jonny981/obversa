import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { EngineError, classifyEngineFailure } from '@obversa/api';
import { ClaudeCliEngine } from '../src/index.ts';

let dir: string;
let bin: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-turns-')));
  bin = join(dir, 'claude');
  copyFileSync(fileURLToPath(new URL('./fixtures/claude-cli.mjs', import.meta.url)), bin);
  chmodSync(bin, 0o755);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runOnce(env: Record<string, string>) {
  return new ClaudeCliEngine({ cliBinary: bin, permissionMode: 'bypassPermissions' }).run(
    { prompt: 'ping', model: 'claude-test', cwd: dir, leaf: true, timeoutMs: 10_000, env },
    () => {},
    new AbortController().signal,
  );
}

it('returns the second turn\'s answer as the one final part of a two-turn session', async () => {
  const result = await runOnce({ OBVERSA_TEST_CLAUDE_TWO_TURNS: '1' });
  expect(result.parts).toEqual([
    { kind: 'assistant', text: 'started', final: false },
    { kind: 'assistant', text: 'finished', final: true },
  ]);
  expect(result.usage).toEqual({ kind: 'reported', inputTokens: 8, outputTokens: 3 });
  expect(result.cost).toEqual({ kind: 'reported', usd: 0.75 });
});

it('fails a stream with no final answer with a kind that is not retried on the same lane', async () => {
  const failure = await runOnce({ OBVERSA_TEST_CLAUDE_NO_RESULT: '1' }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineError);
  expect(classifyEngineFailure(failure)).toBe('invalid-config');
  expect((failure as EngineError).message).toBe('claude-cli stream did not end with exactly one final answer');
});
