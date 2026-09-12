/**
 * Tournament runs alternative approaches to the same task. Where a DAG fans out
 * disjoint work and lands all of it, a tournament runs N candidates, each in its own
 * isolated worktree, judges them, lands only the winner and discards the rest.
 *
 * It composes over the worktree primitives, no new machinery. Only one branch is ever
 * merged (the winner, off an unchanged HEAD), so there is no conflict to resolve.
 */

import pLimit from 'p-limit';

import type { Job, JobContext, Outcome, Workspace } from './types.js';
import { childContext } from './context.js';
import {
  isRepo,
  addWorktree,
  removeWorktree,
  deleteBranch,
  mergeBranch,
  stageAll,
  commit,
} from './git.js';
import { LoopError } from './errors.js';

function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/(^-+|-+$)/g, '') || 'x';
}

export interface TournamentConfig {
  name: string;
  /** Candidates to run. */
  n: number;
  /** Build the candidate job for attempt `i` (0-based): same task, varied angle. */
  candidate: (i: number) => Job;
  /**
   * Score a finished candidate (higher wins). Run against the candidate's own
   * context, so it can read the candidate's workspace. The highest-scoring
   * passing candidate lands back; ties break to the earliest.
   */
  judge: (outcome: Outcome, ctx: JobContext) => number | Promise<number>;
  /** Max candidates running at once. Default `n`. */
  concurrency?: number;
}

interface Attempt {
  i: number;
  branch: string;
  dir: string;
  outcome: Outcome;
  score: number;
}

export function tournament(config: TournamentConfig): Job {
  if (!config.name)
    throw new LoopError({
      code: 'CONFIG',
      message: 'tournament() requires a non-empty name',
    });
  if (config.n < 1)
    throw new LoopError({ code: 'CONFIG', message: 'tournament() needs n >= 1' });

  return async (parent: JobContext): Promise<Outcome> => {
    const path = [...parent.path, config.name];
    const base = parent.workspace;
    parent.emit({
      kind: 'job:start',
      ts: Date.now(),
      path,
      label: config.name,
      timeoutMs: parent.timeoutMs,
    });

    if (!(await isRepo({ cwd: base.dir, signal: parent.signal }))) {
      const error = new LoopError({
        code: 'CONFIG',
        message: `tournament "${config.name}" requires a git repository (cwd: ${base.dir})`,
      });
      return { status: 'fail', summary: error.message, error };
    }

    const limit = pLimit(config.concurrency ?? config.n);
    const attempts = await Promise.all(
      Array.from({ length: config.n }, (_, i) =>
        limit(async (): Promise<Attempt> => {
          const branch = `lines/${slug(config.name)}-cand-${i}`;
          const wt = await addWorktree(base.dir, {
            branch,
            base: 'HEAD',
            signal: parent.signal,
          });
          const ws: Workspace = { dir: wt.dir, branch };
          try {
            const ctx = childContext(parent, {
              depth: parent.depth + 1,
              path: [...path, `#${i}`],
              workspace: ws,
            });
            const outcome = await config.candidate(i)(ctx);
            // Capture the candidate's work onto its branch so the winner can land.
            await stageAll({ cwd: wt.dir, signal: parent.signal });
            await commit(
              {
                subject: `${config.name}: candidate ${i}`,
              },
              { cwd: wt.dir, signal: parent.signal },
            );
            const score =
              outcome.status === 'pass' ? await config.judge(outcome, ctx) : -1;
            parent.log(`${config.name} candidate ${i}: score ${score}`);
            return { i, branch, dir: wt.dir, outcome, score };
          } catch (e) {
            const error = LoopError.from(e, { code: 'BODY', path });
            console.error(JSON.stringify({
              diagnostic: 'F33',
              candidate: i,
              code: error.code,
              message: error.message,
            }));
            return {
              i,
              branch,
              dir: wt.dir,
              outcome: { status: 'fail', summary: error.message, error },
              score: -1,
            };
          }
        }),
      ),
    );

    // A paused candidate is a deliberate halt, not a loss. Mirror DAG precedence
    // and propagate the pause instead of flattening it into "no candidate passed".
    const paused = attempts.find((a) => a.outcome.status === 'paused');

    // Winner: highest score among passing candidates; ties to the earliest.
    const winner = paused
      ? undefined
      : [...attempts]
          .filter((a) => a.outcome.status === 'pass' && a.score >= 0)
          .sort((a, b) => b.score - a.score || a.i - b.i)[0];

    let landed = false;
    if (winner) {
      const merged = await mergeBranch(base.dir, winner.branch, {
        signal: parent.signal,
        message: `${config.name}: land candidate ${winner.i} (score ${winner.score})`,
      });
      landed = merged.ok;
    }

    // Tear down every worktree; delete loser branches and the merged winner.
    for (const a of attempts) {
      await removeWorktree(base.dir, a.dir, { signal: parent.signal }).catch(
        () => {},
      );
      if (a !== winner || landed)
        await deleteBranch(base.dir, a.branch, {
          signal: parent.signal,
        }).catch(() => {});
    }

    const outcome: Outcome = paused
      ? { ...paused.outcome }
      : winner
      ? {
          status: landed ? 'pass' : 'fail',
          confidence: winner.outcome.confidence,
          summary: landed
            ? `tournament "${config.name}": landed candidate ${winner.i} (score ${winner.score}) of ${config.n}`
            : `tournament "${config.name}": winner ${winner.i} failed to land`,
          data: {
            winner: winner.i,
            score: winner.score,
            scores: attempts.map((a) => ({ i: a.i, score: a.score })),
          },
        }
      : {
          status: 'fail',
          summary: `tournament "${config.name}": no candidate passed`,
          data: { scores: attempts.map((a) => ({ i: a.i, score: a.score })) },
        };
    parent.emit({ kind: 'job:end', ts: Date.now(), path, label: config.name, outcome });
    return outcome;
  };
}
