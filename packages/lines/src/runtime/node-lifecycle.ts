import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import type {
  AgentRequest,
  AgentResultPart,
  Engine,
  EngineSelectionRecord,
  EngineTransportFailure,
  UsageReceipt,
} from '../engines/engine.js';
import {
  classifyEngineFailure,
  LANE_DEAD_FAILURES,
  type EngineFailureKind,
} from '../engines/failure.js';
import { scrubCapture } from '../core/redact.js';
import {
  canonicalJson,
  cloneFrozenJson,
  type JsonObject,
  type JsonValue,
} from '../graph/value.js';
import type { AttemptIdentity } from './attempt.js';
import {
  validateAttemptBudgetPolicy,
  type AttemptBudgetPolicy,
  type BudgetReservation,
  type TokenBudget,
} from './budget.js';
import type { ResultContract } from './result-contract.js';
import {
  engineSelection,
  validateAgentResult,
} from './result-parts.js';
import {
  captureWorkspaceEntry,
  inspectWorkspaceExit,
  validateWorkspacePolicy,
  type NodeWorkspacePolicy,
  type WorkspaceAttemptEvidence,
} from './workspace-policy.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const EMPTY_USAGE = Object.freeze({ kind: 'unknown' as const });
const EMPTY_WORKSPACE = cloneFrozenJson({
  entryHead: null,
  exitHead: null,
  headChanged: false,
  changedPaths: [],
  foreignPaths: [],
  filesChanged: 0,
  linesChanged: 0,
} satisfies WorkspaceAttemptEvidence);

export interface AllowActionDecision extends JsonObject {
  readonly kind: 'allow';
}

export interface WaitActionDecision extends JsonObject {
  readonly kind: 'wait';
  readonly reason: string;
  readonly request: JsonValue;
}

export interface DenyActionDecision extends JsonObject {
  readonly kind: 'deny';
  readonly reason: string;
}

export type ActionDecision =
  | AllowActionDecision
  | WaitActionDecision
  | DenyActionDecision;

export interface PreparedEngineLane {
  readonly engine: Engine;
  readonly selection: EngineSelectionRecord;
  readonly hardTokenLimitEnforceable: boolean;
}

export interface NodeDataContext {
  readonly input: JsonValue;
  readonly scratchDirectory: string;
  readonly workspaceDirectory: string | null;
  readonly trustedCaller: JsonObject;
  readonly permissions: readonly string[];
  readonly signal: AbortSignal;
}

export interface ModelUnavailableFact {
  readonly schemaVersion: 1;
  readonly identity: AttemptIdentity;
  readonly selection: EngineSelectionRecord;
  readonly failure: EngineFailureKind;
}

export interface PreparedNodeAttempt {
  readonly identity: AttemptIdentity;
  readonly nodeId: string;
  readonly input: JsonValue;
  readonly prompt: string | null;
  readonly scratchDirectory: string;
  readonly workspace: NodeWorkspacePolicy;
  readonly trustedCaller: JsonObject;
  readonly permissions: readonly string[];
  readonly policy: AttemptBudgetPolicy;
  readonly resultContract: ResultContract | null;
  readonly engineRoute:
    | readonly [PreparedEngineLane]
    | readonly [PreparedEngineLane, PreparedEngineLane]
    | null;
  readonly runData:
    | ((context: NodeDataContext) => Promise<JsonValue>)
    | null;
  readonly parseResult:
    | ((part: AgentResultPart) => JsonValue)
    | null;
  readonly tokenBudget: TokenBudget | null;
  readonly recordModelUnavailable: (
    fact: ModelUnavailableFact,
  ) => Promise<void>;
  decideAction(): Promise<ActionDecision>;
}

export type NodeAttemptFailureCode =
  | 'INVALID_ATTEMPT'
  | 'ABORTED'
  | 'INPUT_LIMIT'
  | 'ACTION_POLICY'
  | 'TOKEN_BUDGET'
  | 'EFFECT_FAILED'
  | 'ENGINE_UNAVAILABLE'
  | 'MODEL_UNAVAILABLE_RECORD'
  | 'RESULT_INVALID'
  | 'OUTPUT_LIMIT'
  | 'WORKSPACE_INSPECTION'
  | 'WORKSPACE_VIOLATION'
  | 'WORKSPACE_LIMIT';

