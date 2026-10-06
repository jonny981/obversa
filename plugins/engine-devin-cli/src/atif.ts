/**
 * Read the conversation file `devin --export` writes. Devin 3000.11 writes it
 * in the ATIF v1 shape: ordered steps from the system, the user and the agent,
 * with each agent step carrying its text, its tool calls, the results of those
 * calls and the model that produced it.
 */
import type { EngineStreamEvent, UsageReceipt } from '@obversa/api';
import { toolTarget } from '@obversa/core/tool-target';

/** What Devin writes as the result of a tool call its permission mode refused. */
const REFUSED_RESULT = 'Tool execution was rejected';

export interface DevinConversation {
  /** Every non-empty agent message, in order. */
  readonly messages: readonly string[];
  /** True when the conversation ends on an agent message with no tool calls. */
  readonly answered: boolean;
  /** The model named on the last agent step, when Devin names one. */
  readonly model: string | undefined;
  readonly toolEvents: readonly Extract<EngineStreamEvent, { type: 'tool' }>[];
  /**
   * The totals of every run in the session: Devin's export of a continued
   * session holds the whole session.
   */
  readonly usage: UsageReceipt;
  /** The session id `devin -r` continues, when the export names one. */
  readonly sessionId: string | undefined;
  /** What each refused tool call acted on, or the tool's name, in order. */
  readonly refused: readonly string[];
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Devin export ${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => (part !== null && typeof part === 'object'
      && (part as Record<string, unknown>).type === 'text'
      && typeof (part as Record<string, unknown>).text === 'string'
      ? (part as Record<string, string>).text
      : ''))
    .join('');
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function usage(value: unknown): UsageReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unknown' };
  }
  const totals = value as Record<string, unknown>;
  const input = totals.total_prompt_tokens;
  const output = totals.total_completion_tokens;
  const cached = totals.total_cached_tokens;
  if (!tokenCount(input) || !tokenCount(output)
    || (cached != null && (!tokenCount(cached) || cached > input))) {
    return { kind: 'unknown' };
  }
  return {
    kind: 'reported',
    inputTokens: input,
    outputTokens: output,
    ...(cached == null ? {} : { cacheReadInputTokens: cached }),
  };
}

export function readDevinExport(value: unknown): DevinConversation {
  const root = record(value, 'root');
  if (typeof root.schema_version !== 'string' || !root.schema_version.startsWith('ATIF-v1.')) {
    throw new Error('Devin export is not in the ATIF v1 shape');
  }
  if (!Array.isArray(root.steps)) throw new Error('Devin export has no steps');

  const messages: string[] = [];
  const toolEvents: Extract<EngineStreamEvent, { type: 'tool' }>[] = [];
  const refused: string[] = [];
  let answered = false;
  let model: string | undefined;
  for (const value of root.steps) {
    const step = record(value, 'step');
    if (step.source !== 'agent') {
      answered = false;
      continue;
    }
    if (typeof step.model_name === 'string' && step.model_name.length > 0) {
      model = step.model_name;
    }
    const calls = new Map<string, string>();
    const targets = new Map<string, string>();
    if (Array.isArray(step.tool_calls)) {
      for (const value of step.tool_calls) {
        const call = record(value, 'tool call');
        if (typeof call.tool_call_id !== 'string' || typeof call.function_name !== 'string') {
          throw new Error('Devin export has a tool call without an id or a name');
        }
        calls.set(call.tool_call_id, call.function_name);
        targets.set(call.tool_call_id, toolTarget(call.arguments) ?? call.function_name);
        toolEvents.push({ type: 'tool', name: call.function_name, phase: 'use' });
      }
    }
    const results = step.observation === undefined || step.observation === null
      ? []
      : record(step.observation, 'observation').results;
    if (Array.isArray(results)) {
      for (const value of results) {
        const result = record(value, 'tool result');
        const id = result.source_call_id;
        const name = typeof id === 'string' ? calls.get(id) : undefined;
        if (name !== undefined) toolEvents.push({ type: 'tool', name, phase: 'result' });
        if (name !== undefined && typeof result.content === 'string' && result.content.startsWith(REFUSED_RESULT)) {
          refused.push(targets.get(id as string)!);
        }
      }
    }
    const text = messageText(step.message);
    if (text.length > 0) messages.push(text);
    answered = text.length > 0 && calls.size === 0;
  }
  return {
    messages, answered, model, toolEvents, usage: usage(root.final_metrics),
    sessionId: typeof root.session_id === 'string' && root.session_id.length > 0 ? root.session_id : undefined,
    refused,
  };
}
