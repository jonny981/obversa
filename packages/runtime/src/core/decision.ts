import type { Condition, Job, JobContext, Outcome } from './types.js';
import { isInfrastructureError } from './errors.js';

export interface LastGateBriefOptions {
  maxOutputChars?: number;
}

export interface ConfidenceConditionOptions {
  /**
   * Units used by `threshold`. `fraction` uses 0..1 (default 0.8), while
   * `percent` uses 0..100 (default 80). Reported confidence stays normalized
   * to 0..1 in both modes.
   */
  scale?: 'fraction' | 'percent';
  threshold?: number;
  token?: string;
  /** Accept an exact, case-insensitive `n/a` token when the wrapped job passes. */
  allowNa?: boolean;
  /** Use the full work output as the condition reason when it is nonempty. */
  reason?: 'concise' | 'output';
}

export interface LastDecisionLineOptions {
  /**
   * `closing` requires the token to be the final nonblank line. `last-match`
   * permits trailing prose and selects the last line-anchored token.
   */
  mode?: 'closing' | 'last-match';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function lastDecisionLine(
  text: string,
  token: string,
  values?: readonly string[],
  opts: LastDecisionLineOptions = {},
): string | undefined {
  const work = text;
  const tag = escapeRegExp(token);
  // The vocabulary matches case-insensitively, but its own casing is the
  // canonical return: a gate comparing against its declared values must not
  // depend on how a chatty leaf happened to case the token.
  const allowed = values
    ? new Map(values.map((value) => [value.toLowerCase(), value]))
    : undefined;
  const lines = work
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const valueFromLine = (line: string): string | undefined => {
    const xml = new RegExp(`^<${tag}>\\s*([^<]+?)\\s*</${tag}>$`, 'i').exec(line);
    const colon = new RegExp(`^${tag}\\s*:\\s*(.+?)\\s*$`, 'i').exec(line);
    return (xml?.[1] ?? colon?.[1])?.trim();
  };

  if (opts.mode === 'last-match') {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const value = valueFromLine(lines[index]!);
      if (!value) continue;
      return allowed ? allowed.get(value.toLowerCase()) : value;
    }
    return undefined;
  }

  const line = lines.at(-1);
  if (!line) return undefined;
  const value = valueFromLine(line);
  if (!value) return undefined;
  return allowed ? allowed.get(value.toLowerCase()) : value;
}

export function confidenceFromText(
  text: string,
  token = 'confidence',
): number | undefined {
  const raw = lastDecisionLine(text, token);
  if (!raw) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(%)?$/.exec(raw);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  const value = match[2] || n > 1 ? n / 100 : n;
  if (value < 0 || value > 1) return undefined;
  return value;
}

function outcomeText(outcome: Outcome): string {
  const candidates = [
    typeof outcome.data === 'string' ? outcome.data : undefined,
  ].filter((value): value is string => Boolean(value));
  if (!candidates.length && outcome.summary) candidates.push(outcome.summary);
  return candidates.join('\n');
}

export function confidenceCondition(
  job: Job,
  opts: ConfidenceConditionOptions = {},
): Condition {
  const scale = opts.scale ?? 'fraction';
  const threshold = opts.threshold ?? (scale === 'percent' ? 80 : 0.8);
  const normalizedThreshold = scale === 'percent' ? threshold / 100 : threshold;
  const token = opts.token ?? 'confidence';
  return async (ctx: JobContext) => {
    const outcome = await job(ctx);
    if (
      outcome.error &&
      (ctx.signal.aborted || isInfrastructureError(outcome.error))
    ) {
      throw outcome.error;
    }
    const output = outcomeText(outcome);
    const raw = lastDecisionLine(output, token);
    const acceptedNa =
      outcome.status === 'pass' && opts.allowNa === true && raw?.toLowerCase() === 'n/a';
    const confidence = acceptedNa ? 1 : confidenceFromText(output, token);
    const met =
      outcome.status === 'pass' &&
      confidence !== undefined &&
      (acceptedNa || confidence >= normalizedThreshold);
    const conciseReason = acceptedNa
      ? `${token} n/a accepted`
      : confidence === undefined
        ? `missing ${token} decision token`
        : scale === 'percent'
          ? `${token} ${(confidence * 100).toFixed(2)}% ${met ? 'meets' : 'below'} threshold ${threshold.toFixed(2)}%`
          : `${token} ${confidence.toFixed(2)} ${met ? 'meets' : 'below'} threshold ${threshold.toFixed(2)}`;
    return {
      met,
      confidence: confidence ?? 0,
      reason: opts.reason === 'output' && output ? output : conciseReason,
      output,
    };
  };
}

export function lastGateBrief(
  ctx: Pick<JobContext, 'lastGate'>,
  opts: LastGateBriefOptions = {},
): string {
  const gate = ctx.lastGate;
  if (!gate || gate.met) return '';
  const lines = [`Previous gate failed: ${gate.reason}`];
  if (gate.output) {
    const cap = opts.maxOutputChars ?? 2000;
    const output =
      gate.output.length <= cap
        ? gate.output
        : `${gate.output.slice(0, cap).trimEnd()}\n[gate output truncated]`;
    lines.push('', output);
  }
  return lines.join('\n');
}
