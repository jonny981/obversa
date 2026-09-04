import { createHash, randomUUID } from 'node:crypto';

import { validateArtifactReference } from '../artifacts/store.js';
import type {
  DomainEventEnvelope,
  NewDomainEvent,
} from '../events/envelope.js';
import type { PermissionDescriptor } from '../graph/plan.js';
import {
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
} from '../graph/value.js';
import {
  validateActionDecision,
  type ActionDecision,
} from '../runtime/node-lifecycle.js';
import {
  readRunEvents,
} from '../runtime/run-event.js';
import {
  loadRunDefinition,
  type RunStorageBinding,
} from '../runtime/run-definition.js';
import type { WorkspaceAnchor } from '../workspace/provider.js';
import type { AcceptedResultGraph } from '../proof/acceptance.js';
import type { ProofArtifactReference } from '../proof/artifact.js';
import type { CallbackEvent } from './client.js';
import {
  callbackRequestDigest,
  createCallbackGate,
  validateCallbackRequest,
  validateCallbackResponse,
  type CallbackGateDefinition,
  type CallbackRequest,
} from './gate.js';

export type ApprovalSubmission = Extract<
  CallbackEvent,
  { readonly kind: 'callback-submitted' }
>;

export interface ApprovalSubjectInput {
  readonly workspaceAnchor: WorkspaceAnchor | null;
  readonly inputArtifactHashes: Readonly<Record<string, Sha256Digest>>;
  readonly proofScope: JsonObject;
  readonly proofArtifact: ProofArtifactReference;
  readonly proposedOutput: Uint8Array;
  readonly effectivePermissions: readonly PermissionDescriptor[];
}

export interface ApprovalResolutionInput extends ApprovalSubjectInput {
  readonly request: CallbackRequest;
}

export interface ApprovalSubject extends JsonObject {
  readonly workspaceAnchor: WorkspaceAnchor | null;
  readonly inputArtifactHashes: Readonly<Record<string, Sha256Digest>>;
  readonly proofScope: JsonObject;
  readonly proofArtifact: ProofArtifactReference;
  readonly proposedOutputDigest: Sha256Digest;
  readonly effectivePermissions: readonly JsonObject[];
}

export interface ApprovalBinding extends JsonObject {
  readonly requestId: string;
  readonly requestDigest: string;
  readonly planDigest: Sha256Digest;
  readonly graph: AcceptedResultGraph;
  readonly workspaceAnchor: WorkspaceAnchor | null;
  readonly inputArtifactHashes: Readonly<Record<string, Sha256Digest>>;
  readonly proofScope: JsonObject;
  readonly proofArtifact: ProofArtifactReference;
  readonly proposedOutputDigest: Sha256Digest;
  readonly actor: JsonObject;
  readonly responsePath: string;
  readonly decision: ActionDecision;
  readonly effectivePermissions: readonly JsonObject[];
}

export interface ApprovalRecord extends JsonObject {
  readonly schemaVersion: 1;
  readonly binding: ApprovalBinding;
  readonly bindingDigest: Sha256Digest;
}

export interface ApprovalEventPayload extends JsonObject {
  readonly requestId: string;
  readonly record: ApprovalRecord;
}

export type NewApprovalEvent = NewDomainEvent<
  'callback:approval-recorded',
  1,
  ApprovalEventPayload
>;

export class ApprovalSubjectError extends Error {
  readonly code = 'SUBJECT_MISMATCH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ApprovalSubjectError';
  }
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CALLBACK_DIGEST = /^[0-9a-f]{64}$/u;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactFields(value: JsonObject, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length
    && actual.every((field, index) => field === expected[index]);
}

