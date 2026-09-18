import { validateCallbackRequest, type CallbackRequest } from './gate.js';
import { cloneFrozenJson, type JsonObject, type JsonValue } from '../json.js';

export type CallbackEvent =
  | { readonly kind: 'callback-requested'; readonly request: CallbackRequest }
  | { readonly kind: 'callback-claimed'; readonly requestId: string; readonly routerId: string; readonly claimToken: string }
  | { readonly kind: 'callback-released'; readonly requestId: string; readonly routerId: string }
  | { readonly kind: 'callback-submitted'; readonly requestId: string; readonly requestDigest: string; readonly routerId: string; readonly response: JsonValue }
  | { readonly kind: 'callback-rejected'; readonly requestId: string; readonly routerId: string; readonly reason: string }
  | { readonly kind: 'callback-superseded'; readonly requestId: string; readonly supersededBy: string };

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

export type Responder = (request: CallbackRequest) => Promise<JsonObject> | JsonObject;
