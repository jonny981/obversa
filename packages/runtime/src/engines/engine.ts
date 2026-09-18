/** Thin compatibility surface while the runtime package keeps its old name. */

export {
  CLAUDE_SUBAGENT_TOOLS,
  EngineError,
  EngineIncompleteResultError,
  SUBAGENT_TOOLS,
  isEngine,
  type AgentRequest,
  type AgentResult,
  type AgentResultPart,
  type AttemptMetadata,
  type Engine,
  type EngineEventSink,
  type EngineFailureKind,
  type EngineIncompleteResultEvidence,
  type EngineRef,
  type EngineSelectionRecord,
  type EngineStreamEvent,
  type EngineTransportFailure,
  type Usage,
  type UsageReceipt,
} from '@obversa/api';
export { attemptEnvironment, attemptEnvironment as requestEnv } from '@obversa/core/command';

export type { EngineName } from '@obversa/api';
