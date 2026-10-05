/**
 * `isolated(job)` runs any Job in its own git worktree on a fork branch, and lands
 * its work back into the parent branch on pass. The concurrency boundary as a Job
 * wrapper, not a node type.
 *
 * dag nodes can already fork a worktree (`isolation: 'worktree'`), but that only
 * works for predeclared nodes. A Tend loop dispatches dynamically: it discovers each
 * ticket at runtime and routes it to the right shape of sub-loop, and each dispatch
 * wants its own isolated worktree so parallel tickets never collide on files or the
 * index. `isolated()` makes that composable: wrap the dispatched Job.
 *
 * On pass: any uncommitted remainder is committed in the worktree, then the fork
 * branch merges back (`--no-ff`). Land-back merges are serialised across all
 * `isolated()` jobs in the process, so concurrent dispatch cannot race the parent
 * index/HEAD. A conflict fails, or is synthesised when asked. The worktree
 * is always removed, and then the fork branch is deleted. When that branch
 * held commits that never landed, the outcome's `discarded` names it and its
 * last commit. A process that dies mid-attempt leaves its worktree and
 * branch for a person to recover; a cleanup git refuses leaves them too, with
 * a warning in the log. A non-repo workspace degrades to running in place (a
 * warning, no isolation).
 *
 * NOTE: dag's own runNodeJob holds parallel worktree/land-back logic (plus per-team
 * environments). The two should be unified (dag delegating to `isolated()`) once
 * `isolated()` grows environment support; until then the land-back logic lives in
 * both deliberately, to avoid destabilising the dag path.
 */

import type { Job, JobContext, Outcome, Workspace } from './types.js';
import type { ReasoningRecorder } from '@obversa/api';

import { childContext } from './context.js';
import { LoopError } from './errors.js';
import {
  addWorktree,
  branchExists,
  removeWorktree,
  deleteBranch,
  mergeBranch,
  stageAll,
  commit,
  hasStagedChanges,
  headSha,
  isRepo,
  unlandedTip,
  type WorktreeHandle,
} from './git.js';
import { mergeLock, mergeSynthesis } from './merge.js';

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';

let forkSeq = 0;

export interface IsolatedOptions {
  /** Label for the fork branch and the child path. Default 'isolated'. */
  label?: string;
  /** On a land-back conflict: 'fail' (default) or 'synthesize'. */
  onConflict?: 'fail' | 'synthesize';
  /**
   * A record of why this stage's change exists. It watches the stage's own
   * events and, when the stage passes with something to commit, supplies the
   * message for the commit that carries the change. A stage that changed
   * nothing produces no commit, so it is never asked for one.
   */
  record?: ReasoningRecorder;
}

/**
 * Finish with a fork once its step has ended: remove its worktree, then delete
 * its branch unless `keepBranch` is set. Returns the branch and its last commit
 * when the deleted branch held commits that never landed. Cleanup runs even
 * after the run was stopped. A cleanup that fails is logged as a warning and
 * never changes the step's outcome.
 */
export async function closeFork(
  parent: JobContext,
  repoDir: string,
  fork: WorktreeHandle,
  keepBranch = false,
): Promise<{ branch: string; sha: string } | undefined> {
  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
  try {
    await removeWorktree(repoDir, fork.dir);
  } catch (error) {
    parent.log(`could not remove the worktree ${fork.dir}: ${reason(error)}`, 'warn');
  }
  if (keepBranch) return undefined;
  try {
    const sha = await unlandedTip(repoDir, fork.branch);
    await deleteBranch(repoDir, fork.branch);
    return sha === undefined ? undefined : { branch: fork.branch, sha };
  } catch (error) {
    parent.log(`could not delete the branch ${fork.branch}: ${reason(error)}`, 'warn');
    return undefined;
  }
}

