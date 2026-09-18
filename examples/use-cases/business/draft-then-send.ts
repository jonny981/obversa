import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import {
  briefFromFile,
  formatEvent,
  person,
  run,
  stage,
  workflow,
  type TeamSeat,
} from '@obversa/runtime';

interface DraftThenSendEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: DraftThenSendEngines = { claude, codex };

/** Where the approved emails go: a mail API's batch endpoint, the key from the environment. */
const MAIL_ENDPOINT = 'https://api.resend.com/emails/batch';
const MAIL_KEY = process.env.RESEND_API_KEY ?? '';

/**
 * Draft, then a person sends. A model researches each lead from the file
 * and the brief, a model writes the emails, a model from another family
 * reads them for tone and for claims we cannot back, and then the person
 * whose name is on them decides. What the person approves is the exact
 * payload the command sends, byte for byte; a no goes back to the drafting
 * stage with the person's note as the finding.
 */
function createDraftThenSend(engines: DraftThenSendEngines = realEngines) {
  return workflow('draft-then-send', {
    brief: briefFromFile('briefs/outreach.md'),
    options: { timeout: '10m' },

    roles: {
      research: engines.claude('claude-sonnet-4-5'),
      draft: engines.claude('claude-sonnet-4-5'),
      'tone-review': [engines.codex('gpt-5.6-luna')],
      sender: person('Send these emails exactly as they stand in outreach/emails.json?'),
    },

    stages: [
      stage('research', {
        agent: 'research',
        writes: 'outreach/notes.md',
        desc: 'For each lead in leads.csv, write what the file and the brief say about them and one reason they would care.',
        gate: 'Every lead in the file has a note.',
      }),

      stage('draft', {
        agent: 'draft',
        writes: ['outreach/drafts.md', 'outreach/emails.json'],
        desc: 'Write one email per lead: the readable drafts in drafts.md, and the same text as the exact payload in emails.json.',
        gate: 'Both files exist, they say the same thing, and a reviewer from another family has accepted the tone and every claim.',
        reviewedBy: 'tone-review',
        retry: 3,
      }),

      stage('seal', {
        run: ['sh', '-c', 'cp outreach/emails.json outreach/approved.json && shasum -a 256 outreach/approved.json > outreach/approved.sha256'],
        writes: ['outreach/approved.json', 'outreach/approved.sha256'],
        desc: 'Freeze the exact bytes the person is about to read, and record their digest.',
        gate: 'The frozen payload and its digest are on disk.',
      }),

      stage('send', {
        input: 'sender',
        desc: 'Put the frozen payload in front of the person whose name is on it.',
        gate: 'The person has said yes to outreach/approved.json as it stands.',
        sendsBackTo: 'draft',
      }),

      stage('deliver', {
        run: ['sh', '-c', `shasum -a 256 -c outreach/approved.sha256 && curl -fsS -X POST ${MAIL_ENDPOINT} -H "Authorization: Bearer ${MAIL_KEY}" -H "Content-Type: application/json" --data-binary @outreach/approved.json`],
        desc: 'Check the bytes are the ones that were approved, then send those bytes.',
        gate: 'The digest still matches and the mail API accepted the batch.',
      }),
    ],
  });
}

const result = await run(createDraftThenSend(), {
  onEvent: (event) => console.log(formatEvent(event)),
});
console.log(JSON.stringify(result.outcome, null, 2));
