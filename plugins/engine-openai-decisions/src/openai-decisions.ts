/**
 * OpenAI's Decisions API as an Obversa engine adapter.
 *
 * The Decisions API answers typed questions about some evidence: the
 * probability that a condition is true, one choice from a fixed set, or a
 * score against ordered levels. It is the same kind of model as Jev, so this
 * adapter takes the same prompt document the Jev adapter takes, a JSON
 * `{state, questions}` object whose questions are keyed by name and typed
 * `noul`, `choice` or `score`, and returns the answers keyed by the same
 * names. The runtime's `judge` runs on it unchanged.
 *
 * The wire is one POST to `/v1/decisions` with a bearer key taken from
 * adapter configuration at construction; a `request.env` field is refused.
 * The adapter is stateless: one call per attempt, no retry, no confidence
 * threshold. What a workflow does with a low-confidence answer is the
 * caller's routing, not this adapter's.
 */

import { isDeepStrictEqual } from 'node:util';
import {
  EngineError,
  engineSelection,
  finalResultPart,
  modelIdentity,
  reportedUsage,
  validateAgentResult,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
  type EngineFailureKind,
  type EngineSelectionRecord,
  type JsonObject,
  type JsonValue,
  type UsageReceipt,
} from '@obversa/api';

const ADAPTER = 'openai-decisions';
const PROVIDER = 'openai';
const DEFAULT_MODEL = 'gpt-6-luna';
const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/decisions';
const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);
const NO_EFFORT = 'the Decisions API takes no effort setting; leave effort unset';

export interface OpenAIDecisionsEngineOptions {
  /** Bearer credential supplied by adapter configuration at run time. */
  readonly apiKey: string;
  /** POST target. Defaults to `https://api.openai.com/v1/decisions`. */
  readonly endpoint?: string;
  /** Package version recorded in the requested identity. */
  readonly adapterVersion?: string;
  /** Wire model used when the request names none. Defaults to `gpt-6-luna`. */
  readonly model?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
  /** Unsupported: the Decisions API takes no effort setting, so setting it throws. */
  readonly effort?: string;
}

interface DecisionDocument {
  readonly state: JsonValue;
  readonly questions: JsonObject;
}

interface WireQuestion {
  readonly type: 'predicate' | 'choice' | 'score';
  readonly name: string;
  readonly instructions: string;
  readonly choices?: readonly { readonly value: string; readonly description: string }[];
  readonly levels?: readonly { readonly label: string; readonly description: string }[];
}

