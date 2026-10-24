/**
 * Accepted proofs: each proof a proof check accepted, with the tree it was
 * accepted on and the files it covers. A proof stays accepted until the
 * diff from that tree to the current one touches a file it covers.
 */

import type { AcceptedProof, JobContext } from './types.js';
import { treeChanges } from './git.js';
import { runRuntimeProcess } from './process.js';

/** Run-owned state key: the proofs accepted so far in this run. */
export const ACCEPTED_PROOFS = 'obversa:accepted-proofs';

/**
 * The proofs accepted so far: this run's list, or on a fresh run the list
 * the earlier run left (`ctx.carried`).
 */
export function acceptedProofs(ctx: Pick<JobContext, 'state' | 'carried'>): readonly AcceptedProof[] {
  const kept = ctx.state[ACCEPTED_PROOFS];
  return Array.isArray(kept) ? kept as AcceptedProof[] : ctx.carried?.acceptedProofs ?? [];
}

/**
 * Add proofs to the accepted list. A proof for an item already on the list
 * replaces it; a new report never clears the list.
 */
export function acceptProofs(ctx: Pick<JobContext, 'state' | 'carried'>, proofs: readonly AcceptedProof[]): readonly AcceptedProof[] {
  const items = new Set(proofs.map((proof) => proof.item));
  const list = [...acceptedProofs(ctx).filter((proof) => !items.has(proof.item)), ...proofs];
  ctx.state[ACCEPTED_PROOFS] = list;
  return list;
}

/** Run-owned state key: the proof check's send-backs so far, and the report the last one read. */
export const PROOF_SEND_BACKS = 'obversa:proof-send-backs';

/** How many times the proof check sent work back in this run, and the report it read the last time. */
export interface ProofSendBacks {
  readonly count: number;
  readonly report: string;
}

/** The proof check's send-backs so far in this run; a resume reads them back from the record. */
export function proofSendBacks(ctx: Pick<JobContext, 'state'>): ProofSendBacks {
  const kept = ctx.state[PROOF_SEND_BACKS] as ProofSendBacks | undefined;
  return kept ?? { count: 0, report: '' };
}

/**
 * Count one more proof send-back, with the report it read. Put the result
 * in the outcome's `data.proofSendBacks`, so a resume reads it back.
 */
export function noteProofSendBack(ctx: Pick<JobContext, 'state'>, report: string): ProofSendBacks {
  const next = { count: proofSendBacks(ctx).count + 1, report };
  ctx.state[PROOF_SEND_BACKS] = next;
  return next;
}

function covers(files: readonly string[], path: string): boolean {
  return files.some((file) => {
    const trimmed = file.replace(/\/+$/, '');
    return path === trimmed || path.startsWith(`${trimmed}/`);
  });
}

/**
 * Split accepted proofs into those that still stand on `tree` and those
 * whose covered files changed since the tree they were accepted on. A proof
 * that names no files covers the whole change, so any change stales it.
 */
export async function standingProofs(
  proofs: readonly AcceptedProof[],
  tree: string,
  opts: { readonly cwd: string; readonly signal?: AbortSignal },
): Promise<{ readonly standing: readonly AcceptedProof[]; readonly changed: readonly AcceptedProof[] }> {
  const standing: AcceptedProof[] = [];
  const changed: AcceptedProof[] = [];
  const diffs = new Map<string, readonly string[] | null>();
  for (const proof of proofs) {
    if (proof.tree === tree) {
      standing.push(proof);
      continue;
    }
    let paths = diffs.get(proof.tree);
    if (paths === undefined) {
      // A tree git no longer has cannot show what changed, so its proofs are asked for again.
      const known = await runRuntimeProcess({ executable: 'git', args: ['cat-file', '-e', `${proof.tree}^{tree}`], cwd: opts.cwd, ...(opts.signal ? { signal: opts.signal } : {}) });
      paths = known.exitCode === 0
        ? (await treeChanges({ cwd: opts.cwd, ...(opts.signal ? { signal: opts.signal } : {}) }, proof.tree, tree)).map((change) => change.path)
        : null;
      diffs.set(proof.tree, paths);
    }
    const touched = paths === null || (proof.files.length === 0 ? paths.length > 0 : paths.some((path) => covers(proof.files, path)));
    (touched ? changed : standing).push(proof);
  }
  return { standing, changed };
}
