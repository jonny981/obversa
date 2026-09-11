import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  agentJob,
  commandSucceeds,
  dag,
  gateJob,
  type Job,
} from '@obversa/runtime';

import { outcomeFromAgentText } from './agent-response.js';
import type { ReviewerSeat, TeamInput, TeamSeat } from './types.js';

export const DELIVERY_NOTE = 'team-output/brief.md';
export const APPROVAL_NOTE = 'team-output/approval.md';

interface SeatIdentity {
  readonly adapter: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly model: string;
}

export function assertTeamInput(input: TeamInput): void {
  if (!input.brief.trim()) throw new TypeError('brief must not be empty');
  if (!input.workspace.trim()) throw new TypeError('workspace must not be empty');
  if (!Array.isArray(input.files) || !input.files.length) throw new TypeError('at least one expected file is required');
  for (const file of input.files) {
    if (typeof file !== 'string' || !file.trim() || file.startsWith('/') || file.split('/').includes('..')) {
      throw new TypeError(`expected file must be a non-empty relative path: ${file}`);
    }
  }
  if (!input.test.command.trim()) throw new TypeError('test command must not be empty');
  if (!Number.isFinite(input.test.timeoutMs ?? 30_000) || (input.test.timeoutMs ?? 30_000) <= 0) {
    throw new TypeError('test timeout must be positive');
  }
}

export function seatIdentity(seat: TeamSeat): SeatIdentity {
  const target = seat.binding.target;
  const selection = seat.binding.selection;
  if (!target.adapter.trim() || !target.provider.trim() || !target.model.trim() || !target.modelFamily.trim()) {
    throw new TypeError('engine binding must contain adapter, provider, model family, and model');
  }
  if (
    selection.adapter !== target.adapter ||
    selection.provider !== target.provider ||
    selection.modelFamily !== target.modelFamily ||
    selection.model !== target.model
  ) {
    throw new TypeError('engine binding target and recorded selection must match');
  }
  if (typeof seat.engine !== 'string' && seat.engine !== seat.binding.engine) {
    throw new TypeError('EngineRef must be the engine carried by its GraphEngineBinding');
  }
  return {
    adapter: target.adapter,
    provider: target.provider,
    modelFamily: target.modelFamily,
    model: target.model,
  };
}

export function assertDistinctSeats(seats: readonly TeamSeat[]): void {
  const families = seats.map((seat) => seatIdentity(seat).modelFamily);
  const duplicates = families.filter((family, index) => families.indexOf(family) !== index);
  if (duplicates.length) {
    throw new TypeError(`model family must be distinct per seat: ${[...new Set(duplicates)].join(', ')}`);
  }
}

export function assertReviewers(reviewers: readonly ReviewerSeat[], threshold: number): void {
  if (!reviewers.length) throw new TypeError('at least one reviewer is required');
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > reviewers.length) {
    throw new TypeError(`review threshold must be an integer from 1 to ${reviewers.length}`);
  }
  for (const reviewer of reviewers) {
    if (!reviewer.name.trim()) throw new TypeError('reviewer name must not be empty');
  }
}

export function assertKickbacks(maxKickbacks: number): void {
  if (!Number.isInteger(maxKickbacks) || maxKickbacks < 0) {
    throw new TypeError('maxKickbacks must be a non-negative integer');
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

export function requireNonEmptyFiles(
  label: string,
  job: Job,
  workspace: string,
  files: readonly string[],
): Job {
  return async (ctx) => {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
    for (const file of files) {
      const path = join(workspace, file);
      try {
        const details = await stat(path);
        if (!details.isFile() || details.size === 0) {
          return {
            status: 'fail',
            summary: `${label} did not produce a non-empty file: ${file}`,
          };
        }
      } catch {
        return {
          status: 'fail',
          summary: `${label} did not produce a non-empty file: ${file}`,
        };
      }
    }
    return outcome;
  };
}

function rolePrompt(role: string, brief: string): string {
  return [
    `Obversa team role: ${role}`,
    `Work brief: ${brief}`,
    'Work in the supplied cwd.',
    'Return one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"..."}]}',
  ].join('\n');
}

export function teamAgent(
  label: string,
  seat: TeamSeat,
  input: TeamInput,
  instructions: string,
  target?: string,
): Job {
  const identity = seatIdentity(seat);
  return agentJob({
    label,
    engine: seat.engine,
    model: identity.model,
    cwd: input.workspace,
    consumeFeedback: target !== undefined,
    prompt: `${rolePrompt(label, input.brief)}\n${instructions}`,
    outcome: (text) => outcomeFromAgentText(text, target),
  });
}

export function panelReviewers(
  reviewers: readonly ReviewerSeat[],
  input: TeamInput,
): Array<{ name: string; scope?: string; job: Job }> {
  return reviewers.map((reviewer) => ({
      name: reviewer.name,
      scope: reviewer.scope,
      job: teamAgent(
        reviewer.name,
        reviewer.seat,
        input,
        `Inspect the files and test evidence. Write reviews/${reviewer.name}.json.`,
      ),
  }));
}

export { dag };
