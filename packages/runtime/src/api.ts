/** Public programmatic API for the Lines graph runtime. */

export type {
  JsonPrimitive,
  JsonObject,
  JsonValue,
  RunBrief,
  Sha256Digest,
  GraphValidationIssue,
} from './graph/value.js';
export { JsonValueError } from './graph/value.js';
export {
  GraphValidationError,
  type GraphId,
  type NodeId,
  type EdgeId,
  type GraphNode,
  type GraphEdge,
  type GraphDefinition,
  type CompiledGraphDefinition,
  type GraphKernel,
} from './graph/kernel.js';
export type {
  DispatchGraphCommand,
  PauseGraphCommand,
  CompleteGraphCommand,
  FailGraphCommand,
  GraphCommand,
} from './graph/commands.js';
export {
  compileGraph,
  type GraphEvent,
  type GraphEngineIdentity,
  type EngineAttemptRecordedPayload,
  type GraphBindings,
  type GraphTypeCompilation,
  type CompiledGraphType,
  type GraphType,
} from './graph/type.js';
export {
  dag as dagGraphType,
  type DagDefinition,
} from './graph-types/dag.js';
export {
  convergence,
  type ConvergenceDefinition,
  type ConvergenceEvent,
  type ConvergenceStatus,
} from './graph-types/loop.js';
export {
  createCallbackGate,
  callbackRequestDigest,
  validateCallbackRequest,
  validateCallbackResponse,
  type CallbackGateDefinition,
  type CallbackRequest,
} from './callback/gate.js';
export {
  createCallbackClient,
  replayCallbackClient,
  directRouter,
  validateCallbackEvent,
  type CallbackClient,
  type CallbackEvent,
  type ClaimResult,
  type SubmitResult,
  type ReleaseResult,
  type Responder,
} from './callback/client.js';
export {
  createStoredCallbackClient,
  type NewCallbackHistoryEvent,
  type StoredCallbackClient,
} from './callback/stored-client.js';
export {
  ApprovalSubjectError,
  approvalSubjectDigest,
  createApprovalCallbackGate,
  resolveApproval,
  validateApprovalRecord,
  type ApprovalBinding,
  type ApprovalEventPayload,
  type ApprovalRecord,
  type ApprovalResolutionInput,
  type ApprovalSubject,
  type ApprovalSubjectInput,
  type NewApprovalEvent,
} from './callback/approval.js';
export {
  acceptedResultMatches,
  createAcceptedResultRecord,
  resolveAcceptedResult,
  validateAcceptedResultRecord,
  type AcceptedResultBinding,
  type AcceptedResultBindingInput,
  type AcceptedResultEventPayload,
  type AcceptedResultGraph,
  type AcceptedResultRecord,
  type AcceptedResultResolution,
  type CreateAcceptedResultRecordInput,
  type NewAcceptedResultEvent,
} from './proof/acceptance.js';
export {
  writeProofArtifact,
  type ProofArtifactReference,
} from './proof/artifact.js';
export {
  createProofCache,
  type CachedProofPacket,
  type ProofCache,
  type ProofCacheCurrentBinding,
  type ProofCacheOptions,
  type ProofJob,
  type ProofPacket,
  type ProofPacketSource,
  type ProofSource,
} from './proof/cache.js';
export {
  createGraphExecutor,
  GraphExecutionError,
  type GraphExecutionErrorCode,
  type GraphNodeBinding,
  type GraphEngineBinding,
  type GraphExecutor,
  type GraphExecutorOptions,
  type GraphExecutorResult,
} from './runtime/graph-executor.js';
export {
  resolveGraphPlan,
  validateGraphDescription,
  type PermissionDescriptor,
  type ExecutionTarget,
  type ExecutionLaneDescription,
  type GraphPhaseDescription,
  type GraphNodeDescription,
  type GraphEdgeDescription,
  type PlanBound,
  type GraphBounds,
  type GraphPolicyDescription,
  type GraphRequirements,
  type GraphDescriptionInput,
  type GraphDescription,
  type GraphPackageIdentity,
  type GraphPackageAdmission,
  type ExecutionLaneResolution,
  type PlanResolution,
  type ResolvedExecutionLane,
  type ResolvedPlan,
  type ResolvedPlanSnapshot,
} from './graph/plan.js';

export {
  StorageError,
  type StorageErrorCode,
} from './storage/error.js';
export {
  createGitWorktreeProvider,
} from './workspace/git-provider.js';
export type {
  WorkspaceProvider,
  WorkspaceAnchor,
  WorkspaceHeadDrift,
  WorkspaceFilesDrift,
  WorkspaceRepositoryDrift,
  WorkspaceDrift,
  VerifyResult,
  ForkOk,
  ForkChangedAnchor,
  ForkExists,
  ForkIncomplete,
  ForkUnleased,
  ForkNoRevision,
  ForkInvalidChild,
  ForkResult,
  LeaseClaimed,
  LeaseHeld,
  LeaseIncomplete,
  AcquireResult,
  WorkspaceReleaseResult,
  RecoverResult,
} from './workspace/provider.js';
export {
  validateNewDomainEvent,
  validateDomainEventEnvelope,
  type DomainEventId,
  type EventStreamId,
  type StorageNamespace,
  type StreamRevision,
  type EventStreamRef,
  type NewDomainEvent,
  type DomainEventEnvelope,
} from './events/envelope.js';
export {
  validateDomainEventBatch,
  validateEventStreamRef,
  type DomainEventBatch,
  type EventStore,
} from './events/store.js';
export {
  validateArtifactReference,
  validateArtifactScope,
  validateNewArtifact,
  type ArtifactBatch,
  type ArtifactContentMode,
  type ArtifactScope,
  type NewArtifact,
  type ArtifactReference,
  type ArtifactStore,
} from './artifacts/store.js';
export {
  loadRunDefinition,
  persistRunDefinition,
  validateRunDefinition,
  validateRunStartRecord,
  validateRunStoragePolicy,
  validateRunStorageRecord,
  type StorageProviderRecord,
  type SensitiveContentPolicy,
  type RunStoragePolicy,
  type RunStorageRecord,
  type RunDefinition,
  type RunStartedPayload,
  type NewRunStartedEvent,
  type RunStartRecord,
  type RunStorageBinding,
} from './runtime/run-definition.js';
export type {
  AttemptBudgetPolicy,
  TokenBudget,
} from './runtime/budget.js';
export type {
  ActionDecision,
  AllowActionDecision,
  WaitActionDecision,
  DenyActionDecision,
  NodeDataContext,
} from './runtime/node-lifecycle.js';
export type { ResultContract } from './runtime/result-contract.js';
export type { NodeWorkspacePolicy } from './runtime/workspace-policy.js';

