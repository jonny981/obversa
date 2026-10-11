import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { agentJob } from './core/job.js';
import { LoopError } from './core/errors.js';
import { seatIdentity } from './core/refine.js';
import type { Job, JobContext } from './core/types.js';
import type { TeamSeat } from '@obversa/api';
import { INVALID_TEAM_DECISION, outcomeFromAgentText } from './workflow-agent-response.js';

export {
  assertDistinctSeats,
  requireNoFiles,
  requireNonEmptyFiles,
  seatIdentity,
} from './core/refine.js';
export type { ReviewerSeat } from './core/types.js';
import type { ReviewerSeat } from './core/types.js';

type TeamWorkspaceMode = 'read' | 'write';

export interface TestCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}

export interface TeamInput {
  readonly brief: string;
  readonly workspace: string;
  readonly files: readonly string[];
  readonly test: TestCommand;
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
  recordAs?: { readonly role: 'writer' | 'reviewer'; readonly stage: string },
): Job {
  const identity = seatIdentity(seat);
  if (workspaceMode === 'read' && identity.tools.length === 0) {
    throw new TypeError(`${label} cannot read the workspace: reviewer seat declares no tools`);
  }
  const agent = agentJob({
    label,
    engine: seat.engine,
    model: identity.model,
    tools: [...identity.tools],
    allowedTools: [...identity.tools],
    workspaceMode,
    cwd: input.workspace,
    consumeFeedback: target !== undefined,
    ...(recordAs === undefined ? {} : { recordAs }),
    prompt: (ctx) => `${rolePrompt(label, input.brief)}\n${typeof instructions === 'function' ? instructions(ctx) : instructions}\nReturn one JSON object: {"status":"pass"|"revise","summary":"...","findings":[{"evidence":"..."}]}`,
    outcome: (text) => outcomeFromAgentText(text, target),
  });
  if (!decisionFile) return agent;
  return async (ctx) => {
    const path = join(input.workspace, decisionFile);
    const before = await snapshotFile(path);
    const replyOutcome = await agent(ctx);
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
  recordAs?: { readonly role: 'writer' | 'reviewer'; readonly stage: string },
  stage?: { readonly desc?: string; readonly gate?: string },
): Array<{ name: string; scope?: string; job: Job }> {
  return reviewers.map((reviewer) => {
    const instructions = [
      `Review target: ${reviewTarget ?? 'the supplied files and test evidence'}.`,
      stage?.desc ? `Task: ${stage.desc}` : undefined,
      stage?.gate ? `Gate: ${stage.gate}` : undefined,
      'Judge only that target against this stage gate; do not require files from another stage.',
      reviewer.scope ? `Scope: ${reviewer.scope}` : undefined,
    ].filter(Boolean).join('\n');
    const review = teamAgent(
      reviewer.name,
      reviewer.seat,
      input,
      instructions,
      undefined,
      undefined,
      'read',
      recordAs,
    );
    const retry = teamAgent(
      reviewer.name,
      reviewer.seat,
      input,
      `${instructions}\nYour previous response was not a valid decision. Return only the required JSON object.`,
      undefined,
      undefined,
      'read',
      recordAs,
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

export { INVALID_TEAM_DECISION, outcomeFromAgentText } from './workflow-agent-response.js';
