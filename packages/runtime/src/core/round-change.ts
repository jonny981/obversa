/**
 * What one build round changed in a git workspace, and which findings it was
 * sent back to answer: the link from a finding to the change that answered it.
 */

import { revisionFromOutcome } from './feedback.js';
import { treeLineChanges, workTreeSnapshot } from './git.js';
import { findingId } from './judge.js';
import type { JobContext, Outcome } from './types.js';

/** The round a `round:change` event describes. */
export interface RoundChange {
  readonly path: readonly string[];
  readonly node?: string;
  readonly round: number;
  readonly findings: readonly string[];
}

/**
 * Snapshot the directory now: the workspace, or the worktree a node runs in.
 * The returned function emits a `round:change` with every file that changed
 * in it since, whoever changed it. Undefined when it is not in a git
 * repository.
 */
export async function watchRoundChange(
  ctx: JobContext,
  dir: string = ctx.workspace.dir,
): Promise<((round: RoundChange) => Promise<void>) | undefined> {
  const opts = {
    cwd: dir,
    signal: ctx.signal,
    ...(ctx.fingerprintExcludePaths === undefined ? {} : { excludePaths: ctx.fingerprintExcludePaths }),
  };
  const before = await workTreeSnapshot(opts);
  if (before === undefined) return undefined;
  return async ({ path, node, round, findings }) => {
    const after = await workTreeSnapshot(opts);
    if (after === undefined || after.root !== before.root) return;
    let files: Awaited<ReturnType<typeof treeLineChanges>>;
    try {
      files = await treeLineChanges(before.root, before.tree, after.tree, ctx.signal);
    } catch {
      return;
    }
    ctx.emit({
      kind: 'round:change',
      ts: Date.now(),
      path: [...path],
      ...(node === undefined ? {} : { node }),
      round,
      files,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      findings: [...findings],
    });
  };
}

/** The ids of the findings an outcome sends back, in the round that raised them. */
export function answeredFindingIds(review: Outcome | undefined): string[] {
  const findings = review === undefined ? [] : revisionFromOutcome(review)?.findings ?? [];
  return findings.map((finding, index) => finding.id ?? findingId(index));
}
