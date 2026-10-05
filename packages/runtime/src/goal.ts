/**
 * A goal check: a seat reads the brief and the work, lists the requirements,
 * and marks each one met or unmet with evidence. Any unmet requirement sends
 * the work back. A review asks what is wrong with what is there; this asks
 * whether everything the brief asked for is there at all.
 */

import type { TeamSeat } from '@obversa/api';

import { agentJob } from './core/job.js';
import { LoopError } from './core/errors.js';
import { revisionRequest } from './core/feedback.js';
import type { GoalRequirement, Job, JobContext } from './core/types.js';
import { objectAt } from './workflow-agent-response.js';

export type { GoalRequirement } from './core/types.js';

/** What the goal seat reads besides the work itself. */
export interface GoalSource {
  /** The brief or task text the requirements come from. */
  readonly text: string;
  readonly desc?: string;
  readonly gate?: string;
  /** The files that make up the work, when the caller knows them. */
  readonly work?: string;
}

const REPLY = 'One JSON object: {"requirements":[{"requirement":"...","verdict":"met"|"unmet","evidence":"..."}]}';

function goalPrompt(source: GoalSource, retry: boolean): string {
  return JSON.stringify({
    step: 'goal check',
    instructions: 'Read the text below, then read the work in the workspace. Do not change any file. List every requirement the text sets; when the text gives a list, use that list. Mark each requirement met or unmet. For a met requirement, the evidence is a file and line, or a test, that shows it. For an unmet one, the evidence says what is missing.',
    text: source.text,
    ...(source.desc ? { task: source.desc } : {}),
    ...(source.gate ? { gate: source.gate } : {}),
    ...(source.work ? { work: source.work } : {}),
    reply: retry ? `Your previous response was not a valid list of requirements. Return only ${REPLY}` : REPLY,
  });
}

/** The requirements in a reply, or none when the list is empty or any entry is unreadable. */
function requirementsOf(text: string): GoalRequirement[] | undefined {
  // The last object in the reply that carries a requirements list, as a
  // reviewer's decision is read: an example earlier in the reply is not it.
  let list: unknown;
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
    const candidate = (value as { requirements?: unknown } | null)?.requirements;
    if (Array.isArray(candidate)) list = candidate;
  }
  if (!Array.isArray(list) || !list.length) return undefined;
  const requirements: GoalRequirement[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') return undefined;
    const { requirement, verdict, evidence } = item as Record<string, unknown>;
    if (typeof requirement !== 'string' || !requirement.trim()) return undefined;
    if (verdict !== 'met' && verdict !== 'unmet') return undefined;
    if (typeof evidence !== 'string' || !evidence.trim()) return undefined;
    requirements.push({ requirement, verdict, evidence });
  }
  return requirements;
}

/**
 * Ask `seat`, read-only, whether the work meets every requirement in
 * `source`, and record its verdicts as a `goal:check` event for `round`.
 * Every requirement met passes. Any unmet one is a revision to `target`
 * with each unmet requirement and its evidence as a finding, which no judge
 * decides. A reply that is not a readable list is asked for once more, then
 * pauses the run.
 */
export function goalCheckJob(
  label: string,
  seat: TeamSeat,
  source: GoalSource,
  target: string | undefined,
  round: (ctx: JobContext) => number,
): Job {
  const tools = [...seat.identity.tools];
  if (!tools.length) throw new TypeError(`${label} cannot read the work: the goal seat declares no tools`);
  const ask = (retry: boolean) => agentJob({
    label,
    engine: seat.engine,
    model: seat.identity.model,
    workspaceMode: 'read',
    tools,
    allowedTools: tools,
    leaf: true,
    prompt: goalPrompt(source, retry),
  });
  const attempts = [ask(false), ask(true)];
  return async (ctx) => {
    let requirements: GoalRequirement[] | undefined;
    for (const attempt of attempts) {
      const outcome = await attempt(ctx);
      if (outcome.status !== 'pass') return outcome;
      requirements = requirementsOf(String(outcome.data ?? ''));
      if (requirements) break;
    }
    if (!requirements) {
      // Paused, as a review panel pauses on a reviewer that sends no decision.
      const summary = `${label} returned no list of requirements`;
      return { status: 'paused', summary, error: new LoopError({ code: 'ENGINE', phase: 'review', message: summary }) };
    }
    ctx.emit({ kind: 'goal:check', ts: Date.now(), path: [...ctx.path], label, round: round(ctx), requirements });
    const unmet = requirements.filter((requirement) => requirement.verdict === 'unmet');
    // The target rides with the verdicts, so a judge of that target reads them.
    const data = { requirements, ...(target !== undefined ? { target } : {}) };
    if (!unmet.length) {
      return { status: 'pass', summary: `every requirement is met (${requirements.length})`, data };
    }
    const outcome = revisionRequest({
      target,
      reason: `${unmet.length} of ${requirements.length} requirements are not met`,
      findings: unmet.map(({ requirement, evidence }) => ({ severity: 'block', evidence: `${requirement}: ${evidence}` })),
    }, { data });
    return { ...outcome, revision: { ...outcome.revision!, skipJudge: true } };
  };
}

/**
 * A goal check as one `dag()` node: put it between the build and the review
 * nodes. It passes when every requirement in `text` is met, and otherwise
 * sends the unmet ones, with evidence, back to `target` as a revision. A
 * judge on `maxKickbacks` for `target` does not decide them.
 */
export function goalCheck(seat: TeamSeat, opts: { readonly target: string; readonly text: string }): Job {
  return goalCheckJob('goal-check', seat, { text: opts.text }, opts.target, (ctx) => ctx.graph?.attempt ?? 1);
}
