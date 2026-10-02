import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { engineSelection, type AgentRequest } from '@obversa/api';
import { runEngineConformance } from '@obversa/api/testing';
import { DevinCliEngine } from '../src/index.ts';

it('runs the full kit through the Devin process boundary', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'devin-conformance-')));
  try {
    const bin = join(dir, 'devin');
    const calls = join(dir, 'calls.jsonl');
    copyFileSync(fileURLToPath(new URL('./fixtures/devin-cli.mjs', import.meta.url)), bin);
    chmodSync(bin, 0o755);
    const env = { OBVERSA_TEST_DEVIN_CALLS: calls, OBVERSA_ENGINE_CONFORMANCE_SCENARIO: '' };
    const request: AgentRequest = {
      prompt: 'fixture', model: 'swe-2-max', tools: ['read'], allowedTools: ['read'],
      cwd: dir, leaf: true, timeoutMs: 10_000, timeoutGraceMs: 200, env,
    };
    const selected = engineSelection({
      adapter: 'devin-cli', provider: 'cognition', modelFamily: 'swe', model: 'swe-2-max',
      adapterVersion: '3000.11.3', executable: bin, capabilities: ['read'],
    });
    const writeSelected = engineSelection({ ...selected, capabilities: ['read', 'edit'] });
    const report = await runEngineConformance({
      request, requested: selected, effective: selected, identityFromModel: true,
      unsupported: {
        cancellation: 'This adapter reads the conversation export after the child settles, so it cannot drive this streaming cancellation fixture.',
      },
      parseStructuredResult: (part) => JSON.parse(part.kind === 'assistant' ? part.text : 'null'),
      workspace: {
        modes: {
          none: { request, outcome: 'refused' },
          read: { request, outcome: 'supported' },
          write: {
            request: { ...request, tools: ['read', 'edit'], allowedTools: ['read', 'edit'] },
            outcome: 'supported', requested: writeSelected, effective: writeSelected,
          },
        },
        observe() {
          const models = readFileSync(calls, 'utf8').split('\n').filter(Boolean)
            .map((line) => JSON.parse(line) as { kind: string; args: string[]; config: string | null })
            .filter((call) => call.kind === 'model');
          const args = models.at(-1)?.args ?? [];
          const mode = args[args.indexOf('--permission-mode') + 1];
          if (models.length > 0) expect(['auto', 'accept-edits']).toContain(mode);
          // A clean run reads an empty config file in place of the person's own.
          const ownSetup = !args.includes('--config');
          expect(models.at(-1)?.config ?? null).toBe(ownSetup ? null : '{}\n');
          return { modelCalls: models.length, canRead: true, canWrite: mode === 'accept-edits', ownSetup };
        },
      },
      open(scenario) {
        writeFileSync(calls, '');
        env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO = scenario;
        return new DevinCliEngine({ cliBinary: scenario === 'missing-cli' ? join(dir, 'absent') : bin, clean: scenario === 'clean-mode' });
      },
    });
    expect(report).toMatchObject({ ok: true, cases: 21, failures: [] });
    expect(report.unsupported.map((item) => item.case)).toEqual(['cancellation']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