/** Wrap a Job so it runs in an isolated worktree and lands back on pass. */
export function isolated(job: Job, opts: IsolatedOptions = {}): Job {
  const label = opts.label ?? 'isolated';
  return async (parent) => {
    const base = parent.workspace;
    if (!(await isRepo({ cwd: base.dir, signal: parent.signal }))) {
      // A stage that asked to record its reasoning cannot have it: there is
      // no commit to carry it. Running anyway would drop the opt-in in
      // silence, which is the one outcome the ruling forbids.
      if (opts.record) {
        const message = `isolated("${label}") cannot record its reasoning: ${base.dir} is not a git repository`;
        return {
          status: 'fail',
          summary: message,
          error: new LoopError({ code: 'CONFIG', message, path: [...parent.path, label] }),
        };
      }
      parent.log(
        `isolated("${label}") requested a worktree but ${base.dir} is not a git repo; running in the shared workspace`,
        'warn',
      );
      return job(parent);
    }

    // An interrupted earlier run leaves its fork branch behind for recovery,
    // and a new run counts forks from zero again, so skip any name that is
    // already taken.
    let branch = `lines/${slug(label)}-${(forkSeq += 1)}`;
    while (await branchExists(base.dir, branch, { signal: parent.signal })) {
      branch = `lines/${slug(label)}-${(forkSeq += 1)}`;
    }
    const wt = await addWorktree(base.dir, {
      branch,
      base: 'HEAD',
      signal: parent.signal,
    });
    // Where the fork started, so a job that commits its own work can be told
    // apart from one that left its changes for this wrapper to commit.
    const startSha = await headSha({ cwd: wt.dir, signal: parent.signal });
    const wtWs: Workspace = { dir: wt.dir, branch };
    const attempt = async (): Promise<Outcome> => {
      const ctx = childContext(parent, {
        workspace: wtWs,
        depth: parent.depth + 1,
        path: [...parent.path, label],
      });
      const outcome = await job(ctx);
      if (outcome.status === 'pass') {
        // Capture anything the job left uncommitted, then land it back.
        await stageAll({ cwd: wt.dir, signal: parent.signal });
        // The reasoning rides the commit that carries the change: this one.
        // It is asked for only when there is something staged, so a stage
        // that changed nothing writes neither a commit nor a body.
        const staged = await hasStagedChanges({ cwd: wt.dir, signal: parent.signal });
        // A record attaches to the commit this wrapper makes, so any commit the
        // job made itself carries no reasoning and must stop the stage. The
        // question is whether HEAD moved, never whether anything is staged: a
        // job that commits one file and leaves another has both a commit of its
        // own and something staged, and reading `staged` would let that commit
        // merge back unexplained while the body landed on the leftover.
        if (opts.record) {
          const head = await headSha({ cwd: wt.dir, signal: parent.signal });
          if (head !== undefined && head !== startSha) {
            const message = `isolated("${label}") cannot record its reasoning: the stage committed its own work, `
              + 'and a record attaches to the commit this wrapper makes';
            return {
              status: 'fail',
              summary: message,
              error: new LoopError({ code: 'BODY', message, path: [...parent.path, label] }),
            };
          }
        }
        const message = opts.record && staged
          ? await opts.record.message({
            status: outcome.status,
            ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
          })
          : undefined;
        const sha = await commit(
          message ?? { subject: `chore(${slug(label)}): worktree changes` },
          { cwd: wt.dir, signal: parent.signal },
        );
        const merged = await mergeLock(() =>
          mergeBranch(base.dir, branch, {
            signal: parent.signal,
            message: `merge ${branch}`,
          }),
        );
        if (!merged.ok) {
          if (opts.onConflict !== 'synthesize') {
            return {
              status: 'fail',
              summary: `isolated("${label}") landed with a merge conflict; needs resolution`,
              error: new LoopError({
                code: 'BODY',
                message: `merge conflict landing isolated("${label}")`,
                path: [...parent.path, label],
              }),
            };
          }
          try {
            await mergeLock(() =>
              mergeSynthesis(parent, {
                branch,
                message: `merge: ${branch} (synthesis)`,
              }),
            );
          } catch (e) {
            const error = LoopError.from(e, { code: 'BODY', path: [...parent.path, label] });
            return {
              status: 'fail',
              summary: `isolated("${label}") merge synthesis failed: ${error.message}`,
              error,
            };
          }
        }
        // Told the work has landed, the recorder starts the next iteration
        // empty; never told, it keeps the turns for another attempt. This is
        // after the merge, not after the fork commit: a land-back that fails
        // leaves the change outside the parent, and a recorder cleared at the
        // fork commit would compose the retry from nothing.
        if (opts.record && message && sha !== undefined) opts.record.committed(sha);
      }
      return outcome;
    };
    let outcome: Outcome;
    let discarded: { branch: string; sha: string } | undefined;
    // A step that throws may have committed work that never landed, and nothing
    // would record its sha, so its branch is kept rather than deleted.
    let threw = true;
    try {
      outcome = await attempt();
      threw = false;
    } finally {
      if (threw) parent.log(`kept the branch ${wt.branch}: the step threw before its work could land`, 'warn');
      discarded = await closeFork(parent, base.dir, wt, threw);
    }
    return discarded ? { ...outcome, discarded: [discarded] } : outcome;
  };
}
