import type {
  AgentResult,
  EngineTransportFailure,
  UsageReceipt,
} from '../src/engines/engine.ts';
import {
  assistantResult,
  engineSelection,
  reportedUsage,
} from '../src/runtime/result-parts.ts';

export function fixtureUsage(
  inputTokens = 1,
  outputTokens = 1,
): UsageReceipt {
  return reportedUsage({ inputTokens, outputTokens });
}

export function fixtureResult(
  text: string,
  options: {
    model?: string;
    usage?: UsageReceipt;
    stopReason?: string;
    transportFailure?: EngineTransportFailure;
  } = {},
): AgentResult {
  const model = options.model ?? 'fixture-model';
  const selection = engineSelection({ adapter: 'fixture', model });
  return assistantResult({
    text,
    usage: options.usage ?? fixtureUsage(),
    requested: selection,
    ...(options.stopReason === undefined
      ? {}
      : { stopReason: options.stopReason }),
    ...(options.transportFailure === undefined
      ? {}
      : { transportFailure: options.transportFailure }),
  });
}
