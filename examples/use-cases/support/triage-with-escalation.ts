import { appendFile, mkdir, readFile } from 'node:fs/promises';

import { claude } from '@obversa/engine-claude-cli';
import {
  agentJob,
  approval,
  commandJob,
  dag,
  fnJob,
  formatEvent,
  predicate,
  run,
  type JobContext,
  type Outcome,
} from '@obversa/runtime';

/**
 * Support triage with a person on everything that isn't routine. For each
 * ticket a Claude seat classifies it with a typed answer, a check turns
 * that answer into a route, the same seat drafts a reply, and then the run
 * splits: a routine ticket the seat was sure about is answered through the
 * helpdesk's command, and everything else stops on a question for a
 * person with the draft beside it. A classification the check can't read
 * is never routine.
 */

interface Ticket {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
}

interface Policy {
  readonly minConfidenceToReply: number;
}

type Route = 'reply' | 'person';

interface Routing {
  readonly route: Route;
  readonly kind: string;
  readonly confidence: number | null;
  readonly reason: string;
}

/** Read the typed classification. Anything the check can't read goes to a person. */
function routing(text: string, policy: Policy): Routing {
  try {
    const answer = JSON.parse(text) as { kind?: unknown; confidence?: unknown; reason?: unknown };
    const kind = answer.kind === 'routine' || answer.kind === 'needs-a-person' ? answer.kind : null;
    const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : null;
    const reason = typeof answer.reason === 'string' ? answer.reason : 'no reason given';
    if (kind === null || confidence === null) {
      return { route: 'person', kind: 'unreadable', confidence, reason: 'the classification could not be read' };
    }
    const routine = kind === 'routine' && confidence >= policy.minConfidenceToReply;
    return { route: routine ? 'reply' : 'person', kind, confidence, reason };
  } catch {
    return { route: 'person', kind: 'unreadable', confidence: null, reason: 'the classification was not JSON' };
  }
}

const routeOf = (ctx: JobContext): Routing => ctx.needs?.route?.data as Routing;

/** One ticket: classify, route, draft, then reply or ask a person. */
function triage(ticket: Ticket, policy: Policy, helpdeskUrl: string) {
  const reply = `replies/${ticket.id}.md`;
  const ticketText = `Ticket ${ticket.id} from ${ticket.from}\nSubject: ${ticket.subject}\n\n${ticket.body}`;
  return dag({
    name: `triage-${ticket.id}`,
    nodes: {
      classify: agentJob({
        label: 'classify',
        engine: 'support',
        workspaceMode: 'read',
        tools: ['Read', 'Glob'],
        prompt: `Classify this ticket as briefs/support.md says, reading help/ to see whether the answer is there.\n\n${ticketText}`,
      }),
      route: {
        needs: 'classify',
        job: fnJob('route', (ctx): Outcome => {
          const decided = routing(String(ctx.needs?.classify?.data ?? ''), policy);
          return { status: 'pass', summary: `${decided.route}: ${decided.reason}`, data: decided };
        }),
      },
      draft: {
        needs: 'route',
        job: agentJob({
          label: 'draft',
          engine: 'support',
          prompt: `Draft the reply as briefs/support.md says and write ${reply}.\n\n${ticketText}`,
        }),
      },
      send: {
        needs: ['route', 'draft'],
        when: predicate((ctx) => routeOf(ctx).route === 'reply', 'the ticket is routine and the seat was sure'),
        job: commandJob('send', ['curl', '-sS', '-X', 'POST', `${helpdeskUrl}/${ticket.id}/reply`, '--data-binary', `@${reply}`]),
      },
      escalate: {
        needs: ['route', 'draft'],
        when: predicate((ctx) => routeOf(ctx).route === 'person', 'a person needs to read this one'),
        job: approval('escalate', {
          question: `Ticket ${ticket.id} (${ticket.subject}) needs a person. Send the draft in ${reply}, or answer it yourself?`,
          input: { ticket: ticket.id, draft: reply },
        }),
      },
    },
  });
}

const tickets = JSON.parse(await readFile('tickets/inbox.json', 'utf8')) as Ticket[];
const policy = JSON.parse(await readFile('policy.json', 'utf8')) as Policy;
const helpdeskUrl = process.env.HELPDESK_URL ?? 'https://helpdesk.example/api/tickets';
const support = claude('claude-sonnet-4-5');

interface Report {
  readonly ticket: string;
  readonly kind: string;
  readonly confidence: number | null;
  readonly route: Route;
  readonly outcome: string;
}

const reports: Report[] = [];
await mkdir('history', { recursive: true });
for (const ticket of tickets) {
  const result = await run(triage(ticket, policy, helpdeskUrl), {
    engines: { support: support.engine },
    recordTo: `records/${ticket.id}.jsonl`,
    runId: `triage-${ticket.id}`,
    onEvent: (event) => console.log(formatEvent(event)),
  });
  const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
  const decided = nodes.route?.data as Routing;
  const report: Report = {
    ticket: ticket.id,
    kind: decided.kind,
    confidence: decided.confidence,
    route: decided.route,
    outcome: result.outcome.status,
  };
  reports.push(report);
  await appendFile(
    decided.route === 'reply' ? 'history/answered.jsonl' : 'history/for-a-person.jsonl',
    `${JSON.stringify({ ticket: ticket.id, runId: `triage-${ticket.id}`, reason: decided.reason })}\n`,
  );
}

console.log(JSON.stringify({
  status: 'pass',
  tickets: reports,
  answered: reports.filter((report) => report.route === 'reply').length,
  forAPerson: reports.filter((report) => report.route === 'person').length,
}, null, 2));