export interface NodeAttemptFailure extends JsonObject {
  readonly code: NodeAttemptFailureCode;
  readonly message: string;
}

export interface NodeAttemptRecord {
  readonly schemaVersion: 1;
  readonly identity: AttemptIdentity;
  readonly status: 'completed' | 'failed' | 'paused' | 'denied';
  readonly decision: ActionDecision | null;
  readonly failure: NodeAttemptFailure | null;
  readonly result: JsonValue | null;
  readonly parts: readonly AgentResultPart[];
  readonly usage: UsageReceipt;
  readonly requestedEngine: EngineSelectionRecord | null;
  readonly effectiveEngine: EngineSelectionRecord | null;
  readonly unavailableModels: readonly EngineSelectionRecord[];
  readonly transportFailure: EngineTransportFailure | null;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly changedPaths: readonly string[];
  readonly foreignPaths: readonly string[];
  readonly filesChanged: number;
  readonly linesChanged: number;
  readonly entryHead: string | null;
  readonly exitHead: string | null;
  readonly headChanged: boolean;
  readonly trustedCaller: JsonObject;
  readonly permissions: readonly string[];
}

interface MutableAttemptFacts {
  status: NodeAttemptRecord['status'];
  decision: ActionDecision | null;
  failure: NodeAttemptFailure | null;
  result: JsonValue | null;
  parts: readonly AgentResultPart[];
  usage: UsageReceipt;
  requestedEngine: EngineSelectionRecord | null;
  effectiveEngine: EngineSelectionRecord | null;
  unavailableModels: EngineSelectionRecord[];
  transportFailure: EngineTransportFailure | null;
  outputBytes: number;
  workspace: WorkspaceAttemptEvidence;
}

