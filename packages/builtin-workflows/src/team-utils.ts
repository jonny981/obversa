import {
  commandSucceeds,
  gateJob,
  type Job,
  type KickbackBudget,
} from '@obversa/runtime';
import type { ReviewerSeat, TeamInput } from './types.js';

export {
  assertDistinctSeats,
  dag,
  panelReviewers,
  requireNoFiles,
  requireNonEmptyFiles,
  seatIdentity,
  teamAgent,
} from '@obversa/runtime/workflow-support';

export const DELIVERY_NOTE = 'team-output/brief.md';
export const APPROVAL_NOTE = 'team-output/approval.md';

export function assertTeamInput(input: TeamInput): void {
  if (!input.brief.trim()) throw new TypeError('brief must not be empty');
  if (!input.workspace.trim()) throw new TypeError('workspace must not be empty');
  if (!Array.isArray(input.files) || !input.files.length) throw new TypeError('at least one expected file is required');
  for (const file of input.files) {
    if (typeof file !== 'string' || !file.trim() || file.startsWith('/') || file.split('/').includes('..')) {
      throw new TypeError(`expected file must be a non-empty relative path: ${file}`);
    }
    if (file === DELIVERY_NOTE || file === APPROVAL_NOTE) {
      throw new TypeError(`expected file must not be a team output note: ${file}`);
    }
  }
  if (!input.test.command.trim()) throw new TypeError('test command must not be empty');
  if (!Number.isFinite(input.test.timeoutMs ?? 30_000) || (input.test.timeoutMs ?? 30_000) <= 0) {
    throw new TypeError('test timeout must be positive');
  }
}

export function assertReviewers(reviewers: readonly ReviewerSeat[], threshold: number): void {
  if (!reviewers.length) throw new TypeError('at least one reviewer is required');
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > reviewers.length) {
    throw new TypeError(`review threshold must be an integer from 1 to ${reviewers.length}`);
  }
  const names = new Set<string>();
  for (const reviewer of reviewers) {
    const name = reviewer.name.trim();
    if (!name) throw new TypeError('reviewer name must not be empty');
    if (name.startsWith('/') || name.split('/').includes('..')) {
      throw new TypeError(`reviewer name must be a non-empty relative path: ${name}`);
    }
    if (names.has(name)) throw new TypeError(`reviewer name must be unique: ${name}`);
    names.add(name);
  }
}

export function assertKickbacks(maxKickbacks: KickbackBudget): void {
  if (typeof maxKickbacks === 'number') {
    if (!Number.isInteger(maxKickbacks) || maxKickbacks < 0) {
      throw new TypeError('maxKickbacks must be a non-negative integer or target budget map');
    }
    return;
  }
  if (!maxKickbacks || typeof maxKickbacks !== 'object') {
    throw new TypeError('maxKickbacks must be a non-negative integer or target budget map');
  }
  for (const limit of Object.values(maxKickbacks)) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError('maxKickbacks must be a non-negative integer or target budget map');
    }
  }
}

export function teamTest(input: TeamInput): Job {
  return gateJob(
    'test',
    commandSucceeds(input.test.command, [...input.test.args], {
      cwd: input.workspace,
      timeoutMs: input.test.timeoutMs,
      captureOutput: true,
    }),
  );
}

export function expectedFilesPrompt(files: readonly string[]): string {
  return `Expected files, relative to the workspace: ${files.join(', ')}`;
}
