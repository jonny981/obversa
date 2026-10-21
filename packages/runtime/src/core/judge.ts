/**
 * A judge: a seat that answers typed questions about a piece of work and the
 * rounds spent on it so far, in place of a plain review-round count. Used on
 * a `workflow()` stage's `refine` and in a `dag()` node's `review()`, between
 * a review's verdict and the send-back.
 *
 * The default question set and the routing rule below make a loop that was
 * first hand-wired as dag nodes into a runtime primitive.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { jobMeta } from './describe.js';
import { treeChanges, treeDiff, workTree, type TreeChange } from './git.js';
import { LoopError } from './errors.js';
import { resolveEnv } from './env-overlay.js';
import type { AgentResult } from '../engines/engine.js';
import { agentJob } from './job.js';
import { scrubbed } from './redact.js';
import { DEFAULT_INTERACTION, interactionIdentity, jsonSnapshot, requestInteraction, type InteractionBinding, type InteractionResponse } from './interaction.js';
import type { Outcome } from './types.js';
import { normalizeFeedbackSeverity, revisionRequest } from './feedback.js';
import type {
  FeedbackActionSeverity,
  FeedbackFinding,
  FindingDecision,
  FindingLevel,
  GoalRequirement,
  Job,
  Judge,
  JudgeAnswer,
  JudgeCheck,
  JudgeQuestions,
  JobContext,
  JudgePacket,
  JudgeQuestion,
  JudgeRound,
  JudgeWork,
  RepeatFinding,
  SkippedFinding,
} from './types.js';

export type {
  FindingDecision,
  FindingLevel,
  Judge,
  JudgeAnswer,
  JudgeCheck,
  JudgePacket,
  JudgeQuestion,
  JudgeQuestions,
  JudgeRound,
  JudgeWork,
  RepeatFinding,
  SkippedFinding,
} from './types.js';

/**
 * The confidence each judge action needs before the runtime takes it, in
 * one place. Set per action, by the cost of being wrong, and tuned against
 * labelled findings with `tools/calibrate-judge.mjs`; the values below are
 * the starting bars, not measured ones.
 *
 * - `sendBack`: a finding scored `impactful` goes back to the builder at or
 *   above it. A wrong send-back costs a round; a missed real finding costs
 *   more, so the bar sits inside the guide's confirm band.
 * - `sendBackBlocking`: a finding scored `blocking` goes back at or above
 *   this lower bar, because a missed blocker is the worst miss. It sits at
 *   the hand-off floor: no lower answer could route the finding anyway.
 * - `stop`: a stop answer that would end the run — ship or fail — needs it.
 *   Below it the run pauses for a person instead.
 * - `handOff`: the floor. Any answer that would route the run below it, a
 *   `none_applies`, and a missing or unreadable confidence go to a person.
 */
export const JUDGE_CONFIDENCE = Object.freeze({
  sendBack: 0.7,
  sendBackBlocking: 0.6,
  stop: 0.8,
  handOff: 0.6,
});

/**
 * The default question set: one judgement per question, batched in the same
 * call. `product_decision` is a `noul` — must a person settle a product
 * decision before this review can continue. `stop_reason` is a `choice`
 * about how the round should end — it routes only while no finding is being
 * sent back — with `none_applies` for the case that fits none of them, which
 * hands the call to a person. A caller's own set replaces this wholesale
 * (e.g. for a use case this wording doesn't fit); `what` names the thing
 * being judged in the wording.
 */
export function stopQuestions(what = 'the draft'): JudgeQuestions {
  return {
    product_decision: {
      type: 'noul',
      instructions: 'Must a person settle a product decision before this review can continue?',
      criteria: {
        true: 'A finding or the brief turns on intent, audience or scope that only the person who owns the work can settle.',
        false: 'Every open finding is decidable from the brief, the use case and the work itself.',
      },
    },
    stop_reason: {
      type: 'choice',
      instructions: `The findings have their own questions; this one is about the whole round. The round counts and repeats are under \`when\`, the open findings under \`how.findings\`. If no finding is sent back, how should the run end? Choose continue only while at least one finding is going back.`,
      criteria: {
        holds: `${what} already does what the use case asks: the findings are mistaken, already met, or ask for something outside it.`,
        over_polishing: 'The findings left are real but small: taste, nits or edge cases below the bar the use case sets, so another round polishes rather than fixes.',
        not_converging: 'The repeats the runtime counted, or the counts, show another round will not fix what remains: end the run.',
        continue: 'At least one finding is going back to the builder, so another round runs.',
        none_applies: 'None of these fits what the evidence shows: a person decides.',
      },
    },
  };
}

/**
 * A judge for `refine` or a node's `review()`: `seat` runs with workspace mode
 * none (it reads no file itself; everything it needs rides in the prompt),
 * and `questions` defaults to `stopQuestions()`. With no `cap`, the rounds
 * end when the judge stops them or the review passes. A `cap` is an
 * optional backstop: `cap: N` allows at most N refinements after the first
 * build, so N+1 builds the reviews paid for. A failed check or a missing
 * file sends the work back on the check budget instead (a `dag()` node's
 * `checkRounds`; 3 on a `workflow()` stage a panel reviews), which the cap
 * does not count.
 * The judge is asked about the review of the
 * last build too, and only a stop that lets the work stand passes. `perFinding`
 * asks the judge to call each finding as well: it scores each one from
 * cosmetic to blocking, and the runtime sends back only a finding scored
 * impactful or blocking whose answer clears the send-back bar for its level
 * (see `JUDGE_CONFIDENCE`); a finding whose answer sits under the hand-off
 * floor goes to a person instead, whatever its level. It
 * defaults to true with the default questions and to false with a caller's
 * own.
 * A finding the judge holds back never goes back to the builder; it is
 * collected on `minorFindings`, with its level and confidence, for a person
 * to read before the work lands. A `pending` one — under the hand-off
 * floor — waits on the person the run pauses for: their call sends it back
 * with its evidence or keeps it on that list. On any pause the person's
 * `"hold"` also keeps back a finding the judge acted on, and an approval
 * holds every acted finding they do not name.
 * A `product_decision` the judge asks after the last review the cap allows
 * buys one more round for a change the person asks for, marked
 * `productDecision` — each time one is asked and answered, so a requested
 * change always reaches the builder. An answer that sends nothing back
 * lets the work stand as a pass instead.
 */
export function judge(seat: Judge['seat'], opts: { cap?: number; questions?: JudgeQuestions; perFinding?: boolean; interaction?: InteractionBinding } = {}): Judge {
  if (opts.cap !== undefined && (!Number.isSafeInteger(opts.cap) || opts.cap < 1)) {
    throw new TypeError('judge cap must be a whole number of refinements, 1 or more');
  }
  return {
    kind: 'judge', seat, ...(opts.cap !== undefined ? { cap: opts.cap } : {}), questions: opts.questions ?? stopQuestions(),
    perFinding: opts.perFinding ?? opts.questions === undefined,
    ...(opts.interaction ? { interaction: opts.interaction } : {}),
  };
}

/**
 * A finding's id within its round: `finding-1` for the first finding in the
 * round's list, and so on. The list is saved with a pending question, so the
 * ids stay the same after a resume.
 */
export function findingId(index: number): string {
  return `finding-${index + 1}`;
}

/**
 * The levels a per-finding `score` asks for, lowest to highest, and what the
 * record says when an answer carries no reason of its own. The level decides
 * whether the finding can go back at all, and the answer's confidence
 * decides whether it does — a `blocking` level clears a lower bar than an
 * `impactful` one, because a missed blocker is the worst miss.
 */
export const FINDING_LEVELS = Object.freeze(['cosmetic', 'minor', 'impactful', 'blocking'] as const satisfies readonly FindingLevel[]);

const LEVEL_REASON: Record<FindingLevel, string> = {
  cosmetic: 'Cosmetic: wording, style, naming or polish past the bar, so it changes nothing a reader gets.',
  minor: 'Minor: a real fault a reader of this work rarely meets, an edge case outside normal use, or a nice-to-have.',
  impactful: 'Impactful: behaviour wrong under normal use, a requirement of the brief unmet, a test that cannot fail, or a risk of data loss, a security hole or a broken rule of the work.',
  blocking: 'Blocking: so wrong the work must not land while it stands, such as data loss, a security hole, or a broken guarantee the brief names.',
};

/**
 * One question per finding, keyed by the finding's id. Each is a `score`
 * over `FINDING_LEVELS` — the guide's primitive for "how much" — so the same
 * scale serves every round: `impactful` or `blocking` at or over the
 * send-back bar for its level goes back to the builder, and every other
 * call joins `minorFindings`, the list a person reads before the work
 * lands. The finding's entry under `how.findings` carries the brief lines
 * it touches and its diff hunk.
 */
export function findingQuestions(findings: readonly FeedbackFinding[]): JudgeQuestions {
  const questions: Record<string, JudgeQuestion> = {};
  for (const [index, finding] of findings.entries()) {
    const severity = normalizeFeedbackSeverity(finding.severity);
    const recommendation = finding.recommendation ? ` Recommendation: ${finding.recommendation}` : '';
    questions[findingId(index)] = {
      type: 'score',
      instructions: `Read this one finding; the brief lines it touches and its diff hunk sit in its entry under \`how.findings\`. For this use case, how impactful is it? ${FINDING_LEVELS.map((level) => LEVEL_REASON[level]).join(' ')} Give a one-line reason. Finding [${severity}]: ${finding.evidence}${recommendation}`,
      criteria: [...FINDING_LEVELS],
    };
  }
  return questions;
}

