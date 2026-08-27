/**
 * A scripted, offline engine, the reference "drop-in". It implements the same
 * `Engine` interface as the real backends, so tests and examples run the exact
 * same loop/dag/condition code paths with zero network. Writing one of these is
 * all it takes to add a provider: implement `run`, register a name.
 */

import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
  Usage,
} from './index.js';
import {
  assistantResult,
  engineSelection,
  reportedUsage,
} from './result.js';

export {
  assertEngineConformance,
  runEngineConformance,
  type EngineConformanceFailure,
  type EngineConformanceFixture,
  type EngineConformanceReport,
  type EngineConformanceScenario,
} from './conformance.js';

export type MockResponder = (
  req: AgentRequest,
) => string | { text: string; usage?: Usage; model?: string };

export class MockEngine implements Engine {
  readonly name = 'mock';
  constructor(private readonly responder: MockResponder) {}

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (signal.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const raw = this.responder(req);
    const out = typeof raw === 'string' ? { text: raw } : raw;
    const model = out.model ?? 'mock';
    const usage = reportedUsage(
      out.usage ?? { inputTokens: 10, outputTokens: 5 },
    );
    if (out.text) onEvent({ type: 'text', delta: out.text });
    onEvent({ type: 'usage', usage, model });
    const selection = engineSelection({ adapter: 'mock', model });
    return assistantResult({
      text: out.text,
      usage,
      requested: selection,
      stopReason: 'end_turn',
    });
  }
}

/** Convenience: always reply with a verdict JSON (handy for validator tests). */
export function mockVerdict(
  verdict: 'yes' | 'no',
  confidence: number,
  reason = 'mock',
): MockEngine {
  return new MockEngine(() => JSON.stringify({ verdict, confidence, reason }));
}
