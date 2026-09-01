import type {
  AgentResult,
  AgentResultPart,
  EngineIncompleteResultEvidence,
  EngineSelectionRecord,
  EngineTransportFailure,
  UsageReceipt,
} from './contracts.js';
import { cloneFrozenJson, type JsonValue } from './json.js';

const ENGINE_FAILURE_KINDS = new Set<EngineTransportFailure['kind']>([
  'auth',
  'billing',
  'missing-cli',
  'model-unavailable',
  'invalid-config',
  'rate-limit',
  'quota',
  'transient',
  'timeout',
  'aborted',
  'unknown',
]);

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  cloneFrozenJson(value);
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return nonEmptyText(value, field);
}

function tokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateUsage(value: UsageReceipt): UsageReceipt {
  if (value.kind === 'unknown') return Object.freeze({ kind: 'unknown' });
  if (value.kind !== 'reported') {
    throw new TypeError('usage.kind must be unknown or reported');
  }
  const receipt = {
    kind: 'reported' as const,
    inputTokens: tokenCount(value.inputTokens, 'usage.inputTokens'),
    outputTokens: tokenCount(value.outputTokens, 'usage.outputTokens'),
    ...(value.cacheCreationInputTokens === undefined
      ? {}
      : {
          cacheCreationInputTokens: tokenCount(
            value.cacheCreationInputTokens,
            'usage.cacheCreationInputTokens',
          ),
        }),
    ...(value.cacheReadInputTokens === undefined
      ? {}
      : {
          cacheReadInputTokens: tokenCount(
            value.cacheReadInputTokens,
            'usage.cacheReadInputTokens',
          ),
        }),
  };
  return Object.freeze(receipt);
}

function validateSelection(
  value: EngineSelectionRecord,
  field: string,
): EngineSelectionRecord {
  const capabilities = value.capabilities.map((capability, index) =>
    nonEmptyText(capability, `${field}.capabilities[${index}]`),
  );
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError(`${field}.capabilities must be unique`);
  }
  return Object.freeze({
    adapter: nonEmptyText(value.adapter, `${field}.adapter`),
    adapterVersion:
      value.adapterVersion === null
        ? null
        : nonEmptyText(value.adapterVersion, `${field}.adapterVersion`),
    provider: nullableText(value.provider, `${field}.provider`),
    modelFamily: nullableText(value.modelFamily, `${field}.modelFamily`),
    model: nullableText(value.model, `${field}.model`),
    capabilities: Object.freeze(capabilities),
  });
}

function validatePart(value: AgentResultPart, index: number): AgentResultPart {
  if (value.kind === 'assistant') {
    if (typeof value.final !== 'boolean') {
      throw new TypeError(`parts[${index}].final must be a boolean`);
    }
    cloneFrozenJson(value.text);
    return Object.freeze({
      kind: 'assistant',
      text: value.text,
      final: value.final,
    });
  }
  if (value.kind === 'structured' && value.final === true) {
    return Object.freeze({
      kind: 'structured',
      value: cloneFrozenJson(value.value as JsonValue),
      final: true,
    });
  }
  throw new TypeError(`parts[${index}] is not a valid result part`);
}

function validateTransportFailure(
  value: EngineTransportFailure | undefined,
): EngineTransportFailure | undefined {
  if (value === undefined) return undefined;
  if (value.exitCode !== null && !Number.isSafeInteger(value.exitCode)) {
    throw new TypeError('transportFailure.exitCode must be a safe integer or null');
  }
  if (!ENGINE_FAILURE_KINDS.has(value.kind)) {
    throw new TypeError('transportFailure.kind is invalid');
  }
  return Object.freeze({
    kind: value.kind,
    message: nonEmptyText(value.message, 'transportFailure.message'),
    exitCode: value.exitCode,
  });
}

export function validateIncompleteResultEvidence(
  result: EngineIncompleteResultEvidence,
): EngineIncompleteResultEvidence {
  const parts = result.parts.map(validatePart);
  if (parts.filter((part) => part.final).length > 1) {
    throw new TypeError('incomplete engine evidence cannot contain two final parts');
  }
  const transportFailure = validateTransportFailure(result.transportFailure);
  return Object.freeze({
    parts: Object.freeze(parts),
    usage: validateUsage(result.usage),
    requested: validateSelection(result.requested, 'requested'),
    effective: validateSelection(result.effective, 'effective'),
    ...(result.stopReason === undefined
      ? {}
      : { stopReason: nonEmptyText(result.stopReason, 'stopReason') }),
    ...(transportFailure === undefined ? {} : { transportFailure }),
    ...(result.raw === undefined ? {} : { raw: result.raw }),
  });
}

export function validateAgentResult(result: AgentResult): AgentResult {
  if (result.parts.filter((part) => part.final).length !== 1) {
    throw new TypeError('agent result must contain exactly one final part');
  }
  return validateIncompleteResultEvidence(result);
}

export function engineSelection(input: {
  adapter: string;
  adapterVersion?: string | null;
  provider?: string | null;
  modelFamily?: string | null;
  model?: string | null;
  capabilities?: readonly string[];
}): EngineSelectionRecord {
  return validateSelection({
    adapter: input.adapter,
    adapterVersion: input.adapterVersion ?? null,
    provider: input.provider ?? null,
    modelFamily: input.modelFamily ?? null,
    model: input.model ?? null,
    capabilities: input.capabilities ?? [],
  }, 'selection');
}

export function reportedUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}): UsageReceipt {
  return validateUsage({ kind: 'reported', ...usage });
}

export function assistantResult(input: {
  text: string;
  usage: UsageReceipt;
  requested: EngineSelectionRecord;
  effective?: EngineSelectionRecord;
  stopReason?: string;
  transportFailure?: EngineTransportFailure;
  raw?: unknown;
}): AgentResult {
  return validateAgentResult({
    parts: [{ kind: 'assistant', text: input.text, final: true }],
    usage: input.usage,
    requested: input.requested,
    effective: input.effective ?? input.requested,
    ...(input.stopReason === undefined
      ? {}
      : { stopReason: input.stopReason }),
    ...(input.transportFailure === undefined
      ? {}
      : { transportFailure: input.transportFailure }),
    ...(input.raw === undefined ? {} : { raw: input.raw }),
  });
}

export function finalResultPart(result: AgentResult): AgentResultPart {
  const part = result.parts.find((candidate) => candidate.final);
  if (!part) throw new TypeError('agent result must contain exactly one final part');
  return part;
}

export function finalResultText(result: AgentResult): string | undefined {
  const part = finalResultPart(result);
  return part.kind === 'assistant' ? part.text : undefined;
}

export function requireFinalResultText(result: AgentResult): string {
  const text = finalResultText(result);
  if (text === undefined) {
    throw new TypeError('engine result must end with assistant text');
  }
  return text;
}
