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

/**
 * What one engine call cost, in US dollars. `reported` is the engine's own
 * figure. `estimated` is the call's reported tokens priced by one entry of a
 * price table, which `entry` names. `unknown` means there is no figure: the
 * engine reported no tokens, or the table has no price for the model.
 */
export type CostReceipt =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'reported'; readonly usd: number }
  | { readonly kind: 'estimated'; readonly usd: number; readonly entry: string };

/**
 * How the call was paid for. `subscription` is the person's own CLI plan, so
 * a figure is what the same work would cost through the API. `api` is an API
 * key, so a figure is the bill. `unknown` means the engine cannot tell.
 */
export type Billing = 'subscription' | 'api' | 'unknown';

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
  readonly executable: string | null;
  readonly capabilities: readonly string[];
  /**
   * Where `model` on an `effective` record came from: `reported` when the
   * engine named the model that answered, `requested` when it reported
   * none and the record keeps the model id the request sent. A request
   * that named no model leaves the pair null with no marker.
   */
  readonly modelSource?: 'reported' | 'requested';
  /** The reasoning effort the engine was asked to use, when one was set. */
  readonly effort?: string;
}

export interface ExecutionTarget {
  readonly adapter: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly model: string;
  readonly tools: readonly string[];
}

export interface TeamSeat {
  readonly engine: Engine;
  readonly identity: ExecutionTarget;
}

/**
 * One logical seat, tried in order. `seat` runs first; each entry of
 * `candidates` runs when the seat before it cannot answer: its call failed
 * on billing or quota, the step's `fallbackOn` policy passed the failure
 * on (a rate limit under the default policy), or the run's availability
 * store remembers the earlier seat as dead and skips it without a call.
 * Every entry is a full seat: its own engine, identity and tools.
 * `candidates` must not be empty.
 */
export interface SeatAlternatives {
  readonly seat: TeamSeat;
  readonly candidates: readonly TeamSeat[];
}

/** A seat position: one seat, or one seat with ordered alternatives. */
export type SeatChoice = TeamSeat | SeatAlternatives;

/** Every seat a choice can run as, in try order. */
export function seatsOf(choice: SeatChoice): readonly TeamSeat[] {
  return 'candidates' in choice ? [choice.seat, ...choice.candidates] : [choice];
}

/** The seat identity a routing decision or availability entry names. */
export interface SeatRouteTarget {
  readonly adapter: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly model: string;
}

/**
 * One account's access route: the key remembered availability is scoped to.
 * The same model name on another adapter or provider is another account.
 */
export interface AvailabilityTarget {
  readonly adapter: string;
  readonly provider: string;
  readonly model: string;
}

/** A remembered dead candidate: it stays skipped until `until` (epoch ms). */
export interface UnavailableEntry {
  readonly until: number;
  readonly failure: 'billing' | 'quota';
}

/**
 * Remembered unavailability across runs. A runtime reads it before trying
 * a step's candidates and writes it only for a billing or quota failure
 * with a proven reset: one a header or structured field stated, never one
 * parsed out of error text. The host gives the store to the run; the runtime
 * opens no file unless the host passes a file-backed store.
 */
export interface AvailabilityStore {
  /**
   * The stored entry for `target` when it is still dead at `now` (epoch
   * milliseconds), else `undefined`. An entry at or past its `until` is
   * absent.
   */
  unavailableUntil(target: AvailabilityTarget, now: number): UnavailableEntry | undefined;
  markUnavailable(target: AvailabilityTarget, entry: UnavailableEntry): void;
  /**
   * Drains non-fatal problems found while reading or writing, such as a
   * corrupt backing file, so the run can record a warning once. Optional:
   * a store without problems to report may omit it.
   */
  takeProblems?(): readonly string[];
}

export type EngineFailureKind =
  | 'auth'
  | 'billing'
  | 'missing-cli'
  | 'model-unavailable'
  | 'invalid-config'
  | 'rate-limit'
  | 'quota'
  | 'transient'
  | 'timeout'
  | 'aborted'
  | 'unknown';

