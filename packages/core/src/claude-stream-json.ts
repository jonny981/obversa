/**
 * Shared mapping from the Claude stream-json message schema to our neutral
 * `EngineStreamEvent`s. Both the Agent SDK and the `claude` CLI emit this same
 * schema, so the two adapters share this one function.
 *
 * The boundary with an external schema is where `any` is warranted: we read
 * defensively so a minor upstream shape change doesn't crash a run.
 */

import type {
  AgentResultPart,
  Billing,
  CostReceipt,
  EngineEventSink,
  Usage,
  UsageReceipt,
} from '@obversa/api';
import { toolTarget } from './tool-target.js';

export interface Accumulator {
  parts: AgentResultPart[];
  usage: UsageReceipt;
  model: string | null;
  stopReason?: string;
  /** Set once we have seen token deltas, so we don't double-emit full blocks. */
  sawDelta: boolean;
  /** Set only when the backend emits a terminal result message. */
  terminal: boolean;
  /** The dollar figure the result message reports, when it reports one. */
  costUsd?: number;
}

export function newAccumulator(model?: string): Accumulator {
  return {
    parts: [],
    usage: { kind: 'unknown' },
    model: model ?? null,
    sawDelta: false,
    terminal: false,
  };
}

type AnyRecord = Record<string, unknown>;

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? (value as AnyRecord[]) : [];
}

export function mapMessage(
  message: unknown,
  acc: Accumulator,
  onEvent: EngineEventSink,
): void {
  const msg = (message ?? {}) as AnyRecord;
  switch (msg.type) {
    case 'assistant': {
      const inner = (msg.message ?? {}) as AnyRecord;
      if (typeof inner.model === 'string') acc.model = inner.model;
      if (typeof inner.stop_reason === 'string')
        acc.stopReason = inner.stop_reason;
      let assistantText = '';
      for (const block of asArray(inner.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          assistantText += block.text;
          if (!acc.sawDelta) onEvent({ type: 'text', delta: block.text });
        } else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string'
        ) {
          if (!acc.sawDelta)
            onEvent({ type: 'thinking', delta: block.thinking });
        } else if (
          block.type === 'tool_use' &&
          typeof block.name === 'string'
        ) {
          const target = toolTarget(block.input);
          onEvent({
            type: 'tool',
            name: block.name,
            phase: 'use',
            ...(target === undefined ? {} : { target }),
          });
        }
      }
      if (assistantText) {
        acc.parts.push({
          kind: 'assistant',
          text: assistantText,
          final: false,
        });
      }
      const usage = inner.usage as AnyRecord | undefined;
      const reported = usage ? usageFrom(usage) : undefined;
      if (usage && reported) {
        const prior = acc.usage.kind === 'reported' ? acc.usage : undefined;
        const cacheCreation = optionalNum(usage.cache_creation_input_tokens);
        const cacheRead = optionalNum(usage.cache_read_input_tokens);
        acc.usage = {
          kind: 'reported',
          inputTokens: (prior?.inputTokens ?? 0) + reported.inputTokens,
          outputTokens: (prior?.outputTokens ?? 0) + reported.outputTokens,
          ...(cacheCreation === undefined
            ? {}
            : {
                cacheCreationInputTokens:
                  (prior?.cacheCreationInputTokens ?? 0) + cacheCreation,
              }),
          ...(cacheRead === undefined
            ? {}
            : {
                cacheReadInputTokens:
                  (prior?.cacheReadInputTokens ?? 0) + cacheRead,
              }),
        };
      }
      break;
    }
    case 'user': {
      const inner = (msg.message ?? {}) as AnyRecord;
      for (const block of asArray(inner.content)) {
        if (block.type === 'tool_result') {
          onEvent({
            type: 'tool',
            name: typeof block.name === 'string' ? block.name : 'tool',
            phase: 'result',
          });
        }
      }
      break;
    }
    case 'stream_event': {
      const event = (msg.event ?? {}) as AnyRecord;
      if (event.type === 'content_block_delta') {
        const delta = (event.delta ?? {}) as AnyRecord;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          acc.sawDelta = true;
          onEvent({ type: 'text', delta: delta.text });
        } else if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          acc.sawDelta = true;
          onEvent({ type: 'thinking', delta: delta.thinking });
        }
      }
      break;
    }
    case 'result': {
      acc.terminal = true;
      // `subtype` is the result *classification* (success / error_max_turns …),
      // not the model stop reason; that is the sibling `stop_reason` field.
      if (typeof msg.stop_reason === 'string') acc.stopReason = msg.stop_reason;
      const costUsd = optionalNum(msg.total_cost_usd);
      if (costUsd !== undefined && costUsd >= 0) acc.costUsd = costUsd;
      const usage = msg.usage as AnyRecord | undefined;
      const reported = usage ? usageFrom(usage) : undefined;
      if (usage && reported) {
        // result usage is authoritative for the turn
        const cacheCreation = optionalNum(usage.cache_creation_input_tokens);
        const cacheRead = optionalNum(usage.cache_read_input_tokens);
        acc.usage = {
          ...reported,
          ...(cacheCreation === undefined
            ? {}
            : { cacheCreationInputTokens: cacheCreation }),
          ...(cacheRead === undefined
            ? {}
            : { cacheReadInputTokens: cacheRead }),
        };
      }
      if (!acc.parts.length) {
        acc.parts.push({
          kind: 'assistant',
          text: typeof msg.result === 'string' ? msg.result : '',
          final: true,
        });
      } else {
        const last = acc.parts.at(-1);
        if (last?.kind === 'assistant') {
          acc.parts[acc.parts.length - 1] = { ...last, final: true };
        }
      }
      break;
    }
  }
}

/** The figure the result message reported, as a cost receipt. */
export function reportedCost(acc: Accumulator): { cost: CostReceipt } | Record<string, never> {
  return acc.costUsd === undefined ? {} : { cost: { kind: 'reported', usd: acc.costUsd } };
}

/**
 * Variables that make Claude Code bill an API account rather than the
 * person's own plan: an API key, a gateway token, or a cloud provider.
 */
const API_BILLING_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/**
 * `api` when the environment the Claude process gets sets one of the
 * variables above, and `subscription` otherwise: the person's own login.
 */
export function claudeBilling(env: Readonly<Record<string, string | undefined>>): Billing {
  return API_BILLING_VARIABLES.some((name) => (env[name] ?? '') !== '') ? 'api' : 'subscription';
}

function usageFrom(usage: AnyRecord): ({ kind: 'reported' } & Usage) | undefined {
  if (
    optionalNum(usage.input_tokens) === undefined ||
    optionalNum(usage.output_tokens) === undefined
  ) {
    return undefined;
  }
  return {
    kind: 'reported',
    inputTokens: inputTokens(usage),
    outputTokens: num(usage.output_tokens),
  };
}

function inputTokens(usage: AnyRecord): number {
  return (
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens)
  );
}

function num(value: unknown): number {
  return optionalNum(value) ?? 0;
}

function optionalNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
