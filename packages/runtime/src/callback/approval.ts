import { randomUUID } from 'node:crypto';
import { validateApprovalRecord, snapshotApprovalSubject, assertApprovalPermissionsAdmitted, validateActionDecision, type ApprovalRecord, type ApprovalSubject, type ApprovalResolutionInput, type PrepareApprovalRecordInput, type NewApprovalEvent, type ActionDecision, type JsonObject, type Sha256Digest, type AcceptedResultGraph, cloneFrozenJson, digestJson } from '@obversa/api';
import { bindingFromSubject, hasExactFields, isObject } from '@obversa/api/approval-support';
import type { DomainEventEnvelope } from '../events/envelope.js';
import { readRunEvents } from '../runtime/run-event.js';
import { loadRunDefinition, type RunStorageBinding } from '../runtime/run-definition.js';
import { validateCallbackRequest, validateCallbackResponse, type CallbackRequest } from './gate.js';
export { ApprovalSubjectError, approvalSubjectDigest, createApprovalCallbackGate, validateApprovalRecord, validateApprovalSubject, snapshotApprovalSubject, assertApprovalPermissionsAdmitted, type ApprovalSubmission, type ApprovalSubjectInput, type ApprovalResolutionInput, type ApprovalSubject, type ApprovalBinding, type ApprovalRecord, type ApprovalEventPayload, type NewApprovalEvent, type PrepareApprovalRecordInput } from '@obversa/api';

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
  try {
    assertApprovalPermissionsAdmitted(subject, run.resolvedPlan.plan.permissions.admitted);
  } catch {
    return staleApproval(request);
  }
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
