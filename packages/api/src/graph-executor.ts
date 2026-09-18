import type { Memory } from './memory-types.js';
import type { GraphCommand } from './graph-commands.js';
import type { CompiledGraphType } from './graph-type.js';
import type { JsonObject, JsonValue } from './json.js';
import type { ExecutionTarget, AgentResultPart, EngineSelectionRecord, Engine } from './contracts.js';
import type { AttemptBudgetPolicy, TokenBudget } from './budget.js';
import type { NodeDataContext } from './node-data-context.js';
import type { ResultContract } from './result-contract.js';
import type { RunStorageBinding } from './run-definition.js';
import type { NodeWorkspacePolicy } from './workspace/policy.js';
import type { ActionDecision } from './action-decision.js';
import type { PreflightPauseResult, PreflightFailureResult } from './preflight-result.js';

export type GraphExecutionErrorCode =
  | 'ABORTED'
  | 'DUPLICATE_POSITION'
  | 'EMPTY_DECISION'
  | 'ENGINE_IDENTITY_UNRESOLVED'
  | 'INVALID_EVENT'
  | 'INVALID_PREFLIGHT_CONFIG'
  | 'MISSING_ENGINE_BINDING'
  | 'MISSING_MEMORY'
  | 'MISSING_NODE_BINDING'
  | 'PROTOCOL'
  | 'RESUME_EVENT_MISMATCH'
  | 'STORED_GRAPH_MISMATCH';

export class GraphExecutionError extends Error {
  readonly code: GraphExecutionErrorCode;

  constructor(code: GraphExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GraphExecutionError';
    this.code = code;
  }
}

export interface GraphNodeBinding {
  readonly prompt: ((input: JsonValue) => string) | null;
  readonly scratchDirectory: string;
  readonly workspace: NodeWorkspacePolicy;
  readonly trustedCaller: JsonObject;
  readonly permissions: readonly string[];
  readonly policy: AttemptBudgetPolicy;
  readonly resultContract: ResultContract | null;
  readonly runData: ((context: NodeDataContext) => Promise<JsonValue>) | null;
  readonly parseResult:
    | ((part: AgentResultPart, parts: readonly AgentResultPart[]) => JsonValue)
    | null;
  readonly tokenBudget: TokenBudget | null;
  /** Whether node code may run again after a crash leaves its outcome unknown. */
  readonly retrySafe?: boolean;
  decideAction(): Promise<ActionDecision>;
}

export interface GraphEngineBinding {
  readonly target: ExecutionTarget;
  readonly selection: EngineSelectionRecord;
  readonly engine: Engine;
  readonly hardTokenLimitEnforceable: boolean;
}

export interface GraphExecutorOptions {
  readonly runId: string;
  readonly graph: CompiledGraphType;
  readonly storage: RunStorageBinding;
  readonly nodes: Readonly<Record<string, GraphNodeBinding>>;
  readonly engines: readonly GraphEngineBinding[];
  readonly preflightScratchDirectory?: string;
  readonly bindings?: {
    readonly memory?: Memory;
  };
}

export type GraphExecutorResult =
  | Extract<GraphCommand, { readonly kind: 'pause' | 'complete' | 'fail' }>
  | PreflightPauseResult
  | PreflightFailureResult
  | {
      readonly kind: 'waiting';
      readonly positions: readonly string[];
    };

export interface GraphExecutor {
  run(signal: AbortSignal): Promise<GraphExecutorResult>;
  resume(target: string | { readonly preflightEventId: string }, signal: AbortSignal): Promise<GraphExecutorResult>;
}
