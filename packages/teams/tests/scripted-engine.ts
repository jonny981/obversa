import type {
  AgentRequest,
  AgentResult,
  Engine,
} from '@obversa/runtime';

import type { TeamSeat } from '../src/types.js';

export type ScriptStep = (
  request: AgentRequest,
  call: number,
) => string | Promise<string>;

export function scriptedEngine(
  name: string,
  steps: readonly ScriptStep[],
): Engine & { readonly calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const selection = {
    adapter: 'scripted',
    adapterVersion: '1.0.0',
    provider: 'obversa-test',
    modelFamily: name,
    model: `${name}-model`,
    executable: null,
    capabilities: [],
  } as const;
  return {
    name,
    calls,
    async run(request, _onEvent, signal): Promise<AgentResult> {
      if (signal.aborted) throw new Error('aborted');
      calls.push(request);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      if (!step) throw new Error(`no scripted response for ${name}`);
      const text = await step(request, calls.length);
      return {
        parts: [{ kind: 'assistant', text, final: true }],
        usage: { kind: 'unknown' },
        requested: selection,
        effective: selection,
      };
    },
  };
}

export function seat(engine: Engine, modelFamily: string): TeamSeat {
  const model = `${engine.name}-model`;
  return {
    engine,
    identity: {
      adapter: 'scripted',
      provider: 'obversa-test',
      modelFamily,
      model,
    },
  };
}

export function pass(summary: string): string {
  return JSON.stringify({ status: 'pass', summary });
}

export function revise(summary: string, evidence: string): string {
  return JSON.stringify({
    status: 'revise',
    summary,
    findings: [{ severity: 'block', evidence }],
  });
}
