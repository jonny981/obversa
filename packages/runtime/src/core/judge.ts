/**
 * A judge: a seat that answers typed questions about a piece of work and the
 * rounds spent on it so far, in place of a plain review-round count. Used on
 * a `workflow()` stage's `refine` and on a `dag()`'s `maxKickbacks`, between
 * a review's verdict and the send-back.
 *
 * The default question set and the routing rule below make a loop that was
 * first hand-wired as dag nodes into a runtime primitive.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { jobMeta } from './describe.js';
import { treeChanges, treeDiff, workTree, type TreeChange } from './git.js';
import { agentJob } from './job.js';
import { DEFAULT_INTERACTION, jsonSnapshot, requestInteraction, type InteractionBinding, type InteractionResponse } from './interaction.js';
import type { Outcome } from './types.js';
import { normalizeFeedbackSeverity, revisionRequest } from './feedback.js';
import type {
  FeedbackActionSeverity,
  FeedbackFinding,
  GoalRequirement,
  Job,
  Judge,
  JudgeAnswer,
  JudgeQuestions,
  JobContext,
  JudgeQuestion,
  SkippedFinding,
} from './types.js';

export type { Judge, JudgeAnswer, JudgeQuestion, JudgeQuestions, SkippedFinding } from './types.js';

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
 * A judge for `refine` or `maxKickbacks`: `seat` runs with workspace mode
 * none (it reads no file itself; everything it needs rides in the prompt),
 * and `questions` defaults to `stopQuestions()`. With no `cap`, the rounds
 * end when the judge stops them or the review passes. A `cap` is an
 * optional backstop: `cap: N` allows at most N refinements after the first
 * build, so N+1 builds in all. The judge is asked about the review of the
 * last build too, and only a stop that lets the work stand passes. `perFinding`
 * asks the judge to act on or skip each finding as well; it defaults to true
 * with the default questions and to false with a caller's own.
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

/** What `act` and `skip` mean in each per-finding question. */
const FINDING_CRITERIA = {
  act: 'A reader of this kind of work would stumble on, misread or distrust what this finding names, so the builder should fix it.',
  skip: 'It is taste, an edge case, or polish past the bar the use case sets, so fixing it would not change what a reader gets.',
} as const;

/**
 * A finding's id within its round: `finding-1` for the first finding in the
 * round's list, and so on. The list is saved with a pending question, so the
 * ids stay the same after a resume.
 */
export function findingId(index: number): string {
  return `finding-${index + 1}`;
}

/** What `act` and `skip` mean for a finding tagged block: the bar to skip it is higher. */
const BLOCK_CRITERIA = {
  act: 'The case this finding names is part of how the work is really used, so the builder should fix it.',
  skip: 'The case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered.',
} as const;

/** One `choice` question per finding, keyed by the finding's id. A block's question sets the higher bar. */
export function findingQuestions(findings: readonly FeedbackFinding[]): JudgeQuestions {
  const questions: Record<string, JudgeQuestion> = {};
  for (const [index, finding] of findings.entries()) {
    const severity = normalizeFeedbackSeverity(finding.severity);
    const recommendation = finding.recommendation ? ` Recommendation: ${finding.recommendation}` : '';
    const bar = severity === 'block'
      ? 'It is tagged block, so the bar to skip it is higher. Skip it only when the case it names is outside how the work is really used, or the same class of finding keeps returning after it was answered; otherwise act.'
      : 'For this use case, should the builder act on it in another round, or skip it?';
    questions[findingId(index)] = {
      type: 'choice',
      instructions: `Read this one finding. ${bar} Give a one-line reason. Finding [${severity}]: ${finding.evidence}${recommendation}`,
      criteria: severity === 'block' ? BLOCK_CRITERIA : FINDING_CRITERIA,
    };
  }
  return questions;
}

