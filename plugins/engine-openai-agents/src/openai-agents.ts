/**
 * Engine plugin: an agent the caller already built with the OpenAI Agents SDK
 * (`@openai/agents`). Each `run` is one call to the SDK's runner for that
 * agent. The agent keeps its tools, handoffs and guardrails: the engine
 * passes only the prompt, the system text and an abort signal, and reads back
 * the final output and the usage. It passes no session, so each attempt
 * starts without session history unless a given runner adds one.
 *
 * A request's declared tools and workspace mode do not reach the agent. It
 * uses the tools it was built with, wherever those tools act.
 */

import {
  getDefaultModel,
  run as runAgent,
  type Agent,
  type AgentInputItem,
  type RunResult,
  type Usage,
} from '@openai/agents';
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

/** Any agent, typed as the SDK's own runner types the agent it runs. */
type AnyAgent = Agent<any, any>;

/**
 * The part of the SDK's runner the engine calls. The SDK's `Runner` fits it;
 * when none is given, the engine calls the SDK's own `run`.
 */
export interface OpenAIAgentsRunner {
  run(
    agent: AnyAgent,
    input: string | AgentInputItem[],
    options: { readonly signal: AbortSignal },
  ): Promise<Pick<RunResult<unknown, AnyAgent>, 'finalOutput' | 'interruptions' | 'runContext'>>;
}

export interface OpenAIAgentSeatOptions {
  /**
   * The model to record, as `provider/model`, when the seat cannot read it
   * from the agent: the agent holds a model object, or the model is set
   * somewhere else, such as on a `Runner`. When omitted, the seat reads the
   * model name the agent is built with.
   */
  readonly model?: string;
  /**
   * The runner to run the agent with. When omitted, the SDK's own `run`. A
   * runner can add run options the engine does not pass, such as a session.
   */
  readonly runner?: OpenAIAgentsRunner;
  /** Unsupported: the agent you pass decides how its model runs, so setting it throws. Set it on the agent's `modelSettings`. */
  readonly effort?: string;
}

const NO_EFFORT = "openai-agents cannot take effort: the agent you pass decides how its model runs; set it on the agent's modelSettings";

export interface OpenAIAgentSeat {
  readonly engine: OpenAIAgentsEngine;
  readonly identity: {
    readonly adapter: 'openai-agents';
    readonly provider: string;
    readonly modelFamily: string;
    readonly model: string;
    readonly tools: readonly string[];
  };
}

/** Create the seat for an OpenAI Agents SDK agent in a declarative team workflow. */
export function openaiAgent(agent: AnyAgent, options: OpenAIAgentSeatOptions = {}): OpenAIAgentSeat {
  if (options.effort !== undefined) throw new TypeError(NO_EFFORT);
  const configured = options.model !== undefined
    ? splitModel(options.model)
    : configuredModel(agent.model);
  if (configured === undefined) {
    throw new TypeError(options.model !== undefined
      ? `openaiAgent(): model ${JSON.stringify(options.model)} must be "provider/model"`
      : 'openaiAgent(): the agent\'s model is an object whose name the SDK does not expose; pass { model: "provider/model" } to name it');
  }
  const identity = {
    adapter: 'openai-agents' as const,
    provider: configured.provider,
    modelFamily: modelIdentity(configured.model.split('/').at(-1)!).modelFamily,
    model: configured.model,
    tools: [],
  };
  return { engine: new OpenAIAgentsEngine(agent, identity, options.runner), identity };
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
 * Read the model from `Agent['model']`. A model name goes to the SDK's
 * default model provider, which is OpenAI's, and an empty name is the SDK's
 * default model. A model object does not expose its name, so it yields nothing.
 */
function configuredModel(model: string | object): ConfiguredModel | undefined {
  if (typeof model !== 'string') return undefined;
  return { provider: 'openai', model: model === '' ? getDefaultModel() : model };
}

/** The usage the SDK reports, or unknown when the run made no model request that reported it. */
function usageOf(usage: Usage | undefined): UsageReceipt {
  if (usage === undefined || usage.requests === 0) return { kind: 'unknown' };
  const cached = usage.inputTokensDetails.reduce(
    (total, details) => total + (typeof details.cached_tokens === 'number' ? details.cached_tokens : 0),
    0,
  );
  return reportedUsage({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cached > 0 ? { cacheReadInputTokens: cached } : {}),
  });
}

/**
 * Turn a thrown SDK or model-provider error into a typed engine failure. A
 * 429 status is a rate limit, with the provider's `retry-after` kept, or a
 * quota when the error code is `insufficient_quota`; everything else goes
 * through the shared message classification.
 */
function engineFailure(error: unknown): EngineError {
  if (error instanceof EngineError) return error;
  const detail = (error ?? {}) as { status?: unknown; code?: unknown; headers?: unknown };
  const kind = detail.status !== 429
    ? classifyEngineFailure(error)
    : detail.code === 'insufficient_quota' ? 'quota' : 'rate-limit';
  const headers = detail.headers as { get?: (name: string) => string | null } | undefined;
  const retryAfter = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  return new EngineError({
    kind,
    message: `openai agent failed: ${error instanceof Error ? error.message : String(error)}`,
    cause: error,
    ...(kind === 'rate-limit' && typeof retryAfter === 'string'
      ? { retryAfterMs: retryAfterHeaderToMs(retryAfter) }
      : {}),
  });
}

/** The final output as text: a string as it is, structured output as JSON. */
function finalText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

export class OpenAIAgentsEngine implements Engine {
  readonly name = 'openai-agents';
  private readonly selection: EngineSelectionRecord;

  constructor(
    private readonly agent: AnyAgent,
    identity: { readonly provider: string; readonly modelFamily: string; readonly model: string },
    private readonly runner: OpenAIAgentsRunner = { run: (agent, input, options) => runAgent(agent, input, options) },
  ) {
    this.selection = engineSelection({
      adapter: 'openai-agents',
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
    const aborted = () => new EngineError({ kind: 'aborted', message: 'openai agent run aborted' });
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
    const timeout = () => new EngineError({ kind: 'timeout', message: 'openai agent run timed out' });

    // Appended system text is one system message before the prompt; replaced
    // system text becomes the instructions of a copy of the agent.
    const agent = req.system !== undefined && req.systemMode === 'replace'
      ? this.agent.clone({ instructions: req.system })
      : this.agent;
    const input: string | AgentInputItem[] = req.system !== undefined && req.systemMode !== 'replace'
      ? [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }]
      : req.prompt;

    let output: Awaited<ReturnType<OpenAIAgentsRunner['run']>>;
    try {
      output = await this.runner.run(agent, input, { signal: controller.signal });
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (timedOut) throw timeout();
      throw engineFailure(error);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
    if (signal.aborted) throw aborted();
    if (timedOut) throw timeout();
    if (output.finalOutput === undefined) {
      throw new EngineError(output.interruptions.length > 0
        ? { kind: 'invalid-config', message: 'openai agent stopped to wait for a tool approval, which the engine cannot give' }
        : { kind: 'unknown', message: 'openai agent finished with no final output' });
    }

    const usage = usageOf(output.runContext.usage);
    onEvent({ type: 'usage', usage, model: this.selection.model! });
    return assistantResult({
      text: finalText(output.finalOutput),
      usage,
      requested: this.selection,
    });
  }
}
