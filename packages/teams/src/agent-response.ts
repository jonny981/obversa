import {
  revisionRequest,
  type FeedbackFinding,
  type Outcome,
} from '@obversa/runtime';

interface AgentDecision {
  readonly status: 'pass' | 'revise';
  readonly summary: string;
  readonly findings?: readonly FeedbackFinding[];
}

function firstObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
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

function parseDecision(text: string): AgentDecision | undefined {
  const trimmed = text.trim();
  const object = firstObject(trimmed);
  if (!object) return undefined;
  try {
    const value: unknown = JSON.parse(object);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const candidate = value as Partial<AgentDecision>;
    if (candidate.status !== 'pass' && candidate.status !== 'revise') return undefined;
    if (typeof candidate.summary !== 'string' || !candidate.summary.trim()) return undefined;
    if (candidate.findings !== undefined && !Array.isArray(candidate.findings)) return undefined;
    return {
      status: candidate.status,
      summary: candidate.summary,
      findings: candidate.findings ? [...candidate.findings] : undefined,
    };
  } catch {
    return undefined;
  }
}

export function outcomeFromAgentText(text: string, target?: string): Outcome {
  const decision = parseDecision(text);
  if (!decision) {
    return {
      status: 'fail',
      summary: 'The engine response was not a valid team decision JSON object.',
      data: { response: text },
    };
  }
  if (decision.status === 'pass') {
    return { status: 'pass', summary: decision.summary };
  }
  return revisionRequest({
    target,
    reason: decision.summary,
    findings: decision.findings ? [...decision.findings] : undefined,
  });
}
