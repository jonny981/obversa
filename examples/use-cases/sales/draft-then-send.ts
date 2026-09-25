import { appendFile, mkdir, readFile } from 'node:fs/promises';

import { claude } from '@obversa/engine-claude-cli';
import {
  agentJob,
  approval,
  commandJob,
  dag,
  formatEvent,
  run,
  type ApprovalAnswer,
  type Outcome,
} from '@obversa/runtime';

/**
 * Outreach drafted by a model, sent by a person, one message at a time. A
 * Claude seat drafts a first note to each warm contact from the brief and
 * the contact's notes. The person reads the draft and decides: a yes sends
 * it through the CRM's command, a no records the reason, and no decision
 * yet leaves the run stopped on the question. The record keeps what was
 * sent, what was refused and why, and what is still waiting.
 */

interface Contact {
  readonly id: string;
  readonly name: string;
  readonly company: string;
  readonly notes: string;
}

interface ContactList {
  readonly sender: string;
  readonly contacts: readonly Contact[];
}

const list = JSON.parse(await readFile('contacts/list.json', 'utf8')) as ContactList;
const decisions = JSON.parse(await readFile('decisions.json', 'utf8')) as Record<string, ApprovalAnswer | string>;
const sendUrl = process.env.OUTREACH_SEND_URL ?? 'https://crm.example/api/outbox';
const draft = claude('claude-sonnet-4-5');

/** One contact: a draft, the person's decision, and the send. */
function outreach(contact: Contact) {
  const decision = decisions[contact.id];
  const question = `Send this note to ${contact.name} at ${contact.company}?`;
  return dag({
    name: `outreach-${contact.id}`,
    nodes: {
      draft: agentJob({
        label: 'draft',
        engine: 'draft',
        prompt: [
          `Draft the first note to ${contact.name} at ${contact.company}.`,
          `Their notes: ${contact.notes}`,
          `Sign off as ${list.sender}.`,
          `Follow briefs/outreach.md and write outbox/${contact.id}.md.`,
        ].join('\n'),
      }),
      approve: {
        needs: 'draft',
        // The person's decision from the last pass, when there is one.
        // Without it the step pauses on the question and nothing is sent.
        job: typeof decision === 'object'
          ? approval('approve', { question, answer: () => decision })
          : approval('approve', { question }),
      },
      send: {
        needs: 'approve',
        job: commandJob('send', ['curl', '-sS', '-X', 'POST', sendUrl, '--data-binary', `@outbox/${contact.id}.md`]),
      },
    },
  });
}

interface Report {
  readonly contact: string;
  readonly outcome: string;
  readonly sent: boolean;
  readonly note: string | null;
}

const reports: Report[] = [];
await mkdir('history', { recursive: true });
for (const contact of list.contacts) {
  const result = await run(outreach(contact), {
    engines: { draft: draft.engine },
    recordTo: `records/${contact.id}.jsonl`,
    runId: `outreach-${contact.id}`,
    onEvent: (event) => console.log(formatEvent(event)),
  });
  const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
  const sent = nodes.send?.status === 'pass';
  const refused = nodes.approve?.status === 'fail';
  const report: Report = {
    contact: contact.id,
    outcome: result.outcome.status,
    sent,
    note: refused ? nodes.approve?.summary ?? null : null,
  };
  reports.push(report);
  const line = `${JSON.stringify({ contact: contact.id, runId: `outreach-${contact.id}`, ...(refused ? { note: report.note } : {}) })}\n`;
  await appendFile(sent ? 'history/sent.jsonl' : refused ? 'history/refused.jsonl' : 'history/waiting.jsonl', line);
}

console.log(JSON.stringify({
  status: 'pass',
  contacts: reports,
  sent: reports.filter((report) => report.sent).length,
  refused: reports.filter((report) => report.note !== null).length,
  waiting: reports.filter((report) => report.outcome === 'paused').length,
}, null, 2));
