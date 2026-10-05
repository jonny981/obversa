/**
 * The DAG / stages layer. `dag(config)` returns a `Job`, so it nests with
 * `loop()` both ways. Nodes declare `needs` (dependencies); each node waits on
 * its dependencies' promises, then runs under a shared `p-limit` concurrency
 * gate. Cycle/missing-dep detection is delegated to `toposort` and happens
 * before any work runs.
 *
 * Failure policy (ours, not the libs'):
 *   - a required node failing (or ending `exhausted`) blocks its dependents
 *     (they don't run) and fails the DAG;
 *   - with `stopOnError` (default) the first required failure stops scheduling
 *     anything not already in flight;
 *   - `optional` nodes never fail the DAG nor block dependents;
 *   - an unmet `when` gate *skips* the node, which counts as green.
 */

import { randomUUID } from 'node:crypto';

import pLimit from 'p-limit';
import toposort from 'toposort';

import type {
  DagConfig,
  KickbackBudget,
  DagNode,
  Job,
  JobContext,
  Judge,
  Outcome,
  ResumedStageRecords,
  Workspace,
} from './types.js';
import { childContext, NODE_FILE, rebuildUntil, recordedRounds, recordKey, ROUNDS, roundsOf, type Rounds } from './context.js';
import { nodeJobContext } from './approval-job.js';
import { needDecisionsOf, toCondition } from './condition.js';
import { setMeta, jobMeta, describeConditions, declaredWrites, declareWrites } from './describe.js';
import {
  isRepo,
  stageAll,
  commit,
  addWorktree,
  branchExists,
  mergeBranch,
} from './git.js';
import { closeFork } from './isolated.js';
import { mergeLock, mergeSynthesis } from './merge.js';
import type { EnvHandle } from '../env/environment.js';
import { LoopError } from './errors.js';
import { revisionFromOutcome } from './feedback.js';
import { consultJudge, isJudge, judgedFindings, judgeRound, judgeState, lastRoundAnswered, productDecisionFeedback, readJudgedFile, type JudgeRound, type JudgeState, type SkippedFinding } from './judge.js';
import { checkpointInteraction, interactionDeclaration, interactionIdentity, jsonSnapshot, outcomeSnapshot, savedInteraction, type InteractionResponse } from './interaction.js';
import { DEFAULT_FANOUT_CONCURRENCY } from './concurrency.js';
import { dagResumeIdentity, missingFiles, recordedSteps, restoreRecordedUsage, restoreWrote, resumeGuard, reusedWrote, RESUME_IDENTITY, RESUME_STAGE_OUTCOMES } from './resume.js';
import { roundRule } from './rounds.js';

/**
 * Internal context key: what a graph keeps, for one run, about the rounds of
 * the node it runs. A node that runs its own review rounds (a reviewed
 * `workflow()` stage) reads and adds to it, so its own reviews and the
 * send-backs to it share one count of builds and one judge history. Not
 * exported from the package.
 */
export const TARGET_ROUNDS = Symbol('obversa:target-rounds');

/** One node's rounds in one run of a graph, under `TARGET_ROUNDS`. */
export interface TargetRounds {
  /** The node's builds after its first, in this run. */
  builds: number;
  /**
   * Save the rounds so far between two of the node's own rounds, with the
   * feedback its next build reads. A resume that runs the node again starts
   * from that build.
   */
  save(feedback: Outcome): void;
  rounds: readonly JudgeRound[];
  skipped: readonly SkippedFinding[];
  productFeedback: readonly InteractionResponse[];
  /** The node's file as its judge last read it. */
  previousDraft: string | undefined;
}

/** Sanitise a name into a git-ref-safe slug. */
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/(^-+|-+$)/g, '') || 'node';
}

function normalizeNeeds(needs: DagNode['needs']): string[] {
  if (needs === undefined) return [];
  return typeof needs === 'string' ? [needs] : [...needs];
}

function normalize(node: DagNode | Job): DagNode {
  if (typeof node === 'function') return { job: node, needs: [] };
  return {
    ...node,
    needs: normalizeNeeds(node.needs),
  };
}

function validateKickbackBudget(
  budget: KickbackBudget | undefined,
  nodes: ReadonlyMap<string, DagNode>,
): void {
  if (budget === undefined) return;
  if (typeof budget === 'number') {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new LoopError({
        code: 'CONFIG',
        message: 'dag maxKickbacks must be a non-negative integer',
      });
    }
    return;
  }
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    throw new LoopError({
      code: 'CONFIG',
      message: 'dag maxKickbacks must be a number or target budget map',
    });
  }
  for (const [target, limit] of Object.entries(budget)) {
    if (!nodes.has(target)) {
      throw new LoopError({
        code: 'CONFIG',
        message: `dag maxKickbacks names unknown target "${target}"`,
      });
    }
    // A judge is built (and its cap validated) by `judge()` itself.
    if (isJudge(limit)) continue;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new LoopError({
        code: 'CONFIG',
        message: `dag maxKickbacks for "${target}" must be a non-negative integer or a judge`,
      });
    }
  }
}

/** The files a node declares it writes: its job's, as far as `outcome`, its
 * recorded result, shows, and its `file`. */
function nodeWrites(node: DagNode, outcome?: Outcome): string[] {
  return [...new Set([...declaredWrites(node.job, outcome), ...(node.file === undefined ? [] : [node.file])])];
}

/** The files a node wrote, by its recorded result: none unless it passed
 * without being skipped. A result a resume reused wrote what its record
 * says. */
function wroteFiles(node: DagNode, outcome: Outcome | undefined): string[] {
  return outcome?.status === 'pass' && (outcome.data as { skipped?: boolean } | undefined)?.skipped !== true
    ? [...(reusedWrote(outcome) ?? nodeWrites(node, outcome))]
    : [];
}

