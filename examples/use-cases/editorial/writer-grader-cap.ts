import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { JevApiEngine } from '@obversa/engine-jev-api';
import {
  briefFromFile,
  finalResultPart,
  formatEvent,
  judge,
  person,
  run,
  stage,
  workflow,
  type Engine,
  type JudgeAnswer,
  type TeamSeat,
} from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

interface EditorialEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: EditorialEngines = { claude, codex };

/**
 * The judge that decides whether the draft goes round again: Jev over the
 * TypeSafe API when JUDGE=jev, otherwise the answers recorded in judge.json
 * beside the brief, one set per round, so the file runs offline. Jev answers
 * with a structured part and a stage wants text, so the seat wraps the
 * answers as JSON.
 */
async function judgeSeat(): Promise<TeamSeat> {
  const identity = { adapter: 'jev-api', provider: 'typesafe', modelFamily: 'jev', model: 'jev-latest', tools: [] };
  if (process.env.JUDGE === 'jev') {
    const endpoint = process.env.TYPESAFE_ENDPOINT;
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!endpoint || !apiKey) throw new Error('JUDGE=jev needs TYPESAFE_ENDPOINT and TYPESAFE_API_KEY');
    const api = new JevApiEngine({ endpoint, apiKey });
    const engine = {
      name: 'jev-api',
      async run(request, onEvent, signal) {
        const result = await api.run(request, onEvent, signal);
        const part = finalResultPart(result);
        return part.kind === 'structured' ? { ...result, parts: [{ kind: 'assistant', text: JSON.stringify(part.value), final: true }] } : result;
      },
    } as Engine;
    return { engine, identity };
  }
  const answers = JSON.parse(await readFile('judge.json', 'utf8')) as Record<string, JudgeAnswer>[];
  let round = 0;
  return { engine: new MockEngine(() => JSON.stringify(answers[Math.min(round++, answers.length - 1)])), identity: { ...identity, adapter: 'recorded' } };
}

/**
 * A writer, a strict grader from another model family, a judge, and an
 * editor. The writer drafts the post. The grader reads it against the house
 * style and returns findings that name the line and the rule; the writer
 * runs again with them. The judge decides when another round is worth it,
 * with the cap as the backstop. When the grader passes the draft, the run
 * stops for the editor, who decides whether it is published. A draft the
 * grader never passes ends the run with the last findings, and nothing is
 * published.
 */
function createEditorial(jev: TeamSeat, engines: EditorialEngines = realEngines) {
  return workflow('writer-grader-cap', {
    brief: briefFromFile('briefs/post.md'),
    options: { timeout: '10m' },

    roles: {
      write: engines.claude('claude-sonnet-4-5'),
      grade: [engines.codex('gpt-5.6-luna')],
      editor: person('Publish this post?'),
    },

    stages: [
      stage('draft', {
        agent: 'write',
        writes: 'posts/draft.md',
        desc: 'Write the post from the brief, in the house style.',
        gate: 'The draft holds against every rule in style/house.md, as read by a grader from another model family.',
        reviewedBy: 'grade',
        // The judge. After a round the grader did not pass, Jev reads the
        // findings and the rounds so far and says whether another round is
        // worth it; a finding tagged block goes back without asking. The
        // cap is the backstop: three rounds at most, whatever the judge says.
        refine: judge(jev, { cap: 3 }),
      }),

      stage('publish', {
        input: 'editor',
        desc: 'Put the graded draft in front of the editor.',
        gate: 'The editor has said publish.',
        sendsBackTo: 'draft',
      }),
    ],
  });
}

// The review loop watches what changed in the worktree between drafts, so
// the folder is a Git repository. A folder that isn't one yet becomes one.
if (!existsSync('.git')) {
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=editorial', '-c', 'user.email=editorial@example.invalid', ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'the brief and the house style');
}

const result = await run(createEditorial(await judgeSeat()), {
  onEvent: (event) => console.log(formatEvent(event)),
  recordTo: 'records/writer-grader-cap.jsonl',
});
console.log(JSON.stringify(result.outcome, null, 2));
