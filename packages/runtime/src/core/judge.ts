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
  SkippedFinding,
} from './types.js';

export type {
  FindingDecision,
  Judge,
  JudgeAnswer,
  JudgeCheck,
  JudgePacket,
  JudgeQuestion,
  JudgeQuestions,
  JudgeRound,
  JudgeWork,
  SkippedFinding,
} from './types.js';

/**
 * The default question set: does the work hold for this use case, are the
 * latest findings worth doing, is another round worth it, and why stop. A
 * caller's own set replaces this wholesale (e.g. for a use case this
 * wording doesn't fit); `what` names the thing being judged in the wording.
 */
export function stopQuestions(what = 'the draft'): JudgeQuestions {
  return {
    holds: {
      type: 'noul',
      instructions: `For this use case, does ${what} hold as it stands?`,
      criteria: {
        true: 'The latest findings are nits, taste or nothing, and a reader of this kind of work would not notice what remains.',
        false: 'The latest findings include a block, or shoulds a reader of this kind of work would notice.',
      },
    },
    worth_doing: {
      type: 'noul',
      instructions: 'Read the latest findings themselves. For this use case, are they worth acting on?',
      criteria: {
        true: 'They name things a reader of this kind of work would stumble on, misread or distrust.',
        false: 'They are taste, edge cases, or polish past the bar the use case sets; acting on them would not change what a reader gets.',
      },
    },
    worth_another_round: {
      type: 'noul',
      instructions: 'Given the whole history and whether the latest findings are worth doing, is another round worth it?',
      criteria: {
        true: 'The findings are worth doing, and the rounds so far have fixed what was found, so one more pass would land them.',
        false: 'The findings are not worth doing for this use case; or the same class of finding keeps returning; or the change between rounds is small; or the work is being polished past the bar.',
      },
    },
    stop_reason: {
      type: 'choice',
      instructions: 'If a person must settle a product decision, choose product_decision. Otherwise, are we at the point of diminishing returns? If so, which kind; if not, continue.',
      criteria: {
        holds: `${what} holds for this use case.`,
        over_polishing: 'The remaining findings are taste, nits or edge cases past the bar.',
        not_converging: 'The same class of finding keeps returning, so another round will not fix it.',
        continue: 'Another round is worth it.',
        product_decision: 'A person must settle a product decision before this review can continue.',
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
 * asks the judge to call each finding as well: in round 1 whether to act on
 * it or skip it, and from round 2 on whether it is impactful or minor. It
 * defaults to true with the default questions and to false with a caller's
 * own.
 * A finding the judge does not act on never goes back to the builder; it is
 * collected on `minorFindings` for a person to read before the work lands.
 * A `product_decision` the judge asks after the last review the cap allows
 * buys one more round for the person's answer, marked `productDecision` —
 * each time one is asked and answered, so the answer always reaches the
 * builder.
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

/** What `act` and `skip` mean in round 1's per-finding question. */
const ACT_CRITERIA = {
  act: 'A reader of this kind of work would stumble on, misread or distrust what this finding names, so the builder should fix it.',
  skip: 'It is taste, an edge case, or polish past the bar the use case sets, so fixing it would not change what a reader gets.',
} as const;

/** What `act` and `skip` mean for a finding tagged block in round 1: the bar to skip it is higher. */
const ACT_BLOCK_CRITERIA = {
  act: 'The case this finding names is part of how the work is really used, so the builder should fix it.',
  skip: 'The case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered.',
} as const;

/** What yes and no mean in each per-finding question from round 2 on: an impactful finding against a minor one. */
const FINDING_CRITERIA = {
  true: 'Impactful: behaviour wrong under normal use, a requirement of the brief unmet, a test that cannot fail, or a risk of data loss, a security hole or a broken rule of the work, so the builder should fix it.',
  false: 'Minor: wording of docs or comments, style, naming, an edge case outside real use, or a nice-to-have, so fixing it would not change what a reader gets.',
} as const;

/**
 * A finding's id within its round: `finding-1` for the first finding in the
 * round's list, and so on. The list is saved with a pending question, so the
 * ids stay the same after a resume.
 */
export function findingId(index: number): string {
  return `finding-${index + 1}`;
}

/** What yes and no mean for a finding tagged block from round 2 on: the bar to call it minor is higher. */
const BLOCK_CRITERIA = {
  true: 'Impactful: the case this finding names is part of how the work is really used, so the builder should fix it.',
  false: 'Minor: the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered.',
} as const;

/**
 * One question per finding, keyed by the finding's id. Round 1 keeps the
 * act/skip call — whether the finding should send the work back for another
 * round or be skipped — and from round 2 on the same call is asked as a
 * yes/no question: is the finding impactful, or minor. A block's question
 * sets the higher bar for holding it back, in either wording.
 */
export function findingQuestions(findings: readonly FeedbackFinding[], round?: number): JudgeQuestions {
  const questions: Record<string, JudgeQuestion> = {};
  for (const [index, finding] of findings.entries()) {
    const severity = normalizeFeedbackSeverity(finding.severity);
    const recommendation = finding.recommendation ? ` Recommendation: ${finding.recommendation}` : '';
    // Round 1 asks the act/skip call with its own bar; from round 2 on the
    // same call is asked as yes/no, with the minor bar on a block.
    const bar = round === 1
      ? (severity === 'block'
        ? 'It is tagged block, so the bar to skip it is higher. Skip it only when the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered; otherwise act.'
        : 'For this use case, should the builder act on it in another round, or skip it?')
      : (severity === 'block'
        ? 'It is tagged block, so the bar to call it minor is higher. Call it minor only when the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered; otherwise it is impactful.'
        : 'For this use case, is it impactful enough that the builder should act on it in another round?');
    questions[findingId(index)] = round === 1
      ? {
        type: 'choice',
        instructions: `Read this one finding. ${bar} Give a one-line reason. Finding [${severity}]: ${finding.evidence}${recommendation}`,
        criteria: severity === 'block' ? ACT_BLOCK_CRITERIA : ACT_CRITERIA,
      }
      : {
        type: 'noul',
        instructions: `Read this one finding. ${bar} Give a one-line reason. Finding [${severity}]: ${finding.evidence}${recommendation}`,
        criteria: severity === 'block' ? BLOCK_CRITERIA : FINDING_CRITERIA,
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
  /** The judge's decision on each finding of the round it sent to a person, so the answer reaches the builder with the findings those decisions send back. */
  readonly decided?: readonly FindingDecision[];
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
 * recorded as the judge's request for it, with the decisions it had made.
 */
export function judgeRound(
  state: JudgeState,
  changedLines: number | undefined,
  result: { readonly decision: JudgeDecision } | { readonly state: JudgeState; readonly answer: InteractionResponse },
): JudgeRound {
  const judged = 'decision' in result
    ? { reason: result.decision.reason, ...(result.decision.findings ? { findings: result.decision.findings } : {}) }
    : { reason: `the judge requested a product decision, and a person answered "${result.answer.prompt}"`, ...(result.state.decided ? { findings: result.state.decided } : {}) };
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
 * The hunks of a diff within ten lines of `line`, in the old file or the new
 * one, so a finding that cites a removed line finds its hunk too, with the
 * diff's header; the whole diff with no line.
 */
function hunksNear(diff: string, line: number | undefined): string {
  if (line === undefined) return diff;
  const head: string[] = [];
  const hunks: string[][] = [];
  for (const text of diff.split('\n')) {
    if (text.startsWith('@@')) hunks.push([text]);
    else if (hunks.length) hunks.at(-1)!.push(text);
    else head.push(text);
  }
  const within = (start: string, count: string | undefined) =>
    line >= Number(start) - 10 && line <= Number(start) + (count === undefined ? 1 : Number(count)) + 10;
  const near = hunks.filter(([header]) => {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header!);
    return match !== null && (within(match[1]!, match[2]) || within(match[3]!, match[4]));
  });
  return near.length ? [...head, ...near.flat()].join('\n') : '';
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
function packetWithin(full: JudgePacket, cap: number): JudgePacket {
  const size = capped(cap);
  const { why, what, how, when: { rounds: allRounds, skipped: allSkipped, changedSinceLastRound: allSince, ...place } } = full;
  const text = (key: 'brief' | 'useCase' | 'desc' | 'gate', name: string) => {
    const value = size.text(why[key], name);
    return value !== undefined ? { [key]: value } : {};
  };
  const productFeedback = size.list(why.productFeedback, 'a person\'s earlier answers', 'answers', true);
  const changedFiles = size.list(what.changedFiles, 'the list of changed files', 'files');
  const diffs = (what.diffs ?? []).flatMap(({ file, line, diff }) => {
    const kept = size.text(diff, `the diff around ${line === undefined ? file : `${file}:${line}`}`);
    return kept === undefined ? [] : [{ file, ...(line !== undefined ? { line } : {}), diff: kept }];
  });
  const draft = size.text(what.draft, `the content of ${what.file}`);
  const checks = how.checks?.map(({ output, ...check }) => {
    const kept = size.text(output, `the output of the check "${check.name}"`);
    return kept !== undefined ? { ...check, output: kept } : check;
  });
  const goal = size.list(how.goal, 'the goal check\'s verdicts', 'verdicts');
  const rounds = size.list(allRounds, 'the earlier rounds', 'rounds', true) ?? [];
  const skipped = size.list(allSkipped, 'the findings skipped before', 'findings', true);
  const since = size.list(allSince, 'the list of files changed since the last round', 'files');
  return {
    why: {
      ...text('brief', 'the brief'), ...text('useCase', 'the use case'), ...text('desc', 'the desc'), ...text('gate', 'the gate'),
      ...(productFeedback !== undefined ? { productFeedback } : {}),
    },
    what: {
      ...(changedFiles !== undefined ? { changedFiles } : {}),
      ...(diffs.length ? { diffs } : {}),
      ...(what.file !== undefined ? { file: what.file } : {}),
      ...(draft !== undefined ? { draft } : {}),
    },
    how: {
      ...(checks ? { checks } : {}),
      ...(goal !== undefined ? { goal } : {}),
      findings: how.findings,
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
 * A list keeps whole items: the earlier rounds and the findings skipped
 * before keep the latest. The findings to decide are never cut, so when they
 * and the names, numbers and commands around them pass the limit on their
 * own, the packet stays over it and says so.
 */
function fitPacket(full: JudgePacket, limit: number): JudgePacket {
  const fits = (packet: JudgePacket) => JSON.stringify(packet).length <= limit;
  if (fits(full)) return full;
  const least = packetWithin(full, 0);
  if (!fits(least)) {
    return { ...least, cut: [...least.cut ?? [], 'what is left is never cut, so the packet is over the limit: the findings to decide, and the names, numbers and commands around them'] };
  }
  let low = 0;
  let high = JSON.stringify(full).length;
  while (low < high) {
    const cap = Math.ceil((low + high) / 2);
    if (fits(packetWithin(full, cap))) low = cap;
    else high = cap - 1;
  }
  return packetWithin(full, low);
}

/**
 * Assemble what the judge reads, in code: why the work exists, what changed,
 * how this round went, and where the rounds stand, kept to `limit`
 * characters as `fitPacket` says, with `cut` naming each cut.
 */
export async function judgePacket(state: JudgeState, dir: string, limit: number): Promise<JudgePacket> {
  const git = { cwd: dir };
  const changed = state.base !== undefined && state.tree !== undefined ? await treeChanges(git, state.base, state.tree) : [];
  const diffs: { file: string; line?: number; diff: string }[] = [];
  for (const { file, line } of changed.length ? citations(state.latestFindings, changed.map(({ path }) => path)) : []) {
    const diff = hunksNear(await treeDiff(git, state.base!, state.tree!, file), line);
    if (diff) diffs.push({ file, ...(line !== undefined ? { line } : {}), diff });
  }
  const previous = state.rounds.at(-1)?.tree;
  const limitLine = roundLimit(state);
  const since = previous !== undefined && state.tree !== undefined ? await treeChanges(git, previous, state.tree) : undefined;
  return fitPacket({
    why: {
      ...(state.brief !== undefined ? { brief: state.brief } : {}),
      ...(state.useCase !== undefined ? { useCase: state.useCase } : {}),
      ...(state.desc !== undefined ? { desc: state.desc } : {}),
      ...(state.gate !== undefined ? { gate: state.gate } : {}),
      ...(state.productFeedback?.length ? { productFeedback: state.productFeedback } : {}),
    },
    what: {
      ...(state.tree !== undefined ? { changedFiles: changed } : {}),
      ...(diffs.length ? { diffs } : {}),
      ...(state.file !== undefined ? { file: state.file } : {}),
      ...(state.draft !== undefined ? { draft: state.draft } : {}),
    },
    how: {
      ...(state.checks?.length ? { checks: state.checks } : {}),
      ...(state.goal?.length ? { goal: state.goal } : {}),
      findings: state.latestFindings.map((finding, index) => ({ id: findingId(index), ...finding })),
    },
    when: {
      round: state.round,
      ...(state.cap !== undefined ? { cap: state.cap } : {}),
      ...(state.lastRound ? { lastRound: true as const } : {}),
      ...(limitLine !== undefined ? { limit: limitLine } : {}),
      rounds: state.rounds.map(({ round, findings, counts, changedLines, judged }) => ({
        round, counts,
        ...(changedLines !== undefined ? { changedLines } : {}),
        ...(judged ? { decision: judged.reason } : {}),
        findings: findings.map((finding, index) => {
          const decided = judged?.findings?.[index];
          return decided ? { ...finding, decision: decided.decision, reason: decided.reason } : finding;
        }),
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
   * asked again only after that round is reviewed. After the last round a
   * cap allows, each answered product decision buys one more round, marked
   * `productDecision` on the send-back. Absent when `again` is true.
   */
  readonly stop?: 'ship' | 'fail' | 'product_decision';
  /**
   * Set on an `again` a spent cap still pays for: fewer findings were acted
   * on than the round before, so the cap grants one more round. The caller
   * records the grant on the send-back so the rounds rule lets it through.
   */
  readonly converging?: true;
  /**
   * Set on a `product_decision` the spent cap itself raised: the judge still
   * acted on findings and their count was not falling, so a person is asked
   * whether the run goes on. Their answer buys a round past the cap like a
   * judge-chosen product decision's does.
   */
  readonly capPause?: true;
  /**
   * The answer that decided the route: the chosen reason (`stop_reason:
   * continue`), the probability answer it fell back to
   * (`worth_another_round: 0.49`), the count of findings acted on and
   * skipped (`findings: 1 act, 2 skip`), or `no clear answer`.
   */
  readonly rule: string;
  /** The decision on each finding, when the judge decides each finding. */
  readonly findings?: readonly FindingDecision[];
  /**
   * This round's findings that do not go back to the builder: the findings
   * the judge skipped in round 1 or called minor from round 2 on. Each
   * carries its id and the judge's reason. For a person to read before the
   * work lands.
   */
  readonly minorFindings?: readonly FeedbackFinding[];
}

/**
 * Route on the judge's answers. The chosen `stop_reason` decides when there is
 * one: in use it moves with the rounds while the probability answers stay
 * flat, so it is the answer that discriminates. A chosen `continue` runs
 * another round whatever the probability answers say. A clear yes or no from
 * `holds`, `worth_doing` or `worth_another_round` decides only when there is
 * no choice: a question set without `stop_reason`, or a `stop_reason`
 * answer that is not a choice. The cap is not checked here: `askJudge` turns a decision after
 * the last review the cap allows into a stop. A block finding is decided
 * here like any other.
 *
 * `product_decision` pauses for a person's answer, which goes to the builder
 * as the next round. For a terminal stop, `holds` and `over_polishing` say
 * the work is good enough as it stands, so it ships as a pass; other stops, including
 * `not_converging` and any choice a custom question set invents of its own,
 * says the run should not ship silently, so it stops there and the
 * requesting side's failure stands. The same split applies to the
 * probability fallback: a clear `holds` or a clear "not worth doing" ships
 * the work; an unclear "another round is not worth it" fails instead of
 * shipping, since its own criteria already blend polish with a stall and
 * cannot tell the two apart.
 *
 * With `findingIds`, the round answer routes as above only to settle
 * `product_decision`; the answer for each finding decides the rest (see
 * `decideEachFinding`). `questions` are the questions each finding was
 * asked; an answer with no reason of its own records the text of that
 * answer from its finding's question. `judged` names the round's findings
 * and its round: a finding the judge holds back stays with the judge, and
 * it is collected on `minorFindings` too.
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
 * Route on the judge's answer for each finding. `product_decision` stands as
 * the round answer gives it. Otherwise any finding the judge calls
 * impactful runs another round, and a round whose findings are all held
 * back ships as a pass, whatever the round answer says: a chosen
 * `not_converging` does not drop a finding the judge called impactful, and
 * it does not fail a round whose findings are all held back.
 *
 * A finding the judge holds back is recorded `skip` in round 1 and `minor`
 * from round 2 on; neither goes back to the builder. Every held-back
 * finding of the round is collected on `minorFindings` for a person to
 * read before the work lands, so a stop answer can let the work stand as a
 * pass with the collected list attached. The judge's own answer routes the
 * finding: the reviewer's severity tag only informs what it reads, never
 * what a yes or a no does.
 *
 * `askJudge` checks every asked question is answered before it decides, so
 * a call through it never reaches the fallbacks here. They stand for a
 * caller deciding on answers it did not check — one read back from a
 * record, say: a finding with no usable answer follows the round answer
 * (it goes back when that answer runs another round, and is held back when
 * it ships), and answers naming no finding at all let the round answer
 * route alone, with the same reason and rule as before.
 */
function decideEachFinding(
  answers: Readonly<Record<string, JudgeAnswer>>,
  findingIds: readonly string[],
  round: JudgeDecision,
  questions?: JudgeQuestions,
  judged?: { readonly findings: readonly FeedbackFinding[]; readonly round: number },
): JudgeDecision {
  // The call a finding's answer makes: a round-1 `choice` names `act` or
  // `skip` outright; from round 2 on a `noul` at or above the middle calls
  // the finding impactful. Any other shape is no answer for the finding.
  const call = (id: string): boolean | undefined => {
    const answer = answers[id];
    if (answer?.choice === 'act') return true;
    if (answer?.choice === 'skip') return false;
    const value = answer?.noul ?? answer?.probability;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value >= 0.5 : undefined;
  };
  // A held-back finding is `skip` in round 1 and `minor` from round 2 on;
  // neither goes back to the builder.
  const heldBack = judged !== undefined && judged.round >= 2 ? 'minor' as const : 'skip' as const;
  const findings = findingIds.map((id): FindingDecision => {
    const answer = answers[id];
    const impactful = call(id);
    if (impactful === undefined) {
      return { id, decision: round.again ? 'act' : heldBack, reason: `no answer for this finding; ${round.reason}` };
    }
    // A reason the judge gave stands; else the text of the answer it chose
    // is recorded: the named criterion of a `choice`, the true or false
    // text of a `noul`.
    const reason = typeof answer?.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : undefined;
    const question = questions?.[id];
    const chosen = question?.type === 'choice' && typeof answer?.choice === 'string' ? question.criteria[answer.choice] : undefined;
    const criteria = question?.type === 'noul' ? question.criteria : FINDING_CRITERIA;
    return { id, decision: impactful ? 'act' : heldBack, reason: reason ?? chosen ?? (impactful ? criteria.true : criteria.false) };
  });
  const answered = findingIds.some((id) => call(id) !== undefined);
  // A judge that answered no finding decided nothing about them: every finding stands, as with whole-round judging.
  if (!answered) return round;
  const collected = findings.flatMap((item, index) =>
    item.decision !== 'act' && judged?.findings[index] !== undefined
      ? [{ ...judged.findings[index]!, id: item.id, judgeReason: item.reason, round: judged.round }]
      : []);
  const minorFindings = collected.length ? { minorFindings: collected } : {};
  if (round.stop === 'product_decision') return { ...round, findings, ...minorFindings };
  const acted = findings.filter((finding) => finding.decision === 'act').length;
  const minors = findings.filter((finding) => finding.decision === 'minor').length;
  const rule = `findings: ${acted} act, ${findings.length - acted - minors} skip${minors ? `, ${minors} minor` : ''}`;
  if (acted) return { again: true, reason: `the judge acts on ${acted} of ${findings.length} findings`, rule, findings, ...minorFindings };
  const stood = judged?.round === 1 ? 'the judge skipped every finding' : 'the judge found only minor findings';
  return { again: false, stop: 'ship', reason: stood, rule, findings, ...minorFindings };
}

function roundDecision(answers: Readonly<Record<string, JudgeAnswer>>): JudgeDecision {
  const worth = answers.worth_another_round?.noul ?? answers.worth_another_round?.probability;
  const doing = answers.worth_doing?.noul ?? answers.worth_doing?.probability;
  const holds = answers.holds?.noul ?? answers.holds?.probability;
  const choice = answers.stop_reason?.choice;
  if (choice !== undefined) {
    const rule = `stop_reason: ${choice}`;
    if (choice === 'continue') return { again: true, reason: 'the judge chose continue', rule };
    if (choice === 'product_decision') return { again: false, stop: 'product_decision', reason: 'the judge requested a product decision', rule };
    return { again: false, stop: choice === 'holds' || choice === 'over_polishing' ? 'ship' : 'fail', reason: `the judge chose ${choice}`, rule };
  }
  if (typeof holds === 'number' && holds >= 0.5) {
    return { again: false, stop: 'ship', reason: `the judge says it holds (${holds.toFixed(2)})`, rule: `holds: ${holds.toFixed(2)}` };
  }
  if (typeof doing === 'number' && doing < 0.5) {
    return { again: false, stop: 'ship', reason: `the judge says the findings are not worth doing (${doing.toFixed(2)})`, rule: `worth_doing: ${doing.toFixed(2)}` };
  }
  if (typeof worth === 'number' && worth < 0.5) {
    return { again: false, stop: 'fail', reason: `the judge says another round is not worth it (${worth.toFixed(2)})`, rule: `worth_another_round: ${worth.toFixed(2)}` };
  }
  return {
    again: true,
    reason: `the judge says another round is worth it${typeof worth === 'number' ? ` (${worth.toFixed(2)})` : ''}`,
    rule: typeof worth === 'number' ? `worth_another_round: ${worth.toFixed(2)}` : 'no clear answer',
  };
}

/**
 * The line the judge reads about the round limit: none with no cap, the
 * last round a cap allows when only a granted round follows this review,
 * and a granted round — each answered product decision buys one more round
 * for a person's answer on either. Absent otherwise.
 */
function roundLimit(state: JudgeState): string | undefined {
  if (state.cap === undefined) return 'No round limit: the rounds end when you stop them or the review passes.';
  if (!state.lastRound) return undefined;
  if (state.round > state.cap + 1) {
    return `This is a round granted past the cap of ${state.cap}: a product decision still buys one more round for the person's answer; every other answer decides how this ends.`;
  }
  return `This is the last round the cap of ${state.cap} allows (${state.cap} ${state.cap === 1 ? 'refinement' : 'refinements'} after the first build): a product decision buys exactly one more round for the person's answer; every other answer decides how this ends.`;
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
  if (decided.stop === 'ship' || decided.stop === 'product_decision') return decided;
  const acted = decided.findings?.filter((finding) => finding.decision === 'act').length ?? 0;
  if (decided.again && acted > 0) {
    // The round before is the previous build's judged round: a later entry
    // for this same round is another review of this build, not the round
    // its count should fall from.
    const before = state.rounds.findLast((entry) => entry.round < state.round)?.judged?.findings?.filter((finding) => finding.decision === 'act').length;
    if (before !== undefined && acted < before) {
      return { ...decided, converging: true, reason: `${decided.reason}; the cap of ${state.cap} is spent, and the findings acted on fell from ${before} to ${acted}: one more round is granted` };
    }
    return {
      ...decided,
      again: false,
      stop: 'product_decision',
      capPause: true,
      reason: `${decided.reason}; the cap of ${state.cap} is spent and the findings acted on are not falling${before === undefined ? '' : ` (${before} the round before, ${acted} now)`}: a person decides`,
    };
  }
  return { ...decided, again: false, stop: 'fail', reason: `${decided.reason}; this was the last round the cap of ${state.cap} allows` };
}

/**
 * Ask the judge, and record its answer. Runs `cfg.seat` as a workspace-mode-
 * none agent turn over the packet `judgePacket` builds from `state` and over
 * the complete question set (`cfg.questions` plus the generated per-finding
 * ones), parses the reply as the judge engine's own
 * `{ [question]: JudgeAnswer }` shape, and emits `refine:judge` with the
 * `target` it decides about, the round and the packet's size and cuts, so a
 * person reading the record sees what it answered and why. The packet's
 * `when` carries `limit`, a line about the round limit, when there is no cap
 * or this is the last round. When the judge decides
 * each finding, the questions also carry one per finding in
 * `state.latestFindings`.
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
  const eachFinding = perFinding ? findingQuestions(state.latestFindings, state.round) : undefined;
  const packet = await judgePacket(state, ctx.workspace.dir, ctx.judgeContextLimit ?? DEFAULT_JUDGE_CONTEXT_LIMIT);
  const questions: JudgeQuestions = eachFinding ? { ...cfg.questions, ...eachFinding } : cfg.questions;
  let effective: AgentResult['effective'] | undefined;
  const env = resolveEnv(ctx);
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
  // A stopped judge step: the event keeps the original failure, the paused
  // outcome carries it to the node.
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
  // The required answers are the questions the judge was asked: the round
  // questions and the generated per-finding ones. Each must hold a usable
  // answer for its type — a probability in [0,1] for a `noul`, one of the
  // question's named choices for a `choice`, and for a `score` either the
  // rating the engine reports (a finite `score`) or a probability per
  // named criterion. A reply that misses one, or fills it with something
  // the question does not ask for, is a failure, not a decision.
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
 * is still asked, and the caller buys one more round for their answer, each
 * time one is asked and answered (`productDecisionFeedback` marks it
 * `productDecision`).
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
    if (decision.stop !== 'product_decision') return { state, decision };
    // Kept with the question, so a resumed run still knows which findings
    // the judge would act on, and whether the spent cap raised the question.
    asked = {
      ...state,
      ...(decision.findings ? { decided: decision.findings } : {}),
      ...(decision.capPause === true ? { capPause: true as const } : {}),
    };
  }
  options.save(asked);
  const answer = await requestInteraction(cfg.interaction ?? DEFAULT_INTERACTION,
    asked.capPause === true
      ? 'The cap of rounds is spent and the findings the judge would act on are not falling: what should the builder do about them?'
      : 'What product decision should guide this review?', jsonSnapshot({
      requester: { path, identity: options.identity, engine: cfg.seat.identity, round: state.round },
      material: asked,
    }), ctx);
  if ('paused' in answer) return { state: asked, paused: answer.paused };
  return { state: { ...asked, productFeedback: [...(asked.productFeedback ?? []), answer.response] }, answer: answer.response };
}

/**
 * The next round's feedback after a person answers a product decision: it
 * says it is their decision, quotes their prompt, lists the review findings
 * it answers, and carries their whole response as structured feedback.
 * `granted` marks the round the cap could not pay for: the person was asked
 * after the last review the cap allows, so this one round was granted for
 * their answer, and the send-back says so.
 */
export function productDecisionFeedback(
  answer: InteractionResponse,
  findings: readonly FeedbackFinding[],
  over: { readonly target?: string; readonly source?: string; readonly granted?: boolean } = {},
): Outcome {
  const { granted, ...route } = over;
  const reason = `A person made a product decision about the findings below. Apply it in this round.${granted ? ' It was granted for a product answer, past the cap.' : ''} Their decision: "${answer.prompt}"`;
  const outcome = revisionRequest({ ...route, reason, findings: [...findings] }, { data: answer });
  return granted === true ? { ...outcome, productDecision: true } : outcome;
}

/**
 * The list a person reads before the work lands: every finding the judge
 * held back, each with the judge's reason for holding it and the round it
 * was held back in — a skip in round 1, a minor call from round 2 on. The
 * skipped list keeps them across rounds, so it is also where they are
 * collected from.
 */
export function minorFindings(skipped: readonly SkippedFinding[]): FeedbackFinding[] {
  return skipped
    .map(({ finding, reason, round }) => ({ ...finding, judgeReason: reason, round }));
}

/**
 * What the judge's decisions on a round's findings send on: the findings
 * the judge called impactful, each carrying its reason, and the skipped
 * list grown by this round's held-back findings — a `skip` from round 1, a
 * `minor` from round 2 on. A round the judge did not decide each finding
 * of sends every finding and holds none back.
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
      acted.push({ ...finding, judgeReason: item.reason, id: item.id });
      continue;
    }
    // The same finding raised again keeps one entry, with the latest judgment.
    const earlier = next.findIndex((entry) => entry.finding.evidence === finding.evidence);
    if (earlier === -1) next.push({ round, finding, reason: item.reason });
    else next[earlier] = { round, finding, reason: item.reason };
  }
  return { acted, skipped: next };
}
