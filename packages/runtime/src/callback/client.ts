/**
 * The callback client (roadmap D7): the router-facing side of the Callback
 * Gate. Pending requests are observable without starting any effect; a
 * router claims a request through atomic assignment — two racing routers,
 * exactly one winner — submits a structured response validated against
 * the request's response schema and its digest, and can release or be
 * reassigned.
 *
 * The client is event-sourced: every mutation is recorded as an event, and
 * the request states are a fold of the log — `replayCallbackClient`
 * rebuilds a full client from any history, so no state is hidden outside
 * the events. A newer request from the same gate supersedes the older
 * unanswered ones with a recorded event, and a submit whose digest does
 * not match the posted request is refused as stale.
 *
 * The direct-router helper takes a plain responder function and drives
 * the whole loop. It imports no Surfacer, agent, or service code — it is
 * the smallest possible router, and the proof that the contract is
 * replaceable.
 */

import { randomUUID } from 'node:crypto';

import { validateCallbackRequest, validateCallbackResponse } from './gate.js';
import type { CallbackRequest } from './gate.js';
import { cloneFrozenJson, type JsonObject, type JsonValue } from '../graph/value.js';

export type CallbackEvent =
  | { readonly kind: 'callback-requested'; readonly request: CallbackRequest }
  | { readonly kind: 'callback-claimed'; readonly requestId: string; readonly routerId: string; readonly claimToken: string }
  | { readonly kind: 'callback-released'; readonly requestId: string; readonly routerId: string }
  | { readonly kind: 'callback-submitted'; readonly requestId: string; readonly requestDigest: string; readonly routerId: string; readonly response: JsonValue }
  | { readonly kind: 'callback-rejected'; readonly requestId: string; readonly routerId: string; readonly reason: string }
  | { readonly kind: 'callback-superseded'; readonly requestId: string; readonly supersededBy: string };

interface RequestState {
  readonly request: CallbackRequest;
  status: 'pending' | 'claimed' | 'answered' | 'superseded';
  routerId: string | null;
  claimToken: string | null;
}

const CALLBACK_DIGEST = /^[0-9a-f]{64}$/u;

function callbackObject(value: unknown): JsonObject {
  const stored = cloneFrozenJson(value as JsonValue);
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new TypeError('a stored callback event must be an object');
  }
  return stored as JsonObject;
}

function exactFields(value: JsonObject, fields: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length
    || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError('a stored callback event has missing or unknown fields');
  }
}

function callbackText(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`a stored callback event needs ${field}`);
  }
  return value;
}

/** Validate one callback event before it can affect replayed state. */
export function validateCallbackEvent(value: unknown): CallbackEvent {
  const event = callbackObject(value);
  switch (event.kind) {
    case 'callback-requested':
      exactFields(event, ['kind', 'request']);
      validateCallbackRequest(event.request);
      break;
    case 'callback-claimed':
      exactFields(event, ['kind', 'requestId', 'routerId', 'claimToken']);
      callbackText(event.requestId, 'requestId');
      callbackText(event.routerId, 'routerId');
      callbackText(event.claimToken, 'claimToken');
      break;
    case 'callback-released':
      exactFields(event, ['kind', 'requestId', 'routerId']);
      callbackText(event.requestId, 'requestId');
      callbackText(event.routerId, 'routerId');
      break;
    case 'callback-submitted':
      if (typeof event.requestDigest !== 'string' || !CALLBACK_DIGEST.test(event.requestDigest)) {
        throw new TypeError('a stored callback submission has an invalid requestDigest');
      }
      exactFields(event, ['kind', 'requestId', 'requestDigest', 'routerId', 'response']);
      callbackText(event.requestId, 'requestId');
      callbackText(event.routerId, 'routerId');
      break;
    case 'callback-rejected':
      exactFields(event, ['kind', 'requestId', 'routerId', 'reason']);
      callbackText(event.requestId, 'requestId');
      callbackText(event.routerId, 'routerId');
      callbackText(event.reason, 'reason');
      break;
    case 'callback-superseded':
      exactFields(event, ['kind', 'requestId', 'supersededBy']);
      callbackText(event.requestId, 'requestId');
      callbackText(event.supersededBy, 'supersededBy');
      break;
    default:
      throw new TypeError('a stored callback event has an unknown kind');
  }
  return event as unknown as CallbackEvent;
}

export interface ClaimOk {
  readonly ok: true;
  readonly claimToken: string;
}

export interface ClaimRefused {
  readonly ok: false;
  readonly kind: 'missing' | 'claimed' | 'answered' | 'superseded';
  readonly routerId: string | null;
}

export type ClaimResult = ClaimOk | ClaimRefused;

export interface SubmitOk {
  readonly ok: true;
  readonly response: JsonValue;
}

