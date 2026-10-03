/**
 * A review panel's synthesis: the reviews become one before anything reads
 * them. A merger seat groups the findings that name the same problem; each
 * reviewer then answers, once, the merged findings it did not raise; plain
 * code applies the votes.
 */

import type { TeamSeat } from '@obversa/api';

import { mapWithConcurrency } from './concurrency.js';
import { agentJob } from './job.js';
import {
  normalizeFeedbackSeverity,
  reviewPanelWith,
  type PanelSynthesisInput,
  type ReviewPanelConfig,
} from './feedback.js';
import type {
  FeedbackActionSeverity,
  FeedbackFinding,
  FindingVote,
  Job,
  JobContext,
  PanelSynthesisEntry,
} from './types.js';

/**
 * Run reviewers as one panel. With `synthesise` set and more than one
 * reviewer, the reviews are merged and cross-reviewed before the outcome
 * carries them; see `ReviewPanelConfig.synthesise`.
 */
export function reviewPanel(config: ReviewPanelConfig): Job {
  return reviewPanelWith(config, synthesiseFindings);
}

const SEVERITY_ORDER: readonly FeedbackActionSeverity[] = ['block', 'should-fix', 'nice-to-have', 'approve'];
const VOTES = new Set<FindingVote['vote']>(['agree', 'disagree', 'better fix']);

/** The first `{` to the last `}` of a reply, parsed; anything else reads as no answer. */
function replyObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One turn of `seat`. A voter that declares tools may read the work to check
 * a claim; the merger reads only the findings in its prompt.
 */
async function ask(
  seat: TeamSeat,
  label: string,
  prompt: string,
  read: boolean,
  ctx: JobContext,
  path: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const tools = read ? [...seat.identity.tools] : [];
  const outcome = await agentJob({
    label,
    engine: seat.engine,
    model: seat.identity.model,
    workspaceMode: tools.length ? 'read' : 'none',
    tools,
    allowedTools: tools,
    leaf: true,
    prompt,
  })({ ...ctx, depth: ctx.depth + 1, path: [...path] });
  return outcome.status === 'pass' ? replyObject(String(outcome.data ?? '')) : undefined;
}

function promptFinding(finding: FeedbackFinding) {
  return {
    severity: normalizeFeedbackSeverity(finding.severity),
    evidence: finding.evidence,
    ...(finding.recommendation ? { recommendation: finding.recommendation } : {}),
  };
}

/** The merger's groups of two or more, as indexes; an id used twice counts once. */
function mergeGroups(reply: Record<string, unknown> | undefined, count: number): { members: number[]; evidence: number; fix?: number }[] {
  const index = (id: unknown) => {
    const match = typeof id === 'string' ? /^f(\d+)$/.exec(id) : null;
    const value = match ? Number(match[1]) - 1 : -1;
    return value >= 0 && value < count ? value : undefined;
  };
  const used = new Set<number>();
  const groups: { members: number[]; evidence: number; fix?: number }[] = [];
  for (const group of Array.isArray(reply?.groups) ? reply.groups : []) {
    if (group === null || typeof group !== 'object') continue;
    const { ids, evidence, fix } = group as Record<string, unknown>;
    const members = [...new Set((Array.isArray(ids) ? ids : []).map(index))]
      .filter((member): member is number => member !== undefined && !used.has(member))
      .sort((a, b) => a - b);
    if (members.length < 2) continue;
    for (const member of members) used.add(member);
    const evidenceAt = index(evidence);
    const fixAt = index(fix);
    groups.push({
      members,
      evidence: evidenceAt !== undefined && members.includes(evidenceAt) ? evidenceAt : members[0]!,
      ...(fixAt !== undefined && members.includes(fixAt) ? { fix: fixAt } : {}),
    });
  }
  return groups;
}

/** Merge each group into one finding: the strongest severity, every reviewer credited, the chosen evidence and fix. */
function mergedFindings(raised: PanelSynthesisInput['raised'], reply: Record<string, unknown> | undefined): FeedbackFinding[] {
  const groups = mergeGroups(reply, raised.length);
  const groupOf = new Map(groups.flatMap((group) => group.members.map((member) => [member, group] as const)));
  const merged: FeedbackFinding[] = [];
  for (const [at, { reviewer, finding }] of raised.entries()) {
    const group = groupOf.get(at);
    if (!group) {
      merged.push({ ...finding, raisedBy: [reviewer] });
      continue;
    }
    if (group.members[0] !== at) continue;
    const members = group.members.map((member) => raised[member]!);
    const raisedBy = [...new Set(members.map((member) => member.reviewer))];
    const severity = SEVERITY_ORDER[Math.min(...members.map((member) =>
      SEVERITY_ORDER.indexOf(normalizeFeedbackSeverity(member.finding.severity))))]!;
    const fixFrom = group.fix !== undefined && raised[group.fix]!.finding.recommendation !== undefined
      ? raised[group.fix]!.finding
      : members.find((member) => member.finding.recommendation !== undefined)?.finding;
    const { recommendation: _unused, ...evidenceFrom } = raised[group.evidence]!.finding;
    merged.push({
      ...evidenceFrom,
      reviewer: raisedBy[0],
      raisedBy,
      severity,
      ...(fixFrom?.recommendation !== undefined ? { recommendation: fixFrom.recommendation } : {}),
    });
  }
  return merged;
}

