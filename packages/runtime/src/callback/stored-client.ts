import { randomUUID } from 'node:crypto';

import {
  validateNewDomainEvent,
  type NewDomainEvent,
} from '../events/envelope.js';
import type { DomainEventBatch } from '../events/store.js';
import {
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type JsonValue,
} from '../graph/value.js';
import {
  loadRunDefinition,
  type RunStorageBinding,
} from '../runtime/run-definition.js';
import {
  validateActionDecision,
  type ActionDecision,
} from '../runtime/node-lifecycle.js';
import { StorageError } from '../storage/error.js';
import {
  ApprovalSubjectError,
  prepareApprovalRecord,
  snapshotApprovalSubject,
  validateApprovalRecord,
  validateApprovalSubject,
  type ApprovalRecord,
  type ApprovalSubject,
  type ApprovalSubjectInput,
} from './approval.js';
import {
  createCallbackClient,
  validateCallbackEvent,
  type CallbackClient,
  type CallbackEvent,
  type ClaimResult,
  type ReleaseResult,
  type SubmitResult,
} from './client.js';
import {
  validateCallbackRequest,
  type CallbackRequest,
} from './gate.js';

const CALLBACK_EVENT_TYPE = 'callback:history-recorded';

type CallbackHistoryPayload =
  | Readonly<{ readonly event: JsonObject }>
  | Readonly<{
      readonly event: JsonObject;
      readonly approvalSubject: ApprovalSubject;
    }>;

export type NewCallbackHistoryEvent = NewDomainEvent<
  typeof CALLBACK_EVENT_TYPE,
  1,
  CallbackHistoryPayload
>;

export interface StoredCallbackClient {
  post(request: CallbackRequest, approvalSubject?: ApprovalSubjectInput): Promise<void>;
  listPending(): Promise<readonly CallbackRequest[]>;
  claim(requestId: string, routerId: string): Promise<ClaimResult>;
  submit(
    requestId: string,
    claimToken: string,
    routerId: string,
    requestDigest: string,
    response: JsonValue,
    actor?: JsonObject,
  ): Promise<SubmitResult>;
  release(requestId: string, claimToken: string): Promise<ReleaseResult>;
  supersede(requestId: string, supersededBy: string): Promise<void>;
  history(requestId?: string): Promise<readonly CallbackEvent[]>;
}

interface StoredState {
  readonly revision: number;
  readonly events: readonly CallbackEvent[];
  readonly client: CallbackClient;
  readonly approvalSubjects: ReadonlyMap<string, ApprovalSubject>;
  readonly approvalRecords: ReadonlyMap<string, ApprovalRecord | null>;
}

function historyEvent(
  runId: string,
  event: CallbackEvent,
  approvalSubject?: ApprovalSubject,
): NewCallbackHistoryEvent {
  const payload = approvalSubject === undefined
    ? { event: cloneFrozenJson(event as unknown as JsonValue) }
    : {
        event: cloneFrozenJson(event as unknown as JsonValue),
        approvalSubject,
      };
  return validateNewDomainEvent({
    eventId: randomUUID(),
    type: CALLBACK_EVENT_TYPE,
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: runId,
    causationId: null,
    payload,
  }) as NewCallbackHistoryEvent;
}

function object(value: unknown, message: string): JsonObject {
  const stored = cloneFrozenJson(value as JsonValue);
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new TypeError(message);
  }
  return stored as JsonObject;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestApprovalSubjectDigest(request: CallbackRequest): string | undefined {
  if (!isObject(request.input)) return undefined;
  const value = request.input.approvalSubjectDigest;
  return typeof value === 'string' ? value : undefined;
}

function assertSubjectMatchesRequest(
  request: CallbackRequest,
  subject: ApprovalSubject,
): void {
  if (requestApprovalSubjectDigest(request) !== digestJson(subject)) {
    throw new ApprovalSubjectError(
      'The approval subject does not match the digest in the callback request input.',
    );
  }
}

