import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { engineSelection, type AgentRequest } from '@obversa/api';
import { runEngineConformance } from '@obversa/api/testing';
import { CodexEngine } from '../src/index.ts';

it.each([0, 2_500])('runs the full kit through the Codex process boundary (structured-result boot delay %i ms)', async (bootDelayMs) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codex-conformance-')));
  try {
    const bin = join(dir, 'codex');
    const calls = join(dir, 'calls.jsonl');
    copyFileSync(fileURLToPath(new URL('./fixtures/codex-cli.mjs', import.meta.url)), bin);
    chmodSync(bin, 0o755);
    const env = { OBVERSA_TEST_CODEX_CALLS: calls, OBVERSA_ENGINE_CONFORMANCE_SCENARIO: '', OBVERSA_TEST_CODEX_BOOT_DELAY_MS: '0' };
    const request: AgentRequest = {
      prompt: 'fixture', model: 'gpt-test', tools: ['Read'], allowedTools: ['Read'],
      cwd: dir, leaf: true, timeoutMs: 10_000, timeoutGraceMs: 200, env,
    };
    const selected = engineSelection({
      adapter: 'codex', provider: 'openai', model: 'gpt-test', adapterVersion: '0.153.2', executable: bin, capabilities: ['Read'],
    });
    const report = await runEngineConformance({
      request, requested: selected, effective: selected,
      unsupported: {
        'ordered-parts': 'Codex returns one final file rather than ordered assistant continuations.',
        'tool-events': 'This adapter does not forward Codex tool events.',
        cancellation: 'This adapter emits events only after its child settles; it cannot drive this streaming cancellation fixture.',
      },
      parseStructuredResult: (part) => JSON.parse(part.kind === 'assistant' ? part.text : 'null'),
      workspace: {
        modes: {
          none: { request, outcome: 'refused' },
          read: { request, outcome: 'supported' },
          write: {
            request: { ...request, tools: ['Read', 'Edit'], allowedTools: ['Read', 'Edit'] }, outcome: 'supported',
            requested: engineSelection({ ...selected, capabilities: ['Read', 'Edit'] }),
            effective: engineSelection({ ...selected, capabilities: ['Read', 'Edit'] }),
          },
        },
        observe() {
          const models = readFileSync(calls, 'utf8').split('\n').filter(Boolean)
            .map((line) => JSON.parse(line) as { kind: string; args: string[] }).filter((call) => call.kind === 'model');
          const args = models.at(-1)?.args ?? [];
          const sandbox = args[args.indexOf('-s') + 1];
          expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
          return { modelCalls: models.length, canRead: sandbox === 'read-only' || sandbox === 'workspace-write', canWrite: sandbox === 'workspace-write' };
        },
      },
      open(scenario) {
        writeFileSync(calls, '');
        env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO = scenario;
        env.OBVERSA_TEST_CODEX_BOOT_DELAY_MS = String(scenario === 'structured-result' ? bootDelayMs : 0);
        return new CodexEngine({ cliBinary: scenario === 'missing-cli' ? join(dir, 'absent') : bin });
      },
    });
    expect(report).toMatchObject({ ok: true, cases: 17, failures: [] });
    expect(report.unsupported.map((item) => item.case)).toEqual(['ordered-parts', 'tool-events', 'cancellation']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
