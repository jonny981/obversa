/**
 * The Callback Gate (roadmap D7): a question the run asks and waits for,
 * answered through a replaceable router. The runtime stores the durable
 * request and its assignment; an external router claims the request,
 * submits a structured response, and the runtime validates and records it.
 *
 * The request digest covers the gate version, the decision text, the
 * response schema, and the referenced input bytes. Display-only data —
 * placement, layout, theme, and other presentation or routing hints — is
 * stored in the request payload but excluded from the digest, so
 * restyling a question never invalidates a pending answer, and changing
 * what is asked always does.
 */

import { createHash } from 'node:crypto';

import {
  canonicalJson,
  cloneFrozenJson,
  type JsonObject,
  type JsonValue,
} from '../graph/value.js';

export interface CallbackGateDefinition {
  readonly gateId: string;
  readonly gateVersion: number;
  /** The question the run is asking, in plain text. */
  readonly decisionText: string;
  /** The shape a valid answer takes. */
  readonly responseSchema: JsonObject;
  /** The input bytes the decision refers to. */
  readonly input: JsonValue;
  /** Presentation and routing hints: stored, never digested. */
  readonly presentation?: JsonObject;
}

export interface CallbackRequest extends JsonObject {
  readonly requestId: string;
  readonly gateId: string;
  readonly gateVersion: number;
  readonly digest: string;
  readonly decisionText: string;
  readonly responseSchema: JsonObject;
  readonly input: JsonValue;
  readonly presentation: JsonObject;
}

const REQUEST_FIELDS = [
  'decisionText',
  'digest',
  'gateId',
  'gateVersion',
  'input',
  'presentation',
  'requestId',
  'responseSchema',
] as const;

function digestOf(definition: CallbackGateDefinition): string {
  return createHash('sha256').update(canonicalJson({
    gateId: definition.gateId,
    gateVersion: definition.gateVersion,
    decisionText: definition.decisionText,
    responseSchema: definition.responseSchema,
    input: definition.input,
  } as JsonValue)).digest('hex');
}

/** Create the gate's request. Same definition bytes, same digest. */
export function createCallbackGate(
  definition: CallbackGateDefinition,
): CallbackRequest {
  if (typeof definition.gateId !== 'string' || definition.gateId.length === 0) {
    throw new Error('a callback gate needs a gateId');
  }
  if (!Number.isSafeInteger(definition.gateVersion) || definition.gateVersion < 1) {
    throw new Error('a callback gate needs a positive gateVersion');
  }
  if (typeof definition.decisionText !== 'string' || definition.decisionText.length === 0) {
    throw new Error('a callback gate needs decision text');
  }
  const fixed = cloneFrozenJson({
    gateId: definition.gateId,
    gateVersion: definition.gateVersion,
    decisionText: definition.decisionText,
    responseSchema: definition.responseSchema,
    input: definition.input,
    presentation: definition.presentation ?? {},
  }) as unknown as CallbackGateDefinition;
  const digest = digestOf(fixed);
  return cloneFrozenJson({
    requestId: `${fixed.gateId}#${fixed.gateVersion}#${digest}`,
    gateId: fixed.gateId,
    gateVersion: fixed.gateVersion,
    digest,
    decisionText: fixed.decisionText,
    responseSchema: fixed.responseSchema,
    input: fixed.input,
    presentation: fixed.presentation ?? {},
  }) as CallbackRequest;
}

/** The digest a gate definition produces, without creating a request. */
export function callbackRequestDigest(
  definition: Omit<CallbackGateDefinition, 'presentation'>,
): string {
  return digestOf({ ...definition, presentation: {} } as CallbackGateDefinition);
}

/** Validate stored request bytes and their content-derived identity. */
export function validateCallbackRequest(value: unknown): CallbackRequest {
  const stored = cloneFrozenJson(value as JsonValue);
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new TypeError('a stored callback request must be an object');
  }
  const record = stored as JsonObject;
  const fields = Object.keys(record).sort();
  if (fields.length !== REQUEST_FIELDS.length
    || fields.some((field, index) => field !== REQUEST_FIELDS[index])) {
    throw new TypeError('a stored callback request has missing or unknown fields');
  }
  if (typeof record.gateId !== 'string'
    || typeof record.gateVersion !== 'number'
    || typeof record.decisionText !== 'string'
    || record.responseSchema === null
    || typeof record.responseSchema !== 'object'
    || Array.isArray(record.responseSchema)
    || record.presentation === null
    || typeof record.presentation !== 'object'
    || Array.isArray(record.presentation)) {
    throw new TypeError('a stored callback request has invalid fields');
  }
  const rebuilt = createCallbackGate({
    gateId: record.gateId,
    gateVersion: record.gateVersion,
    decisionText: record.decisionText,
    responseSchema: record.responseSchema as JsonObject,
    input: record.input as JsonValue,
    presentation: record.presentation as JsonObject,
  });
  if (canonicalJson(stored) !== canonicalJson(rebuilt)) {
    throw new TypeError('stored callback request bytes do not match its identity');
  }
  return stored as CallbackRequest;
}

function hasJsonType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'null': return value === null;
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

/** Validate a response object against a response schema's plain shape. */
export function validateCallbackResponse(
  response: JsonValue,
  schema: JsonObject,
): { ok: true } | { ok: false; reason: string } {
  if (typeof response !== 'object' || response === null || Array.isArray(response)) {
    return { ok: false, reason: 'a callback response must be an object' };
  }
  const record = response as Record<string, unknown>;
  const properties = schema.properties;
  if (properties !== undefined
    && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    return { ok: false, reason: 'the response schema properties must be an object' };
  }
  const required = schema.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      return { ok: false, reason: 'the response schema required list must be an array' };
    }
    for (const key of required) {
      if (typeof key !== 'string' || !Object.hasOwn(record, key)) {
        return { ok: false, reason: `the response is missing the required field "${String(key)}"` };
      }
    }
  }
  if (properties !== undefined) {
    const fields = properties as Record<string, unknown>;
    for (const [key, field] of Object.entries(record)) {
      const declared = fields[key];
      if (declared === undefined) continue;
      if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
        return { ok: false, reason: `the schema field "${key}" must be an object` };
      }
      const expected = (declared as { type?: unknown }).type;
      if (expected === undefined) continue;
      const allowed = Array.isArray(expected) ? expected : [expected];
      if (!allowed.some((type) => hasJsonType(field, type))) {
        return { ok: false, reason: `the response field "${key}" must be ${String(expected)}` };
      }
    }
  }
  return { ok: true };
}
