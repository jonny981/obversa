/**
 * Engine plugin: a Mastra agent the caller already built (`@mastra/core`).
 * Each `run` is one call to the agent's own `generate`. The agent keeps its
 * tools, memory and workflows: the engine passes only the prompt, the system
 * text and an abort signal, and reads back the final text and the usage.
 *
 * A request's declared tools and workspace mode do not reach the agent. It
 * uses the tools it was built with, wherever those tools act.
 */

import type { Agent } from '@mastra/core/agent';
import type { FullOutput } from '@mastra/core/stream';
import {
  EngineError,
  assertReadAccess,
  assistantResult,
  classifyEngineFailure,
  engineSelection,
  modelIdentity,
  reportedUsage,
  type AgentRequest,
  type AgentResult,
  type Engine,
  type EngineEventSink,
  type EngineSelectionRecord,
  type UsageReceipt,
} from '@obversa/api';
import { retryAfterHeaderToMs } from '@obversa/core/command';

/** The part of a Mastra `Agent` the engine reads and calls. */
export interface MastraAgent {
  readonly model: Agent['model'];
  generate(
    prompt: string,
    options: {
      readonly system?: string;
      readonly instructions?: string;
      readonly abortSignal: AbortSignal;
    },
  ): Promise<Pick<FullOutput<unknown>, 'text' | 'totalUsage' | 'finishReason' | 'error'>>;
}

export interface MastraSeatOptions {
  /**
   * The model to record, as `provider/model`, when the agent chooses its
   * model at run time. When omitted, the seat reads the model the agent is
   * built with.
   */
  readonly model?: string;
  /** Unsupported: the Mastra agent you pass decides how its model runs, so setting it throws. */
  readonly effort?: string;
}

const NO_EFFORT = 'mastra cannot take effort: the Mastra agent you pass decides how its model runs; set it on the agent';

export interface MastraSeat {
  readonly engine: MastraEngine;
  readonly identity: {
    readonly adapter: 'mastra';
    readonly provider: string;
    readonly modelFamily: string;
    readonly model: string;
    readonly tools: readonly string[];
  };
}

/** Create the seat for a Mastra agent in a declarative team workflow. */
export function mastra(agent: MastraAgent, options: MastraSeatOptions = {}): MastraSeat {
  if (options.effort !== undefined) throw new TypeError(NO_EFFORT);
  const configured = options.model !== undefined
    ? splitModel(options.model)
    : configuredModel(agent.model);
  if (configured === undefined) {
    throw new TypeError(options.model !== undefined
      ? `mastra(): model ${JSON.stringify(options.model)} must be "provider/model"`
      : 'mastra(): the agent\'s model cannot be read before the run; pass { model: "provider/model" } to name it');
  }
  const identity = {
    adapter: 'mastra' as const,
    provider: configured.provider,
    modelFamily: modelIdentity(configured.model.split('/').at(-1)!).modelFamily,
    model: configured.model,
    tools: [],
  };
  return { engine: new MastraEngine(agent, identity), identity };
}

interface ConfiguredModel {
  readonly provider: string;
  readonly model: string;
}

