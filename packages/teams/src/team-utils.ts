import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  agentJob,
  commandSucceeds,
  copyJobMeta,
  dag,
  gateJob,
  LoopError,
  type Job,
  type JobContext,
  type KickbackBudget,
} from '@obversa/runtime';

import { INVALID_TEAM_DECISION, outcomeFromAgentText } from './agent-response.js';
import type { ReviewerSeat, TeamInput, TeamSeat } from './types.js';

type TeamWorkspaceMode = 'read' | 'write';

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

export function seatIdentity(seat: TeamSeat): TeamSeat['identity'] {
  const identity = seat.identity;
  if (
    !identity
    || typeof identity.adapter !== 'string'
    || typeof identity.provider !== 'string'
    || typeof identity.modelFamily !== 'string'
    || typeof identity.model !== 'string'
    || !Array.isArray(identity.tools)
    || !identity.adapter.trim()
    || !identity.provider.trim()
    || !identity.model.trim()
    || !identity.modelFamily.trim()
  ) {
    throw new TypeError('engine identity must contain adapter, provider, model family, and model');
  }
  return identity;
}

export function assertDistinctSeats(seats: readonly TeamSeat[]): void {
  const identities = seats.map((seat, index) => {
    try {
      return seatIdentity(seat);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'invalid engine identity';
      throw new TypeError(`seat ${index + 1} has an invalid engine identity: ${message}`, { cause });
    }
  });
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < identities.length; rightIndex += 1) {
      const left = identities[leftIndex]!;
      const right = identities[rightIndex]!;
      const sameFamily = left.modelFamily === right.modelFamily;
      if (!sameFamily) continue;
      throw new TypeError(
        `seats ${leftIndex + 1} and ${rightIndex + 1} report the same model family ${left.modelFamily}; model family must be distinct per seat`,
      );
    }
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

export function requireNoFiles(
  label: string,
  job: Job,
  workspace: string,
  files: readonly string[],
  phase: 'body' | 'review' = 'review',
): Job {
  const wrapper: Job = async (ctx) => {
    const before = new Map<string, FileSnapshot>();
    for (const file of files) {
      before.set(file, await snapshotFile(join(workspace, file)));
    }
    const outcome = await job(ctx);
    const changed: string[] = [];
    for (const file of files) {
      const after = await snapshotFile(join(workspace, file));
      const previous = before.get(file)!;
      if (
        previous.exists !== after.exists
        || previous.hash !== after.hash
      ) {
        changed.push(file);
      }
    }
    if (changed.length) {
      const summary = `${label} wrote, changed or removed the implementation before its step completed: ${changed.join(', ')}`;
      return {
        status: 'fail',
        summary,
        error: new LoopError({ code: 'WRITE_BOUNDARY', phase, message: summary }),
      };
    }
    return outcome;
  };
  return copyJobMeta(wrapper, job);
}

interface FileSnapshot {
  exists: boolean;
  hash: string | null;
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    const details = await stat(path);
    if (!details.isFile()) return { exists: true, hash: null };
    const contents = await readFile(path);
    return { exists: true, hash: createHash('sha256').update(contents).digest('hex') };
  } catch {
    return { exists: false, hash: null };
  }
}

function rolePrompt(role: string, brief: string): string {
  return [
    `Obversa team role: ${role}`,
    `Work brief: ${brief}`,
    'Work in the supplied cwd.',
  ].join('\n');
}

export function teamAgent(
  label: string,
  seat: TeamSeat,
  input: TeamInput,
  instructions: string | ((ctx: JobContext) => string),
  target?: string,
  decisionFile?: string,
  workspaceMode: TeamWorkspaceMode = 'write',
): Job {
  const identity = seatIdentity(seat);
  const agent = agentJob({
    label,
    engine: seat.engine,
    model: identity.model,
    tools: [...identity.tools],
    workspaceMode,
    cwd: input.workspace,
    consumeFeedback: target !== undefined,
    prompt: (ctx) => `${rolePrompt(label, input.brief)}\n${typeof instructions === 'function' ? instructions(ctx) : instructions}\nReturn one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"..."}]}`,
    outcome: (text) => outcomeFromAgentText(text, target),
  });
  const checkedAgent: Job = async (ctx) => {
    if (workspaceMode === 'read' && identity.tools.length === 0) {
      const summary = `${label} cannot read the workspace: reviewer seat declares no tools`;
      return {
        status: 'fail',
        summary,
        error: new LoopError({ code: 'CONFIG', phase: 'body', message: summary }),
      };
    }
    return agent(ctx);
  };
  const checked = copyJobMeta(checkedAgent, agent);
  if (!decisionFile) return checked;
  return async (ctx) => {
    const path = join(input.workspace, decisionFile);
    const before = await snapshotFile(path);
    const replyOutcome = await checked(ctx);
    const after = await snapshotFile(path);
    const changed = before.exists !== after.exists || before.hash !== after.hash;
    if (!changed || !after.exists || after.hash === null) return replyOutcome;
    try {
      const fileOutcome = outcomeFromAgentText(await readFile(path, 'utf8'), target);
      return fileOutcome.status === 'fail' && fileOutcome.summary === INVALID_TEAM_DECISION
        ? replyOutcome
        : fileOutcome;
    } catch {
      return replyOutcome;
    }
  };
}

export function panelReviewers(
  reviewers: readonly ReviewerSeat[],
  input: TeamInput,
  reviewTarget?: string,
): Array<{ name: string; scope?: string; job: Job }> {
  return reviewers.map((reviewer) => {
    const instructions = [
      `Review target: ${reviewTarget ?? 'the supplied files and test evidence'}.`,
      'Judge only that target against this stage gate; do not require files from another stage.',
      `Write reviews/${reviewer.name}.json.`,
      reviewer.scope ? `Scope: ${reviewer.scope}` : undefined,
    ].filter(Boolean).join('\n');
    const review = teamAgent(
      reviewer.name,
      reviewer.seat,
      input,
      instructions,
      undefined,
      `reviews/${reviewer.name}.json`,
      'read',
    );
    const retry = teamAgent(
      reviewer.name,
      reviewer.seat,
      input,
      `${instructions}\nYour previous response was not a valid decision. Return only the required JSON object.`,
      undefined,
      `reviews/${reviewer.name}.json`,
      'read',
    );
    const job: Job = async (ctx) => {
      const first = await review(ctx);
      if (first.status !== 'fail' || first.summary !== INVALID_TEAM_DECISION) return first;
      const second = await retry(ctx);
      if (second.status !== 'fail' || second.summary !== INVALID_TEAM_DECISION) return second;
      const summary = `reviewer ${reviewer.name} returned no decision`;
      return {
        status: 'fail',
        summary,
        error: new LoopError({ code: 'ENGINE', phase: 'review', message: summary }),
      };
    };
    return { name: reviewer.name, scope: reviewer.scope, job };
  });
}

export { dag };