/** Open an awaited callback writer over the run's own event stream. */
export async function createStoredCallbackClient(
  storage: RunStorageBinding,
  runId: string,
): Promise<Readonly<StoredCallbackClient>> {
  const run = await loadRunDefinition(storage, runId);
  const stream = { namespace: storage.record.namespace, streamId: runId };

  const read = async (): Promise<StoredState> => {
    let revision = 0;
    const events: CallbackEvent[] = [];
    const approvalSubjects = new Map<string, ApprovalSubject>();
    const approvalRecords = new Map<string, ApprovalRecord | null>();
    for await (const envelope of storage.eventStore.read(stream)) {
      revision = envelope.revision;
      if (envelope.type === 'callback:approval-recorded') {
        const payload = envelope.payload;
        if (envelope.version !== 1
          || !isObject(payload)
          || typeof payload.requestId !== 'string') {
          throw new StorageError(
            'INVALID_STORED_VALUE',
            'Stored callback approval event is invalid.',
            { eventId: envelope.eventId },
          );
        }
        if (approvalRecords.has(payload.requestId)) {
          approvalRecords.set(payload.requestId, null);
          continue;
        }
        try {
          if (Object.keys(payload).sort().join(',') !== 'record,requestId') {
            throw new TypeError('approval event has unknown fields');
          }
          const record = validateApprovalRecord(payload.record);
          approvalRecords.set(
            payload.requestId,
            record.binding.requestId === payload.requestId ? record : null,
          );
        } catch {
          approvalRecords.set(payload.requestId, null);
        }
        continue;
      }
      if (envelope.type !== CALLBACK_EVENT_TYPE) continue;
      const payload = envelope.payload;
      const fields = isObject(payload)
        ? Object.keys(payload).sort()
        : [];
      if (envelope.version !== 1
        || !isObject(payload)
        || (fields.length !== 1 && fields.length !== 2)
        || (fields.length === 1 && fields[0] !== 'event')
        || (fields.length === 2
          && (fields[0] !== 'approvalSubject' || fields[1] !== 'event'))) {
        throw new StorageError(
          'INVALID_STORED_VALUE',
          'Stored callback history event is invalid.',
          { eventId: envelope.eventId },
        );
      }
      const event = validateCallbackEvent(payload.event);
      if (Object.hasOwn(payload, 'approvalSubject')) {
        if (event.kind !== 'callback-requested') {
          throw new StorageError(
            'INVALID_STORED_VALUE',
            'Stored approval subject is not attached to a callback request.',
            { eventId: envelope.eventId },
          );
        }
        const subject = validateApprovalSubject(payload.approvalSubject);
        try {
          assertSubjectMatchesRequest(event.request, subject);
        } catch (error) {
          throw new StorageError(
            'INVALID_STORED_VALUE',
            error instanceof Error ? error.message : String(error),
            { eventId: envelope.eventId },
          );
        }
        if (approvalSubjects.has(event.request.requestId)) {
          throw new StorageError(
            'INVALID_STORED_VALUE',
            'Stored callback request has more than one approval subject.',
            { requestId: event.request.requestId },
          );
        }
        approvalSubjects.set(event.request.requestId, subject);
      }
      events.push(event);
    }
    return Object.freeze({
      revision,
      events: Object.freeze(events),
      client: createCallbackClient(events),
      approvalSubjects,
      approvalRecords,
    });
  };

  interface Change<Result> {
    readonly result: Result;
    readonly approvalSubject?: ApprovalSubject;
    readonly additionalEvents?: readonly NewDomainEvent[];
  }

  const change = async <Result>(
    apply: (state: StoredState) => Change<Result>,
  ): Promise<Result> => {
    for (;;) {
      const state = await read();
      const mutation = apply(state);
      const added = state.client.history().slice(state.events.length);
      const batch = [
        ...added.map((event) => historyEvent(
          runId,
          event,
          event.kind === 'callback-requested' ? mutation.approvalSubject : undefined,
        )),
        ...(mutation.additionalEvents ?? []),
      ];
      const first = batch[0];
      if (first === undefined) return mutation.result;
      try {
        await storage.eventStore.append(
          stream,
          state.revision,
          [first, ...batch.slice(1)],
        );
        return mutation.result;
      } catch (error) {
        if (error instanceof StorageError && error.code === 'REVISION_CONFLICT') continue;
        throw error;
      }
    }
  };

  const client: StoredCallbackClient = {
    post: async (request, approvalSubjectInput) => {
      const storedRequest = validateCallbackRequest(request);
      const approvalSubject = approvalSubjectInput === undefined
        ? undefined
        : snapshotApprovalSubject(approvalSubjectInput);
      if (approvalSubject === undefined
        && requestApprovalSubjectDigest(storedRequest) !== undefined) {
        throw new ApprovalSubjectError(
          'The approval subject named by the callback request input is missing.',
        );
      }
      if (approvalSubject !== undefined) {
        assertSubjectMatchesRequest(storedRequest, approvalSubject);
      }
      await change((state) => {
        const existing = state.client.history(storedRequest.requestId).some((event) => (
          event.kind === 'callback-requested'
        ));
        const storedSubject = state.approvalSubjects.get(storedRequest.requestId);
        if (existing && approvalSubject !== undefined) {
          if (storedSubject === undefined
            || digestJson(storedSubject) !== digestJson(approvalSubject)) {
            throw new StorageError(
              'REVISION_CONFLICT',
              `A different callback request is already stored for "${storedRequest.requestId}".`,
              { requestId: storedRequest.requestId },
            );
          }
        }
        state.client.post(storedRequest);
        return { result: undefined, approvalSubject };
      });
    },
    listPending: async () => (await read()).client.listPending(),
    claim: async (requestId, routerId) => change((state) => ({
      result: state.client.claim(requestId, routerId),
    })),
    submit: async (requestId, claimToken, routerId, requestDigest, response, actor) => {
      const storedResponse = cloneFrozenJson(response);
      const storedActor = actor === undefined
        ? undefined
        : object(actor, 'an approval submit actor must be an object');
      return change((state) => {
        const subject = state.approvalSubjects.get(requestId);
        if (subject !== undefined && storedActor === undefined) {
          return {
            result: {
              ok: false,
              kind: 'invalid',
              reason: 'a subject-backed callback submit needs an actor',
            } satisfies SubmitResult,
          };
        }
        if (subject !== undefined) {
          try {
            validateActionDecision(storedResponse as ActionDecision);
          } catch (error) {
            return {
              result: {
                ok: false,
                kind: 'invalid',
                reason: error instanceof Error ? error.message : String(error),
              } satisfies SubmitResult,
            };
          }
        }
        const history = state.client.history(requestId);
        const requested = history.find((event) => event.kind === 'callback-requested');
        const existingSubmission = [...history].reverse().find((event) => (
          event.kind === 'callback-submitted'
        ));
        if (subject !== undefined
          && storedActor !== undefined
          && requested?.kind === 'callback-requested'
          && existingSubmission?.kind === 'callback-submitted') {
          const claim = [...history].reverse().find((event) => (
            event.kind === 'callback-claimed'
          ));
          if (claim?.kind !== 'callback-claimed'
            || claim.claimToken !== claimToken
            || claim.routerId !== routerId) {
            return {
              result: {
                ok: false,
                kind: 'not-owner',
                reason: 'the claim belongs to another router',
              } satisfies SubmitResult,
            };
          }
          if (requestDigest !== requested.request.digest) {
            return {
              result: {
                ok: false,
                kind: 'stale',
                reason: 'the submit digest does not match the posted request',
              } satisfies SubmitResult,
            };
          }
          const prepared = prepareApprovalRecord(runId, {
            request: requested.request,
            planDigest: run.resolvedPlan.digest,
            graph: {
              definitionDigest: run.resolvedPlan.plan.graph.definitionDigest,
              typeVersion: run.resolvedPlan.plan.graph.typeVersion,
            },
            subject,
            actor: storedActor,
            responsePath: routerId,
            submission: {
              kind: 'callback-submitted',
              requestId,
              requestDigest,
              routerId,
              response: storedResponse,
            },
          });
          const existingApproval = state.approvalRecords.get(requestId);
          if (existingApproval === undefined) {
            throw new StorageError(
              'INVALID_STORED_VALUE',
              'Stored callback submission has no matching approval.',
              { requestId },
            );
          }
          if (digestJson(existingApproval) === digestJson(prepared.record)) {
            return { result: { ok: true, response: storedResponse } };
          }
          throw new StorageError(
            'REVISION_CONFLICT',
            `A different approval is already stored for request "${requestId}".`,
            { requestId },
          );
        }
        if (subject !== undefined && state.approvalRecords.has(requestId)) {
          throw new StorageError(
            'INVALID_STORED_VALUE',
            'Stored callback approval has no matching submission.',
            { requestId },
          );
        }
        const result = state.client.submit(
          requestId,
          claimToken,
          routerId,
          requestDigest,
          storedResponse,
        );
        if (!result.ok || subject === undefined || storedActor === undefined) {
          return { result };
        }
        const submission = [...state.client.history(requestId)].reverse().find((event) => (
          event.kind === 'callback-submitted'
        ));
        const posted = state.client.history(requestId).find((event) => (
          event.kind === 'callback-requested'
        ));
        if (submission?.kind !== 'callback-submitted'
          || posted?.kind !== 'callback-requested') {
          throw new StorageError(
            'INVALID_STORED_VALUE',
            'Callback approval is missing its request or submission.',
            { requestId },
          );
        }
        const prepared = prepareApprovalRecord(runId, {
          request: posted.request,
          planDigest: run.resolvedPlan.digest,
          graph: {
            definitionDigest: run.resolvedPlan.plan.graph.definitionDigest,
            typeVersion: run.resolvedPlan.plan.graph.typeVersion,
          },
          subject,
          actor: storedActor,
          responsePath: routerId,
          submission,
        });
        return { result, additionalEvents: [prepared.event] };
      });
    },
    release: async (requestId, claimToken) => change((state) => ({
      result: state.client.release(requestId, claimToken),
    })),
    supersede: async (requestId, supersededBy) => {
      await change((state) => {
        state.client.supersede(requestId, supersededBy);
        return { result: undefined };
      });
    },
    history: async (requestId) => (await read()).client.history(requestId),
  };
  return Object.freeze(client);
}
