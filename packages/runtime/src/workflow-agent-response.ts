import { revisionRequest } from './core/job.js';
import type { FeedbackFinding, Outcome } from './core/types.js';

interface AgentDecision {
  readonly status: 'pass' | 'revise';
  readonly summary: string;
  readonly findings?: readonly FeedbackFinding[];
}

export const INVALID_TEAM_DECISION = 'The engine response was not a valid team decision JSON object.';

/** The balanced `{...}` that opens at `start`, or undefined when it never closes. */
function objectAt(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

/**
 * A reply can show code, a JSON example or a braced aside before its answer,
 * and the prompt asks for the answer at the end. So the decision is the last
 * object in the reply with a `status` of pass or revise and a non-empty
 * `summary`. An object inside another object that parses is part of that
 * object, never a decision of its own.
 */
function parseDecision(text: string): AgentDecision | undefined {
  let last: Partial<AgentDecision> | undefined;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const object = objectAt(text, start);
    if (!object) continue;
    let value: unknown;
    try {
      value = JSON.parse(object);
    } catch {
      continue;
    }
    start += object.length - 1;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const candidate = value as Partial<AgentDecision>;
    if (candidate.status !== 'pass' && candidate.status !== 'revise') continue;
    if (typeof candidate.summary !== 'string' || !candidate.summary.trim()) continue;
    last = candidate;
  }
  if (!last) return undefined;
  if (last.findings !== undefined && !Array.isArray(last.findings)) return undefined;
  return {
    status: last.status!,
    summary: last.summary!,
    findings: last.findings ? [...last.findings] : undefined,
  };
}

export function outcomeFromAgentText(text: string, target?: string): Outcome {
  const decision = parseDecision(text);
  if (!decision) {
    return {
      status: 'fail',
      summary: INVALID_TEAM_DECISION,
      data: { response: text },
    };
  }
  if (decision.status === 'pass') {
    // A pass can carry notes; a synthesising review panel reads them.
    return decision.findings?.length
      ? { status: 'pass', summary: decision.summary, data: { findings: [...decision.findings] } }
      : { status: 'pass', summary: decision.summary };
  }
  return revisionRequest({
    target,
    reason: decision.summary,
    findings: decision.findings ? [...decision.findings] : undefined,
  });
}