/** The judge's decision on one finding. */
export interface FindingDecision {
  readonly id: string;
  readonly decision: 'act' | 'skip';
  readonly reason: string;
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

/** One round of the work the judge is watching converge. */
export interface JudgeRound {
  readonly round: number;
  readonly findings: readonly FeedbackFinding[];
  readonly counts: Readonly<Record<FeedbackActionSeverity, number>>;
  /**
   * Lines added or removed since the judge last read the work: in the file,
   * when the target names one, or else in the git workspace.
   */
  readonly changedLines?: number;
  /** The git workspace's files as the judge read them, when it is a git repository. */
  readonly tree?: string;
  /** What the judge decided about this round: its reason, and its decision on each finding when it made one. */
  readonly judged?: { readonly reason: string; readonly findings?: readonly FindingDecision[] };
}

/** One check's result in the round the judge reads: a step that ran a command. */
export interface JudgeCheck {
  /** The step's name. */
  readonly name: string;
  /** The command it ran, when the step is a command. */
  readonly command?: string;
  readonly status: Outcome['status'];
  /** The command's output, when the check did not pass. */
  readonly output?: string;
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
  /** Findings the judge skipped in earlier rounds, with its reasons. */
  readonly skipped?: readonly SkippedFinding[];
  /** The judge's decision on each finding of the round it sent to a person, so the answer reaches the builder with only the findings worth acting on. */
  readonly decided?: readonly FindingDecision[];
  readonly rounds: readonly JudgeRound[];
  readonly round: number;
  readonly cap?: number;
  /** This round's review is the last one the cap allows: no build round follows it. */
  readonly lastRound?: true;
}

/** What the work under review is for, and the file a judge reads, when there is one. */
export interface JudgeWork {
  /** The brief or ticket text the work answers. */
  readonly brief?: string;
  readonly useCase?: string;
  /** The target's own `desc` and `gate`. */
  readonly desc?: string;
  readonly gate?: string;
  /** The file being refined, relative to the workspace. */
  readonly file?: string;
  /** The git workspace's files when the work began, when it is a git repository. */
  readonly base?: string;
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

/** What a judge reads, in the order it reads it. */
export interface JudgePacket {
  /** What the work is for. */
  readonly why: {
    readonly brief?: string;
    readonly useCase?: string;
    readonly desc?: string;
    readonly gate?: string;
    /** A person's answers to the judge's earlier product decisions. */
    readonly productFeedback?: readonly InteractionResponse[];
  };
  /** The change under review. */
  readonly what: {
    /** The files changed since the work began, in a git workspace. */
    readonly changedFiles?: readonly TreeChange[];
    /** The diff around each file and line a finding cites. */
    readonly diffs?: readonly { readonly file: string; readonly line?: number; readonly diff: string }[];
    readonly file?: string;
    readonly draft?: string;
  };
  /** This round's evidence. */
  readonly how: {
    readonly checks?: readonly JudgeCheck[];
    readonly goal?: readonly GoalRequirement[];
    /** This round's findings, by the id each one's question uses. */
    readonly findings: readonly (FeedbackFinding & { readonly id: string })[];
  };
  /** Where the rounds stand. */
  readonly when: {
    readonly round: number;
    readonly cap?: number;
    readonly lastRound?: true;
    readonly limit?: string;
    readonly rounds: readonly unknown[];
    readonly skipped?: readonly SkippedFinding[];
    /** The files changed since the judge last read the work, in a git workspace. */
    readonly changedSinceLastRound?: readonly TreeChange[];
  };
  /** What the size limit cut, when it cut anything. */
  readonly cut?: readonly string[];
}

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
   * cap allows, no round follows the answer and the run fails. Absent when
   * `again` is true.
   */
  readonly stop?: 'ship' | 'fail' | 'product_decision';
  /**
   * The answer that decided the route: the chosen reason (`stop_reason:
   * continue`), the probability answer it fell back to
   * (`worth_another_round: 0.49`), the count of findings acted on and
   * skipped (`findings: 1 act, 2 skip`), or `no clear answer`.
   */
  readonly rule: string;
  /** The decision on each finding, when the judge decides each finding. */
  readonly findings?: readonly FindingDecision[];
}

/**
 * Route on the judge's answers. The chosen `stop_reason` decides when there is
 * one: in use it moves with the rounds while the probability answers stay
 * flat, so it is the answer that discriminates. A chosen `continue` runs
 * another round whatever the probability answers say. A clear yes or no from
 * `holds`, `worth_doing` or `worth_another_round` decides only when there is
 * no choice: a question set without `stop_reason`, or a reply that did not
 * parse. The cap is not checked here: `askJudge` turns a decision after
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
 * asked; a choice with no reason of its own records the text of the chosen
 * option from its finding's question.
 */
export function judgeDecision(answers: Readonly<Record<string, JudgeAnswer>>, findingIds?: readonly string[], questions?: JudgeQuestions): JudgeDecision {
  const round = roundDecision(answers);
  if (!findingIds?.length) return round;
  return decideEachFinding(answers, findingIds, round, questions);
}

/**
 * Route on the judge's answer for each finding. `product_decision` stands as
 * the round answer gives it. Otherwise any finding the judge acts on runs
 * another round, and a round with none ships as a pass, whatever the round
 * answer says: a chosen `not_converging` does not drop acted findings, and
 * it does not fail a round whose findings are all skipped. A finding the
 * judge did not answer, or answered with neither choice, follows the round
 * answer: it goes back when that answer runs another round, and is skipped
 * when that answer ships. When the judge answered no finding at all, the
 * round answer routes alone, with the same reason and rule as before.
 */
function decideEachFinding(answers: Readonly<Record<string, JudgeAnswer>>, findingIds: readonly string[], round: JudgeDecision, questions?: JudgeQuestions): JudgeDecision {
  const findings = findingIds.map((id): FindingDecision => {
    const answer = answers[id];
    const choice = answer?.choice;
    const reason = typeof answer?.reason === 'string' && answer.reason.trim() ? answer.reason.trim() : undefined;
    if (choice === 'act' || choice === 'skip') {
      const question = questions?.[id];
      const criteria = question?.type === 'choice' ? question.criteria : FINDING_CRITERIA;
      return { id, decision: choice, reason: reason ?? criteria[choice] ?? FINDING_CRITERIA[choice] };
    }
    return { id, decision: round.again ? 'act' : 'skip', reason: `no answer for this finding; ${round.reason}` };
  });
  const answered = findings.some(({ id }) => answers[id]?.choice === 'act' || answers[id]?.choice === 'skip');
  // A judge that answered no finding decided nothing about them: every finding stands, as with whole-round judging.
  if (!answered) return round;
  if (round.stop === 'product_decision') return { ...round, findings };
  const acted = findings.filter((finding) => finding.decision === 'act').length;
  const rule = `findings: ${acted} act, ${findings.length - acted} skip`;
  if (acted) return { again: true, reason: `the judge acts on ${acted} of ${findings.length} findings`, rule, findings };
  return { again: false, stop: 'ship', reason: 'the judge skipped every finding', rule, findings };
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
 * The line the judge reads about the round limit: none with no cap, and the
 * last round when no build round follows this review. Absent otherwise.
 */
function roundLimit(state: JudgeState): string | undefined {
  if (state.cap === undefined) return 'No round limit: the rounds end when you stop them or the review passes.';
  if (state.lastRound) return `This is the last round the cap of ${state.cap} allows (${state.cap} ${state.cap === 1 ? 'refinement' : 'refinements'} after the first build): no build round follows, so your answer decides how this ends.`;
  return undefined;
}

/**
 * Ask the judge, and record its answer. Runs `cfg.seat` as a workspace-mode-
 * none agent turn over the packet `judgePacket` builds from `state` and over
 * `cfg.questions`, parses the reply as the judge engine's own
 * `{ [question]: JudgeAnswer }` shape, and emits `refine:judge` with the
 * `target` it decides about, the round and the packet's size and cuts, so a
 * person reading the record sees what it answered and why. The packet's
 * `when` carries `limit`, a line about the round limit, when there is no cap
 * or this is the last round. When the judge decides
 * each finding, the questions also carry one per finding in
 * `state.latestFindings`. A reply that fails to parse becomes an empty
 * answers object, and `judgeDecision` reads that as no clear answer, which
 * runs another round.
 *
 * After the last review the cap allows (`state.lastRound`), only a stop
 * that lets the work stand passes, and it records the open findings; a
 * `product_decision` still asks a person; anything else is a stop that
 * fails, with the cap named in the reason.
 */
export async function askJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
  target: string,
): Promise<{ answers: Readonly<Record<string, JudgeAnswer>>; decision: JudgeDecision }> {
  const perFinding = cfg.perFinding && state.latestFindings.length > 0;
  const eachFinding = perFinding ? findingQuestions(state.latestFindings) : undefined;
  const packet = await judgePacket(state, ctx.workspace.dir, ctx.judgeContextLimit ?? DEFAULT_JUDGE_CONTEXT_LIMIT);
  const judgeJob = agentJob({
    label: 'refine:judge',
    engine: cfg.seat.engine,
    model: cfg.seat.identity.model,
    workspaceMode: 'none',
    tools: [],
    leaf: true,
    prompt: JSON.stringify({
      state: packet,
      questions: eachFinding ? { ...cfg.questions, ...eachFinding } : cfg.questions,
    }),
  });
  // The skipped findings ride in the packet; the prompt stays the JSON above.
  const outcome = await judgeJob({ ...ctx, depth: ctx.depth + 1, path: [...path, 'refine-judge'], skippedFindings: undefined });
  let answers: Record<string, JudgeAnswer> = {};
  if (outcome.status === 'pass') {
    try {
      const parsed: unknown = JSON.parse(String(outcome.data ?? ''));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        answers = parsed as Record<string, JudgeAnswer>;
      }
    } catch {
      // Left empty: an unreadable answer routes as no clear answer, not a crash.
    }
  }
  const decided = judgeDecision(answers, eachFinding ? Object.keys(eachFinding) : undefined, eachFinding);
  const decision: JudgeDecision = state.lastRound && decided.stop !== 'ship' && decided.stop !== 'product_decision'
    ? { ...decided, again: false, stop: 'fail', reason: `${decided.reason}; this was the last round the cap of ${state.cap} allows` }
    : decided;
  const status = decision.stop === 'ship' ? 'pass' : decision.stop === 'fail' ? 'fail' : undefined;
  ctx.emit({
    kind: 'refine:judge', ts: Date.now(), path: [...path], target, round: state.round, answers, reason: decision.reason,
    route: decision.again ? 'again' : 'stop', rule: decision.rule, ...(status ? { status } : {}),
    packet: { size: JSON.stringify(packet).length, ...(packet.cut ? { cut: packet.cut } : {}) },
    ...(decision.findings ? { findings: decision.findings } : {}),
    ...(state.lastRound && decision.stop === 'ship' ? { openFindings: state.latestFindings } : {}),
  });
  return { answers, decision };
}

