import type {
  AgentRequest,
  AgentResult,
  Engine,
} from '@obversa/runtime';
import type { TeamSeat } from '@obversa/teams';

export type ScriptStep = (
  request: AgentRequest,
  call: number,
) => string | Promise<string>;

export function scriptedSeat(
  name: string,
  modelFamily: string,
  steps: readonly ScriptStep[],
): TeamSeat & { readonly calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const model = `${name}-model`;
  const selection = {
    adapter: 'scripted',
    adapterVersion: '1.0.0',
    provider: 'obversa-example',
    modelFamily,
    model,
    executable: null,
    capabilities: [],
  } as const;
  const engine: Engine = {
    name,
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
  return {
    engine,
    identity: {
      adapter: 'scripted',
      provider: 'obversa-example',
      modelFamily,
      model,
    },
    calls,
  };
}

export const pass = (summary: string): string =>
  JSON.stringify({ status: 'pass', summary });

export const revise = (summary: string, evidence: string): string =>
  JSON.stringify({
    status: 'revise',
    summary,
    findings: [{ severity: 'block', evidence }],
  });
