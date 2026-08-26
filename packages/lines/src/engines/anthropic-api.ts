/**
 * Engine adapter: the raw Anthropic Messages API (`@anthropic-ai/sdk`). Lowest
 * level, token-level streaming, and the cheapest path for validator models.
 * Transient 429/5xx/connection errors are retried with backoff via `p-retry`;
 * non-retryable errors abort immediately.
 *
 * Needs `ANTHROPIC_API_KEY` (or `EngineOptions.apiKey`). Constructed lazily by
 * the registry, so other engines work without a key present.
 *
 * Ignores `AgentRequest.env`: no subprocess is spawned and the API call takes
 * no environment.
 */

import pRetry, { AbortError } from 'p-retry';
import pTimeout, { TimeoutError } from 'p-timeout';

import type {
  AgentRequest,
  AgentResult,
  Engine,
  EngineEventSink,
  EngineOptions,
} from './engine.js';
import { modelFor } from './engine.js';
import { LoopError } from '../core/errors.js';
import { retryAfterHeaderToMs } from '../core/limits.js';
import {
  assistantResult,
  engineSelection,
  reportedUsage,
} from '../runtime/result-parts.js';

/**
 * Transient backend errors that warrant p-retry's blind backoff: 5xx (incl.
 * 529 overloaded) and connection/timeout. A 429 is not here: a rate limit is
 * classified to a typed `RATE_LIMIT` and handed to the loop's `onLimit` policy,
 * which waits the provider's actual reset rather than a generic backoff.
 */
function isTransient(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  if (typeof status === 'number') return status >= 500;
  const name = (error as { name?: string })?.name ?? '';
  return /connection|timeout|socket|network/i.test(name);
}

/**
 * Best-effort `.get()` off the SDK error's `headers` (a web `Headers`). The SDK
 * attaches the response headers on `APIError`; read defensively in case a
 * version exposes them as a plain object instead.
 */
