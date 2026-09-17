import { expect, it, vi } from 'vitest';
import { engineSelection, runEngineConformance, type AgentRequest } from '@obversa/engine';
import { AgentSdkEngine } from '../src/index.ts';

interface QueryInput {
  options: { tools?: string[]; allowedTools?: string[]; disallowedTools?: string[]; abortController: AbortController; settingSources?: string[]; strictMcpConfig?: boolean };
}

const provider = vi.hoisted(() => {
  const state = { scenario: '', calls: [] as QueryInput[] };
  return {
    state,
    query(input: QueryInput) {
      state.calls.push(input);
      const scenario = state.scenario;
      return (async function* () {
        const errors: Record<string, string> = {
          auth: '401 unauthorized', 'model-unavailable': 'unknown model fixture',
          'rate-limit': '429 rate limit reached', quota: 'monthly usage limit reached',
          transient: '503 service unavailable', 'invalid-config': 'invalid configuration',
        };
        if (errors[scenario]) throw new Error(errors[scenario]);
        const assistant = (text: string) => ({ type: 'assistant', message: { model: 'claude-test', content: [{ type: 'text', text }] } });
        if (scenario === 'timeout' || scenario === 'cancellation') {
          if (scenario === 'cancellation') yield assistant('started');
          const signal = input.options.abortController.signal;
          await new Promise<never>((_resolve, reject) => {
            const abort = () => reject(Object.assign(new Error('provider aborted'), { name: 'AbortError' }));
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        }
        if (scenario === 'ordered-parts') yield assistant('draft');
        const answer = scenario === 'structured-result' ? '{"answer":42}' : 'answer';
        yield assistant(answer);
        yield { type: 'result', result: answer,
          ...(scenario === 'reported-usage' ? { usage: { input_tokens: 5, output_tokens: 3 } } : {}),
        };
        if (scenario === 'late-final') throw new Error('transport closed');
      })();
    },
  };
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: provider.query }));

it('runs the full kit at the SDK query boundary', async () => {
  const request: AgentRequest = { prompt: 'fixture', model: 'claude-test', tools: ['Read'], allowedTools: ['Read'], timeoutMs: 100 };
  const selected = (capabilities: string[]) => engineSelection({ adapter: 'agent-sdk', provider: 'anthropic', model: 'claude-test', capabilities });
  const mixed = { ...request, tools: ['Read', 'Edit', 'Bash'], allowedTools: ['Read', 'Edit', 'Bash'] };
  const report = await runEngineConformance({
    request, requested: selected(['Read']), effective: selected(['Read']),
    unsupported: {
      'tool-events': 'SDK tool-result messages have no tool name; this adapter reports a generic result name.',
      'missing-cli': 'The SDK manages its executable; this adapter has no executable option.',
      billing: 'This adapter classifies billing failures as quota, not a distinct billing kind.',
    },
    parseStructuredResult: (part) => JSON.parse(part.kind === 'assistant' ? part.text : 'null'),
    workspace: {
      modes: {
        none: { request: mixed, outcome: 'supported', requested: selected(mixed.tools), effective: selected([]) },
        read: { request: mixed, outcome: 'supported', requested: selected(mixed.tools), effective: selected(['Read']) },
        write: { request: mixed, outcome: 'supported', requested: selected(mixed.tools), effective: selected(mixed.tools) },
      },
      observe() {
        const options = provider.state.calls.at(-1)!.options;
        const tools = options.tools ?? [];
        if (!tools.includes('Edit')) {
          expect(options.settingSources).toEqual([]);
          expect(options.strictMcpConfig).toBe(true);
          expect(options.disallowedTools).toContain('mcp__*');
        }
        return { modelCalls: provider.state.calls.length, canRead: tools.includes('Read'), canWrite: tools.includes('Edit') || tools.includes('Bash') };
      },
    },
    open(scenario) {
      provider.state.scenario = scenario;
      provider.state.calls = [];
      return new AgentSdkEngine({ permissionMode: 'bypassPermissions' });
    },
  });
  expect(report).toMatchObject({ ok: true, cases: 17, failures: [] });
  expect(report.unsupported.map((item) => item.case)).toEqual(['tool-events', 'missing-cli', 'billing']);
});
