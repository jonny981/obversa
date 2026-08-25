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
 * is always removed; a cleanly-merged fork branch is deleted. A non-repo workspace
 * degrades to running in place (a warning, no isolation).
 *
 * NOTE: dag's own runNodeJob holds parallel worktree/land-back logic (plus per-team
 * environments). The two should be unified (dag delegating to `isolated()`) once
 * `isolated()` grows environment support; until then the land-back logic lives in
 * both deliberately, to avoid destabilising the dag path.
 */

import pLimit from 'p-limit';

import type { Job, Workspace } from './types.js';
import { childContext } from './context.js';
import { LoopError } from './errors.js';
import {
  addWorktree,
  removeWorktree,
  deleteBranch,
  mergeBranch,
  stageAll,
  commit,
  isRepo,
} from './git.js';
import { mergeSynthesis } from './merge.js';

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'job';

/** Serialise land-back merges process-wide so concurrent dispatch can't race. */
const mergeLock = pLimit(1);
let forkSeq = 0;

export interface IsolatedOptions {
  /** Label for the fork branch and the child path. Default 'isolated'. */
  label?: string;
  /** On a land-back conflict: 'fail' (default) or 'synthesize'. */
  onConflict?: 'fail' | 'synthesize';
}

/** Wrap a Job so it runs in an isolated worktree and lands back on pass. */
export function isolated(job: Job, opts: IsolatedOptions = {}): Job {
  const label = opts.label ?? 'isolated';
  return async (parent) => {
    const base = parent.workspace;
    if (!(await isRepo({ cwd: base.dir, signal: parent.signal }))) {
      parent.log(
        `isolated("${label}") requested a worktree but ${base.dir} is not a git repo; running in the shared workspace`,
        'warn',
      );
      return job(parent);
    }

    const branch = `lines/${slug(label)}-${(forkSeq += 1)}`;
    const wt = await addWorktree(base.dir, {
      branch,
      base: 'HEAD',
      signal: parent.signal,
    });
    const wtWs: Workspace = { dir: wt.dir, branch };
    try {
      const ctx = childContext(parent, {
        workspace: wtWs,
        depth: parent.depth + 1,
        path: [...parent.path, label],
      });
      const outcome = await job(ctx);
      if (outcome.status === 'pass') {
        // Capture anything the job left uncommitted, then land it back.
        await stageAll({ cwd: wt.dir, signal: parent.signal });
        await commit(
          {
            subject: `chore(${slug(label)}): worktree changes`,
          },
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
        await deleteBranch(base.dir, branch, { signal: parent.signal }).catch(() => {});
      }
      return outcome;
    } finally {
      await removeWorktree(base.dir, wt.dir, { signal: parent.signal }).catch(() => {});
    }
  };
}