function splitModel(value: string): ConfiguredModel | undefined {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/**
 * Read the provider and model from the forms `Agent['model']` takes: a
 * `provider/model` string, a language model object, an OpenAI-compatible
 * config, or a fallback list, whose first enabled entry is the model Mastra
 * tries first. A function is resolved only at run time, so it yields nothing here.
 */
function configuredModel(config: unknown): ConfiguredModel | undefined {
  if (typeof config === 'string') return splitModel(config);
  if (Array.isArray(config)) {
    const first = config.find((entry: { enabled?: unknown }) => entry?.enabled !== false) as
      | { model?: unknown }
      | undefined;
    return first === undefined ? undefined : configuredModel(first.model);
  }
  if (typeof config !== 'object' || config === null) return undefined;
  const value = config as Record<string, unknown>;
  if (typeof value.provider === 'string' && typeof value.modelId === 'string') {
    return value.provider && value.modelId
      ? { provider: value.provider, model: value.modelId }
      : undefined;
  }
  if (typeof value.providerId === 'string' && typeof value.modelId === 'string') {
    return value.providerId && value.modelId
      ? { provider: value.providerId, model: value.modelId }
      : undefined;
  }
  if (typeof value.id === 'string') return splitModel(value.id);
  return undefined;
}

function usageOf(usage: FullOutput<unknown>['totalUsage'] | undefined): UsageReceipt {
  if (typeof usage?.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') {
    return { kind: 'unknown' };
  }
  return reportedUsage({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(typeof usage.cachedInputTokens === 'number'
      ? { cacheReadInputTokens: usage.cachedInputTokens }
      : {}),
    ...(typeof usage.cacheCreationInputTokens === 'number'
      ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
      : {}),
  });
}

/**
 * Turn a thrown Mastra or model-provider error into a typed engine failure.
 * A 429 status is a rate limit, with the provider's `retry-after` kept;
 * everything else goes through the shared message classification.
 */
function engineFailure(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  const detail = (error ?? {}) as { statusCode?: unknown; responseHeaders?: unknown };
  const kind = detail.statusCode === 429 ? 'rate-limit' : classifyEngineFailure(error);
  const headers = typeof detail.responseHeaders === 'object' && detail.responseHeaders !== null
    ? detail.responseHeaders as Record<string, unknown>
    : {};
  const retryAfter = headers['retry-after'];
  return new EngineError({
    kind,
    message: `mastra agent failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
    ...(kind === 'rate-limit' && typeof retryAfter === 'string'
      ? { retryAfterMs: retryAfterHeaderToMs(retryAfter) }
      : {}),
  });
}

export class MastraEngine implements Engine {
  readonly name = 'mastra';
  private readonly selection: EngineSelectionRecord;

  constructor(
    private readonly agent: MastraAgent,
    identity: { readonly provider: string; readonly modelFamily: string; readonly model: string },
  ) {
    this.selection = engineSelection({
      adapter: 'mastra',
      provider: identity.provider,
      modelFamily: identity.modelFamily,
      model: identity.model,
      capabilities: [],
    });
  }

  async run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    try {
      assertReadAccess(req);
      if (req.effort !== undefined) throw new TypeError(NO_EFFORT);
    } catch (cause) {
      throw new EngineError({ kind: 'invalid-config', message: (cause as Error).message, cause });
    }
    const aborted = () => new EngineError({ kind: 'aborted', message: 'mastra run aborted' });
    if (signal.aborted) throw aborted();

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const hardTimeout = req.timeoutMs && req.timeoutGraceMs
      ? req.timeoutMs + req.timeoutGraceMs
      : req.timeoutMs;
    let timedOut = false;
    const timer = hardTimeout
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, hardTimeout)
      : undefined;
    const timeout = () => new EngineError({ kind: 'timeout', message: 'mastra run timed out' });
    // A failed call still counts once, under the model and billing it ran
    // with, and with the tokens Mastra counted when the call returned.
    const failed = (error: EngineError, usage: UsageReceipt = { kind: 'unknown' }): EngineError => {
      onEvent({ type: 'usage', usage, model: this.selection.model!, billing: 'api' });
      return error;
    };

    let output: Awaited<ReturnType<MastraAgent['generate']>>;
    try {
      output = await this.agent.generate(req.prompt, {
        ...(req.system === undefined
          ? {}
          : req.systemMode === 'replace'
            ? { instructions: req.system }
            : { system: req.system }),
        abortSignal: controller.signal,
      });
    } catch (error) {
      if (signal.aborted) throw failed(aborted());
      if (timedOut) throw failed(timeout());
      throw failed(engineFailure(error));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    // An aborted Mastra call resolves with empty text rather than throwing.
    const usage = usageOf(output.totalUsage);
    if (signal.aborted) throw failed(aborted(), usage);
    if (timedOut) throw failed(timeout(), usage);
    if (output.error !== undefined) throw failed(engineFailure(output.error), usage);

    onEvent({ type: 'usage', usage, model: this.selection.model!, billing: 'api' });
    return assistantResult({
      text: output.text,
      usage,
      billing: 'api',
      requested: this.selection,
      ...(typeof output.finishReason === 'string' ? { stopReason: output.finishReason } : {}),
    });
  }
}
