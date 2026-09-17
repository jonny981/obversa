import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { formatEvent, run } from '@obversa/runtime';
import { fromFile, person, stage, workflow, type TeamSeat } from '@obversa/teams';

interface ContractPlaybookEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: ContractPlaybookEngines = { claude, codex };

/**
 * Contract review against a playbook. The brief is the playbook: what we
 * accept, what we push back on, what we never sign. One model maps every
 * clause of the contract to the rule it meets or breaks, writes the
 * redlines, and is read by a model from another family that checks each
 * redline against the playbook and sends the work back when one is missing
 * or goes further than the playbook allows. A lawyer decides what is sent.
 */
function createContractPlaybook(engines: ContractPlaybookEngines = realEngines) {
  return workflow('contract-playbook', {
    brief: fromFile('briefs/playbook.md'),
    options: { timeout: '15m' },

    roles: {
      review: engines.claude('claude-sonnet-4-5'),
      'playbook-check': [engines.codex('gpt-5.6-luna')],
      lawyer: person('Send these redlines to the other side?'),
    },

    stages: [
      stage('clauses', {
        agent: 'review',
        writes: 'review/clauses.md',
        desc: 'Read contracts/msa.md and list every clause with the playbook rule it meets or breaks, one line each.',
        gate: 'Every numbered clause of the contract is on the list.',
      }),

      stage('redline', {
        agent: 'review',
        writes: 'review/redlines.md',
        desc: 'For each clause that breaks a rule, write the replacement wording the playbook allows, with the rule it comes from.',
        gate: 'Every breaking clause has a redline, no redline goes further than its rule, and a checker from another family has accepted the set.',
        reviewedBy: 'playbook-check',
        retry: 3,
      }),

      stage('positions', {
        agent: 'review',
        writes: 'review/positions.md',
        desc: 'Write the negotiating note: what to hold, what to concede and to what, and what is a walk-away.',
        gate: 'Every redline has a position.',
      }),

      stage('negotiate', {
        input: 'lawyer',
        desc: 'Put the redlines and the positions in front of the lawyer.',
        gate: 'The lawyer has decided.',
        sendsBackTo: 'redline',
      }),
    ],
  });
}

const result = await run(createContractPlaybook(), {
  onEvent: (event) => console.log(formatEvent(event)),
});
console.log(JSON.stringify(result.outcome, null, 2));
