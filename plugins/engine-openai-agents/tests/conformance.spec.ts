import { expect, it } from 'vitest';
import { Agent, RunContext, Usage } from '@openai/agents';
import { engineSelection, type AgentRequest } from '@obversa/api';
import { runEngineConformance } from '@obversa/api/testing';
import { OpenAIAgentsEngine, type OpenAIAgentsRunner } from '../src/index.ts';

type RunOptions = Parameters<OpenAIAgentsRunner['run']>[2];

const identity = { provider: 'openai', modelFamily: 'gpt', model: 'gpt-5' };
const selected = engineSelection({ adapter: 'openai-agents', ...identity, capabilities: [] });
const agent = new Agent({ name: 'Fixture', model: 'gpt-5' });

it('runs the full kit at the SDK runner boundary', async () => {
  // What the stand-in agent's own tools can do. The engine never narrows an
  // agent's tools, so each workspace scenario opens an agent built with the
  // access that mode names, and the kit checks the engine runs it unchanged.
  let calls: RunOptions[] = [];
  let access = { canRead: false, canWrite: false };
  const request: AgentRequest = { prompt: 'fixture', model: 'gpt-5', tools: [], timeoutMs: 100 };
  const report = await runEngineConformance({
    request,
    requested: selected,
    effective: selected,
    unsupported: {
      'ordered-parts': 'The SDK runner returns one final output; the engine reports that output as one part.',
      'tool-events': 'The agent runs its own tools inside the SDK runner; the engine reports its final output, not those calls.',
      'late-final': 'The agent runs in process, so no process exit can follow its final output.',
      cancellation: 'The engine emits its one observation after the run settles, so the kit cannot abort from an event; openai-agents.spec.ts aborts a run in flight.',
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
        for (const options of calls) expect(Object.keys(options)).toEqual(['signal']);
        return { modelCalls: calls.length, ...access };
      },
    },
    open(scenario) {
      calls = [];
      access = {
        canRead: scenario === 'workspace-read' || scenario === 'workspace-write',
        canWrite: scenario === 'workspace-write',
      };
      const runner: OpenAIAgentsRunner = {
        async run(_agent, _input, options) {
          calls.push(options);
          if (scenario === 'timeout') {
            await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
            throw new DOMException('This operation was aborted', 'AbortError');
          }
          const errors: Record<string, { message: string; status: number; code?: string }> = {
            auth: { message: '401 Incorrect API key provided', status: 401 },
            billing: { message: '402 payment required', status: 402 },
            'model-unavailable': { message: '404 The model `fixture` does not exist', status: 404 },
            'rate-limit': { message: '429 Rate limit reached', status: 429 },
            quota: { message: '429 You exceeded your current quota', status: 429, code: 'insufficient_quota' },
            transient: { message: '503 service unavailable', status: 503 },
            'invalid-config': { message: 'invalid configuration', status: 400 },
          };
          const failure = errors[scenario];
          if (failure) throw Object.assign(new Error(failure.message), { status: failure.status, code: failure.code, headers: new Headers() });
          const runContext = new RunContext();
          runContext.usage = scenario === 'unknown-usage'
            ? new Usage()
            : new Usage({ requests: 1, inputTokens: 5, outputTokens: 3, totalTokens: 8 });
          return {
            finalOutput: scenario === 'structured-result' ? '{"answer":42}' : 'answer',
            interruptions: [],
            runContext,
          };
        },
      };
      return new OpenAIAgentsEngine(agent, identity, runner);
    },
  });
  expect(report).toMatchObject({ ok: true, cases: 15, failures: [] });
  expect(report.unsupported.map((item) => item.case)).toEqual(['ordered-parts', 'tool-events', 'late-final', 'cancellation', 'missing-cli']);
});