export interface SubmitRefused {
  readonly ok: false;
  readonly kind: 'missing' | 'not-claimed' | 'not-owner' | 'stale' | 'invalid';
  readonly reason: string;
}

export type SubmitResult = SubmitOk | SubmitRefused;

export interface ReleaseOk {
  readonly ok: true;
}

export interface ReleaseRefused {
  readonly ok: false;
  readonly kind: 'missing' | 'not-owner';
}

export type ReleaseResult = ReleaseOk | ReleaseRefused;

export interface CallbackClient {
  /** Record a gate's request and make it pending. Observation only. */
  post(request: CallbackRequest): void;
  /** The pending requests, without starting any effect. */
  listPending(): readonly CallbackRequest[];
  /** Atomically assign a request to one router. */
  claim(requestId: string, routerId: string): ClaimResult;
  /**
   * Validate and record a structured response. The assignment binds the
   * response schema and the request digest: a submit whose digest does
   * not match the posted request is stale.
   */
  submit(
    requestId: string,
    claimToken: string,
    routerId: string,
    requestDigest: string,
    response: JsonValue,
  ): SubmitResult;
  /** Give a claimed request back so another router can take it. */
  release(requestId: string, claimToken: string): ReleaseResult;
  /** Mark a request superseded by a newer one from the same gate. */
  supersede(requestId: string, supersededBy: string): void;
  /** The full history, optionally for one request. */
  history(requestId?: string): readonly CallbackEvent[];
}

/** Fold one event into the request states. The client is its log. */
function applyEvent(
  states: Map<string, RequestState>,
  event: CallbackEvent,
): void {
  switch (event.kind) {
    case 'callback-requested': {
      const existing = states.get(event.request.requestId);
      if (existing !== undefined) throw new TypeError('callback request is recorded more than once');
      states.set(event.request.requestId, {
        request: event.request,
        status: 'pending',
        routerId: null,
        claimToken: null,
      });
      return;
    }
    case 'callback-claimed': {
      const state = states.get(event.requestId);
      if (state === undefined || state.status !== 'pending') {
        throw new TypeError('callback claim has no pending request');
      }
      state.status = 'claimed';
      state.routerId = event.routerId;
      state.claimToken = event.claimToken;
      return;
    }
    case 'callback-released': {
      const state = states.get(event.requestId);
      if (state === undefined || state.status !== 'claimed' || state.routerId !== event.routerId) {
        throw new TypeError('callback release has no matching claimed request');
      }
      state.status = 'pending';
      state.routerId = null;
      state.claimToken = null;
      return;
    }
    case 'callback-submitted': {
      const state = states.get(event.requestId);
      if (state === undefined || state.status !== 'claimed') {
        throw new TypeError('callback submission has no claimed request');
      }
      if (state.routerId !== event.routerId || state.request.digest !== event.requestDigest) {
        throw new TypeError('callback submission does not match its claimed request');
      }
      if (!validateCallbackResponse(event.response, state.request.responseSchema).ok) {
        throw new TypeError('callback submission does not match its response schema');
      }
      state.status = 'answered';
      state.routerId = null;
      state.claimToken = null;
      return;
    }
    case 'callback-superseded': {
      const state = states.get(event.requestId);
      if (state === undefined || state.status === 'answered' || state.status === 'superseded') {
        throw new TypeError('callback supersession has no live request');
      }
      state.status = 'superseded';
      state.routerId = null;
      state.claimToken = null;
      return;
    }
    case 'callback-rejected': {
      const state = states.get(event.requestId);
      if (state === undefined || state.status !== 'claimed' || state.routerId !== event.routerId) {
        throw new TypeError('callback rejection has no matching claimed request');
      }
      return;
    }
  }
}

/** Rebuild a complete client from a callback history. A pure fold. */
export function replayCallbackClient(events: readonly CallbackEvent[]): CallbackClient {
  return createCallbackClient(events);
}

/**
 * An event-sourced callback client. Seeding from a history replays it
 * through the same fold the live client applies, so the log is the only
 * state there is.
 */
