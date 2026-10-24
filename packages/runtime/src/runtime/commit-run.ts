/**
 * A passed run commits its own work: every change in the worktree, with the
 * message the named step wrote and the run's own trailers.
 */

import { relative, resolve } from 'node:path';

import type { Outcome } from '../core/types.js';
import { REVIEW_ROUNDS, type ReviewRounds } from '../core/review-rounds.js';
import { processText, runRuntimeProcess } from '../core/process.js';
import { unignored } from '../core/git.js';

export interface CommitRunOptions {
  readonly cwd: string;
  /** The step whose output holds the message, as the run option names it. */
  readonly from?: string;
  /** The step the workflow names, used when the run option names none. */
  readonly workflowFrom?: string;
  readonly runId?: string;
  /** Paths never committed: the run's own record and its check output. */
  readonly exclude?: readonly string[];
  readonly state: Record<string, unknown>;
}

/** The last fenced block marked `commit` in `text`, trimmed; `undefined` when there is none. */
export function commitMessageIn(text: string): string | undefined {
  const blocks = [...text.matchAll(/^(`{3,}|~{3,})commit[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm)];
  const message = blocks.at(-1)?.[2]?.trim();
  return message ? message : undefined;
}

function stepText(outcome: Outcome, step: string): string | undefined {
  const results = outcome.data as Record<string, Outcome | undefined> | undefined;
  const found = results !== null && typeof results === 'object' ? results[step] : undefined;
  if (found === undefined) return undefined;
  return typeof found.data === 'string' ? found.data : found.summary;
}

/** The trailers that say what the run did: its id, and the review rounds and reviewers when a panel reviewed the work. */
function trailers(runId: string | undefined, state: Record<string, unknown>): string[] {
  const panels = Object.values((state[REVIEW_ROUNDS] ?? {}) as Record<string, ReviewRounds>);
  const rounds = Math.max(0, ...panels.map((panel) => panel.round));
  const reviewers = [...new Set(panels.flatMap((panel) => Object.keys(panel.reviewers)))];
  return [
    ...(runId === undefined ? [] : [`Run: ${runId}`]),
    ...(rounds > 0 ? [`Review-rounds: ${rounds}`] : []),
    ...(reviewers.length > 0 ? [`Reviewed-by: ${reviewers.join(', ')}`] : []),
  ];
}

async function git(cwd: string, args: string[], stdin?: string): Promise<{ ok: boolean; out: string }> {
  const r = await runRuntimeProcess({ executable: 'git', args, cwd, ...(stdin === undefined ? {} : { stdin }) });
  return { ok: r.exitCode === 0, out: `${processText(r.stdout)}${processText(r.stderr)}`.trim() };
}

/** Commit the run's work, or say why it stays uncommitted. Never pushes. */
export async function commitRun(outcome: Outcome, options: CommitRunOptions): Promise<{ sha: string } | { uncommitted: string }> {
  const step = options.from ?? options.workflowFrom;
  if (step === undefined) return { uncommitted: 'no step names the commit message' };
  const text = stepText(outcome, step);
  if (text === undefined) return { uncommitted: `the run has no output from step "${step}"` };
  const message = commitMessageIn(text);
  if (message === undefined) return { uncommitted: `step "${step}" wrote no fenced block marked commit` };
  const excluded = await unignored({ cwd: options.cwd }, (options.exclude ?? [])
    .map((path) => relative(options.cwd, resolve(options.cwd, path)))
    .filter((path) => path && !path.startsWith('..')));
  const added = await git(options.cwd, ['add', '-A', '--', '.', ...excluded.map((path) => `:(exclude,literal)${path}`)]);
  if (!added.ok) return { uncommitted: `git add failed: ${added.out}` };
  if ((await git(options.cwd, ['diff', '--cached', '--quiet'])).ok) return { uncommitted: 'the worktree has no change to commit' };
  const lines = trailers(options.runId, options.state);
  const body = lines.length > 0 ? `${message}\n\n${lines.join('\n')}\n` : `${message}\n`;
  const committed = await git(options.cwd, ['commit', '-F', '-'], body);
  if (!committed.ok) return { uncommitted: `git commit was refused: ${committed.out || 'no output'}` };
  const sha = await git(options.cwd, ['rev-parse', 'HEAD']);
  return sha.ok ? { sha: sha.out } : { uncommitted: 'git committed, but its sha could not be read' };
}
