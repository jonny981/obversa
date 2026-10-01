import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { jev } from '@obversa/engine-jev-api';
import {
  briefFromFile,
  formatEvent,
  judge,
  person,
  run,
  stage,
  workflow,
  type TeamSeat,
} from '@obversa/runtime';
import { recordedJudge } from '@obversa/runtime/testing';

interface BacklogGroomEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: BacklogGroomEngines = { claude, codex };

/**
 * The judge that decides whether the stories go round again: Jev over the
 * TypeSafe API when JUDGE=jev, otherwise the answers recorded in judge.json
 * beside the brief, one set per round, so the file runs offline.
 */
const judgeSeat = process.env.JUDGE === 'jev' ? jev() : recordedJudge('judge.json');

/**
 * Backlog grooming, then a person ranks. The raw tickets are whatever the
 * week left behind: support threads, a sales ask, a one-line wish. One
 * model turns each into stories with acceptance checks and a model from
 * another family reads them back against the raw tickets; the same pair
 * writes down the questions that must be settled before anyone codes.
 * Then the product owner ranks. Nothing here writes code: the work is
 * deciding what is worth writing.
 */
function createBacklogGroom(judgeSeat: TeamSeat, engines: BacklogGroomEngines = realEngines) {
  return workflow('backlog-groom-then-rank', {
    brief: briefFromFile('briefs/backlog.md'),
    options: { timeout: '10m' },

    roles: {
      groom: engines.claude('claude-sonnet-4-5'),
      'story-review': [engines.codex('gpt-5.6-luna')],
      owner: person('Which of these go into the next cycle, and in what order?'),
    },

    stages: [
      stage('split', {
        agent: 'groom',
        writes: 'backlog/stories.md',
        desc: 'Turn every raw ticket in backlog/raw.md into one or more stories, each with its acceptance checks and the ticket it came from.',
        gate: 'Every raw ticket is covered by at least one story and a reviewer from another family has accepted the set.',
        reviewedBy: 'story-review',
        // The judge. After a round the reviewer did not pass, Jev reads the
        // findings and the rounds so far and says whether another round is
        // worth it; a finding tagged block goes back without asking. The
        // cap is the backstop: three rounds at most, whatever the judge says.
        refine: judge(judgeSeat, { cap: 3 }),
      }),

      stage('clarify', {
        agent: 'groom',
        writes: 'backlog/questions.md',
        desc: 'For each story, list the questions that must be answered before anyone writes code, with a proposed answer for each.',
        gate: 'Every story has its questions, or the line "no open questions", and a reviewer has accepted them.',
        reviewedBy: 'story-review',
        // Three attempts, not two: the allowance matches how open-ended the
        // work is. Grooming a backlog has many defensible answers, so a strict
        // reviewer and a writer need room to meet. Work with one right answer
        // needs less.
        refine: 3,
      }),

      stage('rank', {
        input: 'owner',
        desc: 'Put the stories and the open questions in front of the product owner.',
        gate: 'The owner has ranked the cycle.',
        sendsBackTo: 'split',
      }),
    ],
  });
}

// The run waits for the owner and prints the address of a page to answer
// on. The wait lives in this process: stop it before the owner answers, and
// the next run starts again from the first stage.
const result = await run(createBacklogGroom(judgeSeat), {
  onCallback: 'wait',
  monitor: true,
  onEvent: (event) => console.log(event.kind === 'monitor' ? `Answer the owner's question on ${event.url}` : formatEvent(event)),
  recordTo: 'records/backlog-groom-then-rank.jsonl',
});
await result.monitor?.close();
console.log(JSON.stringify(result.outcome, null, 2));
