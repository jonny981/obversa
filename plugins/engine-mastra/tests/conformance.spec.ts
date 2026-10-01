import { expect, it } from 'vitest';
import { engineSelection, type AgentRequest } from '@obversa/api';
import { runEngineConformance } from '@obversa/api/testing';
import { MastraEngine, type MastraAgent } from '../src/index.ts';

type GenerateOptions = Parameters<MastraAgent['generate']>[1];

const identity = { provider: 'openai', modelFamily: 'gpt', model: 'gpt-5' };
const selected = engineSelection({ adapter: 'mastra', ...identity, capabilities: [] });

it('runs the full kit at the agent generate boundary', async () => {
  // What the stand-in agent's own tools can do. The engine never narrows an
  // agent's tools, so each workspace scenario opens an agent built with the
  // access that mode names, and the kit checks the engine runs it unchanged.
  let calls: GenerateOptions[] = [];
  let access = { canRead: false, canWrite: false };
  const request: AgentRequest = { prompt: 'fixture', model: 'gpt-5', tools: [], timeoutMs: 100 };
  const report = await runEngineConformance({
    request,
    requested: selected,
    effective: selected,
    unsupported: {
      'ordered-parts': 'A Mastra agent returns one final text; the engine reports that text as one part.',
      'tool-events': 'The agent runs its own tools inside generate; the engine reports its final text, not those calls.',
      'late-final': 'The agent runs in process, so no process exit can follow its final text.',
      cancellation: 'The engine emits its one observation after generate settles, so the kit cannot abort from an event; mastra.spec.ts aborts a call in flight.',
      'missing-cli': 'The agent runs in process; there is no executable.',
    },
    parseStructuredResult: (part) => JSON.parse(part.kind === 'assistant' ? part.text : 'null'),
    workspace: {
      modes: {
        none: { request, outcome: 'supported' },
        read: { request: { ...request, tools: ['Read'] }, outcome: 'supported' },
        write: { request: { ...request, tools: ['Write'] }, outcome: 'supported' },
      },
      observe() {
        for (const options of calls) expect(Object.keys(options)).toEqual(['abortSignal']);
        return { modelCalls: calls.length, ...access };
      },
    },
    open(scenario) {
      calls = [];
      access = {
        canRead: scenario === 'workspace-read' || scenario === 'workspace-write',
        canWrite: scenario === 'workspace-write',
      };
      const agent: MastraAgent = {
        model: 'openai/gpt-5',
        async generate(_prompt, options) {
          calls.push(options);
          if (scenario === 'timeout') {
            await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve, { once: true }));
            return { text: '', totalUsage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }, finishReason: 'aborted', error: undefined };
          }
          const errors: Record<string, { message: string; statusCode: number }> = {
            auth: { message: '401 unauthorized', statusCode: 401 },
            billing: { message: '402 payment required', statusCode: 402 },
            'model-unavailable': { message: 'unknown model fixture', statusCode: 404 },
            'rate-limit': { message: 'Too Many Requests', statusCode: 429 },
            quota: { message: 'monthly usage limit reached', statusCode: 403 },
            transient: { message: '503 service unavailable', statusCode: 503 },
            'invalid-config': { message: 'invalid configuration', statusCode: 400 },
          };
          const failure = errors[scenario];
          if (failure) throw Object.assign(new Error(failure.message), { statusCode: failure.statusCode });
          return {
            text: scenario === 'structured-result' ? '{"answer":42}' : 'answer',
            totalUsage: scenario === 'unknown-usage'
              ? { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }
              : { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
            finishReason: 'stop',
            error: undefined,
          };
        },
      };
      return new MastraEngine(agent, identity);
    },
  });
  expect(report).toMatchObject({ ok: true, cases: 15, failures: [] });
  expect(report.unsupported.map((item) => item.case)).toEqual(['ordered-parts', 'tool-events', 'late-final', 'cancellation', 'missing-cli']);
});