export function isJudge(value: unknown): value is Judge {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'judge';
}

const SEVERITIES: readonly FeedbackActionSeverity[] = ['block', 'should-fix', 'nice-to-have', 'approve'];

/** Every finding, counted by severity, the judge reads numbers, not a list to recount itself. */
export function countBySeverity(findings: readonly FeedbackFinding[]): Record<FeedbackActionSeverity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<FeedbackActionSeverity, number>;
  for (const finding of findings) counts[normalizeFeedbackSeverity(finding.severity)] += 1;
  return counts;
}

/**
 * What the judge sees. `cap` rides along so it can reason about how much
 * room is left; it is absent when the judge has no cap.
 */
export interface JudgeState {
  readonly productFeedback?: readonly InteractionResponse[];
  /** The brief or ticket text the work answers. */
  readonly brief?: string;
  readonly useCase?: string;
  /** The target's own `desc` and `gate`. */
  readonly desc?: string;
  readonly gate?: string;
  /** The git workspace's files when the work began, and as the judge reads them this round. */
  readonly base?: string;
  readonly tree?: string;
  /** This round's checks, and the goal check's verdicts, when there are any. */
  readonly checks?: readonly JudgeCheck[];
  readonly goal?: readonly GoalRequirement[];
  /** The file being refined, relative to the workspace, when there is one. */
  readonly file?: string;
  /** That file's current content, when there is one. */
  readonly draft?: string;
  readonly latestFindings: readonly FeedbackFinding[];
  /** Findings the judge held back in earlier rounds, with its reasons. */
  readonly skipped?: readonly SkippedFinding[];
  /** The judge's calls on each finding of the round it sent to a person; once the person answers, each carries the call their answer settles (`act` or `hold`, see `personCalls`), so the answer reaches the builder with the findings that go back. */
  readonly decided?: readonly FindingDecision[];
  /** The question a pending ask puts to the person, saved so a resume asks the same one. */
  readonly ask?: string;
  /** The pending ask is a hand-off: the judge's answer was under its action's bar or named no fitting option, so a person decides. */
  readonly handoff?: true;
  readonly rounds: readonly JudgeRound[];
  readonly round: number;
  readonly cap?: number;
  /** This round's review is the last one the cap allows: no build round follows it unless a product answer buys one. */
  readonly lastRound?: true;
  /** The saved product question is one the spent cap raised, not one the judge chose: its answer buys a round on whatever past-cap round it lands. */
  readonly capPause?: true;
}

/** Lines added or removed between two drafts (a set difference, not a true diff, cheap and enough to show trend). */
function lineDiffCount(before: string | undefined, after: string): number {
  if (before === undefined) return after.split('\n').length;
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  let changed = 0;
  for (const line of a) if (!b.has(line)) changed += 1;
  for (const line of b) if (!a.has(line)) changed += 1;
  return changed;
}

/** Lines added and removed across a list of changed files. */
function linesIn(changes: readonly TreeChange[]): number {
  return changes.reduce((sum, change) => sum + (change.added ?? 0) + (change.removed ?? 0), 0);
}

/**
 * Read the work a judge reviews: the file's content, when the target names
 * one and it is written, and the git workspace's files as a tree, when it is
 * a git repository. The lines changed since the judge last read the work
 * (`previous`) are counted in the file when there is one, and otherwise
 * across the git workspace, from the tree the work began with on the first
 * round.
 */
export async function readJudgedWork(
  dir: string,
  work: JudgeWork,
  previous: { readonly draft?: string; readonly tree?: string },
  excludePaths?: readonly string[],
): Promise<{ draft?: string; changedLines?: number; tree?: string }> {
  const tree = work.base === undefined ? undefined : await workTree({ cwd: dir, ...(excludePaths ? { excludePaths: [...excludePaths] } : {}) });
  const read: { draft?: string; changedLines?: number; tree?: string } = tree === undefined ? {} : { tree };
  if (work.file !== undefined) {
    try {
      const draft = await readFile(join(dir, work.file), 'utf8');
      return { ...read, draft, changedLines: lineDiffCount(previous.draft, draft) };
    } catch {
      return read;
    }
  }
  if (tree === undefined) return read;
  return { ...read, changedLines: linesIn(await treeChanges({ cwd: dir }, previous.tree ?? work.base!, tree)) };
}

/** What the judge reads for one round, built the same way in every form. */
export function judgeState(input: {
  readonly work: JudgeWork;
  readonly draft: string | undefined;
  readonly tree?: string;
  readonly checks?: readonly JudgeCheck[];
  readonly goal?: readonly GoalRequirement[];
  readonly productFeedback: readonly InteractionResponse[];
  readonly latestFindings: readonly FeedbackFinding[];
  readonly skipped: readonly SkippedFinding[];
  readonly rounds: readonly JudgeRound[];
  readonly round: { readonly round: number; readonly cap?: number; readonly lastRound?: true };
}): JudgeState {
  const { work } = input;
  return {
    ...(input.productFeedback.length ? { productFeedback: input.productFeedback } : {}),
    ...(work.brief !== undefined ? { brief: work.brief } : {}),
    ...(work.useCase !== undefined ? { useCase: work.useCase } : {}),
    ...(work.desc !== undefined ? { desc: work.desc } : {}),
    ...(work.gate !== undefined ? { gate: work.gate } : {}),
    ...(work.base !== undefined ? { base: work.base } : {}),
    ...(input.tree !== undefined ? { tree: input.tree } : {}),
    ...(work.file !== undefined ? { file: work.file } : {}),
    ...(input.draft !== undefined ? { draft: input.draft } : {}),
    ...(input.checks?.length ? { checks: input.checks } : {}),
    ...(input.goal?.length ? { goal: input.goal } : {}),
    latestFindings: input.latestFindings,
    ...(input.skipped.length ? { skipped: input.skipped } : {}),
    rounds: input.rounds,
    ...input.round,
  };
}

/**
 * One round of the judge's history, added once the judge has answered it:
 * the round's findings, the lines it changed, the tree the judge read, and
 * what the judge decided. A person's answer to a product decision is
 * recorded as the judge's request for it, with the calls the answer
 * settled — a `pending` finding carries the person's `act` or `hold`, so
 * the count of findings acted on this round is read off what went back.
 */
export function judgeRound(
  state: JudgeState,
  changedLines: number | undefined,
  result: { readonly decision: JudgeDecision } | { readonly state: JudgeState; readonly answer: InteractionResponse },
): JudgeRound {
  const judged = 'decision' in result
    ? { reason: result.decision.reason, ...(result.decision.findings ? { findings: result.decision.findings } : {}) }
    : { reason: `the judge asked a person "${result.state.ask ?? 'What product decision should guide this review?'}" and they answered "${result.answer.prompt}"`, ...(result.state.decided ? { findings: result.state.decided } : {}) };
  return {
    round: state.round, findings: state.latestFindings, counts: countBySeverity(state.latestFindings),
    ...(changedLines !== undefined ? { changedLines } : {}),
    ...(state.tree !== undefined ? { tree: state.tree } : {}),
    judged,
  };
}

/**
 * The goal check's verdicts an outcome carries, when it is a goal check's.
 * With `target`, only a goal check that sends its unmet requirements back
 * to that target counts.
 */
export function goalVerdicts(outcome: Outcome | undefined, target?: string): GoalRequirement[] | undefined {
  const data = outcome?.data as { requirements?: unknown; target?: unknown } | undefined;
  if (target !== undefined && data?.target !== target) return undefined;
  const requirements = data?.requirements;
  if (!Array.isArray(requirements) || !requirements.length) return undefined;
  const valid = requirements.every((item) => item !== null && typeof item === 'object'
    && typeof (item as GoalRequirement).requirement === 'string'
    && ((item as GoalRequirement).verdict === 'met' || (item as GoalRequirement).verdict === 'unmet'));
  return valid ? requirements as GoalRequirement[] : undefined;
}

/** A step's result as a check, when the step is a check (`commandJob`, `gateJob`, a `run:` stage). */
export function checkResult(name: string, job: Job, outcome: Outcome): JudgeCheck | undefined {
  const meta = jobMeta(job);
  if (meta?.kind !== 'gate' || (outcome.data as { skipped?: unknown } | undefined)?.skipped === true) return undefined;
  const output = outcome.status === 'pass' ? undefined : typeof outcome.data === 'string' ? outcome.data : outcome.summary;
  return {
    name,
    ...(typeof meta.command === 'string' ? { command: meta.command } : {}),
    status: outcome.status,
    ...(output !== undefined ? { output } : {}),
  };
}

/** How many characters, as JSON, a judge reads when the run does not say. */
export const DEFAULT_JUDGE_CONTEXT_LIMIT = 50_000;

/** A word of a finding as a path, with a line when one follows it (`src/app.ts:42`, `Dockerfile:12`). */
const CITED = /^(.+?)(?::(\d+)\b.*)?$/;

