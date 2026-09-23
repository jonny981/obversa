/**
 * Jev decision calls over the TypeSafe API as an Obversa engine adapter.
 *
 * A request carries one private encoding: `prompt` is a JSON document of the
 * shape `{state, questions}`. Anything else is an `invalid-config` failure
 * raised before any network call. The wire is a single POST to the configured
 * endpoint with a bearer key taken from adapter configuration at construction;
 * a `request.env` field is refused. Provider response data, including error
 * bodies, is recorded in the result and in error details.
 *
 * The adapter is stateless: one call per attempt, no repair policy, no
 * confidence threshold. A low-confidence answer is a completed result like any
 * other; what a workflow does with the answers is the caller's routing, not
 * this adapter's decision.
 */

import { isDeepStrictEqual } from 'node:util';
import {
  EngineError,
  engineSelection,
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

const PROVIDER = 'typesafe';
const DEFAULT_MODEL = 'jev-latest';
const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

export interface JevApiEngineOptions {
  /** POST target, for example `https://api.typesafe.ai/v1/systemone`. */
  readonly endpoint: string;
  /** Bearer credential supplied by adapter configuration at run time. */
  readonly apiKey: string;
  /** Package version recorded in the requested identity. */
  readonly adapterVersion?: string;
  /** Wire model used when the request names none. */
  readonly model?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetch?: typeof fetch;
}

interface JevDocument {
  readonly state: JsonValue;
  readonly questions: JsonObject;
}

function invalid(message: string): EngineError {
  return new EngineError({ kind: 'invalid-config', message });
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The prompt must be a `{state, questions}` JSON document. */
export function parseJevDocument(prompt: string): JevDocument {
  let document: unknown;
  try {
    document = JSON.parse(prompt);
  } catch (error) {
    throw invalid(
      `jev prompt must be a JSON {state, questions} document: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPlainObject(document)) {
    throw invalid('jev prompt must parse to an object carrying state and questions');
  }
  const questions = document.questions;
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw invalid('jev prompt must carry a non-empty questions object');
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!isPlainObject(question)) {
      throw invalid(`jev question ${JSON.stringify(id)} must be an object`);
    }
    const type = question.type;
    if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) {
      throw invalid(
        `jev question ${JSON.stringify(id)} must declare a type of noul, choice or score`,
      );
    }
  }
  return { state: document.state ?? {}, questions };
}

/** Fields the builder never sends, or that have no meaning on this wire. */
function assertRequestShape(request: Omit<AgentRequest, 'prompt'>): void {
  if (request.system !== undefined || request.systemMode !== undefined) {
    throw invalid('jev requests do not carry a system prompt');
  }
  if (request.env !== undefined) {
    throw invalid('jev requests do not carry env; credentials live in adapter configuration');
  }
  if (request.maxTokens !== undefined) {
    throw invalid('jev has no server-side token cap; maxTokens is unsupported');
  }
  if (request.workspaceMode !== undefined && request.workspaceMode !== 'none') {
    throw invalid(`jev performs no filesystem access; workspaceMode must be none, not ${request.workspaceMode}`);
  }
  if ((request.tools?.length ?? 0) > 0) {
    throw invalid('jev declares no tools; a non-empty tools list cannot be honoured');
  }
}

export class JevApiEngine implements Engine {
  readonly name = 'jev-api';
  readonly #options: JevApiEngineOptions;

  constructor(options: JevApiEngineOptions) {
    if (typeof options.endpoint !== 'string' || options.endpoint.trim() === '') {
      throw invalid('jev engine requires an endpoint');
    }
    if (typeof options.apiKey !== 'string' || options.apiKey === '') {
      throw invalid('jev engine requires an apiKey from adapter configuration');
    }
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
      throw new EngineError({ kind: 'aborted', message: 'jev admission aborted' });
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
      throw new EngineError({ kind: 'aborted', message: 'jev call aborted' });
    }
    assertRequestShape(request);
    // Everything above is configuration validation — malformed input fails
    // before a single byte goes on the wire.
    const document = parseJevDocument(request.prompt);
    const requested = this.#selection(request);
    const body = JSON.stringify({
      model: requested.model,
      state: document.state,
      questions: document.questions,
    });

    const deadlineMs = request.timeoutMs === undefined
      ? undefined
      : request.timeoutMs + (request.timeoutGraceMs ?? 0);
    const wireSignal = deadlineMs === undefined
      ? signal
      : AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);

    const call = this.#options.fetch ?? fetch;
    let response: Response;
    let text: string;
    try {
      response = await call(this.#options.endpoint, {
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
      if (error instanceof EngineError) throw error;
      if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'jev call aborted', cause: error });
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new EngineError({ kind: 'timeout', message: `jev call exceeded ${deadlineMs}ms`, cause: error });
      }
      throw new EngineError({ kind: 'transient', message: 'jev endpoint unreachable', cause: error });
    }
    if (!response.ok) throw statusFailure(response, text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new EngineError({
        kind: 'unknown',
        message: 'jev response was not JSON',
        cause: error,
      });
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.answers)) {
      throw new EngineError({ kind: 'unknown', message: 'jev response carried no answers object' });
    }

    const usage = readUsage(parsed.usage);
    onEvent({ type: 'usage', usage, model: requested.model ?? DEFAULT_MODEL });

    const effective = effectiveSelection(requested, parsed.model);
    return validateAgentResult({
      parts: [{ kind: 'structured', value: parsed.answers, final: true }],
      usage,
      requested,
      effective,
      raw: parsed,
    });
  }
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
        message: `jev response exceeded the ${maxOutputBytes} byte output cap`,
      });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new EngineError({ kind: 'aborted', message: 'jev call aborted' });
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (maxOutputBytes !== undefined && total > maxOutputBytes) {
        await reader.cancel().catch(() => undefined);
        throw new EngineError({
          kind: 'unknown',
          message: `jev response exceeded the ${maxOutputBytes} byte output cap`,
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
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 402) kind = 'billing';
  else if (status === 429) kind = 'rate-limit';
  else if (status >= 500) kind = 'transient';
  else kind = 'unknown';
  const detail = text.length > 0 ? `: ${text.slice(0, 200)}` : '';
  const retryAfter = response.headers.get('retry-after');
  const retryAfterMs = kind === 'rate-limit' && retryAfter !== null && /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000
    : undefined;
  return new EngineError({ kind, message: `jev request failed with ${status}${detail}`, retryAfterMs });
}

function readUsage(usage: unknown): UsageReceipt {
  if (!isPlainObject(usage)) return { kind: 'unknown' };
  const input = usage.input_tokens;
  const output = usage.output_tokens;
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
