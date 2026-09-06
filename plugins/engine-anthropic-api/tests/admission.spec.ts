import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  engineSelection,
  runEngineAdmissionConformance,
  type AgentRequest,
  type EngineAdmissionConformanceFixture,
} from '@obversa/engine';
import { AnthropicApiEngine } from '../src/index.ts';

const request: AgentRequest = {
  prompt: 'Return a short answer.',
  model: 'request-model',
  tools: [],
  allowedTools: [],
  workspaceMode: 'none',
  timeoutMs: 1_000,
  leaf: true,
};
const selected = engineSelection({
  adapter: 'anthropic-api', provider: 'anthropic', model: 'request-model',
  executable: null, capabilities: [],
});
const signal = () => new AbortController().signal;
function staticRequest(): Omit<AgentRequest, 'prompt'> {
  const { prompt: _prompt, ...rest } = structuredClone(request);
  return rest;
}

function harness(): {
  fixture: EngineAdmissionConformanceFixture;
  bodies: unknown[];
  open: () => AnthropicApiEngine;
} {
  const bodies: unknown[] = [];
  function open(): AnthropicApiEngine {
    const engine = new AnthropicApiEngine({ apiKey: 'test-key', defaultModel: 'default-model' });
    (engine as unknown as { clientPromise: Promise<unknown> }).clientPromise = Promise.resolve({
      messages: {
        stream(body: unknown) {
          bodies.push(body);
          return {
            on() {},
            async finalMessage() {
              return {
                content: [{ type: 'text', text: 'scripted answer' }],
                usage: { input_tokens: 1, output_tokens: 2 },
                stop_reason: 'end_turn',
              };
            },
          };
        },
      },
    });
    return engine;
  }
  return {
    bodies, open,
    fixture: {
      request, selection: selected, open,
      modelCalls(executable) {
        return executable === undefined || executable === null ? bodies.length : 0;
      },
    },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('API static admission', () => {
  it('implements the separate admission contract without a fake executable', async () => {
    const { fixture, bodies } = harness();
    const report = await runEngineAdmissionConformance(fixture);
    expect(report).toEqual({ ok: true, cases: 9, failures: [] });
    expect(bodies).toHaveLength(2);
  });

  it('checks local configuration without creating a client or making a network call', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network is forbidden'));
    const engine = new AnthropicApiEngine({ apiKey: 'test-key' });
    await expect(engine.admit(staticRequest(), signal())).resolves.toEqual(selected);
    expect((engine as unknown as { clientPromise?: unknown }).clientPromise).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the existing missing-key reason and makes no client', async () => {
    const engine = new AnthropicApiEngine({ apiKey: '' });
    await expect(engine.admit(staticRequest(), signal())).rejects.toMatchObject({
      kind: 'invalid-config',
      message: 'the anthropic-api engine needs an API key — set ANTHROPIC_API_KEY or pass --api-key (or use the agent-sdk / claude-cli engine, which use host Claude auth)',
    });
    expect((engine as unknown as { clientPromise?: unknown }).clientPromise).toBeUndefined();
  });

  it.each(['tools', 'allowedTools'] as const)('refuses nonempty %s without a provider call', async (field) => {
    const { open, bodies } = harness();
    await expect(open().admit({ ...staticRequest(), [field]: ['Read'] }, signal()))
      .rejects.toMatchObject({ kind: 'invalid-config' });
    expect(bodies).toEqual([]);
  });

  it('refuses an aborted admission before local client creation', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = new AnthropicApiEngine({ apiKey: 'test-key' });
    await expect(engine.admit(staticRequest(), controller.signal))
      .rejects.toMatchObject({ kind: 'aborted' });
    expect((engine as unknown as { clientPromise?: unknown }).clientPromise).toBeUndefined();
  });

  it('refuses a saved executable on the process-free API', async () => {
    const { open, bodies } = harness();
    await expect(open().admit(staticRequest(), signal(), engineSelection({
      ...selected, executable: '/not/an/api/executable',
    }))).rejects.toMatchObject({ kind: 'invalid-config' });
    expect(bodies).toEqual([]);
  });

  it('does not reuse an earlier request model as the next selection', async () => {
    const { open, bodies } = harness();
    const engine = open();
    await expect(engine.admit(staticRequest(), signal())).resolves.toEqual(selected);
    const next = engineSelection({ ...selected, model: 'second-model' });
    await expect(engine.admit({ ...staticRequest(), model: 'second-model' }, signal()))
      .resolves.toEqual(next);
    const result = await engine.run({ ...request, model: 'second-model' }, () => {}, signal());
    expect(result.requested).toEqual(next);
    expect(result.effective).toEqual(next);
    expect(bodies).toEqual([expect.objectContaining({ model: 'second-model' })]);
  });

  it('keeps ordinary requests text-only without claiming requested tools', async () => {
    const { open, bodies } = harness();
    const result = await open().run({ ...request, tools: ['Read'], allowedTools: ['Read'] }, () => {}, signal());
    expect(result.requested.capabilities).toEqual([]);
    expect(result.effective.capabilities).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual(expect.objectContaining({
      model: 'request-model', messages: [{ role: 'user', content: request.prompt }],
    }));
    expect(bodies[0]).not.toHaveProperty('tools');
  });
});
