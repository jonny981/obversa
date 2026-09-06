/**
 * Shared engine failure classification. Typed engine failures and compatible
 * runtime codes take priority over process errors and message text.
 *
 * Default fallback treats auth, billing, missing executables, unavailable
 * models, invalid configuration and exhausted long allowances as lasting for
 * the run. Ambiguous limit wording is rate-limit, not evidence of quota.
 * Rate limits and transient failures remain outside the default lasting set.
 */

import type {
  EngineFailureKind,
  EngineIncompleteResultEvidence,
  EngineSelectionRecord,
} from './contracts.js';
import { engineSelection } from './result.js';
export type { EngineFailureKind } from './contracts.js';

export interface EngineErrorInit {
  readonly kind: EngineFailureKind;
  readonly message: string;
  readonly cause?: unknown;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
  readonly effective?: EngineSelectionRecord;
}

/** A provider or adapter failure with no runtime policy attached. */
export class EngineError extends Error {
  readonly kind: EngineFailureKind;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;
  readonly effective?: EngineSelectionRecord;

  constructor(init: EngineErrorInit) {
    super(
      init.message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'EngineError';
    this.kind = init.kind;
    this.retryAfterMs = init.retryAfterMs;
    this.resetAt = init.resetAt;
    this.effective = init.effective === undefined
      ? undefined
      : engineSelection(init.effective);
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

/** Failures that default fallback treats as lasting for the run. */
export const LANE_DEAD_FAILURES: ReadonlySet<EngineFailureKind> = new Set([
  'auth',
  'billing',
  'missing-cli',
  'model-unavailable',
  'invalid-config',
  'quota',
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
  { kind: 'quota', pattern: /\bmonthly (?:usage limit|quota|allowance)\b|out of.*credits|\binsufficient credits\b/ },
  { kind: 'rate-limit', pattern: /rate.?limit|too many requests|overloaded|429|529|quota|allowance|usage limit|session limit/ },
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
