import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { globToRegExp } from '../core/guards.js';
import {
  captureGitWorkspaceSnapshot,
  compareGitWorkspaceSnapshots,
  isRepo,
  type GitWorkspaceSnapshot,
} from '../core/git.js';
import { cloneFrozenJson, type JsonObject } from '../graph/value.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type WorkspaceMode = 'none' | 'read' | 'write';

export interface NodeWorkspacePolicy {
  readonly mode: WorkspaceMode;
  readonly directory: string | null;
  readonly allowedPaths: readonly string[];
}

export interface WorkspaceEntry {
  readonly policy: NodeWorkspacePolicy;
  readonly snapshot: GitWorkspaceSnapshot | null;
}

export interface WorkspaceAttemptEvidence extends JsonObject {
  readonly entryHead: string | null;
  readonly exitHead: string | null;
  readonly headChanged: boolean;
  readonly changedPaths: readonly string[];
  readonly foreignPaths: readonly string[];
  readonly filesChanged: number;
  readonly linesChanged: number;
}

export type WorkspacePolicyErrorCode =
  | 'INVALID_WORKSPACE_POLICY'
  | 'NOT_GIT_REPOSITORY'
  | 'GIT_INSPECTION_FAILED'
  | 'ABORTED';

export class WorkspacePolicyError extends Error {
  readonly code: WorkspacePolicyErrorCode;

  constructor(code: WorkspacePolicyErrorCode, message: string) {
    super(message);
    this.name = 'WorkspacePolicyError';
    this.code = code;
  }
}

function validPathPattern(value: unknown, index: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      `allowedPaths[${index}] must be a safe relative glob`,
    );
  }
  return value;
}

export function validateWorkspacePolicy(
  value: NodeWorkspacePolicy,
): NodeWorkspacePolicy {
  if (value.mode !== 'none' && value.mode !== 'read' && value.mode !== 'write') {
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      'workspace mode must be none, read, or write',
    );
  }
  if (!Array.isArray(value.allowedPaths)) {
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      'allowedPaths must be an array',
    );
  }
  const allowedPaths = value.allowedPaths.map(validPathPattern);
  if (new Set(allowedPaths).size !== allowedPaths.length) {
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      'allowedPaths must be unique',
    );
  }

  if (value.mode === 'none') {
    if (value.directory !== null || allowedPaths.length > 0) {
      throw new WorkspacePolicyError(
        'INVALID_WORKSPACE_POLICY',
        'workspace mode none requires a null directory and no allowedPaths',
      );
    }
  } else {
    if (
      typeof value.directory !== 'string' ||
      !isAbsolute(value.directory) ||
      value.directory.length === 0
    ) {
      throw new WorkspacePolicyError(
        'INVALID_WORKSPACE_POLICY',
        'workspace directory must be an absolute path',
      );
    }
    if (value.mode === 'read' && allowedPaths.length > 0) {
      throw new WorkspacePolicyError(
        'INVALID_WORKSPACE_POLICY',
        'workspace read mode does not accept allowedPaths',
      );
    }
  }

  return cloneFrozenJson({
    mode: value.mode,
    directory: value.directory,
    allowedPaths,
  });
}

function samePolicy(left: NodeWorkspacePolicy, right: NodeWorkspacePolicy): boolean {
  return (
    left.mode === right.mode &&
    left.directory === right.directory &&
    left.allowedPaths.length === right.allowedPaths.length &&
    left.allowedPaths.every((path, index) => path === right.allowedPaths[index])
  );
}

async function normalizedPolicy(
  value: NodeWorkspacePolicy,
  signal: AbortSignal,
): Promise<NodeWorkspacePolicy> {
  const policy = validateWorkspacePolicy(value);
  if (signal.aborted) {
    throw new WorkspacePolicyError('ABORTED', 'workspace inspection was aborted');
  }
  if (policy.mode === 'none') return policy;
  let directory: string;
  try {
    directory = await realpath(policy.directory!);
  } catch (error) {
    throw new WorkspacePolicyError(
      'GIT_INSPECTION_FAILED',
      `workspace directory cannot be resolved: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return cloneFrozenJson({ ...policy, directory });
}

export async function captureWorkspaceEntry(
  value: NodeWorkspacePolicy,
  signal: AbortSignal,
): Promise<WorkspaceEntry> {
  const policy = await normalizedPolicy(value, signal);
  if (policy.mode === 'none') {
    return Object.freeze({ policy, snapshot: null });
  }
  if (!(await isRepo({ cwd: policy.directory!, signal }))) {
    if (signal.aborted) {
      throw new WorkspacePolicyError('ABORTED', 'workspace inspection was aborted');
    }
    throw new WorkspacePolicyError(
      'NOT_GIT_REPOSITORY',
      'workspace directory is not a Git repository',
    );
  }
  try {
    const snapshot = await captureGitWorkspaceSnapshot({
      cwd: policy.directory!,
      signal,
    });
    if (snapshot.root !== policy.directory) {
      throw new Error('workspace directory must be the Git worktree root');
    }
    return Object.freeze({ policy, snapshot });
  } catch (error) {
    if (signal.aborted) {
      throw new WorkspacePolicyError('ABORTED', 'workspace inspection was aborted');
    }
    throw new WorkspacePolicyError(
      'GIT_INSPECTION_FAILED',
      `workspace entry inspection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function inspectWorkspaceExit(
  value: NodeWorkspacePolicy,
  entry: WorkspaceEntry,
  signal: AbortSignal,
): Promise<WorkspaceAttemptEvidence> {
  const policy = await normalizedPolicy(value, signal);
  if (!samePolicy(policy, entry.policy)) {
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      'workspace policy changed during the attempt',
    );
  }
  if (policy.mode === 'none') {
    if (entry.snapshot !== null) {
      throw new WorkspacePolicyError(
        'INVALID_WORKSPACE_POLICY',
        'workspace mode none cannot carry a Git entry snapshot',
      );
    }
    return cloneFrozenJson({
      entryHead: null,
      exitHead: null,
      headChanged: false,
      changedPaths: [],
      foreignPaths: [],
      filesChanged: 0,
      linesChanged: 0,
    });
  }
  if (entry.snapshot === null) {
    throw new WorkspacePolicyError(
      'INVALID_WORKSPACE_POLICY',
      'workspace entry snapshot is missing',
    );
  }

  try {
    const exit = await captureGitWorkspaceSnapshot({
      cwd: policy.directory!,
      signal,
    });
    const delta = await compareGitWorkspaceSnapshots(
      entry.snapshot,
      exit,
      signal,
    );
    const patterns = policy.allowedPaths.map(globToRegExp);
    const foreignPaths = policy.mode === 'read'
      ? [...delta.changedPaths]
      : delta.changedPaths.filter(
          (path) => !patterns.some((pattern) => pattern.test(path)),
        );
    if (delta.headChanged) foreignPaths.push('@git/HEAD');
    return cloneFrozenJson({
      entryHead: entry.snapshot.head,
      exitHead: exit.head,
      headChanged: delta.headChanged,
      changedPaths: delta.changedPaths,
      foreignPaths,
      filesChanged: delta.filesChanged,
      linesChanged: delta.linesChanged,
    });
  } catch (error) {
    if (signal.aborted) {
      throw new WorkspacePolicyError('ABORTED', 'workspace inspection was aborted');
    }
    throw new WorkspacePolicyError(
      'GIT_INSPECTION_FAILED',
      `workspace exit inspection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