export interface EngineTransportFailure {
  readonly kind: EngineFailureKind;
  readonly message: string;
  readonly exitCode: number | null;
}

/** Tools used by supported agent hosts to dispatch sub-agents. */
export const SUBAGENT_TOOLS = ['Task', 'Agent', 'task'];
export const CLAUDE_SUBAGENT_TOOLS = ['Task', 'Agent'];

export interface AgentRequest {
  prompt: string;
  purpose?: 'preflight';
  system?: string;
  systemMode?: 'append' | 'replace';
  model?: string;
  /**
   * How hard the model thinks, in the engine's own levels, for this step. It
   * overrides the engine's own `effort` option. Unset leaves the engine's
   * choice, or the tool's own default.
   */
  effort?: string;
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

/** A read-only workspace must expose at least one tool that can read it. */
export function assertReadAccess(
  request: Pick<AgentRequest, 'tools' | 'workspaceMode'>,
): void {
  if (request.workspaceMode === 'read' && (request.tools?.length ?? 0) === 0) {
    throw new TypeError('read workspace requires at least one declared tool');
  }
}

export interface AgentResult {
  /** Ordered assistant continuations with exactly one marked final part. */
  readonly parts: readonly AgentResultPart[];
  readonly usage: UsageReceipt;
  /** What the call cost, when the engine reports a figure. */
  readonly cost?: CostReceipt;
  /** How the call was paid for, when the engine can tell. */
  readonly billing?: Billing;
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
  | {
      type: 'tool';
      name: string;
      phase: 'use' | 'result';
      /**
       * The file, command, URL or pattern the tool acted on, when its input
       * names one. Optional: an adapter that cannot see the tool's input at
       * this phase, or a tool with none of those arguments, reports nothing
       * rather than a guess.
       */
      target?: string;
    }
  | {
      type: 'usage';
      usage: UsageReceipt;
      model: string;
      /** What the call cost, when the engine reports a figure. */
      cost?: CostReceipt;
      /** How the call was paid for, when the engine can tell. */
      billing?: Billing;
      /** The call failed; `usage` holds the tokens its failure carried, or unknown. */
      failed?: true;
    };

export type EngineEventSink = (event: EngineStreamEvent) => void;

/**
 * How much input one request to an engine may hold, as the engine's own
 * service counts it: in characters, or in tokens. A runtime measures a
 * limit in tokens as one token per `CHARACTERS_PER_TOKEN` characters.
 */
export type EngineInputLimit =
  | { readonly characters: number }
  | { readonly tokens: number };

/**
 * The characters a runtime counts as one token when it measures a prompt
 * against a limit in tokens. It is lower than the ratio of any real prompt
 * measured against a service's own count (2.4 on a review prompt that was
 * mostly JSON), so a prompt measured as fitting does fit.
 */
export const CHARACTERS_PER_TOKEN = 2;

/** The most characters one request to an engine may hold, or `undefined` when it declares no limit. */
export function inputLimitCharacters(engine: Pick<Engine, 'inputLimit'>): number | undefined {
  const limit = engine.inputLimit;
  if (limit === undefined) return undefined;
  return 'characters' in limit ? limit.characters : limit.tokens * CHARACTERS_PER_TOKEN;
}

export interface Engine {
  readonly name: string;
  /**
   * How much input one request may hold. An engine that declares none is
   * treated as having no limit.
   */
  readonly inputLimit?: EngineInputLimit;
  admit?(
    request: Omit<AgentRequest, 'prompt'>,
    signal: AbortSignal,
    expectedSelection?: EngineSelectionRecord,
  ): Promise<EngineSelectionRecord>;
  run(
    request: AgentRequest,
    onEvent: EngineEventSink,
    signal: AbortSignal,
  ): Promise<AgentResult>;
}

export type EngineRef = string | Engine;

export type EngineName = string;

export function isEngine(value: unknown): value is Engine {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as Engine).name === 'string'
    && typeof (value as Engine).run === 'function'
  );
}