function isDigest(value: JsonValue | undefined): value is Sha256Digest {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function proposedOutputDigest(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function snapshotApprovalSubject(input: ApprovalSubjectInput): ApprovalSubject {
  const subject = cloneFrozenJson({
    workspaceAnchor: input.workspaceAnchor,
    inputArtifactHashes: input.inputArtifactHashes,
    proofScope: input.proofScope,
    proofArtifact: input.proofArtifact,
    proposedOutputDigest: proposedOutputDigest(Uint8Array.from(input.proposedOutput)),
    effectivePermissions: input.effectivePermissions.map((permission) => ({
      name: permission.name,
      scope: permission.scope,
    })),
  } as JsonValue);
  return validateApprovalSubject(subject);
}

export function approvalSubjectDigest(input: ApprovalSubjectInput): Sha256Digest {
  return digestJson(snapshotApprovalSubject(input));
}

export function createApprovalCallbackGate(
  definition: CallbackGateDefinition,
  subject: ApprovalSubjectInput,
): CallbackRequest {
  if (!isObject(definition.input)) {
    throw new TypeError('an approval callback gate needs object input');
  }
  // The request identity is fixed before post, so this digest must be part of
  // the input bytes or changed approval bytes could leave an answered request.
  return createCallbackGate({
    ...definition,
    input: {
      ...definition.input,
      approvalSubjectDigest: approvalSubjectDigest(subject),
    },
  });
}

function requestDigest(request: CallbackRequest): string {
  return callbackRequestDigest({
    gateId: request.gateId,
    gateVersion: request.gateVersion,
    decisionText: request.decisionText,
    responseSchema: request.responseSchema,
    input: request.input,
  });
}

export function validateApprovalSubject(value: unknown): ApprovalSubject {
  const subject = cloneFrozenJson(value as JsonValue);
  if (!isObject(subject)
    || !hasExactFields(subject, [
      'workspaceAnchor',
      'inputArtifactHashes',
      'proofScope',
      'proofArtifact',
      'proposedOutputDigest',
      'effectivePermissions',
    ])
    || (subject.workspaceAnchor !== null && !isObject(subject.workspaceAnchor))
    || !isObject(subject.inputArtifactHashes)
    || Object.values(subject.inputArtifactHashes).some((hash) => !isDigest(hash))
    || !isObject(subject.proofScope)
    || !isObject(subject.proofArtifact)
    || !isDigest(subject.proposedOutputDigest)
    || !Array.isArray(subject.effectivePermissions)
    || subject.effectivePermissions.some((permission) => (
      !isObject(permission)
      || !hasExactFields(permission, ['name', 'scope'])
      || typeof permission.name !== 'string'
      || permission.name.length === 0
    ))) {
    throw new TypeError('invalid approval subject');
  }
  const proofArtifact = validateArtifactReference(subject.proofArtifact);
  if (proofArtifact.purpose !== 'proof-packet') {
    throw new TypeError('approval needs a proof-packet artifact');
  }
  return subject as ApprovalSubject;
}

interface StoredApprovalBindingInput {
  readonly request: CallbackRequest;
  readonly planDigest: Sha256Digest;
  readonly graph: AcceptedResultGraph;
  readonly subject: ApprovalSubject;
  readonly actor: JsonObject;
  readonly responsePath: string;
}

function bindingFromSubject(
  input: StoredApprovalBindingInput,
  decision: ActionDecision,
): ApprovalBinding {
  const digest = requestDigest(input.request);
  if (input.request.digest !== digest
    || input.request.requestId !== `${input.request.gateId}#${input.request.gateVersion}#${digest}`) {
    throw new TypeError('callback request bytes do not match its identity');
  }
  if (input.responsePath.length === 0) {
    throw new TypeError('approval response path must not be empty');
  }
  return cloneFrozenJson({
    requestId: input.request.requestId,
    requestDigest: digest,
    planDigest: input.planDigest,
    graph: input.graph,
    workspaceAnchor: input.subject.workspaceAnchor,
    inputArtifactHashes: input.subject.inputArtifactHashes,
    proofScope: input.subject.proofScope,
    proofArtifact: input.subject.proofArtifact,
    proposedOutputDigest: input.subject.proposedOutputDigest,
    actor: input.actor,
    responsePath: input.responsePath,
    decision,
    effectivePermissions: input.subject.effectivePermissions,
  } as JsonValue) as ApprovalBinding;
}

export function validateApprovalRecord(value: unknown): ApprovalRecord {
  const record = cloneFrozenJson(value as JsonValue);
  if (!isObject(record)) {
    throw new TypeError('invalid approval record');
  }
  const { binding } = record;
  if (!hasExactFields(record, ['schemaVersion', 'binding', 'bindingDigest'])
    || record.schemaVersion !== 1
    || !isObject(binding)
    || !isDigest(record.bindingDigest)) {
    throw new TypeError('invalid approval record');
  }
  if (!hasExactFields(binding, [
    'requestId',
    'requestDigest',
    'planDigest',
    'graph',
    'workspaceAnchor',
    'inputArtifactHashes',
    'proofScope',
    'proofArtifact',
    'proposedOutputDigest',
    'actor',
    'responsePath',
    'decision',
    'effectivePermissions',
  ])
    || typeof binding.requestId !== 'string'
    || binding.requestId.length === 0
    || typeof binding.requestDigest !== 'string'
    || !CALLBACK_DIGEST.test(binding.requestDigest)
    || !isDigest(binding.planDigest)
    || !isObject(binding.graph)
    || !hasExactFields(binding.graph, ['definitionDigest', 'typeVersion'])
    || !isDigest(binding.graph.definitionDigest)
    || typeof binding.graph.typeVersion !== 'number'
    || !Number.isSafeInteger(binding.graph.typeVersion)
    || binding.graph.typeVersion < 1
    || (binding.workspaceAnchor !== null && !isObject(binding.workspaceAnchor))
    || !isObject(binding.inputArtifactHashes)
    || Object.values(binding.inputArtifactHashes).some((hash) => !isDigest(hash))
    || !isObject(binding.proofScope)
    || !isObject(binding.proofArtifact)
    || !isDigest(binding.proposedOutputDigest)
    || !isObject(binding.actor)
    || typeof binding.responsePath !== 'string'
    || binding.responsePath.length === 0
    || !isObject(binding.decision)
    || !Array.isArray(binding.effectivePermissions)
    || binding.effectivePermissions.some((permission) => (
      !isObject(permission)
      || !hasExactFields(permission, ['name', 'scope'])
      || typeof permission.name !== 'string'
      || permission.name.length === 0
    ))
    || record.bindingDigest !== digestJson(binding)) {
    throw new TypeError('invalid approval binding');
  }
  const proofArtifact = validateArtifactReference(binding.proofArtifact);
  if (proofArtifact.purpose !== 'proof-packet') {
    throw new TypeError('approval needs a proof-packet artifact');
  }
  validateActionDecision(binding.decision as ActionDecision);
  return record as ApprovalRecord;
}

function approvalPayloadFor(
  events: readonly DomainEventEnvelope[],
  requestId: string,
): JsonObject | null | undefined {
  let payload: JsonObject | undefined;
  for (const event of events) {
    if (event.type !== 'callback:approval-recorded' || event.version !== 1) continue;
    if (!isObject(event.payload) || event.payload.requestId !== requestId) continue;
    if (payload !== undefined) return null;
    payload = event.payload;
  }
  return payload;
}

export interface PrepareApprovalRecordInput extends StoredApprovalBindingInput {
  readonly submission: ApprovalSubmission;
}

export function prepareApprovalRecord(
  runId: string,
  input: PrepareApprovalRecordInput,
): Readonly<{ readonly record: ApprovalRecord; readonly event: NewApprovalEvent }> {
  if (input.submission.requestId !== input.request.requestId
    || input.submission.requestDigest !== input.request.digest
    || input.submission.routerId !== input.responsePath) {
    throw new TypeError('callback submission does not match the approval subject');
  }
  const structured = validateCallbackResponse(
    input.submission.response,
    input.request.responseSchema,
  );
  if (!structured.ok) throw new TypeError(structured.reason);
  const decision = validateActionDecision(input.submission.response as ActionDecision);
  const binding = bindingFromSubject(input, decision);
  const record = validateApprovalRecord({
    schemaVersion: 1,
    binding,
    bindingDigest: digestJson(binding),
  });
  const event: NewApprovalEvent = {
    eventId: randomUUID(),
    type: 'callback:approval-recorded',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: runId,
    causationId: null,
    payload: { requestId: input.request.requestId, record },
  };
  return Object.freeze({ record, event });
}

function staleApproval(request: CallbackRequest): ActionDecision {
  return cloneFrozenJson({
    kind: 'wait',
    reason: 'approval no longer matches the bytes to apply',
    request: {
      requestId: request.requestId,
      requestDigest: request.digest,
    },
  });
}

function resolveApprovalRecord(
  record: ApprovalRecord,
  request: CallbackRequest,
  subject: ApprovalSubject,
  planDigest: Sha256Digest,
  graph: AcceptedResultGraph,
): ActionDecision {
  try {
    const stored = validateApprovalRecord(record);
    const { binding: storedBinding } = stored;
    const binding = bindingFromSubject({
      request,
      planDigest,
      graph,
      subject,
      actor: storedBinding.actor,
      responsePath: storedBinding.responsePath,
    }, storedBinding.decision);
    if (stored.bindingDigest !== digestJson(binding)) return staleApproval(request);
    return storedBinding.decision;
  } catch {
    return staleApproval(request);
  }
}

export async function resolveApproval(
  storage: RunStorageBinding,
  runId: string,
  current: ApprovalResolutionInput,
): Promise<ActionDecision> {
  const request = validateCallbackRequest(current.request);
  const subject = snapshotApprovalSubject(current);
  const run = await loadRunDefinition(storage, runId);
  const loaded = await readRunEvents(storage, runId);
  const payload = approvalPayloadFor(loaded.events, request.requestId);
  if (payload === undefined
    || payload === null
    || !hasExactFields(payload, ['requestId', 'record'])
    || !isObject(payload.record)) {
    return staleApproval(request);
  }
  return resolveApprovalRecord(
    payload.record as ApprovalRecord,
    request,
    subject,
    run.resolvedPlan.digest,
    {
      definitionDigest: run.resolvedPlan.plan.graph.definitionDigest,
      typeVersion: run.resolvedPlan.plan.graph.typeVersion,
    },
  );
}