export type {
  Job,
  JobMeta,
  JobContext,
  Outcome,
  OutcomeStatus,
  FeedbackActionSeverity,
  FeedbackDecision,
  FeedbackFinding,
  FeedbackSeverity,
  RevisionRequest,
  RevisionRerun,
  GraphPosition,
  LimitPolicy,
  Condition,
  ConditionInput,
  ConditionResult,
  RawPredicate,
  LoopConfig,
  RetryPolicy,
  DagConfig,
  DagNode,
  LoopEvent,
  LogLevel,
  Workspace,
  ProofKind,
  ProofArtifact,
  ProofRecord,
} from './core/types.js';

export { loop } from './core/loop.js';
export { dag, sequence, parallel } from './core/dag.js';
export { pipeline, type PipelineStage } from './core/pipeline.js';
export { tournament, type TournamentConfig } from './core/tournament.js';
export {
  team,
  type TeamAgent,
  type TeamAgentResult,
  type TeamConfig,
  type TeamResult,
  type TeamReview,
} from './core/team.js';
export {
  agentJob,
  fnJob,
  prove,
  kickback,
  revisionRequest,
  type AgentJobConfig,
  type AgentRoute,
  type ProofDescriptor,
  type ProofProducer,
} from './core/job.js';
export {
  reviewPanel,
  reviewContext,
  type ReviewPanelConfig,
  type ReviewContextConfig,
  type RevisionRequestInput,
} from './core/feedback.js';

export { jobMeta, renderPlan, describeConditions } from './core/describe.js';
export {
  assertGraph,
  type GraphShape,
  type GraphNodeShape,
} from './core/assert-graph.js';

export {
  defineAgent,
  defineSkill,
  fromFile,
  type AgentContractSummary,
  type AgentDef,
  type AgentFailureMode,
  type AgentOutputContract,
  type AgentSkillRef,
  type AgentTier,
  type Skill,
} from './core/agent.js';
export { defineAgentFromMarkdown } from './core/agent-md.js';

export { isolated, type IsolatedOptions } from './core/isolated.js';
export {
  confidenceCondition,
  confidenceFromText,
  lastDecisionLine,
  lastGateBrief,
  type ConfidenceConditionOptions,
  type LastDecisionLineOptions,
  type LastGateBriefOptions,
} from './core/decision.js';
export {
  toCondition,
  predicate,
  bodyPassed,
  minConfidence,
  commandSucceeds,
  all,
  any,
  not,
  quorum,
  always,
  never,
  agentCheck,
  gateJob,
  type AgentCheckConfig,
} from './core/condition.js';
export type {
  NoProgressConfig,
  NoProgressInput,
  StallReport,
} from './core/progress.js';
export { LoopError, type LoopErrorCode } from './core/errors.js';
export type { BudgetConfig } from './core/budget.js';

export type {
  Engine,
  EngineRef,
  EngineName,
  AgentRequest,
  AgentResult,
  AgentResultPart,
  EngineIncompleteResultEvidence,
  EngineSelectionRecord,
  EngineTransportFailure,
  EngineStreamEvent,
  Usage,
  UsageReceipt,
} from './engines/engine.js';
export { EngineError, EngineIncompleteResultError } from './engines/engine.js';
export {
  finalResultPart,
  finalResultText,
  validateAgentResult,
} from './runtime/result-parts.js';

export type { Environment, EnvHandle } from './env/environment.js';
export { withEnv } from './core/env-overlay.js';

export {
  run,
  exitCodeFor,
  EXIT_PAUSED,
  type RunOptions,
  type RunResult,
} from './runtime/runner.js';
export type { StatsSnapshot } from './core/stats.js';
export {
  classifyEngineFailure,
  LANE_DEAD_FAILURES,
  type EngineFailureKind,
} from './engines/failure.js';
export {
  fallbackEngine,
  type FallbackOptions,
  type FallbackInfo,
} from './engines/fallback.js';
export {
  preflight,
  preflightEngine,
  formatPreflight,
  type PreflightResult,
  type PreflightOptions,
} from './engines/preflight.js';
export {
  costReport,
  formatCostReport,
  type PriceTable,
  type ModelPrice,
  type ModelCost,
  type CostReport,
} from './core/cost.js';
export {
  ratchet,
  writeScope,
  sampled,
  type RatchetOptions,
  type WriteScopeOptions,
  type SampledOptions,
} from './core/guards.js';

import type { Job } from './core/types.js';

/** Preserve the exact `Job` type of a default export. */
export function defineJob(job: Job): Job {
  return job;
}