function failure(
  code: NodeAttemptFailureCode,
  error: unknown,
): NodeAttemptFailure {
  const text = error instanceof Error ? error.message : String(error);
  return cloneFrozenJson({
    code,
    message: scrubCapture(text, undefined, 1_000) || code,
  });
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty trimmed string without control characters`,
    );
  }
  cloneFrozenJson(value);
  return value;
}

function permissions(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError('permissions must be an array');
  const checked = value.map((permission, index) =>
    text(permission, `permissions[${index}]`),
  );
  if (new Set(checked).size !== checked.length) {
    throw new TypeError('permissions must be unique');
  }
  return Object.freeze(checked);
}

function selection(value: EngineSelectionRecord): EngineSelectionRecord {
  return engineSelection({
    adapter: value.adapter,
    adapterVersion: value.adapterVersion,
    provider: value.provider,
    modelFamily: value.modelFamily,
    model: value.model,
    capabilities: value.capabilities,
  });
}

function sameSelection(
  left: EngineSelectionRecord,
  right: EngineSelectionRecord,
): boolean {
  return canonicalJson(left as unknown as JsonValue) ===
    canonicalJson(right as unknown as JsonValue);
}

function validateLane(value: PreparedEngineLane, index: number): PreparedEngineLane {
  if (
    typeof value.engine !== 'object' ||
    value.engine === null ||
    typeof value.engine.run !== 'function'
  ) {
    throw new TypeError(`engineRoute[${index}].engine must be an Engine`);
  }
  if (typeof value.hardTokenLimitEnforceable !== 'boolean') {
    throw new TypeError(
      `engineRoute[${index}].hardTokenLimitEnforceable must be a boolean`,
    );
  }
  return Object.freeze({
    engine: value.engine,
    selection: selection(value.selection),
    hardTokenLimitEnforceable: value.hardTokenLimitEnforceable,
  });
}

function validateDecision(value: ActionDecision): ActionDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('action decision must be an object');
  }
  if (value.kind === 'allow') {
    if (Object.keys(value).length !== 1) {
      throw new TypeError('allow action decision has unknown fields');
    }
    return cloneFrozenJson({ kind: 'allow' });
  }
  if (value.kind === 'wait') {
    if (
      Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, 'reason') ||
      !Object.hasOwn(value, 'request')
    ) {
      throw new TypeError('wait action decision has missing or unknown fields');
    }
    return cloneFrozenJson({
      kind: 'wait',
      reason: text(value.reason, 'action wait reason'),
      request: cloneFrozenJson(value.request),
    });
  }
  if (value.kind === 'deny') {
    if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'reason')) {
      throw new TypeError('deny action decision has missing or unknown fields');
    }
    return cloneFrozenJson({
      kind: 'deny',
      reason: text(value.reason, 'action deny reason'),
    });
  }
  throw new TypeError('action decision kind must be allow, wait, or deny');
}

async function validateScratchDirectory(value: string): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError('scratchDirectory must be an absolute path');
  }
  const stat = await lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError('scratchDirectory must be a real directory');
  }
  const resolved = await realpath(value);
  if (resolved !== value) {
    throw new TypeError('scratchDirectory must already be normalized');
  }
  return resolved;
}

function partBytes(part: AgentResultPart): number {
  return Buffer.byteLength(
    part.kind === 'assistant' ? part.text : canonicalJson(part.value),
    'utf8',
  );
}

function outputBytes(parts: readonly AgentResultPart[]): number {
  let total = 0;
  for (const part of parts) {
    total += partBytes(part);
    if (!Number.isSafeInteger(total)) {
      throw new TypeError('result output size exceeded the safe integer range');
    }
  }
  return total;
}

function initialFacts(): MutableAttemptFacts {
  return {
    status: 'failed',
    decision: null,
    failure: null,
    result: null,
    parts: Object.freeze([]),
    usage: EMPTY_USAGE,
    requestedEngine: null,
    effectiveEngine: null,
    unavailableModels: [],
    transportFailure: null,
    outputBytes: 0,
    workspace: EMPTY_WORKSPACE,
  };
}

function record(
  identity: AttemptIdentity,
  trustedCaller: JsonObject,
  grantedPermissions: readonly string[],
  inputBytes: number,
  facts: MutableAttemptFacts,
): NodeAttemptRecord {
  return cloneFrozenJson({
    schemaVersion: 1,
    identity,
    status: facts.status,
    decision: facts.decision,
    failure: facts.failure,
    result: facts.result,
    parts: facts.parts,
    usage: facts.usage,
    requestedEngine: facts.requestedEngine,
    effectiveEngine: facts.effectiveEngine,
    unavailableModels: facts.unavailableModels,
    transportFailure: facts.transportFailure,
    inputBytes,
    outputBytes: facts.outputBytes,
    changedPaths: facts.workspace.changedPaths,
    foreignPaths: facts.workspace.foreignPaths,
    filesChanged: facts.workspace.filesChanged,
    linesChanged: facts.workspace.linesChanged,
    entryHead: facts.workspace.entryHead,
    exitHead: facts.workspace.exitHead,
    headChanged: facts.workspace.headChanged,
    trustedCaller,
    permissions: grantedPermissions,
  } as unknown as JsonValue) as unknown as NodeAttemptRecord;
}

function reserveCalls(
  route: readonly PreparedEngineLane[],
  policy: AttemptBudgetPolicy,
  budget: TokenBudget | null,
): BudgetReservation[] {
  if (policy.callTokens === null) return [];
  if (budget === null) {
    throw new TypeError('a call token policy requires a token budget');
  }
  const reservations: BudgetReservation[] = [];
  try {
    for (const lane of route) {
      reservations.push(
        budget.reserve(policy.callTokens, {
          hardLimitEnforceable: lane.hardTokenLimitEnforceable,
        }),
      );
    }
    return reservations;
  } catch (error) {
    for (const reservation of reservations) reservation.release();
    throw error;
  }
}

function requestFor(
  identity: AttemptIdentity,
  nodeId: string,
  prompt: string,
  lane: PreparedEngineLane,
  policy: AttemptBudgetPolicy,
  workspace: NodeWorkspacePolicy,
  scratchDirectory: string,
  grantedPermissions: readonly string[],
): AgentRequest {
  return {
    prompt,
    ...(lane.selection.model === null ? {} : { model: lane.selection.model }),
    ...(policy.callTokens === null ? {} : { maxTokens: policy.callTokens.tokens }),
    allowedTools: [...grantedPermissions],
    cwd: workspace.directory ?? scratchDirectory,
    timeoutMs: policy.timeoutMs,
    timeoutGraceMs: policy.teardownGraceMs,
    maxOutputBytes: policy.outputBytes,
    maxMemoryBytes: policy.memoryBytes,
    leaf: true,
    lines: {
      leaf: true,
      runId: identity.streamId,
      attemptId: identity.attemptId,
      leafId: nodeId,
      path: [identity.position],
      label: nodeId,
      iteration: 0,
    },
  };
}

async function unavailable(
  identity: AttemptIdentity,
  recordModelUnavailable: PreparedNodeAttempt['recordModelUnavailable'],
  lane: PreparedEngineLane,
  failureKind: EngineFailureKind,
): Promise<ModelUnavailableFact> {
  const fact = cloneFrozenJson({
    schemaVersion: 1,
    identity,
    selection: lane.selection,
    failure: failureKind,
  } as unknown as JsonValue) as unknown as ModelUnavailableFact;
  await recordModelUnavailable(fact);
  return fact;
}

function validatedResult(
  resultContract: ResultContract | null,
  parseResult: PreparedNodeAttempt['parseResult'],
  parts: readonly AgentResultPart[],
): JsonValue | null {
  const final = parts.find((part) => part.final);
  if (!final) throw new TypeError('attempt result has no final part');
  if (resultContract === null) {
    return final.kind === 'structured' ? cloneFrozenJson(final.value) : null;
  }
  const candidate = final.kind === 'structured'
    ? final.value
    : parseResult?.(final);
  if (candidate === undefined) {
    throw new TypeError(
      'assistant text needs an explicit parser for this result contract',
    );
  }
  return resultContract.validate(candidate);
}

function applyWorkspacePolicy(
  facts: MutableAttemptFacts,
  policy: AttemptBudgetPolicy,
): void {
  if (facts.workspace.foreignPaths.length > 0) {
    facts.status = 'failed';
    facts.failure = failure(
      'WORKSPACE_VIOLATION',
      `workspace changed outside the attempt scope: ${facts.workspace.foreignPaths.join(', ')}`,
    );
    return;
  }
  if (
    facts.workspace.filesChanged > policy.filesChanged ||
    facts.workspace.linesChanged > policy.linesChanged
  ) {
    facts.status = 'failed';
    facts.failure = failure(
      'WORKSPACE_LIMIT',
      `workspace delta ${facts.workspace.filesChanged} file(s), ${facts.workspace.linesChanged} line(s) exceeds limits ${policy.filesChanged} file(s), ${policy.linesChanged} line(s): ${facts.workspace.changedPaths.join(', ')}`,
    );
  }
}

export async function executeNodeAttempt(
  prepared: PreparedNodeAttempt,
  signal: AbortSignal,
): Promise<NodeAttemptRecord> {
  const facts = initialFacts();
  let trustedCaller = Object.freeze({}) as JsonObject;
  let grantedPermissions: readonly string[] = Object.freeze([]);
  let inputBytes = 0;
  let policy: AttemptBudgetPolicy | undefined;
  let workspace: NodeWorkspacePolicy | undefined;
  let workspaceEntry: Awaited<ReturnType<typeof captureWorkspaceEntry>> | undefined;
  let identity = prepared.identity;

  try {
    identity = cloneFrozenJson(prepared.identity);
    const nodeId = text(prepared.nodeId, 'nodeId');
    if (nodeId !== identity.nodeId) {
      throw new TypeError('nodeId must match identity.nodeId');
    }
    const input = cloneFrozenJson(prepared.input);
    trustedCaller = cloneFrozenJson(prepared.trustedCaller);
    grantedPermissions = permissions(prepared.permissions);
    policy = validateAttemptBudgetPolicy(prepared.policy);
    workspace = validateWorkspacePolicy(prepared.workspace);
    const route = prepared.engineRoute?.map(validateLane) ?? null;
    const runData = prepared.runData;
    const resultContract = prepared.resultContract;
    const parseResult = prepared.parseResult;
    const tokenBudget = prepared.tokenBudget;
    const recordModelUnavailable = prepared.recordModelUnavailable;
    const decideAction = prepared.decideAction;
    const scratchPath = prepared.scratchDirectory;
    const prompt = prepared.prompt;
    if (route !== null && (route.length < 1 || route.length > 2)) {
      throw new TypeError('engineRoute must contain one primary and at most one fallback');
    }
    if ((route === null) === (runData === null)) {
      throw new TypeError('attempt must declare exactly one engine or data effect');
    }
    if (route !== null) {
      if (
        typeof prompt !== 'string' ||
        prompt.trim().length === 0
      ) {
        throw new TypeError('an engine attempt requires a prompt');
      }
      cloneFrozenJson(prompt);
      if (typeof recordModelUnavailable !== 'function') {
        throw new TypeError('engine attempt needs a model-unavailable recorder');
      }
    } else if (prompt !== null) {
      throw new TypeError('a data-only attempt must not have a model prompt');
    }
    if (runData !== null && typeof runData !== 'function') {
      throw new TypeError('runData must be a function or null');
    }
    if (parseResult !== null && typeof parseResult !== 'function') {
      throw new TypeError('parseResult must be a function or null');
    }
    if (typeof decideAction !== 'function') {
      throw new TypeError('decideAction must be a function');
    }

    inputBytes = Buffer.byteLength(canonicalJson(input), 'utf8') +
      (prompt === null
        ? 0
        : Buffer.byteLength(prompt, 'utf8'));
    if (inputBytes > policy.inputBytes) {
      facts.failure = failure(
        'INPUT_LIMIT',
        `attempt input is ${inputBytes} bytes; limit is ${policy.inputBytes}`,
      );
      return record(identity, trustedCaller, grantedPermissions, inputBytes, facts);
    }
    if (signal.aborted) {
      facts.failure = failure('ABORTED', 'node attempt was aborted before dispatch');
      return record(identity, trustedCaller, grantedPermissions, inputBytes, facts);
    }
    const scratchDirectory = await validateScratchDirectory(scratchPath);

    try {
      workspaceEntry = await captureWorkspaceEntry(workspace, signal);
      workspace = workspaceEntry.policy;
    } catch (error) {
      facts.failure = failure('WORKSPACE_INSPECTION', error);
    }
    let decision: ActionDecision | null = null;
    if (facts.failure === null) {
      try {
        decision = validateDecision(await decideAction());
      } catch (error) {
        facts.failure = failure('ACTION_POLICY', error);
      }
    }
    facts.decision = decision;
    if (facts.failure !== null) {
      facts.status = 'failed';
    } else if (decision?.kind === 'wait') {
      facts.status = 'paused';
    } else if (decision?.kind === 'deny') {
      facts.status = 'denied';
    } else if (signal.aborted) {
      facts.status = 'failed';
      facts.failure = failure('ABORTED', 'node attempt was aborted before dispatch');
    } else if (route === null) {
      let effectResult: JsonValue | undefined;
      try {
        effectResult = cloneFrozenJson(await runData!({
          input,
          scratchDirectory,
          workspaceDirectory: workspace.directory,
          trustedCaller,
          permissions: grantedPermissions,
          signal,
        }));
      } catch (error) {
        facts.failure = failure('EFFECT_FAILED', error);
      }
      if (effectResult !== undefined) {
        const result = effectResult;
        facts.parts = Object.freeze([
          Object.freeze({ kind: 'structured', value: result, final: true }),
        ]);
        facts.outputBytes = outputBytes(facts.parts);
        if (facts.outputBytes > policy.outputBytes) {
          facts.failure = failure(
            'OUTPUT_LIMIT',
            `attempt output is ${facts.outputBytes} bytes; limit is ${policy.outputBytes}`,
          );
        } else {
          try {
            facts.result = resultContract === null
              ? result
              : resultContract.validate(result);
            facts.status = 'completed';
          } catch (error) {
            facts.failure = failure('RESULT_INVALID', error);
          }
        }
      }
    } else {
      facts.requestedEngine = route[0]!.selection;
      let reservations: BudgetReservation[] = [];
      const settled = new Set<number>();
      const settle = (index: number, usage: UsageReceipt): void => {
        if (!reservations[index] || settled.has(index)) return;
        try {
          reservations[index]!.commit(usage);
        } finally {
          settled.add(index);
        }
      };
      const release = (index: number): void => {
        if (!reservations[index] || settled.has(index)) return;
        reservations[index]!.release();
        settled.add(index);
      };
      try {
        reservations = reserveCalls(route, policy, tokenBudget);
      } catch (error) {
        facts.failure = failure('TOKEN_BUDGET', error);
      }

      if (facts.failure === null) {
        let successful = false;
        for (let index = 0; index < route.length; index += 1) {
          const selected = route[index]!;
          try {
            const result = validateAgentResult(await selected.engine.run(
              requestFor(
                identity,
                nodeId,
                prompt!,
                selected,
                policy,
                workspace,
                scratchDirectory,
                grantedPermissions,
              ),
              () => {},
              signal,
            ));
            facts.parts = result.parts;
            facts.usage = index === 0 ? result.usage : EMPTY_USAGE;
            facts.effectiveEngine = result.effective;
            facts.transportFailure = result.transportFailure ?? null;
            facts.outputBytes = outputBytes(result.parts);
            try {
              settle(index, result.usage);
            } catch (error) {
              facts.failure = failure('TOKEN_BUDGET', error);
              for (let unused = index + 1; unused < route.length; unused += 1) {
                release(unused);
              }
              break;
            }
            for (let unused = index + 1; unused < route.length; unused += 1) {
              release(unused);
            }
            if (!sameSelection(result.requested, selected.selection)) {
              facts.failure = failure(
                'RESULT_INVALID',
                'engine requested identity does not match its prepared lane',
              );
            } else if (facts.outputBytes > policy.outputBytes) {
              facts.failure = failure(
                'OUTPUT_LIMIT',
                `attempt output is ${facts.outputBytes} bytes; limit is ${policy.outputBytes}`,
              );
            } else {
              try {
                facts.result = validatedResult(
                  resultContract,
                  parseResult,
                  result.parts,
                );
                facts.status = 'completed';
                successful = true;
              } catch (error) {
                facts.failure = failure('RESULT_INVALID', error);
              }
            }
            break;
          } catch (error) {
            settle(index, EMPTY_USAGE);
            const failureKind = classifyEngineFailure(error);
            if (!LANE_DEAD_FAILURES.has(failureKind)) {
              facts.failure = failure('EFFECT_FAILED', error);
              for (let unused = index + 1; unused < route.length; unused += 1) {
                release(unused);
              }
              break;
            }
            facts.unavailableModels.push(selected.selection);
            try {
              await unavailable(
                identity,
                recordModelUnavailable,
                selected,
                failureKind,
              );
            } catch (recordError) {
              facts.failure = failure('MODEL_UNAVAILABLE_RECORD', recordError);
              for (let unused = index + 1; unused < route.length; unused += 1) {
                release(unused);
              }
              break;
            }
            if (index === route.length - 1) {
              facts.failure = failure('ENGINE_UNAVAILABLE', error);
            }
          }
        }
        if (!successful && facts.failure === null) {
          facts.failure = failure(
            'ENGINE_UNAVAILABLE',
            'no declared engine lane completed the attempt',
          );
        }
      }
      for (let index = 0; index < reservations.length; index += 1) release(index);
    }
  } catch (error) {
    facts.failure = failure('INVALID_ATTEMPT', error);
  } finally {
    if (workspace && workspaceEntry) {
      try {
        facts.workspace = await inspectWorkspaceExit(
          workspace,
          workspaceEntry,
          new AbortController().signal,
        );
        if (policy) applyWorkspacePolicy(facts, policy);
      } catch (error) {
        facts.status = 'failed';
        facts.failure = failure('WORKSPACE_INSPECTION', error);
      }
    }
  }

  return record(
    identity,
    trustedCaller,
    grantedPermissions,
    inputBytes,
    facts,
  );
}
