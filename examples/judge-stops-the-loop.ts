import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { JevApiEngine } from '@obversa/engine-jev-api';
import {
  agentJob,
  approval,
  briefFromFile,
  dag,
  finalResultPart,
  fnJob,
  formatEvent,
  revisionRequest,
  run,
  type ApprovalAnswer,
  type Engine,
  type Job,
  type Outcome,
} from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';
import { requireNoFiles, requireNonEmptyFiles } from '@obversa/runtime/workflow-support';

/**
 * A loop whose stopping rule is a judge, not a count. Claude rewrites the
 * page the brief names; Codex, from another model family, reads every
 * sentence as a person would and reports what fails, each finding tagged
 * [block], [should] or [nit]; Jev answers typed questions about the draft
 * and the rounds so far, the last of them "Are we at the point of
 * diminishing returns?"; the route sends a block back always, up to the
 * cap, and otherwise stops when the judge chooses a reason to stop; a
 * person approves the exact bytes, with their sha in the question. The cap
 * is a safety net, not the plan: a run ends because the judge says the
 * draft holds, or that another round would polish it past the bar.
 */

// ── The judge's questions ───────────────────────────────────────────────────

export type JudgeQuestion =
  | { readonly type: 'noul'; readonly instructions: string; readonly criteria: { readonly true: string; readonly false: string } }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

export type JudgeQuestions = Readonly<Record<string, JudgeQuestion>>;

/** The answers as the judge returns them. Only the fields the route reads. */
export interface JudgeAnswer {
  readonly noul?: number;
  readonly probability?: number;
  readonly choice?: string;
  readonly probabilities?: Readonly<Record<string, number>>;
}

/**
 * The default questions: does the work hold for this use case, are the latest
 * findings worth doing, is another round worth it, and why stop. The route
 * stops on the chosen reason (`stop_reason` other than `continue`) or on a
 * clear yes/no. The shape is the judge engine's own: `{ state, questions }`,
 * each question typed noul (a probability), choice (one of the criteria) or
 * score.
 */
export function stopQuestions(what = 'the draft'): JudgeQuestions {
  return {
    holds: {
      type: 'noul',
      instructions: `For this use case, does ${what} hold as it stands?`,
      criteria: {
        true: `The latest findings are nits, taste or nothing, and a reader of this kind of work would not notice what remains.`,
        false: `The latest findings include a block, or shoulds a reader of this kind of work would notice.`,
      },
    },
    worth_doing: {
      type: 'noul',
      instructions: 'Read the latest findings themselves. For this use case, are they worth acting on?',
      criteria: {
        true: 'They name things a reader of this kind of work would stumble on, misread or distrust.',
        false: 'They are taste, edge cases, or polish past the bar the use case sets; acting on them would not change what a reader gets.',
      },
    },
    worth_another_round: {
      type: 'noul',
      instructions: 'Given the whole history and whether the latest findings are worth doing, is another round worth it?',
      criteria: {
        true: 'The findings are worth doing, and the rounds so far have fixed what was found, so one more pass would land them.',
        false: 'The findings are not worth doing for this use case; or the same class of finding keeps returning; or the change between rounds is small; or the work is being polished past the bar.',
      },
    },
    stop_reason: {
      type: 'choice',
      instructions: 'Are we at the point of diminishing returns? If so, which kind; if not, continue.',
      criteria: {
        holds: `${what} holds for this use case.`,
        over_polishing: 'The remaining findings are taste, nits or edge cases past the bar.',
        not_converging: 'The same class of finding keeps returning, so another round will not fix it.',
        continue: 'Another round is worth it.',
      },
    },
  };
}

// ── The seats ───────────────────────────────────────────────────────────────

const writer = claude('claude-sonnet-4-5');
const reader = codex('gpt-5.6-luna');

/**
 * Jev, the judge: typed questions over state the run already recorded,
 * answered over the TypeSafe API. It reads and writes no files. Its answer
 * comes back as a structured part; `agentJob` wants assistant text, so this
 * wraps the answers as a JSON string.
 */
function jevJudge(): Engine {
  const endpoint = process.env.TYPESAFE_ENDPOINT;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!endpoint || !apiKey) throw new Error('JUDGE=jev needs TYPESAFE_ENDPOINT and TYPESAFE_API_KEY');
  const api = new JevApiEngine({ endpoint, apiKey });
  return {
    name: 'jev-api',
    async run(request, onEvent, signal) {
      const result = await api.run(request, onEvent, signal);
      const part = finalResultPart(result);
      if (part.kind !== 'structured') return result;
      return { ...result, parts: [{ kind: 'assistant', text: JSON.stringify(part.value), final: true }] };
    },
  } as Engine;
}

/**
 * Offline, the judge replays the answers recorded in judge.json, one entry
 * per round, so the example runs with no key. `JUDGE=jev` asks Jev instead.
 */
