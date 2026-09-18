import { expect, it } from 'vitest';
import { engineSelection, type AgentRequest } from '@obversa/api';
import { runEngineConformance } from '@obversa/api/testing';
import { AnthropicApiEngine } from '../src/index.ts';

it('runs the full kit at the Messages API boundary', async () => {
  let calls: Array<{ tools?: unknown }> = [];
  const request: AgentRequest = { prompt: 'fixture', model: 'claude-test', tools: [], purpose: 'preflight', timeoutMs: 100 };
  const selected = engineSelection({ adapter: 'anthropic-api', provider: 'anthropic', model: 'claude-test', capabilities: [] });
  const report = await runEngineConformance({
    request, requested: selected, effective: selected,
    unsupported: {
      'ordered-parts': 'This text adapter returns one final message, not assistant continuations.',
      'unknown-usage': 'Messages API responses require token usage; this adapter always reports it.',
      'tool-events': 'This adapter has no tool execution.',
      'late-final': 'Messages API has no successful final message followed by a process exit.',
      'missing-cli': 'Messages API has no executable.',
    },
    parseStructuredResult: (part) => JSON.parse(part.kind === 'assistant' ? part.text : 'null'),
    workspace: {
      modes: {
        none: { request, outcome: 'supported' },
        read: { request: { ...request, tools: ['Read'] }, outcome: 'refused' },
        write: { request: { ...request, tools: ['Write'] }, outcome: 'refused' },
      },
      observe() {
        for (const body of calls) expect(body.tools).toBeUndefined();
        return { modelCalls: calls.length, canRead: false, canWrite: false };
      },
    },
    open(scenario) {
      calls = [];
      const engine = new AnthropicApiEngine({ apiKey: 'fixture-key' });
      (engine as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve({
        messages: {
          stream(body: { tools?: unknown }, options: { signal: AbortSignal }) {
            calls.push(body);
            return {
              on(_event: string, text: (delta: string) => void) {
                if (scenario === 'cancellation') text('started');
              },
              async finalMessage() {
                if (scenario === 'timeout' || scenario === 'cancellation') {
                  await new Promise<never>((_resolve, reject) => {
                    const abort = () => reject(Object.assign(new Error('provider aborted'), { name: 'AbortError' }));
                    if (options.signal.aborted) abort();
                    else options.signal.addEventListener('abort', abort, { once: true });
                  });
                }
                const errors: Record<string, { message: string; status: number }> = {
                  auth: { message: '401 unauthorized', status: 401 },
                  billing: { message: '402 payment required', status: 402 },
                  'model-unavailable': { message: 'unknown model fixture', status: 404 },
                  'rate-limit': { message: '429 rate limit reached', status: 429 },
                  quota: { message: 'monthly usage limit reached', status: 403 },
                  transient: { message: '503 service unavailable', status: 503 },
                  'invalid-config': { message: 'invalid configuration', status: 400 },
                };
                const failure = errors[scenario];
                if (failure) throw Object.assign(new Error(failure.message), { status: failure.status });
                return {
                  content: [{ type: 'text', text: scenario === 'structured-result' ? '{"answer":42}' : 'answer' }],
                  usage: { input_tokens: 5, output_tokens: 3 }, stop_reason: 'end_turn',
                };
              },
            };
          },
        },
      });
      return engine;
    },
  });
  expect(report).toMatchObject({ ok: true, cases: 15, failures: [] });
  expect(report.unsupported.map((item) => item.case)).toEqual(['ordered-parts', 'unknown-usage', 'tool-events', 'late-final', 'missing-cli']);
});
