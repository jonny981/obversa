/**
 * Engine subprocess resolution is bounded by process EXIT, not stream close.
 *
 * A real engine CLI (codex, claude) spawns helpers — MCP transport workers,
 * hook processes — that inherit its stdio. An orphan that outlives the engine
 * holds the pipe write ends open, and execa settles only when every stream
 * ends: the completed turn would never resolve back to the loop, and neither
 * execa's `timeout` nor `cancelSignal` can settle it in that state. These
 * fixtures reproduce the orphan deterministically (a detached `sleep` given
 * the inherited stdio) and prove each adapter resolves at exit anyway.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CodexEngine } from '../src/engines/codex.ts';
import { ClaudeCliEngine } from '../src/engines/claude-cli.ts';
import { finalResultText } from '../src/runtime/result-parts.ts';

/** Seconds the orphan holds the pipes — far beyond any test bound below, so a
 *  regression to stream-close waiting fails loudly rather than just slowly. */
const HOLD_SECS = 120;

function stub(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'lines-exit-settle-'));
  const bin = join(dir, 'engine-stub.mjs');
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  return bin;
}

const SPAWN_ORPHAN = `
import { spawn } from 'node:child_process';
spawn('sleep', ['${HOLD_SECS}'], { stdio: 'inherit', detached: true }).unref();
`;

describe('engine settle-on-exit (orphan holds the stdio pipes)', () => {
  it('codex resolves a completed turn at exit', async () => {
    const bin = stub(`#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
${SPAWN_ORPHAN}
const args = process.argv.slice(2);
readFileSync(0, 'utf8');
writeFileSync(args[args.indexOf('-o') + 1], 'PONG');
process.exit(0);
`);

    const startedAt = Date.now();
    const result = await new CodexEngine({ cliBinary: bin }).run(
      { prompt: 'ping' },
      () => {},
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('PONG');
    expect(result.transportFailure).toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('claude-cli resolves a completed stream-json turn at exit', async () => {
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { model: 'stub-model', content: [{ type: 'text', text: 'PONG' }] },
    });
    const terminal = JSON.stringify({
      type: 'result',
      result: 'PONG',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    const bin = stub(`#!/usr/bin/env node
import { readFileSync } from 'node:fs';
${SPAWN_ORPHAN}
readFileSync(0, 'utf8');
process.stdout.write(${JSON.stringify(`${assistant}\n${terminal}\n`)});
process.exit(0);
`);

    const startedAt = Date.now();
    const result = await new ClaudeCliEngine({ cliBinary: bin }).run(
      { prompt: 'ping' },
      () => {},
      new AbortController().signal,
    );

    expect(finalResultText(result)).toBe('PONG');
    expect(result.usage).toEqual({
      kind: 'reported',
      inputTokens: 3,
      outputTokens: 1,
    });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('the hard timeout still fires when the engine never exits', async () => {
    const bin = stub(`#!/usr/bin/env node
${SPAWN_ORPHAN}
setInterval(() => {}, 1000);
`);

    const startedAt = Date.now();
    await expect(
      new CodexEngine({ cliBinary: bin }).run(
        { prompt: 'ping', timeoutMs: 500 },
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  it('an abort settles instead of waiting for the orphan', async () => {
    const bin = stub(`#!/usr/bin/env node
${SPAWN_ORPHAN}
setInterval(() => {}, 1000);
`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const startedAt = Date.now();
    await expect(
      new ClaudeCliEngine({ cliBinary: bin }).run(
        { prompt: 'ping' },
        () => {},
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});
