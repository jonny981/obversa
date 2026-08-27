/** Provider-neutral values and behavior shared by runtimes and engine plugins. */

import type { JsonValue } from './json.js';

export type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  Sha256Digest,
} from './json.js';
export {
  JsonValueError,
  canonicalJson,
  cloneFrozenJson,
  digestJson,
} from './json.js';

export type {
  EngineFailureKind,
  EngineErrorInit,
} from './error.js';
export {
  EngineError,
  EngineIncompleteResultError,
  LANE_DEAD_FAILURES,
  classifyEngineFailure,
} from './error.js';

export {
  assistantResult,
  engineSelection,
  finalResultPart,
  finalResultText,
  reportedUsage,
  requireFinalResultText,
  validateAgentResult,
  validateIncompleteResultEvidence,
} from './result.js';

export {
  assertEngineConformance,
  runEngineConformance,
  type EngineConformanceFailure,
  type EngineConformanceFixture,
  type EngineConformanceReport,
  type EngineConformanceScenario,
} from './conformance.js';

export {
  attemptEnvironment,
} from './command/attempt-env.js';
export {
  retryAfterHeaderToMs,
  scrubCapture,
  redactEnvValues,
  redactSecrets,
} from './command/run.js';
export {
  mapMessage,
  newAccumulator,
  type Accumulator,
} from './claude-stream-json.js';

export interface AttemptMetadata {
  leaf: boolean;
  runId?: string;
  attemptId?: string;
  leafId: string;
  path: string[];
  label: string;
  iteration: number;
}

export interface Usage {
  /** Total input, including cache creation and cache reads where reported. */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type UsageReceipt =
  | { readonly kind: 'unknown' }
  | ({ readonly kind: 'reported' } & Usage);

export type AgentResultPart =
  | {
      readonly kind: 'assistant';
      readonly text: string;
      readonly final: boolean;
    }
  | {
      readonly kind: 'structured';
      readonly value: JsonValue;
      readonly final: true;
    };

export interface EngineSelectionRecord {
  readonly adapter: string;
  readonly adapterVersion: string | null;
  readonly provider: string | null;
  readonly modelFamily: string | null;
  readonly model: string | null;
  readonly capabilities: readonly string[];
}

export interface EngineTransportFailure {
  readonly kind: import('./error.js').EngineFailureKind;
  readonly message: string;
  readonly exitCode: number | null;
}

/** Tools used by supported agent hosts to dispatch sub-agents. */
export const SUBAGENT_TOOLS = ['Task', 'Agent', 'task'];
export const CLAUDE_SUBAGENT_TOOLS = ['Task', 'Agent'];

export interface AgentRequest {
  prompt: string;
  system?: string;
  systemMode?: 'append' | 'replace';
  model?: string;
  maxTokens?: number;
  jsonSchema?: JsonValue;
  tools?: string[];
  allowedTools?: string[];
  workspaceMode?: 'none' | 'read' | 'write';
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  timeoutGraceMs?: number;
  maxOutputBytes?: number;
  maxMemoryBytes?: number;
  attempt?: AttemptMetadata;
  leaf?: boolean;
}

export interface AgentResult {
  /** Ordered assistant continuations with exactly one marked final part. */
  readonly parts: readonly AgentResultPart[];
  readonly usage: UsageReceipt;
  readonly requested: EngineSelectionRecord;
  readonly effective: EngineSelectionRecord;
  readonly stopReason?: string;
  readonly transportFailure?: EngineTransportFailure;
  readonly raw?: unknown;
}

export type EngineIncompleteResultEvidence = Omit<AgentResult, 'parts'> & {
  readonly parts: readonly AgentResultPart[];
};

export type EngineStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; phase: 'use' | 'result' }
  | { type: 'usage'; usage: UsageReceipt; model: string };

export type EngineEventSink = (event: EngineStreamEvent) => void;

export interface Engine {
  readonly name: string;
  run(
    request: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult>;
}

export type EngineRef = string | Engine;

export function isEngine(value: unknown): value is Engine {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as Engine).name === 'string'
    && typeof (value as Engine).run === 'function'
  );
}
