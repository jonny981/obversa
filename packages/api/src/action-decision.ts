import { cloneFrozenJson, type JsonObject, type JsonValue } from './json.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
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

export function validateActionDecision(value: ActionDecision): ActionDecision {
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