async function recordedJudge(): Promise<Engine> {
  const answers = JSON.parse(await readFile('judge.json', 'utf8')) as Record<string, JudgeAnswer>[];
  let round = 0;
  return new MockEngine(() => JSON.stringify(answers[Math.min(round++, answers.length - 1)]));
}

const judge = process.env.JUDGE === 'jev' ? jevJudge() : await recordedJudge();

// ── The team ────────────────────────────────────────────────────────────────

const { brief, files } = briefFromFile('briefs/page.md');
const file = files?.[0];
if (file === undefined) throw new Error('briefs/page.md names no file in its front matter');
const useCase = /^Use case:\s*([\s\S]*?)\n\s*\n/m.exec(brief)?.[1]?.replace(/\s+/g, ' ').trim() ?? 'not stated; treat as full polish';
const maxRounds = 3;
const questions = stopQuestions('the draft');

// What the judge sees: every round so far, not just this one.
interface Round { readonly round: number; readonly findings: string; readonly counts: Record<'block' | 'should' | 'nit', number>; readonly changedLines: number }
const history: Round[] = [];
let previousDraft: string | undefined;
const countTags = (text: string) => ({
  block: (text.match(/\[block\]/gi) ?? []).length,
  should: (text.match(/\[should\]/gi) ?? []).length,
  nit: (text.match(/\[nit\]/gi) ?? []).length,
});
const changedLines = (before: string | undefined, after: string) => {
  if (before === undefined) return after.split('\n').length;
  const a = new Set(before.split('\n'));
  const b = new Set(after.split('\n'));
  let n = 0;
  for (const line of a) if (!b.has(line)) n += 1;
  for (const line of b) if (!a.has(line)) n += 1;
  return n;
};

// The writer rewrites the page in place. On a later round the findings are
// appended to its prompt, and it changes only the sentences they name.
const writeAgent = agentJob({
  label: 'write',
  engine: 'claude',
  model: writer.identity.model,
  tools: ['Read', 'Edit', 'Write'],
  allowedTools: ['Read', 'Edit', 'Write'],
  workspaceMode: 'write',
  consumeFeedback: true,
  prompt: [
    brief,
    `The page is ${file}, relative to the working directory. Rewrite it in place. Write no other file. Keep the front matter exactly as it is.`,
    'On a later round, the review findings are appended below. Change only the sentences they name, and leave every other line as it is; a whole new draft brings new findings.',
  ].join('\n\n'),
});
const write: Job = (ctx) => requireNonEmptyFiles('write', writeAgent, ctx.workspace.dir, [file])(ctx);

// The reader did not write the page and may not change it. It reports only
// the sentences that fail for this audience, worst first.
const readAgent = agentJob({
  label: 'read',
  engine: 'codex',
  model: reader.identity.model,
  tools: ['Read'],
  workspaceMode: 'read',
  leaf: true,
  prompt: [
    `Read ${file}, relative to the working directory. You did not write it. The front matter between the --- lines, code blocks and link targets are out of scope: the writer was told to keep them as they are, so a finding on them cannot be acted on.`,
    `The use case sets the bar: ${useCase}`,
    'Ask one question of every sentence: would a reader of this kind of page, described above, read it once and know what to do?',
    'What fails: a word the reader has never met used without the sentence saying what it is; a line that gives the mechanism where the reader wanted what they get; a claim the page does not support; a figure of speech a person would not use; a sentence a person would stumble over aloud.',
    'Report only the sentences that fail for this audience, worst first. Do not fill a list: three findings that matter beat ten that do not, and "Nothing fails" is a good report when it is true. Start each with a severity tag: [block] a person would not understand it or it claims something false; [should] a person would say it differently; [nit] taste. Then quote it, say in a few words why, and give the plainest rewrite a person would say. No praise. Change nothing. If nothing fails, reply with the single line: Nothing fails.',
  ].join('\n\n'),
});
const read: Job = async (ctx) => {
  const draft = await readFile(join(ctx.workspace.dir, file), 'utf8');
  const outcome = await requireNoFiles('read', readAgent, ctx.workspace.dir, [file], 'body')(ctx);
  const findings = String(outcome.data ?? outcome.summary ?? '');
  history.push({ round: ctx.graph?.attempt ?? 1, findings, counts: countTags(findings), changedLines: changedLines(previousDraft, draft) });
  previousDraft = draft;
  return outcome;
};

