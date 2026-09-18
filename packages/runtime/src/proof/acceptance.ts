import { randomUUID } from 'node:crypto';

import {
  validateAcceptedResultRecord,
  type AcceptedResultBindingInput,
  type AcceptedResultRecord,
  type AcceptedResultResolution,
  type CreateAcceptedResultRecordInput,
  type NewAcceptedResultEvent,
} from '@obversa/api';
import { acceptedResultSupport } from '@obversa/api/accepted-result-support';
import type { DomainEventEnvelope } from '../events/envelope.js';
import { digestJson, type JsonObject, type Sha256Digest } from '../graph/value.js';
import { appendRunEvent, readRunEvents } from '../runtime/run-event.js';
import { loadRunDefinition, type RunStorageBinding } from '../runtime/run-definition.js';
import { StorageError } from '../storage/error.js';

export {
  acceptedResultMatches,
  validateAcceptedResultRecord,
  type AcceptedResultGraph,
  type AcceptedResultBindingInput,
  type AcceptedResultBinding,
  type AcceptedResultRecord,
  type AcceptedResultEventPayload,
  type NewAcceptedResultEvent,
  type CreateAcceptedResultRecordInput,
  type AcceptedResultResolution,
} from '@obversa/api';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const { isObject, hasExactFields, bindingFrom, acceptedResultMatchesBinding } = acceptedResultSupport;

function acceptedPayloadAt(
  events: readonly DomainEventEnvelope[],
  position: string,
): JsonObject | null | undefined {
  let payload: JsonObject | undefined;
  for (const event of events) {
    if (event.type !== 'proof:result-accepted' || event.version !== 1) continue;
    if (!isObject(event.payload) || event.payload.position !== position) continue;
    if (payload !== undefined) return null;
    payload = event.payload;
  }
  return payload;
}

function matchesStoredCompletion(
  events: readonly DomainEventEnvelope[],
  position: string,
  nodeIds: ReadonlySet<string>,
  resultDigest: Sha256Digest,
): boolean {
  const matching = events.filter((event) => (
    event.type === 'graph:node-dispatched'
      && isObject(event.payload)
      && event.payload.position === position
  ));
  if (matching.length !== 1) return false;
  const [event] = matching;
  const payload = event?.payload;
  if (!(event?.version === 1
    && isObject(payload)
    && hasExactFields(payload, ['nodeId', 'position'])
    && typeof payload.nodeId === 'string'
    && nodeIds.has(payload.nodeId))) return false;
  const terminals = events.filter((candidate) => (
    (candidate.type === 'graph:node-completed' || candidate.type === 'graph:node-failed')
      && isObject(candidate.payload)
      && candidate.payload.position === position
  ));
  if (terminals.length !== 1) return false;
  const [completed] = terminals;
  const result = completed?.payload;
  return completed?.type === 'graph:node-completed'
    && completed.version === 1
    && completed.revision > event.revision
    && isObject(result)
    && hasExactFields(result, ['nodeId', 'position', 'result'])
    && result.nodeId === payload.nodeId
    && result.result !== undefined
    && digestJson(result.result) === resultDigest;
}

export async function createAcceptedResultRecord(
  storage: RunStorageBinding,
  runId: string,
  position: string,
  input: CreateAcceptedResultRecordInput,
): Promise<AcceptedResultRecord> {
  if (typeof position !== 'string'
    || position.length === 0
    || position !== position.trim()
    || CONTROL_CHARACTER.test(position)) {
    throw new TypeError(
      'accepted-result position must be a non-empty trimmed string without control characters',
    );
  }
  const binding = bindingFrom(input);
  const record = validateAcceptedResultRecord({
    schemaVersion: 1,
    result: input.result,
    resultDigest: digestJson(input.result),
    binding,
    bindingDigest: digestJson(binding),
  });
  const stored = await loadRunDefinition(storage, runId);
  const storedGraph = stored.resolvedPlan.plan.graph;
  if (binding.graph.definitionDigest !== storedGraph.definitionDigest
    || binding.graph.typeVersion !== storedGraph.typeVersion) {
    throw new StorageError(
      'INVALID_STORED_VALUE',
      'The accepted result graph does not match the run plan.',
      { position },
    );
  }
  const nodeIds = new Set(stored.resolvedPlan.plan.nodes.map((node) => node.id));
  const event: NewAcceptedResultEvent = {
    eventId: randomUUID(),
    type: 'proof:result-accepted',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: runId,
    causationId: null,
    payload: { position, record },
  };
  await appendRunEvent(storage, runId, event, (events) => {
    if (!matchesStoredCompletion(events, position, nodeIds, record.resultDigest)) {
      throw new StorageError(
        'INVALID_STORED_VALUE',
        `Accepted result position "${position}" needs one stored dispatch and a matching completed result.`,
        { position },
      );
    }
    const payload = acceptedPayloadAt(events, position);
    if (payload === undefined) return 'append';
    try {
      if (payload !== null
        && hasExactFields(payload, ['position', 'record'])
        && digestJson(validateAcceptedResultRecord(payload.record)) === digestJson(record)) {
        return 'already-stored';
      }
    } catch {
      // A corrupt record at this position still owns the key.
    }
    throw new StorageError(
      'REVISION_CONFLICT',
      `A different accepted result is already stored at position "${position}".`,
      { position },
    );
  });
  return record;
}

export async function resolveAcceptedResult(
  storage: RunStorageBinding,
  runId: string,
  position: string,
  current: AcceptedResultBindingInput,
): Promise<AcceptedResultResolution> {
  const currentBinding = bindingFrom(current);
  const stored = await loadRunDefinition(storage, runId);
  const loaded = await readRunEvents(storage, runId);
  const storedGraph = stored.resolvedPlan.plan.graph;
  const nodeIds = new Set(stored.resolvedPlan.plan.nodes.map((node) => node.id));
  const payload = acceptedPayloadAt(loaded.events, position);
  if (currentBinding.graph.definitionDigest === storedGraph.definitionDigest
    && currentBinding.graph.typeVersion === storedGraph.typeVersion
    && payload !== undefined
    && payload !== null
    && hasExactFields(payload, ['position', 'record'])
    && acceptedResultMatchesBinding(
      payload.record as AcceptedResultRecord,
      currentBinding,
    )
    && matchesStoredCompletion(
      loaded.events,
      position,
      nodeIds,
      (payload.record as AcceptedResultRecord).resultDigest,
    )) {
    return Object.freeze({
      kind: 'accepted',
      record: validateAcceptedResultRecord(payload.record),
    });
  }
  return Object.freeze({
    kind: 'wait',
    reason: 'accepted result no longer matches the bytes under review',
  });
}
