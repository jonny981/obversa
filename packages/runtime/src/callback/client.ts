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
import type { JsonObject } from '../graph/value.js';

import { validateCallbackEvent, type CallbackEvent, type CallbackClient, type ClaimRefused, type ClaimOk, type SubmitRefused, type SubmitOk, type SubmitResult, type ReleaseRefused, type ReleaseOk, type Responder } from '@obversa/api';
export {
  type CallbackEvent,
  validateCallbackEvent,
  type ClaimOk,
  type ClaimRefused,
  type ClaimResult,
  type SubmitOk,
  type SubmitRefused,
  type SubmitResult,
  type ReleaseOk,
  type ReleaseRefused,
  type ReleaseResult,
  type CallbackClient,
  type Responder,
} from '@obversa/api';

interface RequestState {
  readonly request: CallbackRequest;
  status: 'pending' | 'claimed' | 'answered' | 'superseded';
  routerId: string | null;
  claimToken: string | null;
}

/** Fold one event into the request states. The client is its log. */
function applyEvent(
  states: Map<string, RequestState>,
  event: CallbackEvent,
): void {
  switch (event.kind) {
    case 'callback-requested': {
      const existing = states.get(event.request.requestId);
      // A superseded question posted again is live again: the newest post is
      // always the question a router can answer.
      if (existing !== undefined && existing.status !== 'superseded') {
        throw new TypeError('callback request is recorded more than once');
      }
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
      const current = states.get(storedRequest.requestId);
      if (current === undefined || current.status === 'superseded') {
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
