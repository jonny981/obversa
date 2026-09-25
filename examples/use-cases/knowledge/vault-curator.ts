import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { claude } from '@obversa/engine-claude-cli';
import { openMarkdownCorpus } from '@obversa/memory-markdown';
import {
  agentJob,
  approval,
  dag,
  fnJob,
  formatEvent,
  run,
  type ApprovalAnswer,
  type DagNode,
  type Outcome,
} from '@obversa/runtime';
import { ground } from '@obversa/runtime/memory';

/**
 * A notes vault kept by a person, with a model doing the filing and the
 * finding. A Claude seat reads the day's inbox and proposes, for each
 * note, where it belongs in the vault and a cleaned version. The person
 * decides each one: file it as proposed, file it somewhere else, or drop
 * it with a reason. Only what the person kept is written into the vault.
 * Then a question is answered by searching the vault, grounding the seat
 * on the passages that matched, and citing their paths.
 */

interface Proposal {
  readonly note: string;
  readonly path: string;
  readonly title: string;
  readonly body: string;
}

interface Question {
  readonly id: string;
  readonly text: string;
}

type Steering = ApprovalAnswer & { readonly path?: string };

const notes = (await readdir('inbox')).filter((name) => name.endsWith('.md')).sort();
const steering = JSON.parse(await readFile('steering.json', 'utf8')) as Record<string, Steering | string>;
const question = (JSON.parse(await readFile('questions.json', 'utf8')) as Question[])[0]!;
const vault = openMarkdownCorpus({ directory: 'vault' });
const seat = claude('claude-sonnet-4-5');

/** The person's decision on each proposal. A drop fails its step without stopping the run. */
const steer: Record<string, DagNode> = Object.fromEntries(notes.map((note) => {
  const decision = steering[note];
  const prompt = `File the proposal for ${note} into the vault?`;
  return [`steer-${note}`, {
    needs: 'parse',
    optional: true,
    job: typeof decision === 'object'
      ? approval(`steer-${note}`, { question: prompt, answer: () => decision })
      : approval(`steer-${note}`, { question: prompt }),
  }];
}));

const curator = dag({
  name: 'vault-curator',
  nodes: {
    propose: agentJob({
      label: 'propose',
      engine: 'curator',
      workspaceMode: 'read',
      tools: ['Read', 'Glob'],
      prompt: `Read the notes in inbox/ (${notes.join(', ')}) and the folders in vault/, and propose as briefs/vault.md says.`,
    }),
    parse: {
      needs: 'propose',
      job: fnJob('parse', (ctx): Outcome => {
        const proposals = JSON.parse(String(ctx.needs?.propose?.data ?? '[]')) as Proposal[];
        return { status: 'pass', summary: `${proposals.length} proposals`, data: proposals };
      }),
    },
    ...steer,
    file: {
      needs: ['parse', ...Object.keys(steer)],
      job: fnJob('file', async (ctx): Promise<Outcome> => {
        const proposals = ctx.needs?.parse?.data as Proposal[];
        const filed: { note: string; path: string }[] = [];
        for (const proposal of proposals) {
          if (ctx.needs?.[`steer-${proposal.note}`]?.status !== 'pass') continue;
          const decision = steering[proposal.note];
          const path = typeof decision === 'object' && decision.path ? decision.path : proposal.path;
          await mkdir(dirname(join('vault', path)), { recursive: true });
          await writeFile(join('vault', path), `# ${proposal.title}\n\n${proposal.body.trim()}\n`);
          filed.push({ note: proposal.note, path });
        }
        return { status: 'pass', summary: `${filed.length} of ${proposals.length} notes filed`, data: { filed } };
      }),
    },
    search: {
      needs: 'file',
      job: fnJob('search', async (): Promise<Outcome> => {
        const hits = await vault.search(question.text, { limit: 4 });
        const paths = [...new Set(hits.map((hit) => hit.path))];
        const grounded = await ground(vault.memory, { sources: paths.map((path) => ({ path })) });
        if (!grounded.ok) throw new Error(grounded.error.message);
        return { status: 'pass', summary: `${hits.length} passages in ${paths.length} files`, data: { paths, prompt: grounded.value.prompt } };
      }),
    },
    answer: {
      needs: 'search',
      job: agentJob({
        label: 'answer',
        engine: 'curator',
        prompt: (ctx) => {
          const { prompt } = ctx.needs?.search?.data as { prompt: string };
          return `${prompt}\n\nAnswer as briefs/vault.md says and write answers/${question.id}.md.\n\nQuestion: ${question.text}`;
        },
      }),
    },
  },
});

const result = await run(curator, {
  engines: { curator: seat.engine },
  recordTo: 'records/vault-curator.jsonl',
  runId: 'vault-curator',
  onEvent: (event) => console.log(formatEvent(event)),
});

const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
console.log(JSON.stringify({
  status: result.outcome.status,
  proposed: (nodes.parse?.data as Proposal[] | undefined)?.map((proposal) => [proposal.note, proposal.path]) ?? [],
  filed: (nodes.file?.data as { filed: unknown[] } | undefined)?.filed ?? [],
  dropped: notes.filter((note) => nodes[`steer-${note}`]?.status === 'fail').map((note) => ({ note, reason: nodes[`steer-${note}`]?.summary ?? null })),
  searched: (nodes.search?.data as { paths: string[] } | undefined)?.paths ?? [],
  answered: nodes.answer?.status === 'pass' ? [question.id] : [],
}, null, 2));
