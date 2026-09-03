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
 * acquisition token. Acquisition never exposes an incomplete record as a
 * valid owner: an owner that dies mid-acquisition leaves an incomplete
 * claim that the next caller sees as a typed result and clears through an
 * explicit recovery call. Nothing silently clears or steals a live lease.
 */

import type { GitWorkspaceSnapshot } from '../core/git.js';
import type { JsonObject } from '../graph/value.js';

export interface WorkspaceAnchor extends JsonObject {
  readonly schemaVersion: 1;
  readonly root: string;
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

export type WorkspaceDrift = WorkspaceHeadDrift | WorkspaceFilesDrift;

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

export type ForkResult =
  | ForkOk
  | ForkChangedAnchor
  | ForkExists
  | ForkIncomplete
  | ForkUnleased;

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

export type ReleaseResult =
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
  releaseLease(token: string): Promise<ReleaseResult>;
  recoverIncompleteLease(): Promise<RecoverResult>;
}

export type { GitWorkspaceSnapshot };
