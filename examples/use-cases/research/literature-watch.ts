import { readdir, readFile } from 'node:fs/promises';

import type { MemoryPath } from '@obversa/api';
import { claude } from '@obversa/engine-claude-cli';
import { createSimpleMemory } from '@obversa/memory-simple';
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
 * A literature watch for one lab. A Claude seat summarises each supplied
 * paper. A person decides, paper by paper, which summaries enter the lab's
 * memory; a refused one is recorded with the reason and enters nothing.
 * Then a question is answered from the kept notes alone, read into the
 * prompt through `ground`, so the answer can only cite what the person
 * kept.
 */

interface Question {
  readonly id: string;
  readonly text: string;
}

const papers = (await readdir('papers')).filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)).sort();
const curation = JSON.parse(await readFile('curation.json', 'utf8')) as Record<string, ApprovalAnswer | string>;
const questions = JSON.parse(await readFile('questions.json', 'utf8')) as Question[];
const memory = createSimpleMemory({ scope: 'literature-watch' });
const seat = claude('claude-sonnet-4-5');
const memoryPath = (paper: string): MemoryPath => `/memories/papers/${paper}.md` as MemoryPath;

/** One decision per paper. A refusal fails its step without stopping the run. */
const curate: Record<string, DagNode> = Object.fromEntries(papers.map((paper) => {
  const decision = curation[paper];
  const question = `Keep the summary of ${paper} in the lab's memory?`;
  return [`curate-${paper}`, {
    needs: 'harvest',
    optional: true,
    job: typeof decision === 'object'
      ? approval(`curate-${paper}`, { question, answer: () => decision })
      : approval(`curate-${paper}`, { question }),
  }];
}));

const watch = dag({
  name: 'literature-watch',
  nodes: {
    harvest: agentJob({
      label: 'harvest',
      engine: 'lab',
      prompt: `Summarise every paper in papers/ as briefs/literature.md says: ${papers.join(', ')}. Write one file per paper under summaries/.`,
    }),
    ...curate,
    file: {
      needs: Object.keys(curate),
      job: fnJob('file', async (ctx): Promise<Outcome> => {
        const kept: string[] = [];
        for (const paper of papers) {
          if (ctx.needs?.[`curate-${paper}`]?.status !== 'pass') continue;
          const text = await readFile(`summaries/${paper}.md`, 'utf8');
          const result = await ctx.memory!.execute({ command: 'create', path: memoryPath(paper), text });
          if (!result.ok) throw new Error(`memory refused ${paper}: ${result.error.code}`);
          kept.push(paper);
        }
        return { status: 'pass', summary: `${kept.length} of ${papers.length} summaries kept`, data: { kept } };
      }),
    },
    answer: {
      needs: 'file',
      job: agentJob({
        label: 'answer',
        engine: 'lab',
        prompt: async (ctx) => {
          const { kept } = ctx.needs?.file?.data as { kept: string[] };
          const grounded = await ground(ctx.memory!, { sources: kept.map((paper) => ({ path: memoryPath(paper) })) });
          if (!grounded.ok) throw new Error(grounded.error.message);
          const question = questions[0]!;
          return `${grounded.value.prompt}\n\nAnswer as briefs/literature.md says and write answers/${question.id}.md.\n\nQuestion: ${question.text}`;
        },
      }),
    },
  },
});

const result = await run(watch, {
  engines: { lab: seat.engine },
  memory,
  recordTo: 'records/literature-watch.jsonl',
  runId: 'literature-watch',
  onEvent: (event) => console.log(formatEvent(event)),
});

const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
const refused = papers
  .filter((paper) => nodes[`curate-${paper}`]?.status === 'fail')
  .map((paper) => ({ paper, note: nodes[`curate-${paper}`]?.summary ?? null }));
console.log(JSON.stringify({
  status: result.outcome.status,
  papers,
  kept: (nodes.file?.data as { kept: string[] } | undefined)?.kept ?? [],
  refused,
  answered: nodes.answer?.status === 'pass' ? questions.map((question) => question.id) : [],
}, null, 2));
