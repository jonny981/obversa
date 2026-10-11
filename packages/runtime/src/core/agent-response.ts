import { copyJobMeta } from './describe.js';
import { revisionRequest } from './job.js';
import type { FeedbackFinding, Job, Outcome } from './types.js';

interface AgentDecision {
  readonly status: 'pass' | 'revise';
  readonly summary: string;
  readonly findings?: readonly FeedbackFinding[];
  /** The earlier node the work goes back to, when the seat may choose one. */
  readonly target?: string;
}

export const INVALID_TEAM_DECISION = 'The engine response was not a valid team decision JSON object.';

/** The balanced `{...}` that opens at `start`, or undefined when it never closes. */
export function objectAt(text: string, start: number): string | undefined {
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
  if (last.target !== undefined && typeof last.target !== 'string') return undefined;
  return {
    status: last.status!,
    summary: last.summary!,
    findings: last.findings ? [...last.findings] : undefined,
    ...(typeof last.target === 'string' && last.target.trim() ? { target: last.target } : {}),
  };
}

/**
 * The shared agent-reply decision reader for jobs built on agentJob (and for
 * the built-in harnesses that mirror them). The reply's target counts only
 * inside the routes the caller named: one route fills in a target the reply
 * left out, several require the reply to name one of them, and a target
 * outside the routes makes the reply no decision. A caller that names no
 * routes never reads the reply's target.
 *
 * @param text The reply text.
 * @param target Optional: the route or routes this job may send the work back
 *   to when the reply asks for a revision.
 */
export function outcomeFromAgentText(text: string, target?: string | readonly string[]): Outcome {
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
  const routes = target === undefined ? [] : typeof target === 'string' ? [target] : target;
  const named = routes.length === 0 ? undefined : decision.target ?? (routes.length === 1 ? routes[0] : undefined);
  if (routes.length > 0 && (named === undefined || !routes.includes(named))) {
    return {
      status: 'fail',
      summary: INVALID_TEAM_DECISION,
      data: { response: text },
    };
  }
  return revisionRequest({
    target: named,
    reason: decision.summary,
    findings: decision.findings ? [...decision.findings] : undefined,
  });
}

/**
 * Ask a seat again, once, when its reply was no team decision; the second
 * reply stands. The same retry a reviewer gets applies to the seat doing
 * the work: a model sometimes answers in prose, and one prose reply is not
 * a failed round.
 */
export function withDecisionRetry(ask: Job, askAgain: Job): Job {
  return copyJobMeta(async (ctx) => {
    const first = await ask(ctx);
    return first.status === 'fail' && first.summary === INVALID_TEAM_DECISION ? askAgain(ctx) : first;
  }, ask);
}
