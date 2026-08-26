/**
 * The pluggable execution backend. A `Step` asks an `Engine` to run one agent
 * turn with a *fresh context* and stream events back. Each call is independent,
 * giving every loop iteration a clean slate.
 */

import type { Memory } from '@obversa/memory';
import type { JsonValue, Sha256Digest } from '../graph/value.js';
import type { EngineFailureKind } from './failure.js';

/**
 * Built-in, registry-resolvable adapter names. The union is open (`& {}` trick)
 * so callers can name and register their own engines; the core never assumes a
 * fixed provider set. (`mock` is constructed directly in tests/examples, not
 * registered by name, so it is intentionally not listed here.)
 */
export type EngineName =
  | 'agent-sdk'
  | 'claude-cli'
  | 'codex'
  | 'grok-cli'
  | 'anthropic-api'
  | (string & {});

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
  readonly kind: EngineFailureKind;
  readonly message: string;
  readonly exitCode: number | null;
}

/** Tools an agent uses to spawn sub-agents / fan out. A `leaf` request disallows
 *  these, and the markdown agent loader (`agent-md.ts`) drops them from a file's
 *  allowlist. Adapters select only the names their backend accepts. */
export const SUBAGENT_TOOLS = ['Task', 'Agent', 'task'];
export const CLAUDE_SUBAGENT_TOOLS = ['Task', 'Agent'];

export interface AgentRequest {
  prompt: string;
  system?: string;
  /** Replace the backend's default system prompt or append to it. Default append. */
  systemMode?: 'append' | 'replace';
  model?: string;
  maxTokens?: number;
  /** JSON Schema supplied to engines with native structured output. */
  jsonSchema?: JsonValue;
  /** Available built-in tools. An empty list disables them where supported. */
  tools?: string[];
  /** Tool allowlist, where the backend supports tools (SDK / CLI). */
  allowedTools?: string[];
  /** Filesystem access admitted for this one engine call. */
  workspaceMode?: 'none' | 'read' | 'write';
  cwd?: string;
  /**
   * Extra env vars for engines that admit per-call environment changes.
   * Security-hardened adapters may reject this and require host-selected values
   * when the engine is constructed. Engines with no subprocess ignore it.
   */
  env?: Record<string, string>;
  /**
   * Soft timeout for this engine invocation. Streaming does not reset it; each
   * later worker, advisor, or fallback invocation receives its own window.
   */
  timeoutMs?: number;
  /**
   * Extra hard-timeout window after `timeoutMs`. Engines may accept a completed
   * final result that arrived before this boundary and mark it `late`.
   */
  timeoutGraceMs?: number;
  /** Maximum retained stdout/stderr bytes for a command-backed attempt. */
  maxOutputBytes?: number;
  /** Maximum owned process-tree resident bytes for a command-backed attempt. */
  maxMemoryBytes?: number;
  /** Lines-owned subprocess metadata, converted to env by CLI-backed engines. */
  lines?: {
    leaf: boolean;
    runId?: string;
    attemptId?: Sha256Digest;
    leafId: string;
    path: string[];
    label: string;
    iteration: number;
  };
  /** Memory port exposed to engines that support an in-process memory tool. */
  memory?: Memory;
  /**
   * Forbid this agent from spawning sub-agents (fanning out). A leaf agent is told to
   * disallow the sub-agent tool (`SUBAGENT_TOOLS`), so a branch of the graph bottoms out
   * here instead of expanding further. Authoritative over `allowedTools` (a disallow
   * wins). Engines with no sub-agent tool (anthropic-api, codex, mock) ignore it.
   */
  leaf?: boolean;
}

export interface AgentResult {
  /** Ordered assistant continuations with exactly one marked final part. */
  readonly parts: readonly AgentResultPart[];
  readonly usage: UsageReceipt;
  readonly requested: EngineSelectionRecord;
  readonly effective: EngineSelectionRecord;
  readonly stopReason?: string;
  /** A final result and a later teardown failure are separate facts. */
  readonly transportFailure?: EngineTransportFailure;
  /** Backend-native final payload, for escape-hatch inspection. */
  readonly raw?: unknown;
}