/**
 * Ask the judge, or resume its pending product question. When the judge
 * chooses `product_decision`, a person is asked, and their answer comes back
 * as `answer` for the caller to send to the builder; the judge is not asked
 * again until that round has been built and reviewed. After the last review
 * the cap allows, the person is still asked, and the caller records their
 * answer and fails, since no build round follows (`lastRoundAnswered`).
 */
export async function consultJudge(
  cfg: Judge,
  state: JudgeState,
  ctx: JobContext,
  path: readonly string[],
  options: { readonly target: string; readonly identity: string; readonly pending: boolean; readonly save: (state: JudgeState) => void },
): Promise<{ state: JudgeState; decision: JudgeDecision } | { state: JudgeState; paused: Outcome } | { state: JudgeState; answer: InteractionResponse }> {
  let asked = state;
  if (!options.pending) {
    const { decision } = await askJudge(cfg, state, ctx, path, options.target);
    if (decision.stop !== 'product_decision') return { state, decision };
    // Kept with the question, so a resumed run still knows which findings the judge would act on.
    if (decision.findings) asked = { ...state, decided: decision.findings };
  }
  options.save(asked);
  const answer = await requestInteraction(cfg.interaction ?? DEFAULT_INTERACTION,
    'What product decision should guide this review?', jsonSnapshot({
      requester: { path, identity: options.identity, engine: cfg.seat.identity, round: state.round },
      material: asked,
    }), ctx);
  if ('paused' in answer) return { state: asked, paused: answer.paused };
  return { state: { ...asked, productFeedback: [...(asked.productFeedback ?? []), answer.response] }, answer: answer.response };
}

