import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import {
  briefFromFile,
  formatEvent,
  person,
  run,
  stage,
  workflow,
  type JobContext,
  type TeamSeat,
} from '@obversa/runtime';

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

/** The lowest confidence the brief lets a ticket answer itself at. */
const MINIMUM_CONFIDENCE = 0.8;

/** A decision nobody can read is a reason to ask a person, never to send. */
const ASK_A_PERSON: Decision = { route: 'escalate', confidence: 0 };

/**
 * The classifier's decision, read from the file it wrote and checked before
 * it is believed. A model writes this file, so it can write anything: a route
 * that is not a route, a confidence that is not a number, or no JSON at all.
 * Every one of those reads as escalate, because the only safe direction for a
 * decision we cannot understand is towards a person.
 */
async function decision(ctx: JobContext): Promise<Decision> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(ctx.workspace.dir, 'triage/decision.json'), 'utf8'));
  } catch {
    return ASK_A_PERSON;
  }
  if (parsed === null || typeof parsed !== 'object') return ASK_A_PERSON;
  const { route, confidence } = parsed as { route?: unknown; confidence?: unknown };
  // Removing this line leaves the proof green, because the escalate stage's
  // `when` is the negation of `answersItself` and catches an unknown route
  // anyway. It stays because the gate's finding was that this function CAST
  // arbitrary JSON to Decision: without it, decision() returns a value that
  // lies about its own type to every later reader.
  if (route !== 'auto' && route !== 'escalate') return ASK_A_PERSON;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return ASK_A_PERSON;
  if (confidence < 0 || confidence > 1) return ASK_A_PERSON;
  return { route, confidence };
}

/** Routed auto AND sure enough. Anything else goes to a person. */
async function answersItself(ctx: JobContext): Promise<boolean> {
  const { route, confidence } = await decision(ctx);
  return route === 'auto' && confidence >= MINIMUM_CONFIDENCE;
}

/**
 * Support triage with a confidence gate. One model reads the ticket and
 * writes the route, how sure it is and the reply; a model from another
 * family checks that decision before anything happens. Nothing is ever sent
 * without a person: a confident, well-formed decision takes the reply to a
 * person to confirm and then posts it, and everything else goes to a person
 * as an escalation. A decision that cannot be read, a route that is not a
 * route, or a confidence under the brief's minimum all take the second path,
 * because the safe direction for an answer we do not understand is towards a
 * person rather than towards the customer.
 */
function createSupportTriage(engines: SupportTriageEngines = realEngines) {
  return workflow('support-triage', {
    brief: briefFromFile('briefs/support.md'),
    options: { timeout: '10m' },

    roles: {
      classify: engines.claude('claude-sonnet-4-5'),
      'second-opinion': [engines.codex('gpt-5.6-luna')],
      support: person('This ticket needs you: reply, reassign or close?'),
      approve: person('Send this reply to the customer exactly as written?'),
    },

    stages: [
      stage('classify', {
        agent: 'classify',
        writes: ['triage/decision.json', 'triage/reply.json'],
        desc: 'Read the ticket in tickets/inbox.json against the policy; write the route, a confidence from 0 to 1, and the reply as the exact payload to send.',
        gate: 'Both files exist and a model from another family agrees with the route and the confidence.',
        reviewedBy: 'second-opinion',
        // Three attempts, not two: the allowance matches how open-ended the
        // work is. Reading a ticket against a policy is open enough that a
        // first answer is often nearly right rather than right.
        retry: 3,
      }),

      stage('confirm', {
        input: 'approve',
        when: answersItself,
        desc: 'Show the person the exact reply that will go out. Nothing is sent until they say yes.',
        gate: 'The person has said yes to triage/reply.json as written.',
        sendsBackTo: 'classify',
      }),

      stage('auto-reply', {
        run: ['curl', '-fsS', '-X', 'POST', REPLY_ENDPOINT, '-H', 'Content-Type: application/json', '--data-binary', '@triage/reply.json'],
        when: answersItself,
        desc: 'Post the reply the person approved.',
        gate: 'The helpdesk accepted the reply.',
      }),

      stage('escalate', {
        input: 'support',
        when: async (ctx) => !(await answersItself(ctx)),
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