function invalid(message: string): EngineError {
  return new EngineError({ kind: 'invalid-config', message });
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The prompt must be a `{state, questions}` JSON document, as for Jev. */
export function parseDecisionDocument(prompt: string): DecisionDocument {
  let document: unknown;
  try {
    document = JSON.parse(prompt);
  } catch (error) {
    throw invalid(
      `openai-decisions prompt must be a JSON {state, questions} document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPlainObject(document)) {
    throw invalid('openai-decisions prompt must parse to an object carrying state and questions');
  }
  const questions = document.questions;
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw invalid('openai-decisions prompt must carry a non-empty questions object');
  }
  for (const [name, question] of Object.entries(questions)) {
    if (!isPlainObject(question)) {
      throw invalid(`openai-decisions question ${JSON.stringify(name)} must be an object`);
    }
    if (typeof question.type !== 'string' || !QUESTION_TYPES.has(question.type)) {
      throw invalid(
        `openai-decisions question ${JSON.stringify(name)} must declare a type of noul, choice or score`,
      );
    }
  }
  return { state: document.state ?? {}, questions };
}

/**
 * Translate one Jev-shaped question to the Decisions wire. A `noul` is a
 * `predicate`; its true and false criteria have no field of their own on the
 * wire, so they join the instructions. A `choice` maps each criterion to a
 * choice and its description. A `score` maps each criterion, a label or a
 * `{label, description}` object, to a level in the same order.
 */
export function wireQuestion(name: string, question: JsonObject): WireQuestion {
  const where = `openai-decisions question ${JSON.stringify(name)}`;
  if (!nonEmpty(question.instructions)) throw invalid(`${where} must carry instructions`);
  const instructions = question.instructions.trim();
  const criteria = question.criteria;
  if (question.type === 'noul') {
    if (criteria === undefined) return { type: 'predicate', name, instructions };
    if (!isPlainObject(criteria)) throw invalid(`${where} criteria must be an object of true and false`);
    const lines = [instructions];
    if (nonEmpty(criteria.true)) lines.push(`True when: ${criteria.true.trim()}`);
    if (nonEmpty(criteria.false)) lines.push(`False when: ${criteria.false.trim()}`);
    return { type: 'predicate', name, instructions: lines.join('\n') };
  }
  if (question.type === 'choice') {
    if (!isPlainObject(criteria) || Object.keys(criteria).length < 2) {
      throw invalid(`${where} criteria must name at least two choices, each with a description`);
    }
    const choices = Object.entries(criteria).map(([value, description]) => {
      if (!nonEmpty(description)) throw invalid(`${where} choice ${JSON.stringify(value)} must have a description`);
      return { value, description: description.trim() };
    });
    return { type: 'choice', name, instructions, choices };
  }
  if (!Array.isArray(criteria) || criteria.length < 2) {
    throw invalid(`${where} criteria must list at least two ordered levels`);
  }
  const levels = criteria.map((level, index) => {
    if (nonEmpty(level)) return { label: level.trim(), description: level.trim() };
    if (isPlainObject(level) && nonEmpty(level.label)) {
      const description = nonEmpty(level.description) ? level.description.trim() : level.label.trim();
      return { label: level.label.trim(), description };
    }
    throw invalid(`${where} level ${index} must be a label or a {label, description} object`);
  });
  return { type: 'score', name, instructions, levels };
}

/** The evidence: a string as it is, anything else as indented JSON. */
function evidence(state: JsonValue): string {
  return typeof state === 'string' ? state : JSON.stringify(state, null, 2);
}

/** Fields the builder never sends, or that have no meaning on this wire. */
function assertRequestShape(request: Omit<AgentRequest, 'prompt'>): void {
  if (request.system !== undefined || request.systemMode !== undefined) {
    throw invalid('openai-decisions requests do not carry a system prompt');
  }
  if (request.env !== undefined) {
    throw invalid('openai-decisions requests do not carry env; credentials live in adapter configuration');
  }
  if (request.maxTokens !== undefined) {
    throw invalid('the Decisions API has no output token cap; maxTokens is unsupported');
  }
  if (request.jsonSchema !== undefined) {
    throw invalid('the Decisions API answers typed questions only; a jsonSchema result is unsupported');
  }
  if (request.workspaceMode !== undefined && request.workspaceMode !== 'none') {
    throw invalid(`openai-decisions performs no filesystem access; workspaceMode must be none, not ${request.workspaceMode}`);
  }
  if ((request.tools?.length ?? 0) > 0) {
    throw invalid('openai-decisions declares no tools; a non-empty tools list cannot be honoured');
  }
  if (request.effort !== undefined) throw invalid(NO_EFFORT);
}

/**
 * The provider's answers array, keyed by question name. Each answer keeps the
 * fields the provider sent, less `name`; a predicate's `probability` is also
 * given as `noul`, the field Jev answers carry, so the runtime's judge reads
 * it as it reads a Jev answer.
 */
export function answersByName(answers: unknown, names: readonly string[]): JsonObject {
  if (!Array.isArray(answers)) {
    throw new EngineError({ kind: 'unknown', message: 'openai-decisions response carried no answers array' });
  }
  const byName: Record<string, JsonValue> = {};
  for (const answer of answers) {
    if (!isPlainObject(answer) || typeof answer.name !== 'string') {
      throw new EngineError({ kind: 'unknown', message: 'openai-decisions response carried an answer with no name' });
    }
    const { name, ...rest } = answer;
    if (!names.includes(name)) {
      throw new EngineError({ kind: 'unknown', message: `openai-decisions response answered an unknown question ${JSON.stringify(name)}` });
    }
    byName[name] = rest.type === 'predicate' && typeof rest.probability === 'number'
      ? { ...rest, noul: rest.probability }
      : rest;
  }
  const missing = names.filter((name) => !(name in byName));
  if (missing.length > 0) {
    throw new EngineError({ kind: 'unknown', message: `openai-decisions response did not answer ${missing.map((name) => JSON.stringify(name)).join(', ')}` });
  }
  return byName;
}

export class OpenAIDecisionsEngine implements Engine {
  readonly name = ADAPTER;
  readonly #options: OpenAIDecisionsEngineOptions;

  constructor(options: OpenAIDecisionsEngineOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey === '') {
      throw invalid('openai-decisions engine requires an apiKey from adapter configuration');
    }
    if (options.endpoint !== undefined && !nonEmpty(options.endpoint)) {
      throw invalid('openai-decisions endpoint must be a non-empty URL');
    }
    if (options.effort !== undefined) throw invalid(NO_EFFORT);
    this.#options = options;
  }

  #wireModel(request: { readonly model?: string }): string {
    return request.model ?? this.#options.model ?? DEFAULT_MODEL;
  }

  #selection(request: { readonly model?: string }): EngineSelectionRecord {
    const model = this.#wireModel(request);
    return engineSelection({
      adapter: this.name,
      adapterVersion: this.#options.adapterVersion ?? null,
      provider: PROVIDER,
      modelFamily: modelIdentity(model).modelFamily,
      model,
      executable: null,
      capabilities: [],
    });
  }

  async admit(
    request: Omit<AgentRequest, 'prompt'>,
    signal: AbortSignal,
    expectedSelection?: EngineSelectionRecord,
  ): Promise<EngineSelectionRecord> {
    if (signal.aborted) {
      throw new EngineError({ kind: 'aborted', message: 'openai-decisions admission aborted' });
    }
    assertRequestShape(request);
    const selection = this.#selection(request);
    if (expectedSelection !== undefined && !isDeepStrictEqual(expectedSelection, selection)) {
      throw invalid('admission cannot restore a selection this adapter did not make');
    }
    return selection;
  }

  async run(
    request: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    if (signal.aborted) {
      throw new EngineError({ kind: 'aborted', message: 'openai-decisions call aborted' });
    }
    assertRequestShape(request);
    // Everything up to the body is configuration validation: malformed input
    // fails before a single byte goes on the wire.
    const document = parseDecisionDocument(request.prompt);
    const names = Object.keys(document.questions);
    const questions = names.map((name) => wireQuestion(name, document.questions[name] as JsonObject));
    const requested = this.#selection(request);
    const model = requested.model ?? DEFAULT_MODEL;
    const body = JSON.stringify({ model, input: evidence(document.state), questions });

    const deadlineMs = request.timeoutMs === undefined
      ? undefined
      : request.timeoutMs + (request.timeoutGraceMs ?? 0);
    const wireSignal = deadlineMs === undefined
      ? signal
      : AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);

    const call = this.#options.fetch ?? fetch;
    // A failed call still counts once, under the model and billing it ran with.
    const failed = (error: EngineError): EngineError => {
      onEvent({ type: 'usage', usage: { kind: 'unknown' }, model, billing: 'api' });
      return error;
    };
    let response: Response;
    let text: string;
    try {
      response = await call(this.#options.endpoint ?? DEFAULT_ENDPOINT, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${this.#options.apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal: wireSignal,
      });
      text = await readBounded(response, request.maxOutputBytes, signal);
    } catch (error) {
      if (error instanceof EngineError) throw failed(error);
      if (signal.aborted) throw failed(new EngineError({ kind: 'aborted', message: 'openai-decisions call aborted', cause: error }));
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw failed(new EngineError({ kind: 'timeout', message: `openai-decisions call exceeded ${deadlineMs}ms`, cause: error }));
      }
      throw failed(new EngineError({ kind: 'transient', message: 'openai-decisions endpoint unreachable', cause: error }));
    }
    if (!response.ok) throw failed(statusFailure(response, text));

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw failed(new EngineError({ kind: 'unknown', message: 'openai-decisions response was not JSON', cause: error }));
    }
    if (!isPlainObject(parsed)) {
      throw failed(new EngineError({ kind: 'unknown', message: 'openai-decisions response was not an object' }));
    }
    let answers: JsonObject;
    try {
      answers = answersByName(parsed.answers, names);
    } catch (error) {
      throw failed(error as EngineError);
    }

    const usage = readUsage(parsed.usage);
    onEvent({ type: 'usage', usage, model, billing: 'api' });

    return validateAgentResult({
      parts: [{ kind: 'structured', value: answers, final: true }],
      usage,
      billing: 'api',
      requested,
      effective: effectiveSelection(requested, parsed.model),
      raw: parsed,
    });
  }
}

export interface OpenAIDecisionsSeatOptions {
  /** Bearer credential. Defaults to `OPENAI_API_KEY`. */
  readonly apiKey?: string;
  /** POST target, for a regional endpoint. Defaults to `https://api.openai.com/v1/decisions`. */
  readonly endpoint?: string;
}

export interface OpenAIDecisionsSeat {
  readonly engine: Engine;
  readonly identity: {
    readonly adapter: 'openai-decisions';
    readonly provider: 'openai';
    readonly modelFamily: string;
    readonly model: string;
    readonly tools: readonly string[];
  };
}

/**
 * Create a Decisions seat for team workflows and the runtime's `judge`, as
 * `jev()` does for Jev. The answers come back as assistant text, the JSON of
 * the answers object, so a job reads them as it reads any seat's reply.
 */
export function openaiDecisions(
  model: string = DEFAULT_MODEL,
  options: OpenAIDecisionsSeatOptions = {},
): OpenAIDecisionsSeat {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw invalid('openaiDecisions() needs OPENAI_API_KEY, or the apiKey option');
  }
  const api = new OpenAIDecisionsEngine({
    apiKey,
    model,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
  });
  const engine: Engine = {
    name: api.name,
    admit: (request, signal, expectedSelection) => api.admit(request, signal, expectedSelection),
    async run(request, onEvent, signal) {
      const result = await api.run(request, onEvent, signal);
      const part = finalResultPart(result);
      if (part.kind !== 'structured') return result;
      return { ...result, parts: [{ kind: 'assistant', text: JSON.stringify(part.value), final: true }] };
    },
  };
  return {
    engine,
    identity: {
      adapter: ADAPTER,
      provider: PROVIDER,
      modelFamily: modelIdentity(model).modelFamily,
      model,
      tools: [],
    },
  };
}

async function readBounded(
  response: Response,
  maxOutputBytes: number | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) {
    const text = await response.text();
    if (maxOutputBytes !== undefined && Buffer.byteLength(text) > maxOutputBytes) {
      throw new EngineError({
        kind: 'unknown',
        message: `openai-decisions response exceeded the ${maxOutputBytes} byte output cap`,
      });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'openai-decisions call aborted' });
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxOutputBytes !== undefined && total > maxOutputBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EngineError({
          kind: 'unknown',
          message: `openai-decisions response exceeded the ${maxOutputBytes} byte output cap`,
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function statusFailure(response: Response, text: string): EngineError {
  const status = response.status;
  let kind: EngineFailureKind;
  if (status === 400) kind = 'invalid-config';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 402) kind = 'billing';
  else if (status === 429) kind = 'rate-limit';
  else if (status >= 500) kind = 'transient';
  else kind = 'unknown';
  const detail = text.length > 0 ? `: ${text.slice(0, 200)}` : '';
  const retryAfter = response.headers.get('retry-after');
  const retryAfterMs = kind === 'rate-limit' && retryAfter !== null && /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : undefined;
  return new EngineError({ kind, message: `openai-decisions request failed with ${status}${detail}`, retryAfterMs });
}

/**
 * Read the provider's usage. The Decisions API bills input tokens only, so a
 * response that reports input tokens and no output count is read as zero
 * output tokens; a response with no input count is unknown usage.
 */
function readUsage(usage: unknown): UsageReceipt {
  if (!isPlainObject(usage)) return { kind: 'unknown' };
  const input = usage.input_tokens;
  const output = usage.output_tokens ?? 0;
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) return { kind: 'unknown' };
  if (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 0) return { kind: 'unknown' };
  return reportedUsage({ inputTokens: input, outputTokens: output });
}

function effectiveSelection(
  requested: EngineSelectionRecord,
  echo: unknown,
): EngineSelectionRecord {
  if (typeof echo !== 'string') {
    return engineSelection({ ...requested, model: null, modelFamily: null });
  }
  try {
    return engineSelection({
      ...requested,
      model: echo,
      modelFamily: modelIdentity(echo).modelFamily,
    });
  } catch {
    return engineSelection({ ...requested, model: null, modelFamily: null });
  }
}
