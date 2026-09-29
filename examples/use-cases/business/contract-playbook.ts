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

interface ContractPlaybookEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: ContractPlaybookEngines = { claude, codex };

/**
 * The judge that decides whether the redlines go round again: Jev over the
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
 * Contract review against a playbook. The brief is the playbook: what we
 * accept, what we push back on, what we never sign. One model maps every
 * clause of the contract to the rule it meets or breaks, writes the
 * redlines, and is read by a model from another family that checks each
 * redline against the playbook and returns the work when one is missing
 * or goes further than the playbook allows. A lawyer decides what is sent.
 */
function createContractPlaybook(jev: TeamSeat, engines: ContractPlaybookEngines = realEngines) {
  return workflow('contract-playbook', {
    brief: briefFromFile('briefs/playbook.md'),
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
        // The judge. After a round the checker did not pass, Jev reads the
        // findings and the rounds so far and says whether another round is
        // worth it; a finding tagged block goes back without asking. The
        // cap is the backstop: three rounds at most, whatever the judge says.
        refine: judge(jev, { cap: 3 }),
      }),

      stage('positions', {
        agent: 'review',
        writes: 'review/positions.md',
        desc: 'Write the negotiating note: what to hold, what to concede and to what, and what is a walk-away.',
        gate: 'Every redline has a position, and a reviewer from another family has accepted them.',
        reviewedBy: 'playbook-check',
        // Three attempts: the allowance matches how open-ended the work is.
        // Deciding what to hold, what to concede and what is a walk-away is
        // the most judgement-heavy step here, and it had none while listing
        // clauses had three.
        refine: 3,
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

const result = await run(createContractPlaybook(await judgeSeat()), {
  onEvent: (event) => console.log(formatEvent(event)),
  recordTo: 'records/contract-playbook.jsonl',
});
console.log(JSON.stringify(result.outcome, null, 2));
