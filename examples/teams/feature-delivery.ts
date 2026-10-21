import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { resolveCommandExecutable } from '@obversa/core/command';
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { grok } from '@obversa/engine-grok-cli';
import { jev } from '@obversa/engine-jev-api';
import { opencode } from '@obversa/engine-opencode-cli';
import {
  approval,
  briefFromFile,
  dag,
  formatEvent,
  goalCheck,
  isolated,
  judge,
  review,
  run,
  type BriefSource,
  type Job,
  type TeamSeat,
} from '@obversa/runtime';
import { recordedJudge } from '@obversa/runtime/testing';

/**
 * A ticket, delivered the way a team delivers a change. One seat builds it:
 * the build node owns the agent, the files it may write, and its refinement.
 * Each round the ticket's tests run first, and a red one goes back to the
 * builder with its output. A seat from another model family checks that
 * every requirement in the ticket was met. Three reviewers from three model
 * families review the change at the same time, and their reviews become one
 * list. A judge scores each finding cosmetic to blocking. The builder gets only the ones it acts on; a held-back one
 * stays with the judge, collected for a person to read before the change
 * lands. Attended, a person approves the exact bytes before the change
 * lands; with `--unattended`, it lands without asking. Each
 * ticket runs in its own worktree, and the change lands on the current
 * branch when the run passes.
 */

// ── The seats ───────────────────────────────────────────────────────────────

// The OpenCode and Grok adapters need an absolute command path.
const openCode = (model: string) => opencode(model, { executable: resolveCommandExecutable('opencode') });
const grokSeat = (model: string) => grok(model, { executable: resolveCommandExecutable('grok') });

const builder = claude('claude-sonnet-4-5');
const goalSeat = codex('gpt-5.6-luna');
const reviewers = {
  codex: codex('gpt-5.6-luna'),
  gemini: openCode('google/gemini-2.5-pro'),
  grok: grokSeat('grok-4'),
} satisfies Record<string, TeamSeat>;

// Offline, recorded answers stand in for Jev so the example runs with no
// key: judge.json holds one answer object per round, and the last one
// repeats. `JEV=live` asks Jev instead.
const judgeSeat = process.env.JEV === 'live' ? jev() : recordedJudge('judge.json');

// Attended, a person approves the change before it lands. `--unattended`
// leaves the approval out.
const attended = !process.argv.includes('--unattended');

// ── The steps ───────────────────────────────────────────────────────────────

/** Git's answer in the worktree, one entry per path. */
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).split(/[\0\n]/).filter(Boolean);

/** Every file the run added, changed or deleted since `start`, with the sha256 of its bytes. */
const changes = async (dir: string, start: string) => {
  const changed = [
    ...git(dir, 'diff', '--name-only', '--no-renames', '-z', start),
    ...git(dir, 'ls-files', '--others', '--exclude-standard', '-z'),
  ].sort();
  const sha256: Record<string, string> = {};
  for (const file of changed) {
    sha256[file] = existsSync(join(dir, file)) ? createHash('sha256').update(await readFile(join(dir, file))).digest('hex') : 'deleted';
  }
  return sha256;
};

/**
 * A person approves the exact bytes of every file the run added, changed or
 * deleted since `start`, the commit the worktree began at: all of it lands,
 * the ticket's files or not. A no fails the run, and the change does not land.
 */
const approve = (start: string): Job => async (ctx) => {
  const dir = ctx.workspace.dir;
  const sha256 = await changes(dir, start);
  // With approve.json beside the file, the answer comes from it. Without it,
  // the run waits and prints the address of a page to answer on.
  const recorded = existsSync('approve.json') ? JSON.parse(await readFile('approve.json', 'utf8')) : undefined;
  const outcome = await approval('approve', {
    question: `Ship these bytes? ${Object.entries(sha256).map(([file, hash]) => `${file} (${hash === 'deleted' ? 'deleted' : `sha256 ${hash.slice(0, 12)}`})`).join(', ')}`,
    input: { sha256 },
    ...(recorded ? { answer: () => recorded } : {}),
  })(ctx);
  // A file edited while the question waited is not what the person approved,
  // so the run fails and nothing lands.
  if (outcome.status === 'pass' && !isDeepStrictEqual(await changes(dir, start), sha256)) {
    return { status: 'fail', summary: 'the files changed after the approval was asked for; nothing lands' };
  }
  return outcome;
};

// ── The team ────────────────────────────────────────────────────────────────

/** The team for one ticket, in its own worktree. */
export function featureTeam(ticket: BriefSource): Job {
  // The ticket's front matter names the files to change and the tests that
  // check them. Only the ticket's own tests run.
  const tests = (ticket.files ?? []).filter((file) => /\.test\.[cm]?[jt]s$/.test(file));
  const files = (ticket.files ?? []).filter((file) => !tests.includes(file));
  if (!files.length || !tests.length) throw new TypeError('a ticket names the files it changes and its tests in its front matter');
  return isolated((ctx) => {
    const [start] = git(ctx.workspace.dir, 'rev-parse', 'HEAD');
    return dag({
      name: 'feature-delivery',
      brief: ticket.brief,
      nodes: {
        build: {
          desc: `Make the change in ${files.join(', ')}. Do not change ${tests.join(', ')}.`,
          gate: 'The ticket is met and its tests pass.',
          agent: builder,
          writes: files,
          // The node's own refinement, each round: the ticket's tests first,
          // a red one goes straight back with its output; then the goal
          // check; then the three reviewers as one panel; then Jev scores
          // each kept finding cosmetic to blocking, a block included, with
          // no cap; a held-back one is collected for a person to read.
          refine: review({
            checks: [['node', '--test', ...tests]],
            goal: goalCheck(goalSeat, { target: 'build', text: ticket.brief }),
            reviewers: [
              { name: 'codex', seat: reviewers.codex },
              { name: 'gemini', seat: reviewers.gemini },
              { name: 'grok', seat: reviewers.grok },
            ],
            // The merge asks for no tools, a call Codex refuses; Grok takes it.
            synthesise: reviewers.grok,
            judge: judge(judgeSeat),
          }),
        },
        ...(attended ? { approve: { needs: 'build', job: approve(start!) } } : {}),
      },
    })(ctx);
  }, { label: 'feature' });
}

/** Deliver one ticket, printing each event, and keep the record. */
export async function deliver(ticket: BriefSource, recordTo: string) {
  const result = await run(featureTeam(ticket), {
    recordTo,
    onCallback: 'wait',
    // Only an attended run asks, so only it opens the page to answer on.
    monitor: attended,
    onEvent: (event) => console.log(event.kind === 'monitor' ? `Answer the approval on ${event.url}` : formatEvent(event)),
  });
  await result.monitor?.close();
  return result;
}

// Started directly, this file delivers briefs/ticket.md. The backlog
// example imports `deliver` instead.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const result = await deliver(briefFromFile('briefs/ticket.md'), 'records/feature-delivery.jsonl');
  console.log(JSON.stringify({ status: result.outcome.status, summary: result.outcome.summary }, null, 2));
}
