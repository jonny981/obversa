import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { engineSelection, runEngineConformance, type AgentRequest } from '@obversa/engine';
import { ClaudeCliEngine } from '../src/index.ts';

it.each(['stderr', 'stdout'])('runs the full kit through the Claude process boundary with failures on %s', async (stream) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-conformance-')));
  try {
    const bin = join(dir, 'claude');
    const calls = join(dir, 'calls.jsonl');
    copyFileSync(fileURLToPath(new URL('./fixtures/claude-cli.mjs', import.meta.url)), bin);
    chmodSync(bin, 0o755);
    const env = {
      OBVERSA_TEST_CLAUDE_CALLS: calls,
      OBVERSA_ENGINE_CONFORMANCE_SCENARIO: '',
      OBVERSA_TEST_CLAUDE_FAILURE_STREAM: stream,
    };
    const request: AgentRequest = {
      prompt: 'fixture', model: 'claude-test', tools: ['Read'], allowedTools: ['Read'],
      cwd: dir, leaf: true, timeoutMs: 2_000, timeoutGraceMs: 200, env,
    };
    const selection = (capabilities: string[]) => engineSelection({
      adapter: 'claude-cli', provider: 'anthropic', model: 'claude-test',
      adapterVersion: '2.1.261', executable: bin, capabilities,
    });
    const mixed = { ...request, tools: ['Read', 'Edit', 'Bash'], allowedTools: ['Read', 'Edit', 'Bash'] };
    const report = await runEngineConformance({
      request, requested: selection(['Read']), effective: selection(['Read']),
      unsupported: {
        'tool-events': 'Claude tool-result messages have no tool name; this adapter reports a generic result name.',
        billing: 'This adapter classifies billing failures as quota, not a distinct billing kind.',
      },
      parseStructuredResult: (part) => JSON.parse(part.kind === 'assistant' ? part.text : 'null'),
      workspace: {
        modes: {
          none: { request: mixed, outcome: 'supported', requested: selection(mixed.tools), effective: selection([]) },
          read: { request: mixed, outcome: 'supported', requested: selection(mixed.tools), effective: selection(['Read']) },
          write: { request: mixed, outcome: 'supported', requested: selection(mixed.tools), effective: selection(mixed.tools) },
        },
        observe() {
          const models = readFileSync(calls, 'utf8').split('\n').filter(Boolean)
            .map((line) => JSON.parse(line) as { kind: string; args: string[] }).filter((call) => call.kind === 'model');
          const args = models.at(-1)?.args ?? [];
          const tools = args[args.indexOf('--tools') + 1]?.split(',') ?? [];
          if (!tools.includes('Edit')) {
            expect(args).toContain('--strict-mcp-config');
            expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
            expect(args[args.indexOf('--disallowedTools') + 1]).toContain('mcp__*');
          }
          return { modelCalls: models.length, canRead: tools.includes('Read'), canWrite: tools.includes('Edit') || tools.includes('Bash') };
        },
      },
      open(scenario) {
        writeFileSync(calls, '');
        env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO = scenario;
        return new ClaudeCliEngine({
          cliBinary: scenario === 'missing-cli' ? join(dir, 'absent') : bin,
          permissionMode: 'bypassPermissions',
        });
      },
    });
    expect(report).toMatchObject({ ok: true, cases: 18, failures: [] });
    expect(report.unsupported.map((item) => item.case)).toEqual(['tool-events', 'billing']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
