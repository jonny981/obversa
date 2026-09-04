/**
 * The workspace contract (roadmap D12): a replaceable provider that
 * captures, verifies, and forks a workspace, plus a one-writer lease.
 *
 * The anchor is the durable truth: root, head revision, content
 * fingerprint, and the per-file index and dirty states — including dirty
 * and scoped untracked files, so an unowned write that never commits is
 * as visible as a commit. Verify re-derives the state and compares it
 * against the anchor itself; it never trusts a caller-provided claim.
 * Fork validates the anchor before creating anything, then writes only a
 * new ref and a worktree registration into the bound repository's
 * metadata — the user's checkout, index, and dirty files stay untouched.
 *
 * A lease records its owner, scope, workspace anchor digest, and
 * acquisition token. The Git provider publishes one complete blob with a
 * create-if-absent ref update. A kill before that update leaves no owner; a
 * kill after it leaves a completed lease held. Recovery can clear corrupt
 * records and old readable incomplete records, but never a completed lease.
 */

import type { GitWorkspaceSnapshot } from '../core/git.js';
import type { JsonObject } from '../graph/value.js';

export interface WorkspaceAnchor extends JsonObject {
  readonly schemaVersion: 1;
  readonly root: string;
  /** Resolved Git common directory. Distinguishes repositories and linked worktrees. */
  readonly repositoryId: string;
  readonly head: string;
  readonly fingerprint: string;
  /** The capture scope: watched paths, or null for the whole worktree. */
  readonly scope: readonly string[] | null;
  readonly files: readonly JsonObject[];
}

export interface WorkspaceHeadDrift extends JsonObject {
  readonly kind: 'head';
  readonly currentHead: string;
}

export interface WorkspaceFilesDrift extends JsonObject {
  readonly kind: 'files';
  readonly changedPaths: readonly string[];
}

export interface WorkspaceRepositoryDrift extends JsonObject {
  readonly kind: 'repository';
  readonly currentRepositoryId: string;
}

export type WorkspaceDrift =
  | WorkspaceHeadDrift
  | WorkspaceFilesDrift
  | WorkspaceRepositoryDrift;

export type VerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly drift: readonly WorkspaceDrift[] };

export interface ForkOk extends JsonObject {
  readonly ok: true;
  readonly branchRef: string;
  readonly worktreePath: string;
  readonly anchor: WorkspaceAnchor;
}

export interface ForkChangedAnchor extends JsonObject {
  readonly ok: false;
  readonly kind: 'anchor-changed';
  readonly drift: readonly WorkspaceDrift[];
}

export interface ForkExists extends JsonObject {
  readonly ok: false;
  readonly kind: 'exists';
  readonly branchRef: string;
  readonly worktreePath: string;
}

/** The ref was created but the worktree was not; a retry can finish it. */
export interface ForkIncomplete extends JsonObject {
  readonly ok: false;
  readonly kind: 'incomplete';
  readonly branchRef: string;
  readonly worktreePath: string;
}

/** Fork is refused without a lease held for this exact anchor. */
export interface ForkUnleased extends JsonObject {
  readonly ok: false;
  readonly kind: 'unleased';
  readonly reason: string;
}

export interface ForkNoRevision extends JsonObject {
  readonly ok: false;
  readonly kind: 'no-revision';
}

export interface ForkInvalidChild extends JsonObject {
  readonly ok: false;
  readonly kind: 'invalid-child';
}

export type ForkResult =
  | ForkOk
  | ForkChangedAnchor
  | ForkExists
  | ForkIncomplete
  | ForkUnleased
  | ForkNoRevision
  | ForkInvalidChild;

export interface LeaseClaimed extends JsonObject {
  readonly ok: true;
  readonly token: string;
  readonly owner: string;
  readonly scope: string;
  readonly anchorDigest: string;
}

export interface LeaseHeld extends JsonObject {
  readonly ok: false;
  readonly kind: 'held';
  readonly owner: string;
}

export interface LeaseIncomplete extends JsonObject {
  readonly ok: false;
  readonly kind: 'incomplete';
  readonly reason: string;
}

export type AcquireResult = LeaseClaimed | LeaseHeld | LeaseIncomplete;

export type WorkspaceReleaseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'unknown-token' | 'not-owner' | 'incomplete' };

export type RecoverResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'live' | 'none' };

export interface WorkspaceProvider {
  capture(scope?: readonly string[]): Promise<WorkspaceAnchor>;
  verify(anchor: WorkspaceAnchor): Promise<VerifyResult>;
  /**
   * Fork requires a lease held for this exact anchor: the assigned create
   * order is lease, then the caller's idempotent branch-event append, then
   * this fork. A retry after an incomplete fork finishes it.
   */
  fork(
    anchor: WorkspaceAnchor,
    childId: string,
    leaseToken: string,
  ): Promise<ForkResult>;
  acquireLease(owner: string, scope: string, anchor: WorkspaceAnchor): Promise<AcquireResult>;
  releaseLease(token: string): Promise<WorkspaceReleaseResult>;
  recoverIncompleteLease(): Promise<RecoverResult>;
}

export type { GitWorkspaceSnapshot };
