/**
 * A canonical vocabulary for *why* an engine turn failed, shared by the
 * fallback chain and preflight so they agree on what "this lane is dead"
 * means. Classification is deterministic — typed engine failures first, then
 * compatible runtime codes, spawn errnos, and substring rules
 * over the message, in the supervisor-orchestrator tradition.
 *
 * The load-bearing split: some failures are **lane-dead** — they will not
 * heal within a run, however long you wait (a missing binary, a bad key, an
 * empty balance, an unknown model, invalid configuration). Those are what a
 * fallback chain should reroute around. Rate limits, quotas, and transient
 * provider failures are different: they heal or pause, so the fallback chain
 * leaves them alone by default.
 */

import type { EngineIncompleteResultEvidence } from './index.js';

export type EngineFailureKind =
  | 'auth' // not authenticated / invalid or expired key
  | 'billing' // credit balance, payment required
  | 'missing-cli' // the engine's binary is not installed / not on PATH
  | 'model-unavailable' // unknown or inaccessible model id
  | 'invalid-config' // local or request configuration was rejected
  | 'rate-limit' // provider throttle (resets on its own)
  | 'quota' // usage allowance hit (may reset on a schedule)
  | 'transient' // provider 5xx failure that may heal on retry
  | 'timeout'
  | 'aborted'
  | 'unknown';

export interface EngineErrorInit {
  readonly kind: EngineFailureKind;
  readonly message: string;
  readonly cause?: unknown;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
}

/** A provider or adapter failure with no runtime policy attached. */
export class EngineError extends Error {
  readonly kind: EngineFailureKind;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;

  constructor(init: EngineErrorInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'EngineError';
    this.kind = init.kind;
    this.retryAfterMs = init.retryAfterMs;
    this.resetAt = init.resetAt;
  }
}

/** A failed engine turn that still produced measured, recordable evidence. */
export class EngineIncompleteResultError extends EngineError {
  readonly evidence: EngineIncompleteResultEvidence;

  constructor(message: string, evidence: EngineIncompleteResultEvidence) {
    super({ kind: 'unknown', message });
    this.name = 'EngineIncompleteResultError';
    this.evidence = evidence;
  }
}

/** Failures that will not heal within a run: what a fallback chain reroutes
 *  around, and what preflight exists to catch before iteration 1. */
export const LANE_DEAD_FAILURES: ReadonlySet<EngineFailureKind> = new Set([
  'auth',
  'billing',
  'missing-cli',
  'model-unavailable',
  'invalid-config',
]);

interface Rule {
  kind: EngineFailureKind;
  pattern: RegExp;
}

/** Substring rules over the lowercased message, most specific first. The
 *  vocabulary spans the Anthropic API, the claude/codex CLIs, and generic
 *  HTTP phrasing, so every engine classifies through one table. */
const MESSAGE_RULES: Rule[] = [
  {
    kind: 'invalid-config',
    pattern:
      /invalid value.*supported values|invalid (?:configuration|config)|(?:load|parse).*config(?:uration)?|bad config/,
  },
  { kind: 'billing', pattern: /credit balance|billing|payment required|purchase more|insufficient funds|402/ },
  { kind: 'auth', pattern: /not authenticated|unauthorized|invalid (api |x-)?key|authentication[_ ](error|failed)|expired.*(token|credentials)|login|401/ },
  { kind: 'missing-cli', pattern: /enoent|command not found|not recognized as an internal|no such file or directory.*(claude|codex)/ },
  { kind: 'model-unavailable', pattern: /model.*(not found|unavailable|does not exist|unknown)|unknown model|no such model|404/ },
  { kind: 'quota', pattern: /quota|allowance|usage limit|session limit|out of.*credits/ },
  { kind: 'rate-limit', pattern: /rate.?limit|too many requests|overloaded|429|529/ },
  { kind: 'timeout', pattern: /\btim(ed?)?.?out\b|deadline exceeded/ },
  { kind: 'transient', pattern: /internal server error|bad gateway|service unavailable|gateway timeout|\b5\d\d\b/ },
];

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.message];
    if (error.cause instanceof Error) parts.push(error.cause.message);
    return parts.join('\n');
  }
  return String(error);
}

/** Classify a failed engine turn. Typed signals win over substring rules. */
export function classifyEngineFailure(error: unknown): EngineFailureKind {
  if (error instanceof EngineError) return error.kind;
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === 'RATE_LIMIT') return 'rate-limit';
  if (code === 'QUOTA') return 'quota';
  if (code === 'TIMEOUT') return 'timeout';
  if (code === 'ABORTED') return 'aborted';
  if (code === 'CONFIG') return 'invalid-config';
  const err = error as NodeJS.ErrnoException | undefined;
  if (err && (err.code === 'ENOENT' || (err.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')) {
    return 'missing-cli';
  }
  if (err?.name === 'AbortError') return 'aborted';
  const text = messageOf(error).toLowerCase();
  for (const rule of MESSAGE_RULES) {
    if (rule.pattern.test(text)) return rule.kind;
  }
  return 'unknown';
}