export function dag(config: DagConfig): Job {
  if (!config.name)
    throw new LoopError({
      code: 'CONFIG',
      message: 'dag() requires a non-empty name',
    });
  const names = Object.keys(config.nodes);
  const nodes = new Map<string, DagNode>(
    names.map((n) => [n, normalize(config.nodes[n]!)]),
  );
  validateKickbackBudget(config.maxKickbacks, nodes);

  // Fail fast on a bad graph, before the Job is ever run.
  const edges: [string, string][] = [];
  for (const [name, node] of nodes) {
    for (const dep of normalizeNeeds(node.needs)) {
      if (!nodes.has(dep)) {
        throw new LoopError({
          code: 'CONFIG',
          message: `dag "${config.name}": node "${name}" needs unknown node "${dep}"`,
        });
      }
      edges.push([dep, name]); // dep must precede name
    }
    if (node.retrySafe !== undefined && typeof node.retrySafe !== 'boolean')
      throw new LoopError({
        code: 'CONFIG',
        message: `dag "${config.name}": retrySafe of node "${name}" must be a boolean`,
      });
    // A `when` that reads a dependency's outcome (`passed(x)`, `failed(x)`,
    // however composed) must name one of this node's needs, and a branch on
    // `failed(x)` is reached only when x is optional: a required x that
    // fails blocks this node before its `when` is ever read.
    for (const { on, need } of node.when === undefined ? [] : needDecisionsOf(node.when)) {
      const where = `dag "${config.name}": node "${name}" branches on ${on}("${need}")`;
      if (!nodes.has(need)) {
        throw new LoopError({ code: 'CONFIG', message: `${where}, but "${need}" is not a node in this dag` });
      }
      if (!normalizeNeeds(node.needs).includes(need)) {
        throw new LoopError({
          code: 'CONFIG',
          message: `${where}, but "${need}" is not one of its needs; add it to the node's needs`,
        });
      }
      if (on === 'failed' && nodes.get(need)?.optional !== true) {
        throw new LoopError({
          code: 'CONFIG',
          message: `${where}, so "${need}" must be optional: true; `
            + `a required node that fails blocks "${name}" before its when runs`,
        });
      }
    }
  }
  let order: string[];
  try {
    order = toposort.array(names, edges);
  } catch (e) {
    throw new LoopError({
      code: 'CONFIG',
      message: `dag "${config.name}": dependency cycle detected`,
      cause: e,
    });
  }

  const stopOnError = config.stopOnError ?? true;
  const maxKickbacks = config.maxKickbacks ?? 0;
  const perTargetBudget = typeof maxKickbacks !== 'number';
  // A judge's own `cap` stands in for the plain number everywhere the budget
  // is a hard integer limit, and a judge with no cap sets no limit;
  // `targetJudge` is the extra, smart-routing layer consulted on every
  // request, a request with a block finding and the one after its cap
  // included.
  const targetJudge = (target: string): Judge | undefined => {
    if (typeof maxKickbacks === 'number') return undefined;
    const budget = maxKickbacks[target];
    return isJudge(budget) ? budget : undefined;
  };
  const targetLimit = (target: string): number | undefined => {
    if (typeof maxKickbacks === 'number') return maxKickbacks;
    const budget = maxKickbacks[target] ?? 0;
    return isJudge(budget) ? budget.cap : budget;
  };
  const routeKickbacks = config.maxKickbacks !== undefined
    && (perTargetBudget || maxKickbacks > 0);
  // The declared shape a resumed run's record must match.
  const resumeIdentity = (config as DagConfig & { [RESUME_IDENTITY]?: string })[RESUME_IDENTITY]
    ?? dagResumeIdentity(config);
  // Every round a target has been asked to redo work, kept only for a judge's
  // own state, a plain numeric budget never needs this history. A `workflow()`
  // gives its brief and roles only through the resume identity, so the saved
  // state digests it too.
  const identity = interactionIdentity({ config, resumeIdentity });

  // Static graph relations for routing cross-stage feedback (kickback). All pure
  // functions of the declared `needs` edges, computed once. `dependents` is the
  // forward adjacency (who needs me); a kickback to a target re-runs the target
  // plus everything reachable from it, and the target must be an ancestor.
  const dependents = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const [dep, name] of edges) dependents.get(dep)!.push(name);
  const ancestorsOf = (name: string): Set<string> => {
    const seen = new Set<string>();
    const stack = normalizeNeeds(nodes.get(name)!.needs);
    while (stack.length) {
      const n = stack.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      stack.push(...normalizeNeeds(nodes.get(n)!.needs));
    }
    return seen;
  };
  const dirtyFrom = (target: string): Set<string> => {
    const seen = new Set<string>([target]);
    const stack = [target];
    while (stack.length) {
      const n = stack.pop()!;
      for (const d of dependents.get(n)!)
        if (!seen.has(d)) {
          seen.add(d);
          stack.push(d);
        }
    }
    return seen;
  };
  // A node declares, when the graph is built, the nodes it may send work
  // back to; each must be a node it depends on.
  for (const [name, node] of nodes) {
    const declared = node.acceptsKickbackTo;
    if (declared === undefined) continue;
    if (!Array.isArray(declared) || declared.some((target) => typeof target !== 'string')) {
      throw new LoopError({
        code: 'CONFIG',
        message: `dag "${config.name}": acceptsKickbackTo of node "${name}" must be a list of node names`,
      });
    }
    for (const target of declared) {
      if (!nodes.has(target)) {
        throw new LoopError({
          code: 'CONFIG',
          message: `dag "${config.name}": node "${name}" declares it sends work back to "${target}", which is not a node in this dag`,
        });
      }
      if (!ancestorsOf(name).has(target)) {
        throw new LoopError({
          code: 'CONFIG',
          message: `dag "${config.name}": node "${name}" declares it sends work back to "${target}", which is not one of the nodes it depends on`,
        });
      }
    }
  }
  const limitN =
    config.concurrency && config.concurrency > 0
      ? config.concurrency
      : DEFAULT_FANOUT_CONCURRENCY;

  const job: Job = async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const depth = parent.depth + 1;
    const ts = () => Date.now();
    // The resume anchor: a dag records it at start, with the rounds it runs
    // in, so a resumed run can match its finished nodes against the same
    // declared shape in the same round. Each round's first invocation takes
    // its own anchor: a later loop round, or a rerun of the node that holds
    // this graph, reads that round's record. A second invocation in the same
    // round runs every node again.
    const anchors = (parent.state[RESUME_STAGE_OUTCOMES] as ResumedStageRecords | undefined)?.anchors;
    const rounds = recordedRounds(roundsOf(parent), path.length);
    const anchorKey = recordKey(path, rounds.rounds);
    const prior = anchors?.get(anchorKey);
    if (anchors instanceof Map) anchors.delete(anchorKey);
    // The saved rounds belong to the same invocation in the same round.
    const checkpointPath = [...path, '@judge-kickback'];
    const saved = prior === undefined ? undefined : savedInteraction(parent, checkpointPath, identity);
    let pending = saved?.pending as unknown as { from: string; count: number; state: JudgeState } | undefined;
    const targetCounts = new Map<string, number>(Object.entries(saved?.targetCounts ?? {}) as [string, number][]);
    const judgeHistory = new Map<string, JudgeRound[]>(Object.entries(saved?.history ?? {}) as [string, JudgeRound[]][]);
    // Each target's file as its judge last read it, so each round of the
    // judge's history records how many lines that round changed.
    const judgeDrafts = new Map<string, string>(Object.entries(saved?.drafts ?? {}) as [string, string][]);
    // The findings a target's judge skipped, kept across rounds. Every node
    // that declares it sends work back to the target reads them on its next
    // run as `ctx.skippedFindings`.
    const judgeSkipped = new Map<string, SkippedFinding[]>(Object.entries(saved?.skipped ?? {}) as unknown as [string, SkippedFinding[]][]);
    const productFeedback = new Map<string, readonly InteractionResponse[]>(Object.entries(saved?.productFeedback ?? {}) as unknown as [string, InteractionResponse[]][]);
    parent.emit({
      kind: 'workflow:start',
      ts: ts(),
      path,
      identity: resumeIdentity,
      workspace: parent.workspace.dir,
      recordId: prior?.identity === resumeIdentity && prior.workspace === parent.workspace.dir
        ? prior.recordId ?? randomUUID()
        : randomUUID(),
      ...rounds,
    });
    parent.emit({ kind: 'dag:start', ts: ts(), path, depth, nodes: names });

    const concurrency = pLimit(limitN);
    const results = new Map<string, Outcome>(Object.entries(saved?.results ?? {}) as unknown as [string, Outcome][]);
    const savedWrote = (saved?.wrote ?? {}) as Record<string, unknown>;
    for (const [name, outcome] of results) restoreWrote(outcome, savedWrote[name]);
    // How many times each node has run (1 on the first pass, +1 per kickback
    // re-run). Stamped onto its dag:node events so records can tell rounds apart.
    const attempts = new Map<string, number>(Object.entries(saved?.attempts ?? {}) as [string, number][]);
    // The rounds a node runs in: this graph's, and its own attempt.
    const nodeRounds = (name: string): Rounds => {
      const attempt = attempts.get(name) ?? 1;
      return attempt > 1 ? { ...roundsOf(parent), [path.length]: attempt } : roundsOf(parent);
    };
    // A saved node whose files are gone from the workspace, that the record
    // shows started again after it was saved, that a step it needs finished
    // after, or that the record holds from a run the step around this graph
    // runs again in place of, is not reused: it runs as the same attempt, so its
    // resume guard finds its record in its own round and runs it again or
    // asks a person. Every saved node that needs one of them runs again too,
    // on what it rebuilds.
    const stages = (parent.state[RESUME_STAGE_OUTCOMES] as ResumedStageRecords | undefined)?.stages;
    const nodeKey = (name: string): string =>
      recordKey([...path, name], recordedRounds(nodeRounds(name), path.length + 1).rounds);
    // Where the record holds a node's run in its current round; 0 for none.
    const recordLine = (name: string): number => {
      const recorded = stages?.get(nodeKey(name));
      return recorded === undefined ? 0 : recorded.kind === 'completed' ? recorded.line : recorded.startLine;
    };
    // The send-back each node's last finished run read, so a run again in
    // the same round reads it too.
    const readKickback = new Map<string, Outcome>(Object.entries(saved?.readKickbacks ?? {}) as unknown as [string, Outcome][]);
    const rerun = new Set<string>();
    const savedLines = new Map(names.map((name) => [name, recordLine(name)]));
    for (const name of results.keys()) {
      if (stages?.get(nodeKey(name))?.kind !== 'interrupted'
        && !(rebuildUntil(parent) > 0 && savedLines.get(name)! <= rebuildUntil(parent))
        && !normalizeNeeds(nodes.get(name)!.needs).some((need) => savedLines.get(need)! > savedLines.get(name)!)
        && missingFiles(parent.workspace.dir, wroteFiles(nodes.get(name)!, results.get(name))).length === 0) continue;
      results.delete(name);
      attempts.set(name, (attempts.get(name) ?? 1) - 1);
      rerun.add(name);
    }
    for (const name of order) {
      if (!results.has(name) || !normalizeNeeds(nodes.get(name)!.needs).some((need) => rerun.has(need))) continue;
      results.delete(name);
      attempts.set(name, (attempts.get(name) ?? 1) - 1);
      rerun.add(name);
    }
    // The nodes that ran in this invocation instead of reusing their record:
    // a node that needs one of them does not reuse its own.
    const ranAgain = new Set<string>();
    // A node reuses nothing the record holds under it from before a step it
    // needs last finished, in the record or in this run: that work is newer.
    const needsFinished = (name: string): number => Math.max(0, ...normalizeNeeds(nodes.get(name)!.needs)
      .map((need) => (ranAgain.has(need) ? Infinity : recordLine(need))));
    const memo = new Map<string, Promise<Outcome>>([...results].map(([name, outcome]) => [name, Promise.resolve(outcome)]));
    // A step the saved rounds reuse does not run again: its recorded model
    // answers come back from the record, as a reused step's do.
    for (const name of results.keys()) restoreRecordedUsage({ state: parent.state, path: [...path, name], [ROUNDS]: nodeRounds(name) } as Pick<JobContext, 'state' | 'path'>);
    let stopped = false;
    // When a node is kicked back to, the reason rides into its next run as
    // `lastReview` — the same channel a loop's failed `review` uses, so the next
    // worker receives it. Cleared once the node has run, so a later re-run
    // never reads an old send-back. Empty in the common (no-kickback) case.
    // A node's first run reads the feedback the dag itself was given, such as
    // the enclosing loop's rejection when the dag is a loop's body.
    const pendingKickback = new Map<string, Outcome>(Object.entries(saved?.kickbacks ?? {}) as unknown as [string, Outcome][]);
    for (const name of rerun) {
      const read = readKickback.get(name);
      if (read !== undefined && !pendingKickback.has(name)) pendingKickback.set(name, read);
    }
    const feedbackFor = (name: string): Outcome | undefined =>
      pendingKickback.get(name) ?? (attempts.get(name) === 1 ? parent.lastReview : undefined);
    const skippedFor = (name: string): readonly SkippedFinding[] | undefined => {
      const skipped = (nodes.get(name)!.acceptsKickbackTo ?? []).flatMap((target) => judgeSkipped.get(target) ?? []);
      return skipped.length ? skipped : undefined;
    };
    // A node that runs its own review rounds counts them here, with the
    // send-backs to it, and its judge reads and adds to the same history.
    const targetRounds = (name: string): TargetRounds => ({
      get builds() { return targetCounts.get(name) ?? 0; },
      set builds(value) { if (value !== (targetCounts.get(name) ?? 0)) targetCounts.set(name, value); },
      save(feedback) {
        pendingKickback.set(name, feedback);
        saveRounds();
      },
      get rounds() { return judgeHistory.get(name) ?? []; },
      set rounds(value) { judgeHistory.set(name, [...value]); },
      get skipped() { return judgeSkipped.get(name) ?? []; },
      set skipped(value) { judgeSkipped.set(name, [...value]); },
      get productFeedback() { return productFeedback.get(name) ?? []; },
      set productFeedback(value) { productFeedback.set(name, value); },
      get previousDraft() { return judgeDrafts.get(name); },
      set previousDraft(value) { if (value === undefined) judgeDrafts.delete(name); else judgeDrafts.set(name, value); },
    });
    // How many runs of each node finished: a node that paused, was aborted or
    // was still running runs again on a resume, as the same attempt.
    const finished = new Map(attempts);
    let used = Number(saved?.used ?? 0);
    const rejected = new Set<string>((saved?.rejected ?? []) as string[]);
    // The rounds so far belong to this run. Once a node has been sent back to
    // or judged, the graph saves them, with the passed outcomes, whenever a
    // node finishes, a send-back is accepted, or the graph pauses. A resume
    // after a pause, an abort, a crash, a failure or a pass counts on from the same round, with
    // the same judge history. A node that did not pass runs again on the
    // resume, as the same attempt.
    // A skipped node is not kept: the resume asks its condition again.
    const kept = (o: Outcome): boolean =>
      o.status === 'pass' && (o.data as { skipped?: boolean } | undefined)?.skipped !== true;
    // The saved copy of a result may not show the files its node wrote.
    const wroteSoFar = () => Object.fromEntries([...results]
      .map(([name, o]) => [name, wroteFiles(nodes.get(name)!, o)] as const)
      .filter(([, files]) => files.length));
    const saveRounds = (): void => {
      if (targetCounts.size === 0 && judgeHistory.size === 0) return;
      checkpointInteraction(parent, checkpointPath, identity, jsonSnapshot({
        results: Object.fromEntries([...results].filter(([, o]) => kept(o)).map(([name, o]) => [name, outcomeSnapshot(o)])),
        wrote: wroteSoFar(),
        attempts: Object.fromEntries([...finished].map(([name, n]) => {
          const outcome = results.get(name);
          return [name, outcome === undefined || kept(outcome) || outcome.status === 'paused' || outcome.status === 'aborted' ? n : n - 1];
        })),
        kickbacks: Object.fromEntries([...pendingKickback].map(([name, o]) => [name, outcomeSnapshot(o)])),
        readKickbacks: Object.fromEntries([...readKickback].map(([name, o]) => [name, outcomeSnapshot(o)])),
        targetCounts: Object.fromEntries(targetCounts),
        history: Object.fromEntries(judgeHistory), skipped: Object.fromEntries(judgeSkipped), productFeedback: Object.fromEntries(productFeedback), drafts: Object.fromEntries(judgeDrafts), used, rejected: [...rejected],
      }), true);
    };

    // Each node runs under its own name in the path, so a nested job (e.g. a
    // loop) is uniquely addressable for stats/logs even across same-named siblings.
    const nodeContext = (name: string) => {
      const node = nodes.get(name)!;
      return {
        needs: normalizeNeeds(node.needs),
        ...(node.desc !== undefined ? { desc: node.desc } : {}),
        ...(node.gate !== undefined ? { gate: node.gate } : {}),
      };
    };

    const nodeCtx = (
      name: string,
      job: Job | undefined,
      workspace?: Workspace,
      environment?: EnvHandle,
    ): JobContext =>
      Object.assign(nodeJobContext(childContext(parent, {
        depth,
        path: [...path, name],
        round: attempts.get(name) ?? 1,
        staleUntil: needsFinished(name),
        workspace,
        environment,
        lastReview: feedbackFor(name),
        skippedFindings: skippedFor(name),
        needs: Object.freeze(Object.fromEntries(
          normalizeNeeds(nodes.get(name)!.needs)
            .filter((n) => results.has(n))
            .map((n) => [n, results.get(n)!]),
        )),
        graph: {
          dag: config.name,
          node: name,
          attempt: attempts.get(name) ?? 1,
          path: [...path, name],
          ...nodeContext(name),
          dependents: dependents.get(name) ?? [],
        },
        // A nested DAG node starts a new reviewer scope. Its own reviewer
        // receives stageGate below; other checks must not see an ancestor's.
        reviewerGate: null,
        // Bind the node's criterion, including an explicit empty value. A
        // nested ungated node must not inherit its parent's criterion.
        stageGate: nodes.get(name)!.gate ?? null,
        timeoutMs: nodes.get(name)!.timeoutMs,
        timeoutGraceMs: nodes.get(name)!.timeoutGraceMs,
      }), job), {
        [TARGET_ROUNDS]: targetRounds(name),
        // Set or clear: a nested node with no `file` never checks an ancestor's.
        [NODE_FILE]: nodes.get(name)!.file,
      });

    let forkSeq = 0;

    /**
     * Run an isolated node in its own worktree. On pass the node's work is
     * captured (any uncommitted remainder is committed in the worktree) and
     * landed back into the parent branch (`--no-ff`, serialised). A merge
     * conflict fails the node unless synthesis is enabled. The worktree is
     * always removed, and then the fork branch is deleted; a branch that held
     * commits that never landed is named in the outcome's `discarded`.
     */
    const forkNodeJob = async (
      name: string,
      node: DagNode,
    ): Promise<Outcome> => {
      const base = parent.workspace;
      // An interrupted earlier run leaves its fork branch behind for recovery,
      // and a new run counts forks from zero again, so skip any name that is
      // already taken.
      let branch = `lines/${slug(config.name)}-${slug(name)}-${(forkSeq += 1)}`;
      while (await branchExists(base.dir, branch, { signal: parent.signal })) {
        branch = `lines/${slug(config.name)}-${slug(name)}-${(forkSeq += 1)}`;
      }
      const wt = await addWorktree(base.dir, {
        branch,
        base: 'HEAD',
        signal: parent.signal,
      });
      const wtWs: Workspace = { dir: wt.dir, branch };
      // Each team gets its own environment, named after its branch — born with
      // the worktree, torn down with it. A failed start propagates and the node
      // is recorded as failed; the worktree is still cleaned up in `finally`.
      let envHandle: EnvHandle | undefined;
      const attempt = async (): Promise<Outcome> => {
        if (config.environment)
          envHandle = await config.environment.up(wtWs, parent.signal);
        const outcome = await node.job(nodeCtx(name, node.job, wtWs, envHandle));
        if (outcome.status === 'pass') {
          // Capture anything the node left uncommitted, so nothing is stranded
          // in the worktree, then land it back.
          await stageAll({ cwd: wt.dir, signal: parent.signal });
          await commit(
            {
              subject: `chore(${slug(name)}): worktree changes`,
            },
            { cwd: wt.dir, signal: parent.signal },
          );
          const merged = await mergeLock(() =>
            mergeBranch(base.dir, branch, {
              signal: parent.signal,
              message: `merge ${branch} (node ${name})`,
            }),
          );
          if (!merged.ok) {
            // Conflict. Either fail, or synthesise the merge (an agent
            // resolves it and writes a synthesised body).
            if (config.onConflict !== 'synthesize') {
              return {
                status: 'fail',
                summary: `node "${name}" landed with a merge conflict; needs resolution`,
                error: new LoopError({
                  code: 'BODY',
                  message: `merge conflict landing node "${name}"`,
                  path: [...path, name],
                }),
              };
            }
            try {
              await mergeLock(() =>
                mergeSynthesis(parent, {
                  branch,
                  message: `merge: ${branch} (node ${name}, synthesis)`,
                }),
              );
            } catch (e) {
              const error = LoopError.from(e, {
                code: 'BODY',
                path: [...path, name],
              });
              return {
                status: 'fail',
                summary: `node "${name}" merge synthesis failed: ${error.message}`,
                error,
              };
            }
          }
        }
        return outcome;
      };
      let outcome: Outcome;
      let discarded: { branch: string; sha: string } | undefined;
      // A node that throws may have committed work that never landed, and nothing
      // would record its sha, so its branch is kept rather than deleted.
      let threw = true;
      try {
        outcome = await attempt();
        threw = false;
      } finally {
        if (envHandle)
          await envHandle.down(parent.signal).catch(() => {});
        if (threw) parent.log(`kept the branch ${wt.branch}: node "${name}" threw before its work could land`, 'warn');
        discarded = await closeFork(parent, base.dir, wt, threw);
      }
      return discarded ? { ...outcome, discarded: [discarded] } : outcome;
    };

    /**
     * Run a node, in its own worktree when isolated. On resume the guard
     * reuses a recorded outcome or asks about an interrupted attempt first;
     * for an isolated node it wraps the fork itself, so neither makes a
     * worktree.
     */
    const runNodeJob = async (
      name: string,
      node: DagNode,
    ): Promise<Outcome> => {
      const outcome = await guardedNodeJob(name, node);
      const recorded = stages?.get(nodeKey(name));
      if (recorded?.kind !== 'completed' || recorded.outcome !== outcome) ranAgain.add(name);
      return outcome;
    };

    const guardedNodeJob = async (
      name: string,
      node: DagNode,
    ): Promise<Outcome> => {
      const retrySafe = node.retrySafe === true;
      const files = (outcome: Outcome | undefined) => nodeWrites(node, outcome);
      // The steps it needs that ran again after it finished: in this run, or
      // in one the record holds that stopped before it ran again.
      const own = recordLine(name);
      const changed = normalizeNeeds(node.needs).filter((need) => ranAgain.has(need) || recordLine(need) > own);
      const shared = resumeGuard(node.job, resumeIdentity, name, retrySafe, prior, false, files, changed);
      const isolated = node.isolate ?? config.isolation === 'worktree';
      if (!isolated) return shared(nodeCtx(name, shared));

      const base = parent.workspace;
      if (!(await isRepo({ cwd: base.dir, signal: parent.signal }))) {
        parent.log(
          `node "${name}" requested worktree isolation but ${base.dir} is not a git repo; running in the shared workspace`,
          'warn',
        );
        return shared(nodeCtx(name, shared));
      }

      const fork = resumeGuard(() => forkNodeJob(name, node), resumeIdentity, name, retrySafe, prior, true, files, changed);
      return fork(nodeCtx(name, fork));
    };

    const record = (
      name: string,
      outcome: Outcome,
      phase: 'done' | 'skip',
    ): Outcome => {
      results.set(name, outcome);
      // The record keeps the files the node wrote, as a compact record
      // drops the result data they are read from.
      const wrote = phase === 'done' ? wroteFiles(nodes.get(name)!, outcome) : [];
      // A paused or aborted node has not finished with its send-back: it
      // reads it again when it runs again.
      if (outcome.status !== 'paused' && outcome.status !== 'aborted') {
        const read = pendingKickback.get(name);
        if (read === undefined) readKickback.delete(name);
        else readKickback.set(name, read);
        pendingKickback.delete(name);
        finished.set(name, attempts.get(name) ?? 1);
      }
      parent.emit({
        kind: 'dag:node',
        ts: ts(),
        path,
        node: name,
        phase,
        ...nodeContext(name),
        outcome,
        attempt: attempts.get(name),
        timeoutMs: nodes.get(name)!.timeoutMs,
        ...recordedRounds(nodeRounds(name), path.length + 1),
        ...(wrote.length ? { wrote } : {}),
      });
      if (outcome.status !== 'paused' && outcome.status !== 'aborted') saveRounds();
      // A paused node is a deliberate halt, not a failure: stop scheduling nodes
      // even when `stopOnError` is false or the node is optional.
      if (phase === 'done' && outcome.status === 'paused') {
        stopped = true;
      }
      if (
        phase === 'done' &&
        outcome.status !== 'pass' &&
        nodes.get(name)!.optional !== true &&
        stopOnError &&
        // A node requesting a kickback is going to be re-run — don't let its
        // (provisional) non-pass abort siblings before the feedback is resolved.
        !(routeKickbacks && revisionFromOutcome(outcome)?.target)
      ) {
        stopped = true;
      }
      return outcome;
    };

    const run = (name: string): Promise<Outcome> => {
      const existing = memo.get(name);
      if (existing) return existing;
      const node = nodes.get(name)!;
      const promise = (async (): Promise<Outcome> => {
        // This node's run count: 1 the first time, +1 each kickback re-run (the
        // memo/results were cleared for the dirty subgraph, so run() re-enters).
        attempts.set(name, (attempts.get(name) ?? 0) + 1);
        // A node that runs again, a failed one on a resume included, earns a
        // fresh verdict; its target's rounds and judge history stay.
        rejected.delete(name);
        // Whole node is guarded: a throw anywhere (dep resolution, `when`, the
        // job) becomes a recorded outcome, so the DAG always reaches `dag:end`.
        try {
          const needs = normalizeNeeds(node.needs);
          const deps = await Promise.all(needs.map(run));
          // A declared `needs` on a REQUIRED producer is a hard dependency — its
          // failure blocks this consumer. An OPTIONAL producer is best-effort:
          // its failure neither fails the DAG nor blocks consumers, so a consumer
          // must tolerate that producer's artifacts being absent. Skipped deps
          // (unmet `when`) come back with status 'pass', so they never block.
          const blocked = needs.some(
            (dep, i) =>
              deps[i]!.status !== 'pass' && nodes.get(dep)!.optional !== true,
          );
          if (blocked)
            return record(
              name,
              { status: 'aborted', summary: 'blocked by a failed dependency' },
              'done',
            );
          if (parent.signal.aborted || stopped)
            return record(
              name,
              { status: 'aborted', summary: 'aborted before start' },
              'done',
            );

          // `when` + the job both run inside the concurrency limit, so an
          // agentCheck gate counts against the cap (it's real backend load).
          const result = await concurrency(
            async (): Promise<{ outcome: Outcome; phase: 'done' | 'skip' }> => {
              if (parent.signal.aborted || stopped)
                return {
                  outcome: {
                    status: 'aborted',
                    summary: 'aborted before start',
                  },
                  phase: 'done',
                };
              if (node.when) {
                const conditionCtx = nodeCtx(name, undefined);
                const r = await toCondition(node.when)(conditionCtx, undefined);
                parent.emit({
                  kind: 'condition:result',
                  ts: ts(),
                  path: [...conditionCtx.path],
                  label: 'when',
                  iteration: conditionCtx.iteration,
                  result: r,
                });
                if (!r.met)
                  return {
                    outcome: {
                      status: 'pass',
                      summary: `skipped: ${r.reason}`,
                      data: { skipped: true },
                    },
                    phase: 'skip',
                  };
              }
              parent.emit({
                kind: 'dag:node',
                ts: ts(),
                path,
                node: name,
                phase: 'start',
                ...nodeContext(name),
                attempt: attempts.get(name),
                timeoutMs: node.timeoutMs,
                ...recordedRounds(nodeRounds(name), path.length + 1),
              });
              return { outcome: await runNodeJob(name, node), phase: 'done' };
            },
          );
          return record(name, result.outcome, result.phase);
        } catch (e) {
          const error = LoopError.from(e, {
            code: 'BODY',
            phase: 'body',
            path: [...path, name],
          });
          parent.emit({
            kind: 'error',
            ts: ts(),
            path: [...path, name],
            message: error.message,
            code: error.code,
          });
          return record(
            name,
            { status: 'fail', summary: error.message, error },
            'done',
          );
        }
      })();
      memo.set(name, promise);
      return promise;
    };

    await Promise.all(names.map(run));

    // Cross-stage feedback: a node may return a `kickback` asking an earlier
    // node to redo work. We re-run the target + its dependents (the cycle lives
    // in execution, the graph stays acyclic). A numeric `maxKickbacks` or a
    // judge's `cap` bounds the re-runs; a judge with no cap re-runs until it
    // stops the rounds or the review passes. An omitted budget or numeric zero keeps the default
    // single-pass path; a target map still records rejected requests at zero.
    // The judge saves its own state when it pauses to ask a question.
    let judgePaused = false;
    const emitKickback = (
      from: string,
      to: string,
      reason: string,
      accepted: boolean,
      count: number,
      limit: number | undefined,
      note?: string,
    ) =>
      parent.emit({
        kind: 'dag:kickback',
        ts: ts(),
        path,
        from,
        to,
        reason,
        accepted,
        count,
        ...(limit !== undefined ? { limit } : {}),
        note,
      });
    // A node sends work back only to a target it declares in
    // `acceptsKickbackTo` (checked against the graph when it is built).
    // Any other target is an error that fails the sender, whatever the budget.
    const undeclared = (from: string, to: string, reason: string, count: number, limit: number | undefined): boolean => {
      if (nodes.get(from)!.acceptsKickbackTo?.includes(to)) return false;
      const message = `dag "${config.name}": node "${from}" sent work back to "${to}", which it does not declare in acceptsKickbackTo`;
      rejected.add(from);
      emitKickback(from, to, reason, false, count, limit, message);
      memo.set(from, Promise.resolve(record(from, {
        status: 'fail',
        summary: message,
        error: new LoopError({ code: 'CONFIG', path: [...path, from], message }),
      }, 'done')));
      return true;
    };
    if (!routeKickbacks) {
      for (const from of order) {
        const request = results.get(from) && revisionFromOutcome(results.get(from)!);
        if (request?.target === undefined) continue;
        undeclared(from, request.target, request.reason, (targetCounts.get(request.target) ?? 0) + 1, targetLimit(request.target));
      }
    } else {
      for (;;) {
        // A pause outranks a pending kickback. Nothing may run past it.
        if (names.some((n) => results.get(n)?.status === 'paused')) break;
        // Honour kickbacks in topological order, skipping any already rejected.
        const from = order.find(
          (n) => {
            const result = results.get(n);
            return (
              result !== undefined &&
              revisionFromOutcome(result)?.target !== undefined &&
              !rejected.has(n)
            );
          },
        );
        if (!from) break;
        const request = revisionFromOutcome(results.get(from)!)!;
        const to = request.target!;
        const { reason } = request;
        // The round is the target's build under review: one more than its
        // builds before it, the send-backs to it that were carried out and
        // the rounds it ran on its own reviews. A request the judge lets
        // stand, or a second reviewer of the same build, is the same round.
        const count = pending?.from === from ? pending.count : (targetCounts.get(to) ?? 0) + 1;
        const limit = targetLimit(to);

        if (undeclared(from, to, reason, count, limit)) continue;
        // The one round rule: a numeric budget for the whole graph counts the
        // send-backs it has accepted; a target's own budget counts its rounds.
        const round = roundRule(perTargetBudget ? count : used + 1, limit);

        // A judge stands between the review's verdict and the send-back,
        // for every finding, a block included. The
        // request after the cap's last kickback is the last round's review:
        // the judge is still asked, and no kickback follows its answer.
        const requestFindings = request.findings ?? [];
        // A revision that skips the judge (an unmet requirement) goes straight back.
        const cfgJudge = request.skipJudge ? undefined : targetJudge(to);
        const { lastRound } = round;
        let effectiveReason = reason;
        let effectiveFindings = request.findings;
        let productDecision: Outcome | undefined;
        if (cfgJudge !== undefined) {
          const history = judgeHistory.get(to) ?? [];
          const work = { ...(config.useCase !== undefined ? { useCase: config.useCase } : {}), ...(nodes.get(to)!.file !== undefined ? { file: nodes.get(to)!.file } : {}) };
          const { draft, changedLines } = await readJudgedFile(parent.workspace.dir, work.file, judgeDrafts.get(to));
          const state: JudgeState = pending?.from === from ? pending.state : judgeState({
            work, draft, productFeedback: productFeedback.get(to) ?? [], latestFindings: requestFindings, skipped: judgeSkipped.get(to) ?? [], rounds: history, round: round.judge,
          });
          // The judge runs as part of the node that sent the work back:
          // inside that node's timeout and the graph's concurrency limit.
          const result = await concurrency(() => consultJudge(cfgJudge, state, nodeCtx(from, undefined), [...path, from], {
            target: to, identity: interactionIdentity({ identity, from, to }), pending: pending?.from === from,
            save: (questionState) => checkpointInteraction(parent, checkpointPath, identity, jsonSnapshot({
              pending: { from, count, state: questionState },
              results: Object.fromEntries([...results].map(([name, outcome]) => [name, outcomeSnapshot(outcome)])),
              wrote: wroteSoFar(),
              readKickbacks: Object.fromEntries([...readKickback].map(([name, o]) => [name, outcomeSnapshot(o)])),
              attempts: Object.fromEntries(attempts), targetCounts: Object.fromEntries(targetCounts),
              history: Object.fromEntries(judgeHistory), skipped: Object.fromEntries(judgeSkipped), productFeedback: Object.fromEntries(productFeedback), drafts: Object.fromEntries(judgeDrafts), used, rejected: [...rejected],
            })),
          }));
          if ('paused' in result) { judgePaused = true; record(from, result.paused, 'done'); break; }
          pending = undefined;
          productFeedback.set(to, result.state.productFeedback ?? []);
          judgeHistory.set(to, [...history, judgeRound(count, requestFindings, changedLines)]);
          if (draft === undefined) judgeDrafts.delete(to); else judgeDrafts.set(to, draft);
          // The decision replaces the saved question: a resume keeps the round.
          saveRounds();
          // When the judge stops the rounds, or after the last round the cap
          // allows, `from`'s failure stands with its findings, and its outcome
          // says why the run stopped there.
          const stopWith = (why: string) => {
            const failed = results.get(from)!;
            memo.set(from, Promise.resolve(record(from, {
              ...failed,
              summary: `${failed.summary ?? reason} (${why})`,
              revision: { ...request, reason: `${reason} (${why})` },
            }, 'done')));
            rejected.add(from);
          };
          if ('answer' in result && lastRound) {
            // No kickback is left for the answer: the review's own failure stands.
            const why = lastRoundAnswered(result.state, result.answer);
            emitKickback(from, to, reason, false, count, limit, why);
            stopWith(why);
            continue;
          }
          if ('answer' in result) {
            // A person's answer goes back to the target as this round's
            // feedback; the judge sees the result only after it is reviewed.
            // The judge decided each finding before asking: the answer goes with the acted ones only.
            const answered = judgedFindings(requestFindings, { findings: result.state.decided }, result.state.skipped ?? [], count);
            judgeSkipped.set(to, answered.skipped);
            productDecision = productDecisionFeedback(result.answer, answered.acted, { target: to, source: request.source ?? from });
            effectiveReason = `${reason} (a person answered the judge's product decision)`;
          }
          const decision = 'decision' in result ? result.decision : undefined;
          // Per-finding decisions: skipped findings are remembered for the next
          // round's reviewers, and only the acted ones go to the builder.
          const judged = decision ? judgedFindings(requestFindings, decision, result.state.skipped ?? [], count) : undefined;
          if (judged) judgeSkipped.set(to, judged.skipped);
          if (decision?.again === false) {
            emitKickback(from, to, `${reason} (${decision.reason})`, false, count, limit, decision.reason);
            if (decision.stop === 'ship') {
              // Holds or over-polishing: the work stands. `from`'s own
              // failure is replaced with a pass carrying the judge's reason,
              // and everything downstream of it (blocked by that failure in
              // the wave that already ran) gets to run fresh against it.
              const shipped = record(from, {
                status: 'pass',
                confidence: results.get(from)!.confidence,
                summary: decision.reason,
                data: results.get(from)!.data,
                ...(lastRound ? { openFindings: requestFindings } : {}),
              }, 'done');
              // `memo` holds the settled promise every dependant already
              // awaits or will await; without this, `from`'s stale failing
              // promise still answers for it and nothing downstream unblocks.
              memo.set(from, Promise.resolve(shipped));
              const unblocked = dirtyFrom(from);
              unblocked.delete(from);
              for (const d of unblocked) {
                memo.delete(d);
                results.delete(d);
                rejected.delete(d);
              }
              stopped = false;
              await Promise.all(names.map(run));
              continue;
            }
            // not_converging (or a caller-supplied question set with no
            // stop kind, or any answer but a ship after the last round the
            // cap allows): `from`'s own failure stands, same as a plain
            // numeric budget running out.
            stopWith(decision.reason);
            continue;
          }
          if (decision) effectiveReason = `${reason} (${decision.reason})`;
          if (judged && request.findings) effectiveFindings = judged.acted;
        }

        if (!round.another) {
          // Budget spent. Reject and stop: the unresolved kickback leaves the
          // kicking node's own outcome to stand.
          emitKickback(
            from,
            to,
            reason,
            false,
            count,
            limit,
            `kickback budget for "${to}" (${limit}) exhausted`,
          );
          if (perTargetBudget) {
            rejected.add(from);
            continue;
          }
          break;
        }

        used += 1;
        targetCounts.set(to, count);
        emitKickback(from, to, effectiveReason, true, count, limit);
        const dirty = dirtyFrom(to);
        for (const d of dirty) {
          memo.delete(d); // force re-run
          results.delete(d);
          rejected.delete(d); // a re-run earns a fresh verdict
        }
        pendingKickback.set(to, productDecision ?? {
          status: 'fail',
          summary: `Kicked back from "${from}": ${effectiveReason}`,
          revision: { ...request, reason: effectiveReason, ...(effectiveFindings ? { findings: effectiveFindings } : {}), source: request.source ?? from },
        });
        saveRounds();
        stopped = false; // a prior stopOnError must not block the re-run
        await Promise.all(names.map(run));
      }
    }

    // A node that ran out of rounds or stalled never passed: it fails the
    // graph like a plain failure.
    const requiredFailed = names.filter(
      (n) =>
        (results.get(n)?.status === 'fail' || results.get(n)?.status === 'exhausted')
        && nodes.get(n)!.optional !== true,
    );
    const ranOut = requiredFailed
      .filter((n) => results.get(n)!.status === 'exhausted')
      .map((n) => {
        const o = results.get(n)!;
        return `; "${n}" ${o.stall ? 'stalled' : 'ran out of rounds'}: ${o.revision?.reason ?? o.summary ?? 'no reason given'}`;
      })
      .join('');
    const requiredAborted = names.filter(
      (n) =>
        results.get(n)?.status === 'aborted' && nodes.get(n)!.optional !== true,
    );
    // A pause anywhere in the graph (any node, optional included) pauses the
    // whole dag. First in declaration order names the outcome.
    const pausedNode = names.find((n) => results.get(n)?.status === 'paused');
    const data = Object.fromEntries(results);
    const late = [...results.values()].some((r) => r.late);
    let outcome: Outcome;
    if (parent.signal.aborted) {
      // a genuine user/signal cancellation
      outcome = {
        status: 'aborted',
        ...(late ? { late: true } : {}),
        summary: `dag "${config.name}" aborted`,
        data,
      };
    } else if (pausedNode) {
      // Paused takes precedence over fail. The paused node's dependents land
      // blocked-aborted as usual; they must not flip this to fail.
      outcome = {
        status: 'paused',
        ...(late ? { late: true } : {}),
        summary: results.get(pausedNode)!.summary,
        data,
      };
    } else if (requiredFailed.length > 0 || requiredAborted.length > 0) {
      // a real failure (direct, or a required node left undone by an upstream
      // failure) is a fail (exit 1), distinct from a cancellation (exit 130).
      // A required node's error that a retry cannot fix fails the dag with
      // it, so a loop around the dag stops as it would around that node.
      const fatal = requiredFailed.map((n) => results.get(n)!.error).find((error) => error !== undefined && !error.retryable);
      outcome = {
        status: 'fail',
        ...(late ? { late: true } : {}),
        summary: `dag "${config.name}": ${requiredFailed.length + requiredAborted.length} required node(s) did not complete${ranOut}${fatal ? `; ${fatal.message}` : ''}`,
        data,
        ...(fatal ? { error: fatal } : {}),
      };
    } else {
      outcome = {
        status: 'pass',
        ...(late ? { late: true } : {}),
        summary: `dag "${config.name}": all ${names.length} node(s) green`,
        data,
      };
    }
    // A graph keeps its rounds however it ended, so a resume counts on from
    // them and never builds past the limit, and a passed graph whose files
    // are gone rebuilds them in the round it passed in.
    if (outcome.status === 'paused' && !judgePaused) saveRounds();
    parent.emit({ kind: 'dag:end', ts: ts(), path, outcome });
    return outcome;
  };
  // A graph wrote the files of the steps its recorded result shows passed,
  // or, where a compact record dropped them, the steps' own records show.
  declareWrites(job, (outcome) => {
    const ran = (outcome?.data ?? recordedSteps(outcome, config.name)) as Record<string, Outcome | undefined> | undefined;
    return [...new Set([...nodes].flatMap(([name, node]) => wroteFiles(node, ran?.[name])))];
  });

  return interactionDeclaration(setMeta(job, {
    kind: 'dag',
    name: config.name,
    ...(config.maxKickbacks !== undefined
      ? { maxKickbacks: config.maxKickbacks }
      : {}),
    nodes: Object.entries(config.nodes).map(([name, v]) => {
      const node = typeof v === 'function' ? undefined : v;
      const nodeJob = node ? node.job : (v as Job);
      return {
        name,
        needs: normalizeNeeds(node?.needs),
        ...(node?.desc !== undefined ? { desc: node.desc } : {}),
        ...(node?.gate !== undefined ? { gate: node.gate } : {}),
        isolate: node?.isolate ?? false,
        optional: node?.optional === true,
        ...(node?.timeoutMs ? { timeoutMs: node.timeoutMs } : {}),
        // Condition labels only — the meta must stay JSON-serializable
        // so outside readers can serialize it directly.
        ...(node?.when ? { when: describeConditions(node.when) } : {}),
        job: jobMeta(nodeJob),
      };
    }),
  }), config);
}

/** Run jobs strictly in order; stop at the first non-pass. Sugar over `dag`. */
export function sequence(name: string, ...jobs: Job[]): Job {
  const nodes: Record<string, DagNode> = {};
  jobs.forEach((job, i) => {
    nodes[`step-${i}`] = { job, needs: i > 0 ? [`step-${i - 1}`] : [] };
  });
  return dag({ name, nodes, concurrency: 1, stopOnError: true });
}

/** Run jobs concurrently; default fan-out is capped at 4. */
export function parallel(
  name: string,
  jobs: Record<string, Job> | Job[],
  concurrency?: number,
): Job {
  const record = Array.isArray(jobs)
    ? Object.fromEntries(jobs.map((j, i) => [`task-${i}`, j] as const))
    : jobs;
  return dag({ name, nodes: record, concurrency, stopOnError: false });
}
