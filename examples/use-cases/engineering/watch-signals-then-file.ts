import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { formatEvent, run } from '@obversa/runtime';
import { fromFile, person, stage, workflow, type TeamSeat } from '@obversa/teams';

interface WatchSignalsEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: WatchSignalsEngines = { claude, codex };

/** The product's analytics: PostHog's query endpoint, the key from the environment. */
const POSTHOG = { host: 'https://eu.posthog.com', project: '12345' };
const POSTHOG_KEY = process.env.POSTHOG_API_KEY ?? '';
const QUERY = JSON.stringify({
  query: {
    kind: 'HogQLQuery',
    query: "select event, properties.$current_url as url, count() as n from events where timestamp > now() - interval 7 day and event in ('$rageclick', '$exception', 'form_error') group by event, url order by n desc limit 50",
  },
});

/** Where the work is filed. */
const REPO = 'your-org/your-app';

/**
 * Watch the product's signals, file the work. A command pulls a week of
 * rage clicks, exceptions and form errors by page; one model groups them
 * into frictions a person would recognise and a model from another family
 * checks the grouping against the rows; the same pair writes one ticket
 * per friction with its evidence. A person decides what is filed, and a
 * command files it. Run it from cron on Monday morning.
 */
function createWatchSignals(engines: WatchSignalsEngines = realEngines) {
  return workflow('watch-signals-then-file', {
    brief: fromFile('briefs/friction.md'),
    options: { timeout: '10m' },

    roles: {
      analyst: engines.claude('claude-sonnet-4-5'),
      'signal-review': [engines.codex('gpt-5.6-luna')],
      owner: person('File these as issues?'),
    },

    stages: [
      stage('pull', {
        run: ['curl', '-fsS', '-X', 'POST', `${POSTHOG.host}/api/projects/${POSTHOG.project}/query/`, '-H', `Authorization: Bearer ${POSTHOG_KEY}`, '-H', 'Content-Type: application/json', '-d', QUERY, '--create-dirs', '-o', 'signals/events.json'],
        writes: 'signals/events.json',
        desc: 'Ask PostHog for the last seven days of rage clicks, exceptions and form errors, by page.',
        gate: 'The query returned and the rows are in the workspace.',
      }),

      stage('cluster', {
        agent: 'analyst',
        writes: 'signals/frictions.md',
        desc: 'Group the rows in signals/events.json into frictions a person would recognise, worst first, each with its pages and its count.',
        gate: 'Every friction names its pages and its count, and a reviewer from another family has accepted the grouping against the rows.',
        reviewedBy: 'signal-review',
        retry: 2,
      }),

      stage('draft', {
        agent: 'analyst',
        writes: 'signals/tickets.md',
        desc: 'Write one ticket per friction worth fixing: a title, the evidence, and a first suspect.',
        gate: 'Every ticket carries its evidence.',
        reviewedBy: 'signal-review',
        retry: 2,
      }),

      stage('decide', {
        input: 'owner',
        desc: 'Put the tickets in front of the person who owns the product.',
        gate: 'A person has said file them.',
        sendsBackTo: 'draft',
      }),

      stage('file', {
        run: ['gh', 'issue', 'create', '--repo', REPO, '--title', 'Friction report from product signals', '--body-file', 'signals/tickets.md'],
        desc: 'Open one issue with the tickets as its body.',
        gate: 'The issue exists.',
      }),
    ],
  });
}

const result = await run(createWatchSignals(), {
  onEvent: (event) => console.log(formatEvent(event)),
});
console.log(JSON.stringify(result.outcome, null, 2));
