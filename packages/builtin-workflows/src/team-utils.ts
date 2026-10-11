import {
  commandSucceeds,
  gateJob,
  isJudge,
  review,
  type Job,
  type Review,
} from '@obversa/runtime';
import type { RefineBudget, ReviewerSeat, TeamInput } from './types.js';

export {
  assertDistinctSeats,
  panelReviewers,
  requireNoFiles,
  requireNonEmptyFiles,
  seatIdentity,
  teamAgent,
} from '@obversa/runtime/workflow-support';
export { dag } from '@obversa/runtime';

export const DELIVERY_NOTE = 'team-output/brief.md';
export const APPROVAL_NOTE = 'team-output/approval.md';

export function assertTeamInput(input: TeamInput): void {
  if ('maxKickbacks' in input) throw new TypeError('maxKickbacks is now refine');
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

export function assertRefineBudget(budget: RefineBudget, targets: readonly string[]): void {
  if (typeof budget === 'number') {
    if (!Number.isInteger(budget) || budget < 0) {
      throw new TypeError('refine must be a non-negative integer or target budget map');
    }
    return;
  }
  if (!budget || typeof budget !== 'object') {
    throw new TypeError('refine must be a non-negative integer or target budget map');
  }
  if ('maxKickbacks' in budget) throw new TypeError('maxKickbacks is now refine');
  for (const [target, limit] of Object.entries(budget)) {
    if (!targets.includes(target)) {
      throw new TypeError(`refine names a target that takes no send-backs: ${target}`);
    }
    // A judge validates its own cap in `judge()`; nothing more to check here.
    if (isJudge(limit)) continue;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TypeError('refine must be a non-negative integer or target budget map');
    }
  }
}

/** The `refine` one send-back target gets from a `RefineBudget`: its own
 * entry in a map (0 when it has none), or the count a number gives every
 * target. */
export function nodeRefine(budget: RefineBudget, name: string): Review {
  const limit = typeof budget === 'number' ? budget : (budget[name] ?? 0);
  return isJudge(limit) ? review({ judge: limit }) : review({ rounds: limit });
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