export function createCallbackClient(seed?: readonly CallbackEvent[]): CallbackClient {
  const states = new Map<string, RequestState>();
  const log: CallbackEvent[] = [];

  const record = (event: CallbackEvent): void => {
    const stored = validateCallbackEvent(event);
    log.push(stored);
    applyEvent(states, stored);
  };
  for (const event of seed ?? []) record(event);

  const client: CallbackClient = {
    post(request) {
      const storedRequest = validateCallbackRequest(request);
      // A newer request from the same gate supersedes the older,
      // unanswered ones with a recorded event, so a stale question can
      // never be answered and the history can rebuild the state.
      for (const [id, state] of states) {
        if (state.request.gateId === storedRequest.gateId
          && state.request.requestId !== storedRequest.requestId
          && state.status !== 'answered'
          && state.status !== 'superseded') {
          record({
            kind: 'callback-superseded',
            requestId: id,
            supersededBy: storedRequest.requestId,
          });
        }
      }
      if (!states.has(storedRequest.requestId)) {
        record({ kind: 'callback-requested', request: storedRequest });
      }
    },
    listPending() {
      return [...states.values()]
        .filter((state) => state.status === 'pending')
        .map((state) => state.request);
    },
    claim(requestId, routerId) {
      const state = states.get(requestId);
      if (state === undefined) {
        const missing: ClaimRefused = { ok: false, kind: 'missing', routerId: null };
        return missing;
      }
      // Atomic assignment: the check and the write happen in one
      // synchronous section, so of two racing claims exactly one wins.
      if (state.status !== 'pending') {
        const refusal: ClaimRefused = {
          ok: false,
          kind: state.status === 'claimed' ? 'claimed'
            : state.status === 'answered' ? 'answered' : 'superseded',
          routerId: state.routerId,
        };
        return refusal;
      }
      const claimToken = randomUUID();
      record({ kind: 'callback-claimed', requestId, routerId, claimToken });
      const won: ClaimOk = { ok: true, claimToken };
      return won;
    },
    submit(requestId, claimToken, routerId, requestDigest, response) {
      const state = states.get(requestId);
      if (state === undefined) {
        const missing: SubmitRefused = {
          ok: false, kind: 'missing', reason: 'the request does not exist',
        };
        return missing;
      }
      if (state.status !== 'claimed') {
        const notClaimed: SubmitRefused = {
          ok: false,
          kind: state.status === 'superseded' ? 'stale' : 'not-claimed',
          reason: `the request is ${state.status}`,
        };
        return notClaimed;
      }
      if (state.claimToken !== claimToken || state.routerId !== routerId) {
        const notOwner: SubmitRefused = {
          ok: false,
          kind: 'not-owner',
          reason: 'the claim belongs to another router',
        };
        return notOwner;
      }
      if (requestDigest !== state.request.digest) {
        const stale: SubmitRefused = {
          ok: false,
          kind: 'stale',
          reason: 'the submit digest does not match the posted request',
        };
        return stale;
      }
      const validated = validateCallbackResponse(response, state.request.responseSchema);
      if (!validated.ok) {
        record({ kind: 'callback-rejected', requestId, routerId, reason: validated.reason });
        const invalid: SubmitRefused = { ok: false, kind: 'invalid', reason: validated.reason };
        return invalid;
      }
      record({ kind: 'callback-submitted', requestId, requestDigest, routerId, response });
      const accepted: SubmitOk = { ok: true, response };
      return accepted;
    },
    release(requestId, claimToken) {
      const state = states.get(requestId);
      if (state === undefined) {
        const missing: ReleaseRefused = { ok: false, kind: 'missing' };
        return missing;
      }
      if (state.status !== 'claimed' || state.claimToken !== claimToken) {
        const notOwner: ReleaseRefused = { ok: false, kind: 'not-owner' };
        return notOwner;
      }
      record({ kind: 'callback-released', requestId, routerId: state.routerId! });
      const released: ReleaseOk = { ok: true };
      return released;
    },
    supersede(requestId, supersededBy) {
      const state = states.get(requestId);
      if (state === undefined || state.status === 'answered' || state.status === 'superseded') {
        return;
      }
      record({ kind: 'callback-superseded', requestId, supersededBy });
    },
    history(requestId) {
      if (requestId === undefined) return Object.freeze([...log]);
      return Object.freeze(log.filter((event) => event.kind === 'callback-requested'
        ? event.request.requestId === requestId
        : 'requestId' in event && event.requestId === requestId));
    },
  };
  return Object.freeze(client);
}

export type Responder = (request: CallbackRequest) => Promise<JsonObject> | JsonObject;

/**
 * The smallest router: claim the pending request for one gate, ask the
 * responder function, and submit its structured answer with the digest the
 * request carries. Imports nothing beyond the contract — no Surfacer,
 * agent, or service code.
 */
export async function directRouter(
  client: CallbackClient,
  request: CallbackRequest,
  routerId: string,
  responder: Responder,
): Promise<SubmitResult> {
  const claim = client.claim(request.requestId, routerId);
  if (!claim.ok) {
    return {
      ok: false,
      kind: claim.kind === 'missing' ? 'missing' : 'not-claimed',
      reason: `the request could not be claimed: ${claim.kind}`,
    };
  }
  let response: JsonObject;
  try {
    response = await responder(request);
  } catch (error) {
    client.release(request.requestId, claim.claimToken);
    throw error;
  }
  const submitted = client.submit(
    request.requestId,
    claim.claimToken,
    routerId,
    request.digest,
    response,
  );
  if (!submitted.ok && submitted.kind === 'invalid') {
    client.release(request.requestId, claim.claimToken);
  }
  return submitted;
}
