import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { formatEvent, run, type JobContext } from '@obversa/runtime';
import { fromFile, person, stage, workflow, type TeamSeat } from '@obversa/teams';

interface SupportTriageEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: SupportTriageEngines = { claude, codex };

/** Where a reply goes when the run is sure enough to send it itself. */
const REPLY_ENDPOINT = 'https://hooks.example.com/helpdesk/reply';

interface Decision {
  readonly route: 'auto' | 'escalate';
  readonly confidence: number;
}

/** The classifier's decision, read from the file it wrote. */
async function decision(ctx: JobContext): Promise<Decision> {
  return JSON.parse(await readFile(join(ctx.workspace.dir, 'triage/decision.json'), 'utf8')) as Decision;
}

/**
 * Support triage with a confidence gate. One model reads the ticket and
 * writes the route, how sure it is and the reply; a model from another
 * family checks that decision before anything happens. A confident reply
 * goes out by command; an unsure one goes to a person. Only one of the last
 * two stages runs, chosen by `when` from the file the classifier wrote.
 */
function createSupportTriage(engines: SupportTriageEngines = realEngines) {
  return workflow('support-triage', {
    brief: fromFile('briefs/support.md'),
    options: { timeout: '10m' },

    roles: {
      classify: engines.claude('claude-sonnet-4-5'),
      'second-opinion': [engines.codex('gpt-5.6-luna')],
      support: person('This ticket needs you: reply, reassign or close?'),
    },

    stages: [
      stage('classify', {
        agent: 'classify',
        writes: ['triage/decision.json', 'triage/reply.json'],
        desc: 'Read the ticket in tickets/inbox.json against the policy; write the route, a confidence from 0 to 1, and the reply as the exact payload to send.',
        gate: 'Both files exist and a model from another family agrees with the route and the confidence.',
        reviewedBy: 'second-opinion',
        retry: 2,
      }),

      stage('auto-reply', {
        run: ['curl', '-fsS', '-X', 'POST', REPLY_ENDPOINT, '-H', 'Content-Type: application/json', '--data-binary', '@triage/reply.json'],
        when: async (ctx) => (await decision(ctx)).route === 'auto',
        desc: 'Post the reply to the helpdesk, only when the classifier was sure enough.',
        gate: 'The helpdesk accepted the reply.',
      }),

      stage('escalate', {
        input: 'support',
        when: async (ctx) => (await decision(ctx)).route === 'escalate',
        desc: 'Put the ticket, the draft reply and the doubt in front of a person.',
        gate: 'A person has decided.',
      }),
    ],
  });
}

const result = await run(createSupportTriage(), {
  onEvent: (event) => console.log(formatEvent(event)),
});
console.log(JSON.stringify(result.outcome, null, 2));