/**
 * Why the run stops when a person answers a product decision after the last
 * review the cap allows: their answer is recorded here, and no build round
 * follows to apply it.
 */
export function lastRoundAnswered(state: JudgeState, answer: InteractionResponse): string {
  return `the judge requested a product decision after the last round the cap of ${state.cap} allows; a person answered "${answer.prompt}", and no build round follows to apply it`;
}

/**
 * The next round's feedback after a person answers a product decision: it
 * says it is their decision, quotes their prompt, lists the review findings
 * it answers, and carries their whole response as structured feedback.
 */
export function productDecisionFeedback(
  answer: InteractionResponse,
  findings: readonly FeedbackFinding[],
  over: { readonly target?: string; readonly source?: string } = {},
): Outcome {
  const reason = `A person made a product decision about the findings below. Apply it in this round. Their decision: "${answer.prompt}"`;
  return revisionRequest({ ...over, reason, findings: [...findings] }, { data: answer });
}

/**
 * What the judge's decisions on a round's findings send on: the findings it
 * acts on, each carrying its reason, and the skipped list grown by this
 * round's skips. A round the judge did not decide each finding of sends
 * every finding and skips none.
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
    if (item.decision === 'act') acted.push({ ...finding, judgeReason: item.reason, id: item.id });
    else if (!next.some((entry) => entry.finding.evidence === finding.evidence)) next.push({ round, finding, reason: item.reason });
  }
  return { acted, skipped: next };
}