/** Streamed during a run. The runtime re-tags these as `LoopEvent`s. */
export type EngineStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; phase: 'use' | 'result' }
  | { type: 'usage'; usage: UsageReceipt; model: string };

export type EngineEventSink = (event: EngineStreamEvent) => void;

export interface Engine {
  readonly name: EngineName;
  /**
   * Run one fresh agent turn. Contract for the `usage` stream event: emit it
   * **exactly once, at the end** of the turn. The stats fold sums every `usage`
   * event, so a backend that emits incremental usage mid-stream would inflate totals.
   */
  run(
    req: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult>;
}

/**
 * Anywhere an engine can be selected, accept either a registered name or a
 * ready-made `Engine`. The latter is the "bring your own provider/framework"
 * escape hatch; the runtime treats every backend through this one interface.
 */
export type EngineRef = EngineName | Engine;

export function isEngine(ref: EngineRef | undefined): ref is Engine {
  return (
    typeof ref === 'object' &&
    ref !== null &&
    typeof (ref as Engine).run === 'function'
  );
}

export function requestEnv(req: AgentRequest): Record<string, string> | undefined {
  if (!req.env && !req.lines) return undefined;
  const lines = req.lines
    ? {
        LINES_LEAF: req.lines.leaf ? '1' : '0',
        LINES_LEAF_ID: req.lines.leafId,
        LINES_LEAF_LABEL: req.lines.label,
        LINES_LEAF_PATH: req.lines.path.join('/'),
        LINES_LEAF_ITERATION: String(req.lines.iteration),
        ...(req.lines.runId ? { LINES_RUN_ID: req.lines.runId } : {}),
      }
    : {};
  return { ...req.env, ...lines };
}

/**
 * How a tool-using engine treats permission prompts. Mirrors the Claude Code
 * values. `bypassPermissions` lets a headless worker read/write/run without
 * prompting, required for an unattended agent that must touch the filesystem or
 * shell. Set it deliberately.
 */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto';

/** Per-run options that the registry uses to construct engines. */
export interface EngineOptions {
  /** Default model when a request/step does not name one. */
  defaultModel?: string;
  /** Per-engine defaults, used when mixed-engine jobs share one run. */
  defaultModels?: Partial<Record<EngineName, string>>;
  /** Internal: the run's default engine, used to scope `defaultModel`. */
  defaultEngine?: EngineName;
  apiKey?: string;
  /** For CLI-backed engines: path to the binary. */
  cliBinary?: string;
  /** Extra args appended to CLI-backed engine invocations. */
  cliArgs?: string[];
  /**
   * Permission mode for tool-using engines. Unset = the engine/CLI default
   * where applicable; the Codex adapter stays read-only unless explicitly set
   * to `bypassPermissions`.
   */
  permissionMode?: PermissionMode;
  /**
   * Minimum interval between tool executions, in ms. Honored by engines that
   * mediate tool calls in-process (agent-sdk, via an awaited PreToolUse hook).
   * Engines whose subprocess executes tools autonomously (claude-cli, codex,
   * whose tool events are post-hoc observations) and engines that drive no
   * tool loop at all (anthropic-api) ignore it: there is nowhere to pace
   * outside the SDK.
   */
  minToolIntervalMs?: number;
}

export function modelFor(
  req: AgentRequest,
  opts: EngineOptions,
  engine: EngineName,
): string | undefined {
  const model =
    req.model ??
    opts.defaultModels?.[engine] ??
    (opts.defaultEngine == null ||
    opts.defaultEngine === engine ||
    sameModelFamily(opts.defaultEngine, engine)
      ? opts.defaultModel
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

/**
 * A serial pacer: calls resolve at least `minIntervalMs` apart (first call: no
 * wait). Each caller reserves its slot in the synchronous prefix, before any
 * await, so concurrent callers (the SDK awaits parallel-safe tools' PreToolUse
 * hooks concurrently) get strictly spaced slots instead of collapsing onto one.
 * Backs `EngineOptions.minToolIntervalMs`.
 */
export function toolPacer(minIntervalMs: number): () => Promise<void> {
  let nextAt = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + minIntervalMs;
    if (at > now) await new Promise((res) => setTimeout(res, at - now));
  };
}
