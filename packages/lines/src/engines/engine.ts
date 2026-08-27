/** Runtime-only engine selection and bundled-adapter options. */

import {
  CLAUDE_SUBAGENT_TOOLS,
  SUBAGENT_TOOLS,
  attemptEnvironment,
  isEngine as isEngineContract,
  type AgentRequest as EngineAgentRequest,
  type AgentResult,
  type EngineEventSink,
} from '@obversa/engine';

export {
  CLAUDE_SUBAGENT_TOOLS,
  EngineError,
  EngineIncompleteResultError,
  SUBAGENT_TOOLS,
  attemptEnvironment,
  type AgentResult,
  type AgentResultPart,
  type AttemptMetadata,
  type EngineEventSink,
  type EngineFailureKind,
  type EngineIncompleteResultEvidence,
  type EngineSelectionRecord,
  type EngineStreamEvent,
  type EngineTransportFailure,
  type Usage,
  type UsageReceipt,
} from '@obversa/engine';

/** First-party adapter IDs retained until the bundled registry is removed. */
export type EngineName =
  | 'agent-sdk'
  | 'claude-cli'
  | 'codex'
  | 'grok-cli'
  | 'opencode-cli'
  | 'anthropic-api'
  | (string & {});

export type AgentRequest = EngineAgentRequest;

export interface Engine {
  readonly name: EngineName;
  run(
    request: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult>;
}

export type EngineRef = EngineName | Engine;

export function isEngine(value: unknown): value is Engine {
  return isEngineContract(value);
}

/** Compatibility name while bundled adapters move to the engine package. */
export const requestEnv = attemptEnvironment;

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/** Per-run options used only by the bundled provider registry. */
export interface EngineOptions {
  defaultModel?: string;
  defaultModels?: Partial<Record<EngineName, string>>;
  defaultEngine?: EngineName;
  cliBinary?: string;
  cliArgs?: string[];
  permissionMode?: PermissionMode;
}

export function modelFor(
  request: AgentRequest,
  options: EngineOptions,
  engine: EngineName,
): string | undefined {
  const model =
    request.model
    ?? options.defaultModels?.[engine]
    ?? (options.defaultEngine == null
      || options.defaultEngine === engine
      || sameModelFamily(options.defaultEngine, engine)
      ? options.defaultModel
      : undefined);
  return normalizeModelForEngine(engine, model);
}

export function normalizeModelForEngine(
  engine: EngineName,
  model: string | undefined,
): string | undefined {
  if (!model) return model;
  if (engine === 'claude-cli') return model.replace(/\s*\[[^\]]+\]\s*$/, '');
  return model;
}

const CLAUDE_MODEL_ENGINES = new Set<EngineName>([
  'agent-sdk',
  'claude-cli',
  'anthropic-api',
]);

function sameModelFamily(a: EngineName | undefined, b: EngineName): boolean {
  return !!a && CLAUDE_MODEL_ENGINES.has(a) && CLAUDE_MODEL_ENGINES.has(b);
}