/** One voter's answers, keyed by the merged finding's index: one per finding, the first wins. */
function voterAnswers(reply: Record<string, unknown> | undefined, shown: ReadonlyMap<string, number>, reviewer: string): Map<number, FindingVote> {
  const answers = new Map<number, FindingVote>();
  for (const item of Array.isArray(reply?.votes) ? reply.votes : []) {
    if (item === null || typeof item !== 'object') continue;
    const { id, vote, reason, fix } = item as Record<string, unknown>;
    const at = typeof id === 'string' ? shown.get(id) : undefined;
    if (at === undefined || answers.has(at) || !VOTES.has(vote as FindingVote['vote'])) continue;
    const betterFix = typeof fix === 'string' && fix.trim() ? fix.trim() : undefined;
    if (vote === 'better fix' && betterFix === undefined) continue;
    answers.set(at, {
      reviewer,
      vote: vote as FindingVote['vote'],
      reason: typeof reason === 'string' ? reason.trim() : '',
      ...(vote === 'better fix' ? { fix: betterFix } : {}),
    });
  }
  return answers;
}

/**
 * Apply the votes by rule. Most voters disagree: dropped, but only when the
 * reviewers who disagree also outnumber the ones who raised it, agreed or
 * offered a better fix; otherwise, or when the finding is a block, or a
 * reviewer shown it sent no votes, it stays disputed. Exactly half the voters
 * disagree: disputed. Most prefer a better fix: the first offered fix
 * replaces the original.
 */
function applyVotes(finding: FeedbackFinding, votes: readonly FindingVote[], missing: number): PanelSynthesisEntry {
  const disagree = votes.filter((vote) => vote.vote === 'disagree').length;
  const better = votes.filter((vote) => vote.vote === 'better fix');
  const voted: FeedbackFinding = votes.length ? { ...finding, votes: [...votes] } : finding;
  if (votes.length && disagree * 2 > votes.length) {
    const support = finding.raisedBy!.length + votes.length - disagree;
    return normalizeFeedbackSeverity(finding.severity) === 'block' || missing > 0 || disagree <= support
      ? { result: 'disputed', finding: { ...voted, disputed: true } }
      : { result: 'dropped', finding: voted };
  }
  if (votes.length && disagree * 2 === votes.length) return { result: 'disputed', finding: { ...voted, disputed: true } };
  if (better.length * 2 > votes.length) return { result: 'better fix', finding: { ...voted, recommendation: better[0]!.fix } };
  return { result: 'kept', finding: voted };
}

async function synthesiseFindings(input: PanelSynthesisInput, ctx: JobContext): Promise<PanelSynthesisEntry[]> {
  const { raised, voters, merger, label, concurrency, context } = input;
  if (!raised.length) return [];
  const mergeReply = raised.length < 2 ? undefined : await ask(merger, `${label}:merge`, JSON.stringify({
    step: 'merge',
    instructions: 'Several reviewers reviewed the same work. Group the findings that name the same problem, even when they word it differently. For each group, say which finding gives the clearest evidence and which gives the clearest fix. A finding no other finding repeats belongs to no group.',
    findings: raised.map(({ reviewer, finding }, at) => ({ id: `f${at + 1}`, reviewer, ...promptFinding(finding) })),
    reply: 'One JSON object: {"groups":[{"ids":["f1","f3"],"evidence":"f3","fix":"f1"}]}. List only groups of two or more findings.',
  }), false, ctx, [...ctx.path, 'synthesis', 'merge']);
  const mergeFailed = raised.length >= 2 && mergeReply === undefined;
  const merged = mergedFindings(raised, mergeReply);

  const answers = await mapWithConcurrency(voters, concurrency, async (voter) => {
    const shown = merged
      .map((finding, at) => ({ id: `m${at + 1}`, at, finding }))
      .filter(({ finding }) => !finding.raisedBy!.includes(voter.name));
    if (!shown.length) return { voter: voter.name, failed: false, shown: new Set<number>(), votes: new Map<number, FindingVote>() };
    const reply = await ask(voter.seat, `${label}:cross-review`, JSON.stringify({
      step: 'cross-review',
      reviewer: voter.name,
      instructions: 'Other reviewers raised these findings about the work you reviewed. Answer each one: agree, disagree, or better fix, with a one-line reason. For better fix, give the fix you would make instead.',
      ...(context ? { context } : {}),
      ...(ctx.reviewerGate ? { gate: ctx.reviewerGate } : {}),
      findings: shown.map(({ id, finding }) => ({ id, ...promptFinding(finding), raisedBy: finding.raisedBy })),
      reply: 'One JSON object: {"votes":[{"id":"m1","vote":"agree"|"disagree"|"better fix","reason":"one line","fix":"only for better fix"}]}',
    }), true, ctx, [...ctx.path, 'synthesis', 'cross-review', voter.name]);
    return {
      voter: voter.name,
      failed: reply === undefined,
      shown: new Set(shown.map(({ at }) => at)),
      votes: voterAnswers(reply, new Map(shown.map(({ id, at }) => [id, at])), voter.name),
    };
  });

  const entries = merged.map((finding, at) => applyVotes(
    finding,
    answers.flatMap((answer) => answer.votes.get(at) ?? []),
    answers.filter((answer) => answer.failed && answer.shown.has(at)).length,
  ));
  // A merger or voter that failed or sent no readable reply leaves the
  // findings unmerged or without its votes; the record says so.
  const noVotesFrom = answers.filter((answer) => answer.failed).map((answer) => answer.voter);
  ctx.emit({
    kind: 'review:synthesis',
    ts: Date.now(),
    path: [...ctx.path],
    label,
    entries,
    ...(mergeFailed ? { mergeFailed } : {}),
    ...(noVotesFrom.length ? { noVotesFrom } : {}),
  });
  return entries;
}