/** The changed files and lines the findings cite, each once, in the order they are cited. */
function citations(findings: readonly FeedbackFinding[], changed: readonly string[]): { file: string; line?: number }[] {
  const cited = new Map<string, { file: string; line?: number }>();
  for (const finding of findings) {
    for (const word of `${finding.evidence} ${finding.recommendation ?? ''}`.split(/[\s`'"()<>,;]+/)) {
      const match = CITED.exec(word.replace(/[.:!?]+$/, ''));
      if (match === null) continue;
      const named = match[1]!;
      // The whole path; else the longest changed path that the cited one
      // ends with, or that ends with the cited one.
      const file =
        changed.find((path) => path === named) ??
        changed
          .filter((path) => named.endsWith(`/${path}`) || path.endsWith(`/${named}`))
          .reduce<string | undefined>((longest, path) => (longest !== undefined && longest.length >= path.length ? longest : path), undefined);
      if (file === undefined) continue;
      const line = match[2] === undefined ? undefined : Number(match[2]);
      cited.set(`${file}:${line ?? ''}`, { file, ...(line !== undefined ? { line } : {}) });
    }
  }
  return [...cited.values()];
}

/**
 * The hunks of a diff within ten lines of each of `lines`, in the old file
 * or the new one, so a finding that cites a removed line finds its hunk
 * too, with the diff's header; the whole diff when a line is missing.
 */
function hunksNear(diff: string, lines: readonly (number | undefined)[]): string {
  if (lines.length === 0 || lines.some((line) => line === undefined)) return diff;
  const head: string[] = [];
  const hunks: string[][] = [];
  for (const text of diff.split('\n')) {
    if (text.startsWith('@@')) hunks.push([text]);
    else if (hunks.length) hunks.at(-1)!.push(text);
    else head.push(text);
  }
  const within = (start: string, count: string | undefined) =>
    lines.some((line) => line! >= Number(start) - 10 && line! <= Number(start) + (count === undefined ? 1 : Number(count)) + 10);
  const near = hunks.filter(([header]) => {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header!);
    return match !== null && (within(match[1]!, match[2]) || within(match[3]!, match[4]));
  });
  return near.length ? [...head, ...near.flat()].join('\n') : '';
}

/** Words too common to mark a brief line as the one a finding touches. */
const COMMON_WORDS = new Set([
  'about', 'after', 'again', 'before', 'being', 'could', 'every', 'first', 'from',
  'have', 'into', 'just', 'like', 'must', 'only', 'other', 'over', 'page', 'shall',
  'should', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'under', 'what', 'when', 'where', 'which', 'while', 'will', 'with',
  'would', 'your',
  'all', 'and', 'any', 'are', 'can', 'for', 'get', 'has', 'its', 'not', 'now',
  'one', 'our', 'out', 'see', 'the', 'too', 'two', 'use', 'was', 'way', 'who', 'you',
]);

/** The words of a text that could mark a brief line: lowercase, three letters or more, no common words. */
function contentWords(text: string, atLeast: number): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= atLeast && !COMMON_WORDS.has(word)),
  );
}

/** A requirement a finding cites by number: "rule 2", "requirement #3", "item 4". */
const CITED_REQUIREMENT = /\b(?:rule|requirement|req|item|point|step|clause|criterion|section)\s*#?\s*(\d+)\b/gi;

/** The brief line numbered `n`: `2.`, `2)` or `2:` at its start, after any list or heading marker. */
function numberedLine(line: string, n: string): boolean {
  return new RegExp(`^(?:[-*+#>]+\\s*)?(?:\\*\\*)?${n}[.):]`).test(line);
}

/**
 * The lines of the brief a finding touches, recall over precision. A
 * requirement the finding cites by number ("rule 2") keeps the brief line
 * numbered that way; when any cited number matches no numbered line, the
 * finding gets the whole brief, because the line it means cannot be found
 * with confidence. Beside the cited lines, a line counts when it shares a
 * content word with the finding's evidence or recommendation — the
 * finding's words of five letters or more, or the line's own words of
 * three letters or more, so a short-word requirement like "Do not log
 * keys" is kept when the finding breaks it. A finding that touches no line
 * gets the whole brief too. The packet's size limit bounds the whole brief
 * downstream, so a missed match never means no context.
 */
function briefLines(brief: string, finding: FeedbackFinding): string {
  const text = `${finding.evidence} ${finding.recommendation ?? ''}`.toLowerCase();
  const terms = contentWords(text, 5);
  const lines = brief.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const cited = [...text.matchAll(CITED_REQUIREMENT)].map((match) => match[1]!);
  if (cited.some((n) => !lines.some((line) => numberedLine(line, n)))) return brief;
  const kept = lines.filter((line) =>
    cited.some((n) => numberedLine(line, n))
    || [...terms].some((term) => line.toLowerCase().includes(term))
    || [...contentWords(line, 3)].some((word) => text.includes(word)));
  return kept.length ? kept.join('\n') : brief;
}

/** A finding's claim, normalised for comparison: lowercase words, line numbers and punctuation gone. */
function claimOf(finding: FeedbackFinding): string {
  return `${finding.evidence} ${finding.recommendation ?? ''}`
    .toLowerCase()
    .replace(/:\d+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Who raised a finding: its `reviewer`, or the names a synthesised finding carries joined. */
function reviewerOf(finding: FeedbackFinding): string {
  return (finding.reviewer ?? finding.raisedBy?.join(' ') ?? '').toLowerCase();
}

/** The first word of a finding that reads as a file path: it carries a slash or a dotted name. */
function fileOf(finding: FeedbackFinding): string | undefined {
  for (const word of `${finding.evidence} ${finding.recommendation ?? ''}`.split(/[\s`'"()<>,;]+/)) {
    const cleaned = word.replace(/:\d+$/, '').replace(/[.:!?]+$/, '').toLowerCase();
    if (cleaned.includes('/') || /^[\w-]+\.[a-z][a-z0-9]*$/.test(cleaned)) return cleaned;
  }
  return undefined;
}

/**
 * Which of this round's findings repeat an earlier one, worked out in code —
 * no question asks the model to compare rounds. `earlier` carries every
 * finding already raised, open or held back, with the round it came from.
 * A repeat is the same reviewer (its `reviewer`, or a synthesised finding's
 * `raisedBy` joined), the same file (the first path-shaped word in its
 * evidence or recommendation; findings naming none match only each other)
 * and the same claim — the evidence and recommendation normalised to
 * lowercase words, line numbers and punctuation stripped, so a moved line
 * still counts.
 */
export function repeatFindings(
  latest: readonly FeedbackFinding[],
  earlier: readonly { readonly round: number; readonly finding: FeedbackFinding }[],
): RepeatFinding[] {
  const seen = earlier
    .map(({ round, finding }) => ({ round, key: `${reviewerOf(finding)}\n${fileOf(finding) ?? ''}\n${claimOf(finding)}`, claim: claimOf(finding) }))
    .filter(({ claim }) => claim !== '');
  const repeats: RepeatFinding[] = [];
  for (const [index, finding] of latest.entries()) {
    const claim = claimOf(finding);
    if (claim === '') continue;
    const key = `${reviewerOf(finding)}\n${fileOf(finding) ?? ''}\n${claim}`;
    const first = seen.find((entry) => entry.key === key);
    if (first === undefined) continue;
    const reviewer = finding.reviewer ?? (finding.raisedBy?.length ? finding.raisedBy.join(' ') : undefined);
    const file = fileOf(finding);
    repeats.push({
      id: findingId(index),
      sinceRound: first.round,
      ...(reviewer !== undefined ? { reviewer } : {}),
      ...(file !== undefined ? { file } : {}),
    });
  }
  return repeats;
}

/** The whole of one part of the packet, kept to at most `cap` characters, and a plain note of each cut. */
function capped(cap: number) {
  const cut: string[] = [];
  return {
    cut,
    text(value: string | undefined, what: string): string | undefined {
      if (value === undefined || value.length <= cap) return value;
      cut.push(cap === 0 ? `${what}: left out (${value.length} characters)` : `${what}: kept the first ${cap} of ${value.length} characters`);
      return cap === 0 ? undefined : value.slice(0, cap);
    },
    /** A list, measured as JSON, kept whole items at a time from its start, or from its end for `latest`; undefined when none fit. */
    list<T>(items: readonly T[] | undefined, what: string, unit: string, latest = false): T[] | undefined {
      if (items === undefined || JSON.stringify(items).length <= cap) return items && [...items];
      const kept: T[] = [];
      let size = 2;
      for (const item of latest ? [...items].reverse() : items) {
        size += JSON.stringify(item).length + (kept.length ? 1 : 0);
        if (size > cap) break;
        kept.push(item);
      }
      if (!kept.length) {
        cut.push(`${what}: left out (${items.length} ${unit})`);
        return undefined;
      }
      cut.push(`${what}: kept the ${latest ? 'last' : 'first'} ${kept.length} of ${items.length} ${unit}`);
      return latest ? kept.reverse() : kept;
    },
  };
}

/** What the judge reads with no part longer than `cap` characters, and the notes of what that cut. */
function packetWithin(full: JudgePacket, cap: number, cutWhenLists: boolean): JudgePacket {
  const size = capped(cap);
  const { why, what, how, when: { rounds: allRounds, skipped: allSkipped, changedSinceLastRound: allSince, ...place } } = full;
  const text = (key: 'useCase' | 'desc' | 'gate', name: string) => {
    const value = size.text(why[key], name);
    return value !== undefined ? { [key]: value } : {};
  };
  const productFeedback = size.list(why.productFeedback, 'a person\'s earlier answers', 'answers', true);
  const changedFiles = size.list(what.changedFiles, 'the list of changed files', 'files');
  const draft = size.text(what.draft, `the content of ${what.file}`);
  const checks = how.checks?.map(({ output, ...check }) => {
    const kept = size.text(output, `the output of the check "${check.name}"`);
    return kept !== undefined ? { ...check, output: kept } : check;
  });
  const goal = size.list(how.goal, 'the goal check\'s verdicts', 'verdicts');
  // The finding itself is never cut; the brief excerpt and the diff hunk
  // attached to it are the prose a limit cuts first.
  const findings = how.findings.map(({ brief, diff, ...finding }) => {
    const keptBrief = size.text(brief, `the brief lines finding ${finding.id} touches`);
    const keptDiff = size.text(diff, `the diff hunk for finding ${finding.id}`);
    return {
      ...finding,
      ...(keptBrief !== undefined ? { brief: keptBrief } : {}),
      ...(keptDiff !== undefined ? { diff: keptDiff } : {}),
    };
  });
  // The round history is cut after every prose part: lists keep whole
  // items, the latest first. The numbers and the repeats are never cut.
  const rounds = cutWhenLists ? size.list(allRounds, 'the earlier rounds', 'rounds', true) ?? [] : [...allRounds];
  const skipped = cutWhenLists ? size.list(allSkipped, 'the findings skipped before', 'findings', true) : allSkipped && [...allSkipped];
  const since = cutWhenLists ? size.list(allSince, 'the list of files changed since the last round', 'files') : allSince && [...allSince];
  return {
    why: {
      ...text('useCase', 'the use case'), ...text('desc', 'the desc'), ...text('gate', 'the gate'),
      ...(productFeedback !== undefined ? { productFeedback } : {}),
    },
    what: {
      ...(changedFiles !== undefined ? { changedFiles } : {}),
      ...(what.file !== undefined ? { file: what.file } : {}),
      ...(draft !== undefined ? { draft } : {}),
    },
    how: {
      ...(checks ? { checks } : {}),
      ...(goal !== undefined ? { goal } : {}),
      findings,
    },
    when: {
      ...place,
      rounds,
      ...(skipped !== undefined ? { skipped } : {}),
      ...(since !== undefined ? { changedSinceLastRound: since } : {}),
    },
    ...(size.cut.length ? { cut: size.cut } : {}),
  };
}

/**
 * Keep the packet to `limit` characters as JSON. When it is longer, every
 * part `packetWithin` names that is longer than one shared length is cut
 * to it, with the length found by a binary search so that the packet fits.
 * A short part is cut only when cutting the long ones is not enough.
 * The brief excerpts and the diff hunks go before the round lists: the
 * earlier rounds, the findings held back before and the files changed
 * since the last round are cut only when cutting the prose cannot fit it,
 * and then they keep their latest items. The findings to decide are never
 * cut, nor are the computed counts and repeats in `when`, so when they and
 * the names, numbers and commands around them pass the limit on their own,
 * the packet stays over it and says so.
 */
function fitPacket(full: JudgePacket, limit: number): JudgePacket {
  const fits = (packet: JudgePacket) => JSON.stringify(packet).length <= limit;
  if (fits(full)) return full;
  const search = (cutWhenLists: boolean): JudgePacket | undefined => {
    if (!fits(packetWithin(full, 0, cutWhenLists))) return undefined;
    let low = 0;
    let high = JSON.stringify(full).length;
    while (low < high) {
      const cap = Math.ceil((low + high) / 2);
      if (fits(packetWithin(full, cap, cutWhenLists))) low = cap;
      else high = cap - 1;
    }
    return packetWithin(full, low, cutWhenLists);
  };
  // First fit keeps the round lists whole while prose is cut; only when no
  // cap can do that are the lists cut too.
  const packet = search(false) ?? search(true);
  if (packet !== undefined) return packet;
  const least = packetWithin(full, 0, true);
  return { ...least, cut: [...least.cut ?? [], 'what is left is never cut, so the packet is over the limit: the findings to decide, and the names, numbers and commands around them'] };
}

/**
 * Assemble what the judge reads, in code: why the work exists, what changed,
 * how this round went, and where the rounds stand, kept to `limit`
 * characters as `fitPacket` says, with `cut` naming each cut. Each finding
 * carries the brief lines it touches and every diff hunk it cites; the whole
 * brief and the diff bundle are not sent. `when` carries the counts and the
 * repeats the runtime computed, so no question asks the model to count or
 * compare rounds. `thisRoundActed` is this round's own acted-on count: once
 * the per-finding scores are decided it goes into `actedOnThisRound`, and
 * `actedCountFalling` compares it against the last judged round.
 */
export async function judgePacket(state: JudgeState, dir: string, limit: number, thisRoundActed?: number): Promise<JudgePacket> {
  const git = { cwd: dir };
  const changed = state.base !== undefined && state.tree !== undefined ? await treeChanges(git, state.base, state.tree) : [];
  const changedPaths = changed.map(({ path }) => path);
  // Every hunk the finding cites rides it: a finding that names two changed
  // places — a caller and its callee, say — gets both, while diffs it never
  // cites stay out.
  const diffsFor = async (finding: FeedbackFinding): Promise<string | undefined> => {
    if (!changed.length) return undefined;
    const cites = citations([finding], changedPaths);
    const parts: string[] = [];
    for (const file of new Set(cites.map((cite) => cite.file))) {
      const lines = cites.filter((cite) => cite.file === file).map((cite) => cite.line);
      const diff = hunksNear(await treeDiff(git, state.base!, state.tree!, file), lines);
      if (diff !== '') parts.push(diff);
    }
    return parts.length ? parts.join('\n') : undefined;
  };
  const findings = await Promise.all(state.latestFindings.map(async (finding, index) => {
    const brief = state.brief === undefined ? undefined : briefLines(state.brief, finding);
    const diff = await diffsFor(finding);
    return {
      id: findingId(index), ...finding,
      ...(brief !== undefined ? { brief } : {}),
      ...(diff !== undefined ? { diff } : {}),
    };
  }));
  const earlier = [
    ...state.rounds.flatMap((entry) => entry.findings.map((finding) => ({ round: entry.round, finding }))),
    ...(state.skipped ?? []).map(({ round, finding }) => ({ round, finding })),
  ];
  const repeats = repeatFindings(state.latestFindings, earlier);
  const previous = state.rounds.at(-1)?.tree;
  const limitLine = roundLimit(state);
  const since = previous !== undefined && state.tree !== undefined ? await treeChanges(git, previous, state.tree) : undefined;
  const actedIn = (entry: (typeof state.rounds)[number] | undefined) =>
    entry?.judged?.findings?.filter((finding) => finding.decision === 'act').length;
  // The counts compare build rounds, the same way the spent cap does: a
  // second send-back judging this same build is this round's own earlier
  // review, not the round its count falls from.
  const judgedRounds = state.rounds.filter((entry) => entry.judged !== undefined && entry.round < state.round);
  const lastActed = actedIn(judgedRounds.at(-1));
  const beforeActed = actedIn(judgedRounds.at(-2));
  return fitPacket({
    why: {
      ...(state.useCase !== undefined ? { useCase: state.useCase } : {}),
      ...(state.desc !== undefined ? { desc: state.desc } : {}),
      ...(state.gate !== undefined ? { gate: state.gate } : {}),
      ...(state.productFeedback?.length ? { productFeedback: state.productFeedback } : {}),
    },
    what: {
      ...(state.tree !== undefined ? { changedFiles: changed } : {}),
      ...(state.file !== undefined ? { file: state.file } : {}),
      ...(state.draft !== undefined ? { draft: state.draft } : {}),
    },
    how: {
      ...(state.checks?.length ? { checks: state.checks } : {}),
      ...(state.goal?.length ? { goal: state.goal } : {}),
      findings,
    },
    when: {
      round: state.round,
      ...(state.cap !== undefined ? { cap: state.cap } : {}),
      ...(state.lastRound ? { lastRound: true as const } : {}),
      ...(limitLine !== undefined ? { limit: limitLine } : {}),
      openFindings: state.latestFindings.length,
      ...(thisRoundActed !== undefined ? { actedOnThisRound: thisRoundActed } : {}),
      ...(lastActed !== undefined ? { actedOnLastRound: lastActed } : {}),
      ...(beforeActed !== undefined ? { actedOnRoundBefore: beforeActed } : {}),
      // With this round's count the fall is against the last round; without
      // it (the findings are not decided yet) the two completed ones compare.
      ...(thisRoundActed !== undefined
        ? lastActed !== undefined ? { actedCountFalling: thisRoundActed < lastActed } : {}
        : lastActed !== undefined && beforeActed !== undefined ? { actedCountFalling: lastActed < beforeActed } : {}),
      ...(repeats.length ? { repeats } : {}),
      rounds: state.rounds.map(({ round, counts, changedLines, judged }) => ({
        round, counts,
        ...(changedLines !== undefined ? { changedLines } : {}),
        ...(judged?.findings !== undefined ? { acted: judged.findings.filter((finding) => finding.decision === 'act').length } : {}),
        ...(judged ? { decision: judged.reason } : {}),
      })),
      ...(state.skipped?.length ? { skipped: state.skipped } : {}),
      ...(since !== undefined ? { changedSinceLastRound: since } : {}),
    },
  }, limit);
}

export interface JudgeDecision {
  /** Send the work back for another round. */
  readonly again: boolean;
  /** Always names the judge, so a kickback or a stop is traceable to it. */
  readonly reason: string;
  /**
   * What a stop means, when `again` is false. `ship`: the work holds as it
   * is, so it stands as a pass carrying the judge's reason. `fail`: another
   * round will not fix it, so the run stops there and the requesting side's
   * own failure stands. `product_decision` asks a person, then sends the work
   * back to the builder with their answer as another round; the judge is
   * asked again only after that round is reviewed. `person` is the same
   * hand-off for an answer too weak to act on or a `none_applies` — the
   * judge's answer could not be trusted to route the run, so a person
   * decides instead. After the last round a
   * cap allows, a change the person asks for on an answered product
   * decision buys one more round, marked `productDecision` on the
   * send-back; an answer that holds every finding, or approves the work
   * naming none to act on, sends nothing back and lets the work stand.
   * Absent when `again` is true.
   */
  readonly stop?: 'ship' | 'fail' | 'product_decision' | 'person';
  /** The question a `product_decision` or `person` stop puts to the person. */
  readonly ask?: string;
  /**
   * Set on an `again` a spent cap still pays for: fewer findings were acted
   * on than the round before, so the cap grants one more round. The caller
   * records the grant on the send-back so the rounds rule lets it through.
   */
  readonly converging?: true;
  /**
   * Set on a `product_decision` the spent cap itself raised: the judge still
   * acted on findings and their count was not falling, so a person is asked
   * whether the run goes on. Their call on each finding decides it (see
   * `personCalls`): a finding they hold joins `minorFindings`, and the
   * acted findings they do not hold go back in a round past the cap, like
   * a judge-chosen product decision's. When they hold every acted finding,
   * or approve the work naming none to act on, nothing goes back and the
   * work stands as a pass.
   */
  readonly capPause?: true;
  /**
   * The answer that decided the route: the chosen reason (`stop_reason:
   * continue`), the probability answer it fell back to
   * (`worth_another_round: 0.49`), the count of findings acted on and held
   * back (`findings: 1 act, 2 held`), or `no clear answer`.
   */
  readonly rule: string;
  /** The decision on each finding, when the judge decides each finding. */
  readonly findings?: readonly FindingDecision[];
  /**
   * This round's findings that do not go back to the builder. Each carries
   * its id, the level the judge scored it and the answer's confidence, and
   * the judge's reason. For a person to read before the work lands.
   */
  readonly minorFindings?: readonly FeedbackFinding[];
}

/** A `noul` or `probability` answer's value, when it is a number in [0,1]. */
function noulValue(answer: JudgeAnswer | undefined): number | undefined {
  const value = answer?.noul ?? answer?.probability;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * How sure an answer is, in [0,1]. The `confidence` the engine reports wins;
 * a probability spread's confidence is the share on the top option. An
 * answer that carries neither reads 0 — missing confidence is uncertain,
 * never confident, so it never clears a bar.
 */
function answerConfidence(answer: JudgeAnswer | undefined): number {
  const reported = answer?.confidence;
  if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && reported <= 1) return reported;
  const given = answer?.probabilities;
  if (given === undefined || given === null) return 0;
  const shares = Array.isArray(given)
    ? given.map((entry) => entry?.probability)
    : Object.values(given);
  return shares.reduce<number>((top, share) =>
    typeof share === 'number' && Number.isFinite(share) && share >= 0 && share <= 1 && share > top ? share : top, 0);
}

/** The level a `score` answer lands on, and how sure it is — undefined when the answer names no usable score. */
function scoreCall(question: JudgeQuestion | undefined, answer: JudgeAnswer | undefined): { level: FindingLevel; confidence: number } | undefined {
  if (question?.type !== 'score' || answer === undefined || answer === null) return undefined;
  const levels = question.criteria;
  let score: number | undefined;
  if (typeof answer.score === 'number' && Number.isFinite(answer.score)) score = answer.score;
  else {
    const given = answer.probabilities;
    if (Array.isArray(given)) {
      // A {label, probability} per level: the weighted level index.
      let weight = 0;
      let total = 0;
      for (const entry of given) {
        const index = entry !== null && typeof entry === 'object' ? levels.indexOf((entry as { label?: unknown }).label as string) : -1;
        const share = (entry as { probability?: unknown } | null)?.probability;
        if (index === -1 || typeof share !== 'number' || !Number.isFinite(share)) continue;
        weight += index * share;
        total += share;
      }
      if (total > 0) score = weight / total;
    } else if (given !== null && typeof given === 'object') {
      let weight = 0;
      let total = 0;
      for (const [index, level] of levels.entries()) {
        const share = (given as Record<string, unknown>)[level];
        if (typeof share !== 'number' || !Number.isFinite(share)) continue;
        weight += index * share;
        total += share;
      }
      if (total > 0) score = weight / total;
    }
  }
  if (score === undefined) return undefined;
  const level = FINDING_LEVELS[Math.min(Math.max(Math.round(score), 0), FINDING_LEVELS.length - 1)]!;
  return { level, confidence: answerConfidence(answer) };
}

/**
 * Route on the judge's answers, every action gated on the answer's
 * confidence (the bars live in `JUDGE_CONFIDENCE`). A `product_decision`
 * the judge is sure of — or cannot rule out — asks a person first. The
 * chosen `stop_reason` routes the ending when there is one, at or above the
 * hand-off bar; `none_applies` and any answer under it go to a person, as
 * does an ending (`holds`, `over_polishing`, `not_converging` or any other
 * named stop) under the stop bar. A confident `continue` runs another
 * round; a `continue` that ends the run — every finding held back — clears
 * the stop bar the same way, and under it a person decides. A clear
 * `holds`, `worth_doing` or `worth_another_round` noul
 * decides only a question set without `stop_reason`, under the same bars.
 * An answer that decides nothing hands the round to a person: fail closed.
 * The cap is not checked here: `askJudge` turns a decision after
 * the last review the cap allows into a stop.
 *
 * For a terminal stop, `holds` and `over_polishing` say
 * the work is good enough as it stands, so it ships as a pass; other stops, including
 * `not_converging` and any choice a custom question set invents of its own,
 * say the run should not ship silently, so it stops there and the
 * requesting side's failure stands.
 *
 * With `findingIds`, the per-finding scores decide whether work goes back;
 * the round answer still settles `product_decision` and, when nothing goes
 * back, the ending (see `decideEachFinding`). `questions` are the questions
 * each finding was asked; an answer with no reason of its own records the
 * level it landed on. `judged` names the round's findings and its round: a
 * finding the judge holds back stays with the judge, and it is collected on
 * `minorFindings` too.
 */
export function judgeDecision(
  answers: Readonly<Record<string, JudgeAnswer>>,
  findingIds?: readonly string[],
  questions?: JudgeQuestions,
  judged?: { readonly findings: readonly FeedbackFinding[]; readonly round: number },
): JudgeDecision {
  const round = roundDecision(answers);
  if (!findingIds?.length) return round;
  return decideEachFinding(answers, findingIds, round, questions, judged);
}

/**
 * Route on the judge's score for each finding. A `product_decision` or a
 * `person` hand-off the round answer asks for stands, with the per-finding
 * decisions attached: a pause the round needs is never traded for another
 * build, however sure the findings' scores are. Otherwise a finding scored
 * `impactful` or `blocking` at or over the send-back bar for its level runs
 * another round — but only while every answered finding's answer clears the
 * hand-off floor: an answer under it can route the finding neither back nor
 * to the held list, so it is marked `pending` and the round pauses for a
 * person with the judge's calls attached; their call sends each pending
 * finding back with its evidence or keeps it on the held list. When no
 * finding goes back, the round
 * answer decides how the work stands: a gated `holds`, `over_polishing` or
 * `not_converging` ships it as a pass with the held findings attached — a
 * run never ends short while no finding the judge acts on is open — and a
 * `continue` that clears the stop bar with nothing to send back lets the
 * work stand too, a weaker one a person.
 *
 * Every held-back finding of the round is collected on `minorFindings`,
 * with its level and confidence, for a person to read before the work
 * lands; a `pending` one is not collected — it is not a settled call. The
 * judge's own answer routes the finding: the reviewer's severity tag only
 * informs what it reads.
 *
 * `askJudge` checks every asked question is answered before it decides, so
 * a call through it never reaches the fallbacks here. They stand for a
 * caller deciding on answers it did not check — one read back from a
 * record, say: a finding with no usable answer follows the round answer
 * (it goes back when that answer runs another round, and is held back when
 * it stops), and answers naming no finding at all let the round answer
 * route alone, with the same reason and rule as before.
 */
function decideEachFinding(
  answers: Readonly<Record<string, JudgeAnswer>>,
  findingIds: readonly string[],
  round: JudgeDecision,
  questions?: JudgeQuestions,
  judged?: { readonly findings: readonly FeedbackFinding[]; readonly round: number },
): JudgeDecision {
  const call = (id: string) => scoreCall(questions?.[id], answers[id]);
  const findings = findingIds.map((id): FindingDecision => {
    const scored = call(id);
    if (scored === undefined) {
      return { id, decision: round.again ? 'act' : 'hold', reason: `no answer for this finding; ${round.reason}` };
    }
    const { level, confidence } = scored;
    // The level decides whether the finding can go back at all; the bar it
    // must clear is the send-back one for its level. An answer under the
    // hand-off floor settles nothing: the call is `pending`, routed neither
    // back nor onto the held list.
    const bar = level === 'blocking' ? JUDGE_CONFIDENCE.sendBackBlocking : JUDGE_CONFIDENCE.sendBack;
    const acts = (level === 'impactful' || level === 'blocking') && confidence >= bar;
    const reason = typeof answers[id]?.reason === 'string' && answers[id]!.reason!.trim() ? answers[id]!.reason!.trim() : LEVEL_REASON[level];
    return { id, decision: acts ? 'act' : confidence < JUDGE_CONFIDENCE.handOff ? 'pending' : 'hold', level, confidence, reason };
  });
  const answered = findingIds.some((id) => call(id) !== undefined);
  // A judge that answered no finding decided nothing about them: every finding stands, as with whole-round judging.
  if (!answered) return round;
  // The collected list keeps only settled calls: a `pending` finding is not
  // held, it is waiting on a person.
  const collected = findings.flatMap((item, index) =>
    item.decision === 'hold' && judged?.findings[index] !== undefined
      ? [{
        ...judged.findings[index]!, id: item.id, judgeReason: item.reason, round: judged.round,
        ...(item.level !== undefined ? { judgeLevel: item.level } : {}),
        ...(item.confidence !== undefined ? { judgeConfidence: item.confidence } : {}),
      }]
      : []);
  const minorFindings = collected.length ? { minorFindings: collected } : {};
  const acted = findings.filter((finding) => finding.decision === 'act').length;
  const pending = findings.filter((finding) => finding.decision === 'pending');
  const rule = `findings: ${acted} act, ${findings.length - acted - pending.length} held${pending.length ? `, ${pending.length} pending` : ''}`;
  // A person being asked anyway still gets the judge's calls on each
  // finding, and pending findings ride the pause whatever raised it — the
  // person's call routes each of them; the pause stands over any acted
  // finding.
  if (round.stop === 'product_decision' || round.stop === 'person') {
    return pending.length
      ? { ...round, ask: `${round.ask} ${pendingAsk(pending.map(({ id }) => id))}`, findings, ...minorFindings }
      : { ...round, findings, ...minorFindings };
  }
  // A pending finding routes neither way, so a person decides the round,
  // with the judge's calls attached; the person's call sends each one back
  // with its evidence or keeps it on the held list.
  if (pending.length) {
    const ids = pending.map((finding) => finding.id).join(', ');
    return {
      ...handOff(
        `the judge's answers for ${ids} came under the ${JUDGE_CONFIDENCE.handOff} hand-off bar`,
        rule,
        `The judge's answers for ${ids} came under the bar that lets them route a finding. ${pendingAsk(pending.map(({ id }) => id))}`,
      ),
      findings,
      ...minorFindings,
    };
  }
  if (acted) return { again: true, reason: `the judge acts on ${acted} of ${findings.length} findings`, rule, findings, ...minorFindings };
  // Nothing goes back: a gated ending lets the work stand. One that would
  // fail — a confident `not_converging` — ships instead, with the held
  // findings attached: failing with no finding the judge acts on open would
  // end the run short. A `continue` with nothing to send back lets the work
  // stand as a pass too. That ending needs the stop bar like any other: the
  // answer asking for another round must clear it, and under it a person
  // decides.
  if (!round.again && round.stop === 'fail') {
    return { again: false, stop: 'ship', reason: `the judge held every finding back; ${round.reason}`, rule, findings, ...minorFindings };
  }
  if (!round.again) return { ...round, findings, ...minorFindings };
  const keepGoing = answers.stop_reason?.choice === 'continue'
    ? answerConfidence(answers.stop_reason)
    : noulValue(answers.worth_another_round) ?? 0;
  if (keepGoing < JUDGE_CONFIDENCE.stop) {
    const asked = answers.stop_reason?.choice === 'continue' ? 'continue' : 'worth_another_round';
    return {
      ...handOff(
        `the judge's ${asked} came at ${keepGoing.toFixed(2)} confidence, under the ${JUDGE_CONFIDENCE.stop} stop bar`,
        rule,
        `The judge answered "${asked}" at ${keepGoing.toFixed(2)} confidence, under the bar for ending a run, but no finding goes back. Does the work stand, or does the run end another way?`,
      ),
      findings,
      ...minorFindings,
    };
  }
  return { again: false, stop: 'ship', reason: 'the judge held every finding back', rule, findings, ...minorFindings };
}

/** A stop that hands the round to a person: the answer could not be trusted to route it. */
function handOff(reason: string, rule: string, ask: string): JudgeDecision {
  return { again: false, stop: 'person', reason, rule, ask };
}

/**
 * What a pause asks about each pending finding: the person's call routes
 * it — `"act"` sends it back to the builder, `"hold"` or no call keeps it
 * back — and with nothing sent back the work stands rather than buying a
 * build.
 */
function pendingAsk(ids: readonly string[]): string {
  return `For each finding the judge could not route — ${ids.join(', ')} — name "act" or "hold" under its id in feedback.findings; a finding no call names is held. If no finding goes back, the work stands.`;
}

function roundDecision(answers: Readonly<Record<string, JudgeAnswer>>): JudgeDecision {
  const product = noulValue(answers.product_decision);
  // A product question the judge is sure of asks a person — and so does one
  // it cannot rule out either way, because a product question left open is
  // worse than a person asked.
  if (product !== undefined && product > 1 - JUDGE_CONFIDENCE.handOff) {
    return {
      again: false,
      stop: 'product_decision',
      reason: product >= JUDGE_CONFIDENCE.handOff
        ? `the judge says a person must settle a product decision (${product.toFixed(2)})`
        : `the judge could not say whether a product decision is needed (${product.toFixed(2)})`,
      rule: `product_decision: ${product.toFixed(2)}`,
      ask: 'What product decision should guide this review?',
    };
  }
  const choice = answers.stop_reason?.choice;
  if (typeof choice === 'string') {
    const rule = `stop_reason: ${choice}`;
    const confidence = answerConfidence(answers.stop_reason);
    if (choice === 'none_applies') {
      return handOff(
        'the judge found no option that fits how to end the rounds',
        rule,
        'The judge found no option that fits how to end these rounds. What should happen?',
      );
    }
    if (confidence < JUDGE_CONFIDENCE.handOff) {
      return handOff(
        `the judge's answer ${choice} came at ${confidence.toFixed(2)} confidence, under the ${JUDGE_CONFIDENCE.handOff} hand-off bar`,
        rule,
        `The judge answered "${choice}" at ${confidence.toFixed(2)} confidence, under the bar that lets it route the round. What should happen?`,
      );
    }
    if (choice === 'continue') return { again: true, reason: 'the judge chose continue', rule };
    if (confidence < JUDGE_CONFIDENCE.stop) {
      return handOff(
        `the judge chose ${choice} at ${confidence.toFixed(2)} confidence, under the ${JUDGE_CONFIDENCE.stop} stop bar`,
        rule,
        `The judge answered "${choice}" at ${confidence.toFixed(2)} confidence, under the bar for ending a run. Should the run end, and how?`,
      );
    }
    const ship = choice === 'holds' || choice === 'over_polishing';
    return { again: false, stop: ship ? 'ship' : 'fail', reason: `the judge chose ${choice}`, rule };
  }
  // The named probability answers route a set that has no stop_reason, each
  // under its bar; a named answer under every bar goes to a person.
  const holds = noulValue(answers.holds);
  const doing = noulValue(answers.worth_doing);
  const worth = noulValue(answers.worth_another_round);
  if (holds !== undefined && holds >= JUDGE_CONFIDENCE.stop) {
    return { again: false, stop: 'ship', reason: `the judge says it holds (${holds.toFixed(2)})`, rule: `holds: ${holds.toFixed(2)}` };
  }
  if (doing !== undefined && 1 - doing >= JUDGE_CONFIDENCE.stop) {
    return { again: false, stop: 'ship', reason: `the judge says the findings are not worth doing (${doing.toFixed(2)})`, rule: `worth_doing: ${doing.toFixed(2)}` };
  }
  if (worth !== undefined && 1 - worth >= JUDGE_CONFIDENCE.stop) {
    return { again: false, stop: 'fail', reason: `the judge says another round is not worth it (${worth.toFixed(2)})`, rule: `worth_another_round: ${worth.toFixed(2)}` };
  }
  if (worth !== undefined && worth >= JUDGE_CONFIDENCE.handOff) {
    return { again: true, reason: `the judge says another round is worth it (${worth.toFixed(2)})`, rule: `worth_another_round: ${worth.toFixed(2)}` };
  }
  if (holds !== undefined || doing !== undefined || worth !== undefined) {
    return handOff(
      'the judge\'s answers are under every bar that would route the round',
      'no clear answer',
      'The judge\'s answers did not clearly decide the round. What should happen?',
    );
  }
  return handOff(
    'the judge gave no clear answer',
    'no clear answer',
    'The judge gave no clear answer on how the round should end. What should happen?',
  );
}

/**
 * The line the judge reads about the round limit: none with no cap, the
 * last round a cap allows when only a granted round follows this review,
 * and a granted round — on either, a change the person asks for on an
 * answered product decision buys one more round. Absent otherwise.
 */
function roundLimit(state: JudgeState): string | undefined {
  if (state.cap === undefined) return 'No round limit: the rounds end when you stop them or the review passes.';
  if (!state.lastRound) return undefined;
  if (state.round > state.cap + 1) {
    return `This is a round granted past the cap of ${state.cap}: on a product decision, a change the person asks for still buys one more round; every other answer decides how this ends.`;
  }
  return `This is the last round the cap of ${state.cap} allows (${state.cap} ${state.cap === 1 ? 'refinement' : 'refinements'} after the first build): on a product decision, a change the person asks for buys exactly one more round; every other answer decides how this ends.`;
}

/**
 * What the spent cap does with the judge's decision on the review of the
 * last build it allowed. A stop that lets the work stand passes, and a
 * product decision still asks a person. A judge that still acts on findings
 * goes back for one more round while their count is falling from the round
 * before (`converging`, granted); when it is not falling a person is asked
 * instead, with the round's findings and the judge's calls on them attached
 * (`capPause`, a product decision the cap itself raised). Anything else is
 * a stop that fails, with the cap named: a whole-round `continue` or
 * `not_converging` with nothing acted on ends there, so a run never ends as
 * a silent fail while findings the judge called impactful are still open.
 */
function atTheCap(decided: JudgeDecision, state: JudgeState): JudgeDecision {
  if (decided.stop === 'ship' || decided.stop === 'product_decision' || decided.stop === 'person') return decided;
  const acted = decided.findings?.filter((finding) => finding.decision === 'act').length ?? 0;
  if (decided.again && acted > 0) {
    // The round before is the previous build's judged round: a later entry
    // for this same round is another review of this build, not the round
    // its count should fall from.
    const before = state.rounds.findLast((entry) => entry.round < state.round)?.judged?.findings?.filter((finding) => finding.decision === 'act').length;
    if (before !== undefined && acted < before) {
      return { ...decided, converging: true, reason: `${decided.reason}; the cap of ${state.cap} is spent, and the findings acted on fell from ${before} to ${acted}: one more round is granted` };
    }
    const ids = decided.findings?.filter((finding) => finding.decision === 'act').map(({ id }) => id) ?? [];
    return {
      ...decided,
      again: false,
      stop: 'product_decision',
      capPause: true,
      ask: `The cap of rounds is spent and the findings the judge would act on are not falling: what should the builder do about them? Name "act" or "hold" under each finding id in feedback.findings (${ids.join(', ')}). A finding you hold joins minorFindings. One you name nothing for goes back with your answer, unless you approve the work. If nothing goes back, the work stands as a pass.`,
      reason: `${decided.reason}; the cap of ${state.cap} is spent and the findings acted on are not falling${before === undefined ? '' : ` (${before} the round before, ${acted} now)`}: a person decides`,
    };
  }
  return { ...decided, again: false, stop: 'fail', reason: `${decided.reason}; this was the last round the cap of ${state.cap} allows` };
}

/**
 * Ask the judge, and record its answer. Runs `cfg.seat` as a workspace-mode-
 * none agent turn over the packet `judgePacket` builds from `state`, parses
 * the reply as the judge engine's own `{ [question]: JudgeAnswer }` shape,
 * and emits `refine:judge` with the `target` it decides about, the round
 * and the packet's size and cuts, so a person reading the record sees what
 * it answered and why. The packet's `when` carries `limit`, a line about
 * the round limit, when there is no cap or this is the last round.
 *
 * When the judge decides each finding, the round is two asks of one batched
 * call each: the generated per-finding `score` questions go first, then the
 * round questions (`cfg.questions`) over a packet whose `when` already
 * carries `actedOnThisRound`, the count those answers decided. With no
 * per-finding questions it is one call over the complete question set.
 *
 * What the judge was sent is recorded first (`refine:judge-request`,
 * every string scrubbed), so a call that never comes back still leaves the
 * request. A call that ends in any status but pass, a reply that does not
 * parse as an answers object, and a reply that leaves an asked question
 * without a usable answer each end the judge step with a visible failure
 * kept in `paused`: the engine's own error for a failed call, a validation
 * error for a bad reply — never empty answers routed as `no clear answer`,
 * never another build bought by a judge that did not decide.
 *
 * After the last review the cap allows (`state.lastRound`), `atTheCap`
 * rewrites the decision: only a stop that lets the work stand passes, and
 * it records the open findings; a `product_decision` still asks a person; a
 * still-acting judge is granted one more round while the count it acts on
 * falls, and is asked through a person when it does not; anything else is a
 * stop that fails, with the cap named in the reason.
 */
export async function askJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
  target: string,
): Promise<{ answers: Readonly<Record<string, JudgeAnswer>>; decision: JudgeDecision } | { paused: Outcome }> {
  const perFinding = cfg.perFinding && state.latestFindings.length > 0;
  const eachFinding = perFinding ? findingQuestions(state.latestFindings) : undefined;
  const limit = ctx.judgeContextLimit ?? DEFAULT_JUDGE_CONTEXT_LIMIT;
  let effective: AgentResult['effective'] | undefined;
  const env = resolveEnv(ctx);
  /**
   * One batched call to the judge, recorded before it runs. The `stopped`
   * shapes a pause that keeps the real failure: a call that ends in any
   * status but pass, a reply that does not parse as an answers object, and
   * a reply that leaves an asked question without a usable answer each end
   * the judge step with a visible failure — never empty answers routed as
   * `no clear answer`, never another build bought by a judge that did not
   * decide.
   */
  const ask = async (packet: JudgePacket, questions: JudgeQuestions): Promise<{ answers: Record<string, JudgeAnswer> } | { paused: Outcome }> => {
    const keptQuestions = scrubbed(questions, env);
    ctx.emit({
      kind: 'refine:judge-request', ts: Date.now(), path: [...path], target, round: state.round,
      // What a replay groups requests by: the questions asked and the
      // options that shape the decision, not the run that asked them.
      identity: interactionIdentity({ questions: keptQuestions, cap: cfg.cap, perFinding: cfg.perFinding }),
      packet: scrubbed(packet, env), questions: keptQuestions, seat: cfg.seat.identity,
    });
    const judgeJob = agentJob({
      label: 'refine:judge',
      engine: cfg.seat.engine,
      model: cfg.seat.identity.model,
      workspaceMode: 'none',
      tools: [],
      leaf: true,
      onResult: (result) => { effective = result.effective; },
      prompt: JSON.stringify({ state: packet, questions }),
    });
    // The skipped findings ride in the packet; the prompt stays the JSON above.
    const outcome = await judgeJob({ ...ctx, depth: ctx.depth + 1, path: [...path, 'refine-judge'], skippedFindings: undefined });
    const stopped = (error: LoopError, rule: string): { paused: Outcome } => {
      ctx.emit({
        kind: 'refine:judge', ts: Date.now(), path: [...path], target, round: state.round,
        answers: {}, reason: error.message, route: 'stop', status: 'paused', rule,
        failure: { code: error.code, message: error.message },
        packet: { size: JSON.stringify(packet).length, ...(packet.cut ? { cut: packet.cut } : {}) },
        ...(effective === undefined ? {} : { effective }),
      });
      return { paused: { status: 'paused', summary: error.message, error } };
    };
    if (outcome.status !== 'pass') {
      return stopped(outcome.error ?? new LoopError({
        code: 'ENGINE', phase: 'review', path: [...path],
        message: outcome.summary ?? 'the judge call produced no usable result',
      }), 'call failed');
    }
    let answers: Record<string, JudgeAnswer>;
    try {
      const parsed: unknown = JSON.parse(String(outcome.data ?? ''));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an answers object');
      }
      answers = parsed as Record<string, JudgeAnswer>;
    } catch {
      return stopped(new LoopError({
        code: 'VALIDATION', phase: 'review', path: [...path],
        message: 'the judge\'s reply did not parse as a JSON object of answers',
      }), 'unreadable reply');
    }
    // Each asked question must hold a usable answer for its type — a
    // probability in [0,1] for a `noul`, one of the question's named
    // choices for a `choice`, and for a `score` either the rating the
    // engine reports (a finite `score`) or a probability per named
    // criterion. A reply that misses one, or fills it with something the
    // question does not ask for, is a failure, not a decision.
    const inRange = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    const answered = (key: string): boolean => {
      const question = questions[key];
      const answer = answers[key];
      if (question === undefined || answer === null || typeof answer !== 'object') return false;
      if (question.type === 'noul') return inRange(answer.noul ?? answer.probability);
      if (question.type === 'choice') {
        return typeof answer.choice === 'string' && Object.hasOwn(question.criteria, answer.choice);
      }
      if (typeof answer.score === 'number' && Number.isFinite(answer.score)) return true;
      const given: unknown = answer.probabilities;
      // The Decisions API lists one {label, probability} per level, and Jev
      // keys the same probabilities by criterion: either maps each named
      // criterion to a probability in [0,1].
      if (Array.isArray(given)) {
        return question.criteria.every((criterion) => given.some((entry) =>
          entry !== null && typeof entry === 'object'
          && (entry as { label?: unknown }).label === criterion
          && inRange((entry as { probability?: unknown }).probability)));
      }
      return given !== null && typeof given === 'object'
        && question.criteria.every((criterion) => inRange((given as Record<string, unknown>)[criterion]));
    };
    const missing = Object.keys(questions).filter((key) => !answered(key));
    if (missing.length > 0) {
      return stopped(new LoopError({
        code: 'VALIDATION', phase: 'review', path: [...path],
        message: `the judge's reply held no usable answer for ${missing.length} of the ${Object.keys(questions).length} questions it was asked: ${missing.join(', ')}`,
      }), 'missing answers');
    }
    // Only the answers to this call's own questions count: an answer the
    // round call gives to a finding it was not asked never replaces the
    // finding's score from the call that asked it.
    return { answers: Object.fromEntries(Object.keys(questions).map((key) => [key, answers[key]!])) };
  };
  let answers: Record<string, JudgeAnswer> = {};
  let packet = await judgePacket(state, ctx.workspace.dir, limit);
  if (eachFinding !== undefined) {
    // The per-finding scores go first: the calls they decide give this
    // round's acted count, which the round questions then read as a number
    // in `when.actedOnThisRound` — no question asks the model to count or
    // compare rounds.
    const findings = await ask(packet, eachFinding);
    if ('paused' in findings) return findings;
    answers = findings.answers;
    const scored = judgeDecision(findings.answers, Object.keys(eachFinding), eachFinding,
      { findings: state.latestFindings, round: state.round });
    const thisRound = scored.findings?.filter((finding) => finding.decision === 'act').length ?? 0;
    packet = await judgePacket(state, ctx.workspace.dir, limit, thisRound);
  }
  const round = await ask(packet, cfg.questions);
  if ('paused' in round) return round;
  answers = { ...answers, ...round.answers };
  const decided = judgeDecision(answers, eachFinding ? Object.keys(eachFinding) : undefined, eachFinding,
    { findings: state.latestFindings, round: state.round });
  const decision: JudgeDecision = state.lastRound ? atTheCap(decided, state) : decided;
  const status = decision.stop === 'ship' ? 'pass' : decision.stop === 'fail' ? 'fail' : undefined;
  ctx.emit({
    kind: 'refine:judge', ts: Date.now(), path: [...path], target, round: state.round, answers, reason: decision.reason,
    route: decision.again ? 'again' : 'stop', rule: decision.rule, ...(status ? { status } : {}),
    packet: { size: JSON.stringify(packet).length, ...(packet.cut ? { cut: packet.cut } : {}) },
    ...(effective === undefined ? {} : { effective }),
    ...(decision.findings ? { findings: decision.findings } : {}),
    ...(decision.minorFindings?.length ? { minorFindings: decision.minorFindings } : {}),
    ...(state.lastRound && decision.stop === 'ship' ? { openFindings: state.latestFindings } : {}),
  });
  return { answers, decision };
}

/**
 * Ask the judge, or resume its pending product question. When the judge
 * chooses `product_decision`, or the spent cap raises one (`capPause`), a
 * person is asked, and their answer comes back as `answer` for the caller
 * to send to the builder; the judge is not asked again until that round has
 * been built and reviewed. After the last review the cap allows, the person
 * is still asked, and a change they ask for buys one more round, each time
 * one is asked and answered (`productDecisionFeedback` marks it
 * `productDecision`); an answer that sends nothing back lets the work
 * stand as a pass.
 */
export async function consultJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
  options: { readonly target: string; readonly identity: string; readonly pending: boolean; readonly save: (state: JudgeState, retry?: boolean) => void },
): Promise<{ state: JudgeState; decision: JudgeDecision } | { state: JudgeState; paused: Outcome } | { state: JudgeState; answer: InteractionResponse }> {
  let asked = state;
  if (!options.pending) {
    const judged = await askJudge(cfg, state, ctx, path, options.target);
    if ('paused' in judged) {
      // A failed judge is retried for the same round on resume: the saved
      // state replays the completed panel and re-asks the judge; it does
      // not wait on a person the way a product decision does.
      options.save(state, true);
      return { state, paused: judged.paused };
    }
    const { decision } = judged;
    if (decision.stop !== 'product_decision' && decision.stop !== 'person') return { state, decision };
    // Kept with the question, so a resumed run still knows which findings
    // the judge would act on, whether the spent cap raised the question, and
    // whether the ask is a hand-off for an answer too weak to act on.
    asked = {
      ...state,
      ...(decision.findings ? { decided: decision.findings } : {}),
      ...(decision.capPause === true ? { capPause: true as const } : {}),
      ask: decision.ask ?? 'What product decision should guide this review?',
      ...(decision.stop === 'person' ? { handoff: true as const } : {}),
    };
  }
  options.save(asked);
  const answer = await requestInteraction(cfg.interaction ?? DEFAULT_INTERACTION,
    asked.ask ?? 'What product decision should guide this review?', jsonSnapshot({
      requester: { path, identity: options.identity, engine: cfg.seat.identity, round: state.round },
      material: asked,
    }), ctx);
  if ('paused' in answer) return { state: asked, paused: answer.paused };
  return {
    state: {
      ...asked,
      ...(asked.decided !== undefined ? { decided: personCalls(answer.response, asked.decided) } : {}),
      productFeedback: [...(asked.productFeedback ?? []), answer.response],
    },
    answer: answer.response,
  };
}

/**
 * The call a person's answer settles on each finding of the round:
 * `feedback.findings` may name `"act"` (it goes back to the builder) or
 * `"hold"` (it joins `minorFindings`) per finding id, and that call wins
 * over the judge's. A pending finding the answer does not name is held:
 * the person was asked about it by id, so silence never sends unsure work
 * back. A finding the judge acted on that the answer does not name goes
 * back with the answer, unless the answer is an approval
 * (`decision: "approved"`), which holds it. The judge's level, confidence
 * and reason stay on the resolved call, so the round's record still says
 * how the judge called it; a call the person turned round says so.
 */
function personCalls(response: InteractionResponse, decided: readonly FindingDecision[]): readonly FindingDecision[] {
  const feedback = response.feedback;
  const named = feedback !== null && typeof feedback === 'object' && !Array.isArray(feedback)
    ? (feedback as { findings?: unknown }).findings : undefined;
  const calls = named !== null && typeof named === 'object' && !Array.isArray(named) ? named as Record<string, unknown> : undefined;
  return decided.map((item): FindingDecision => {
    const call = calls?.[item.id];
    const decision = call === 'act' || call === 'hold' ? call
      : item.decision === 'pending' || (item.decision === 'act' && response.decision === 'approved') ? 'hold'
      : item.decision;
    if (decision === item.decision) return item;
    return { ...item, decision, ...(item.decision === 'pending' ? {} : { reason: `a person called it ${decision}; the judge: ${item.reason}` }) };
  });
}

/**
 * The next round's feedback after a person answers the judge's ask: it
 * says it is their decision, quotes their prompt, lists the review findings
 * it answers, and carries their whole response as structured feedback.
 * `granted` marks the round the cap could not pay for: the person was asked
 * after the last review the cap allows, so this one round was granted for
 * their answer, and the send-back says so. `handoff` marks the ask as a
 * hand-off — the judge's answer was under its bar or named no fitting
 * option, so the person decided the route — instead of a product decision.
 */
export function productDecisionFeedback(
  answer: InteractionResponse,
  findings: readonly FeedbackFinding[],
  over: { readonly target?: string; readonly source?: string; readonly granted?: boolean; readonly handoff?: boolean } = {},
): Outcome {
  const { granted, handoff, ...route } = over;
  const reason = handoff === true
    ? `The judge's answer was not trusted to route this round, so a person was asked. Apply their call in this round.${granted ? ' It was granted past the cap.' : ''} Their call: "${answer.prompt}"`
    : `A person made a product decision about the findings below. Apply it in this round.${granted ? ' It was granted for a product answer, past the cap.' : ''} Their decision: "${answer.prompt}"`;
  const outcome = revisionRequest({ ...route, reason, findings: [...findings] }, { data: answer });
  return granted === true ? { ...outcome, productDecision: true } : outcome;
}

/**
 * The list a person reads before the work lands: every finding the judge
 * held back, each with the judge's reason for holding it and the round it
 * was held back in. The skipped list keeps them across rounds, so it is
 * also where they are collected from.
 */
export function minorFindings(skipped: readonly SkippedFinding[]): FeedbackFinding[] {
  return skipped
    .map(({ finding, reason, round, level, confidence }) => ({
      ...finding, judgeReason: reason, round,
      ...(level !== undefined ? { judgeLevel: level } : {}),
      ...(confidence !== undefined ? { judgeConfidence: confidence } : {}),
    }));
}

/**
 * What the judge's decisions on a round's findings send on: the findings
 * acted on, each carrying its reason, and the skipped list grown by this
 * round's held-back findings. A finding the judge acted on is the judge's
 * own call; one a person sent back over the judge's unsure answer keeps
 * the level and confidence of that call — an acted call under the
 * hand-off floor could only have got there by a person. A round the judge
 * did not decide
 * each finding of sends every finding and holds none back.
 */
export function judgedFindings(
  findings: readonly FeedbackFinding[],
  decision: Pick<JudgeDecision, 'findings'>,
  skipped: readonly SkippedFinding[],
  round: number,
): { acted: FeedbackFinding[]; skipped: SkippedFinding[] } {
  if (!decision.findings) return { acted: [...findings], skipped: [...skipped] };
  const acted: FeedbackFinding[] = [];
  const next = [...skipped];
  for (const [index, finding] of findings.entries()) {
    const item = decision.findings[index]!;
    if (item.decision === 'act') {
      acted.push({
        ...finding, judgeReason: item.reason, id: item.id,
        ...(item.confidence !== undefined && item.confidence < JUDGE_CONFIDENCE.handOff
          ? { ...(item.level !== undefined ? { judgeLevel: item.level } : {}), judgeConfidence: item.confidence }
          : {}),
      });
      continue;
    }
    // The same finding raised again keeps one entry, with the latest judgment.
    const earlier = next.findIndex((entry) => entry.finding.evidence === finding.evidence);
    const held: SkippedFinding = {
      round, finding, reason: item.reason,
      ...(item.level !== undefined ? { level: item.level } : {}),
      ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
    };
    if (earlier === -1) next.push(held);
    else next[earlier] = held;
  }
  return { acted, skipped: next };
}