function headerValue(error: unknown, name: string): string | undefined {
  const headers = (error as { headers?: unknown }).headers;
  if (headers && typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  if (headers && typeof headers === 'object') {
    const v = (headers as Record<string, unknown>)[name];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * Classify an Anthropic SDK error into a provider-limit `LoopError`, or return
 * `undefined` to let the generic handling take over. The SDK throws an
 * `APIError` with `.status` (HTTP), `.headers` (web `Headers`), and `.type`
 * (the body `error.type`, e.g. `rate_limit_error` / `billing_error`).
 *   - 429 → RATE_LIMIT, reading `retry-after` (seconds) into `retryAfterMs`.
 *   - a billing/quota error → QUOTA with no reset (not auto-waitable).
 * 529 / overloaded is deliberately not a limit: it is a transient ENGINE error
 * and stays on p-retry's backoff path.
 */
function classifyLimit(error: unknown): LoopError | undefined {
  const status = (error as { status?: number })?.status;
  const type = (error as { type?: string })?.type;
  const message = error instanceof Error ? error.message : String(error);

  if (status === 429 || type === 'rate_limit_error') {
    return new LoopError({
      code: 'RATE_LIMIT',
      phase: 'engine',
      message: `anthropic-api rate limited: ${message}`,
      cause: error,
      retryAfterMs: retryAfterHeaderToMs(headerValue(error, 'retry-after')),
    });
  }
  if (type === 'billing_error') {
    return new LoopError({
      code: 'QUOTA',
      phase: 'engine',
      message: `anthropic-api usage/billing limit: ${message}`,
      cause: error,
    });
  }
  return undefined;
}

/** The slice of the Anthropic SDK this adapter actually consumes. */
interface FinalMessage {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
}
interface MessageStreamLike {
  on(event: 'text', cb: (delta: string) => void): void;
  finalMessage(): Promise<FinalMessage>;
}
interface MessagesClientLike {
  messages: {
    stream(body: unknown, opts?: { signal?: AbortSignal }): MessageStreamLike;
  };
}

export class AnthropicApiEngine implements Engine {
  readonly name = 'anthropic-api';
  private clientPromise?: Promise<MessagesClientLike>;

  constructor(private readonly opts: EngineOptions = {}) {}

  private async client(): Promise<MessagesClientLike> {
    if (!this.clientPromise) {
      const apiKey = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // Fail fast with an actionable, non-retryable error instead of leaking
        // the SDK's internal "could not resolve authentication method" message.
        throw new LoopError({
          code: 'CONFIG',
          phase: 'engine',
          retryable: false,
          message:
            'the anthropic-api engine needs an API key — set ANTHROPIC_API_KEY or pass --api-key (or use the agent-sdk / claude-cli engine, which use host Claude auth)',
        });
      }
      this.clientPromise = import('@anthropic-ai/sdk').then(
        // One cast at the boundary to the structural shape we consume.
        (m) => new m.default({ apiKey }) as unknown as MessagesClientLike,
      );
    }
    return this.clientPromise;
  }

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const client = await this.client();
    const model =
      modelFor(req, this.opts, 'anthropic-api') ??
      'claude-haiku-4-5-20251001';
    const maxTokens = req.maxTokens ?? 1024;
    const startedAt = Date.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });

    const attempt = async (): Promise<FinalMessage> => {
      try {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: maxTokens,
            system: req.system,
            messages: [{ role: 'user', content: req.prompt }],
          },
          { signal: controller.signal },
        );
        stream.on('text', (delta) => onEvent({ type: 'text', delta }));
        return await stream.finalMessage();
      } catch (e) {
        // A provider limit is not for p-retry's blind backoff: stop retrying
        // and let the loop's onLimit policy wait the actual reset. Wrap the
        // typed LoopError as the AbortError cause so it survives to the catch.
        const limit = classifyLimit(e);
        if (limit) throw new AbortError(limit);
        if (signal.aborted || !isTransient(e)) {
          throw new AbortError(e instanceof Error ? e : new Error(String(e)));
        }
        throw e;
      }
    };

    let message;
    const hardTimeout =
      req.timeoutMs && req.timeoutGraceMs
        ? req.timeoutMs + req.timeoutGraceMs
        : req.timeoutMs;
    let timedOut = false;
    try {
      const pending = pRetry(attempt, {
        retries: 2,
        minTimeout: 500,
        factor: 2,
      });
      message = await (hardTimeout
        ? pTimeout(pending, { milliseconds: hardTimeout }).catch((e) => {
            if (e instanceof TimeoutError) {
              timedOut = true;
              controller.abort();
            }
            throw e;
          })
        : pending);
    } catch (e) {
      if (signal.aborted)
        throw new LoopError({
          code: 'ABORTED',
          phase: 'engine',
          message: 'anthropic-api run aborted',
        });
      if (timedOut)
        throw new LoopError({
          code: 'TIMEOUT',
          phase: 'engine',
          message: 'anthropic-api run timed out',
          cause: e,
        });
      // p-retry unwraps AbortError to its cause; surface a typed limit as-is.
      if (e instanceof LoopError) throw e;
      throw LoopError.from(e, { code: 'ENGINE', phase: 'engine' });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const usage = reportedUsage({
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    });
    onEvent({ type: 'usage', usage, model });
    const selection = engineSelection({
      adapter: 'anthropic-api',
      provider: 'anthropic',
      model,
    });
    const late =
      typeof req.timeoutMs === 'number' && Date.now() - startedAt > req.timeoutMs;
    return assistantResult({
      text,
      usage,
      requested: selection,
      stopReason: message.stop_reason ?? undefined,
      ...(late
        ? {
            transportFailure: {
              kind: 'timeout' as const,
              message: 'anthropic-api result arrived after the soft timeout',
              exitCode: null,
            },
          }
        : {}),
      raw: message,
    });
  }
}
