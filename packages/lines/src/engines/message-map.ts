/**
 * Shared mapping from the Claude stream-json message schema to our neutral
 * `EngineStreamEvent`s. Both the Agent SDK and the `claude` CLI emit this same
 * schema, so the two adapters share this one function.
 *
 * The boundary with an external schema is where `any` is warranted: we read
 * defensively so a minor upstream shape change doesn't crash a run.
 */

import type { EngineEventSink, Usage } from './engine.js';

export interface Accumulator {
  text: string;
  usage: Usage;
  model: string;
  stopReason?: string;
  /** Set once we have seen token deltas, so we don't double-emit full blocks. */
  sawDelta: boolean;
  /** Set only when the backend emits a terminal result message. */
  terminal: boolean;
}

export function newAccumulator(model: string): Accumulator {
  return {
    text: '',
    usage: { inputTokens: 0, outputTokens: 0 },
    model,
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
      for (const block of asArray(inner.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          acc.text += block.text;
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
          onEvent({ type: 'tool', name: block.name, phase: 'use' });
        }
      }
      const usage = inner.usage as AnyRecord | undefined;
      if (usage) {
        acc.usage.inputTokens += inputTokens(usage);
        acc.usage.outputTokens += num(usage.output_tokens);
        const cacheCreation = optionalNum(usage.cache_creation_input_tokens);
        const cacheRead = optionalNum(usage.cache_read_input_tokens);
        if (cacheCreation !== undefined)
          acc.usage.cacheCreationInputTokens =
            (acc.usage.cacheCreationInputTokens ?? 0) + cacheCreation;
        if (cacheRead !== undefined)
          acc.usage.cacheReadInputTokens =
            (acc.usage.cacheReadInputTokens ?? 0) + cacheRead;
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
      const usage = msg.usage as AnyRecord | undefined;
      if (usage) {
        // result usage is authoritative for the turn
        const i = inputTokens(usage);
        const o = num(usage.output_tokens);
        if (i) acc.usage.inputTokens = i;
        if (o) acc.usage.outputTokens = o;
        const cacheCreation = optionalNum(usage.cache_creation_input_tokens);
        const cacheRead = optionalNum(usage.cache_read_input_tokens);
        if (cacheCreation !== undefined)
          acc.usage.cacheCreationInputTokens = cacheCreation;
        if (cacheRead !== undefined)
          acc.usage.cacheReadInputTokens = cacheRead;
      }
      if (!acc.text && typeof msg.result === 'string') acc.text = msg.result;
      break;
    }
  }
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