// The judge sees the draft, the latest findings and every round so far, and
// answers the questions above. It decides nothing on its own: the route reads
// its answers.
const judgeStep = agentJob({
  label: 'judge',
  engine: 'judge',
  workspaceMode: 'none',
  tools: [],
  leaf: true,
  prompt: async (ctx) => JSON.stringify({
    state: {
      file,
      useCase,
      draft: await readFile(join(ctx.workspace.dir, file), 'utf8'),
      latestFindings: history[history.length - 1]?.findings ?? '',
      rounds: history.map((r) => ({ round: r.round, counts: r.counts, changedLines: r.changedLines, findings: r.findings })),
      round: ctx.graph?.attempt ?? 1,
      maxRounds,
    },
    questions,
  }),
});

// The stopping rule. A block is a false claim or a sentence the reader would
// not understand: it always goes back, up to the cap. Otherwise the judge's
// chosen reason decides, then a clear yes or no, and the cap is the last word.
const route = fnJob('route', (ctx): Outcome => {
  const raw = String(ctx.needs?.judge?.data ?? '');
  let answers: Record<string, JudgeAnswer> = {};
  try { answers = JSON.parse(raw) as typeof answers; } catch { /* an unreadable answer routes as "run again" */ }
  const worth = answers.worth_another_round?.noul ?? answers.worth_another_round?.probability;
  const doing = answers.worth_doing?.noul ?? answers.worth_doing?.probability;
  const holds = answers.holds?.noul ?? answers.holds?.probability;
  const reason = answers.stop_reason?.choice ?? 'unknown';
  const round = ctx.graph?.attempt ?? 1;
  const latest = history[history.length - 1];
  const tally = latest ? `${latest.counts.block} block, ${latest.counts.should} should, ${latest.counts.nit} nit` : 'no findings recorded';
  const blocks = latest?.counts.block ?? 0;
  if (blocks > 0 && round < maxRounds) {
    return revisionRequest({
      target: 'write',
      reason: `round ${round}: ${blocks} block finding${blocks === 1 ? '' : 's'} always go back; ${tally}`,
      findings: [{ evidence: latest?.findings ?? '', severity: 'block' }],
    });
  }
  const chosenStop = reason !== 'unknown' && reason !== 'continue';
  if (chosenStop) return { status: 'pass', summary: `round ${round}: the judge stopped it, reason ${reason} (holds ${String(holds)}, worth doing ${String(doing)}, another round ${String(worth)}); ${tally}`, data: answers };
  if (typeof holds === 'number' && holds >= 0.5) return { status: 'pass', summary: `round ${round}: the judge says the draft holds (${holds.toFixed(2)}); ${tally}`, data: answers };
  if (typeof doing === 'number' && doing < 0.5) return { status: 'pass', summary: `round ${round}: the judge says the findings are not worth doing for this use case (${doing.toFixed(2)}); ${tally}`, data: answers };
  if (typeof worth === 'number' && worth < 0.5) return { status: 'pass', summary: `round ${round}: the judge says another round is not worth it (${worth.toFixed(2)}); ${tally}`, data: answers };
  if (round >= maxRounds) return { status: 'pass', summary: `round ${round}: the safety cap of ${maxRounds} rounds; the judge still wanted another (${String(worth)}); ${tally}`, data: answers };
  return revisionRequest({
    target: 'write',
    reason: `round ${round}: the judge says another round is worth it (${String(worth)}); ${tally}`,
    findings: [{ evidence: latest?.findings ?? '', severity: 'block' }],
  });
});

// A person approves the exact bytes: the sha is in the question. With an
// approve.json beside the brief the answer is recorded (a proof, a script
// that decides); without one the run pauses until a person answers.
const recorded: ApprovalAnswer | undefined = existsSync('approve.json')
  ? JSON.parse(await readFile('approve.json', 'utf8')) as ApprovalAnswer
  : undefined;
const approve: Job = async (ctx) => {
  const bytes = await readFile(join(ctx.workspace.dir, file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return approval('approve', {
    question: `Keep ${file} as it now stands (sha256 ${sha256.slice(0, 12)})? A no with a note sends the note to the writer.`,
    input: { file, sha256 },
    target: 'write',
    ...(recorded ? { answer: () => recorded } : {}),
  })(ctx);
};

const team = dag({
  name: 'judge-stops-the-loop',
  concurrency: 1,
  maxKickbacks: { write: maxRounds },
  nodes: {
    write: { job: write },
    read: { job: read, needs: 'write' },
    judge: { job: judgeStep, needs: 'read' },
    route: { job: route, needs: ['judge', 'read'] },
    approve: { job: approve, needs: 'route' },
  },
});

const result = await run(team, {
  engines: { claude: writer.engine, codex: reader.engine, judge },
  recordTo: 'records/judge-stops-the-loop.jsonl',
  runId: 'judge-stops-the-loop',
  onEvent: (event) => console.log(formatEvent(event)),
});

const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
console.log(JSON.stringify({
  status: result.outcome.status,
  rounds: history.length,
  stop: nodes.route?.summary,
  approved: nodes.approve?.status === 'pass',
}, null, 2));
