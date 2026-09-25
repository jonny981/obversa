import { appendFile, mkdir, readFile } from 'node:fs/promises';

import { claude } from '@obversa/engine-claude-cli';
import {
  agentJob,
  approval,
  commandJob,
  dag,
  fnJob,
  formatEvent,
  pipeline,
  run,
  type Outcome,
} from '@obversa/runtime';

/**
 * Chasing overdue invoices, with a person on every dispute. A command
 * reads the ledger and writes the overdue list, so what counts as overdue
 * is the ledger's arithmetic and not a model's. Then each overdue invoice
 * gets its own run: a Claude seat drafts the chaser from the brief, and
 * either the mailer sends it or, when the customer has raised a dispute,
 * the run stops on a question for a person with the draft beside it. The
 * record shows every draft, every send and every decision.
 */

interface OverdueInvoice {
  readonly id: string;
  readonly customer: string;
  readonly contact: string;
  readonly amount: string;
  readonly currency: string;
  readonly due: string;
  readonly daysOverdue: number;
  readonly dispute?: string;
}

const mailerUrl = process.env.CHASE_MAIL_URL ?? 'https://mail.example/api/send';
const drafter = claude('claude-sonnet-4-5');
const onEvent = (event: Parameters<typeof formatEvent>[0]) => console.log(formatEvent(event));

// Run one: the ledger, read by a command. Its exit code is the result, and
// the list it writes is what the rest of the file works from.
const ledger = await run(
  pipeline('read-ledger', [
    { name: 'export', job: commandJob('export', [process.execPath, 'tools/overdue.mjs']) },
    {
      name: 'select',
      job: fnJob('select', async (): Promise<Outcome> => {
        const overdue = JSON.parse(await readFile('chase/overdue.json', 'utf8')) as OverdueInvoice[];
        return { status: 'pass', summary: `${overdue.length} overdue`, data: overdue };
      }),
    },
  ]),
  { recordTo: 'records/read-ledger.jsonl', runId: 'read-ledger', onEvent },
);
if (ledger.outcome.status !== 'pass') throw new Error(`the ledger could not be read: ${ledger.outcome.summary}`);
const overdue = ((ledger.outcome.data as Record<string, Outcome | undefined>).select?.data ?? []) as OverdueInvoice[];

/** One overdue invoice: a draft, then a send or a person. */
function chase(invoice: OverdueInvoice) {
  const draftPath = `chase/${invoice.id}.md`;
  const draft = agentJob({
    label: 'draft',
    engine: 'drafter',
    prompt: [
      `Draft the chaser for ${invoice.id} to ${invoice.customer} (${invoice.contact}):`,
      `${invoice.currency} ${invoice.amount}, due ${invoice.due}, ${invoice.daysOverdue} days overdue.`,
      invoice.dispute ? `The customer has raised a dispute: ${invoice.dispute}` : 'No dispute is on file.',
      `Follow briefs/chase.md and write ${draftPath}.`,
    ].join('\n'),
  });
  return dag({
    name: `chase-${invoice.id}`,
    nodes: {
      draft,
      ...(invoice.dispute
        ? {
          decide: {
            needs: 'draft',
            job: approval('decide', {
              question: `${invoice.id} is disputed (${invoice.dispute}) Waive, chase anyway, or call them? The draft is in ${draftPath}.`,
              input: { invoice: invoice.id, dispute: invoice.dispute, draft: draftPath },
            }),
          },
        }
        : {
          send: {
            needs: 'draft',
            job: commandJob('send', ['curl', '-sS', '-X', 'POST', mailerUrl, '--data-binary', `@${draftPath}`]),
          },
        }),
    },
  });
}

interface Report {
  readonly invoice: string;
  readonly daysOverdue: number;
  readonly disputed: boolean;
  readonly outcome: string;
  readonly sent: boolean;
}

const reports: Report[] = [];
await mkdir('history', { recursive: true });
for (const invoice of overdue) {
  const result = await run(chase(invoice), {
    engines: { drafter: drafter.engine },
    recordTo: `records/${invoice.id}.jsonl`,
    runId: `chase-${invoice.id}`,
    onEvent,
  });
  const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
  const report: Report = {
    invoice: invoice.id,
    daysOverdue: invoice.daysOverdue,
    disputed: invoice.dispute !== undefined,
    outcome: result.outcome.status,
    sent: nodes.send?.status === 'pass',
  };
  reports.push(report);
  await appendFile(
    report.sent ? 'history/chased.jsonl' : 'history/for-a-person.jsonl',
    `${JSON.stringify({ invoice: invoice.id, runId: `chase-${invoice.id}`, dispute: invoice.dispute ?? null })}\n`,
  );
}

console.log(JSON.stringify({
  status: 'pass',
  overdue: overdue.map((invoice) => invoice.id),
  chased: reports.filter((report) => report.sent).map((report) => report.invoice),
  forAPerson: reports.filter((report) => !report.sent).map((report) => report.invoice),
  invoices: reports,
}, null, 2));
