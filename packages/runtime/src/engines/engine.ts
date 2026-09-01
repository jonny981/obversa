/** Thin compatibility surface while the runtime package keeps its old name. */

export {
  CLAUDE_SUBAGENT_TOOLS,
  EngineError,
  EngineIncompleteResultError,
  SUBAGENT_TOOLS,
  attemptEnvironment,
  attemptEnvironment as requestEnv,
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
} from '@obversa/engine';

export type EngineName = string;
