import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openMarkdownCorpus } from '@obversa/search-markdown';
import { agentJob, run } from '@obversa/runtime';
import { curate, ground } from '@obversa/runtime/memory';
import { MockEngine } from '@obversa/runtime/testing';

await access(fileURLToPath(new URL('./search-markdown-corpus/notes with spaces.md', import.meta.url)));
const corpus = openMarkdownCorpus({
  directory: fileURLToPath(new URL('./search-markdown-corpus', import.meta.url)),
});
const hits = await corpus.search('warranty');
const paths = [...new Set(hits.map((hit) => hit.path))];
const grounded = await ground(corpus.memory, {
  sources: paths.map((path) => ({ path })),
});

if (!grounded.ok) throw new Error(grounded.error.message);
if (paths.length !== 1 || paths[0] !== '/memories/warranty.md') {
  throw new Error('Search returned a corpus path that ground must not receive.');
}

const context = await curate(grounded.value, {
  intent: 'Answer the warranty question.',
  decide: ({ documents }) => ({
    brief: documents
      .flatMap((document) => document.text.split('\n'))
      .find((line) => line.includes('lasts')) ?? '',
    sources: documents.map((document) => document.path),
  }),
});

if (context.mode !== 'curated') throw new Error('The local curator did not return a brief.');

let receivedPrompt = '';
const engine = new MockEngine((request) => {
  receivedPrompt = request.prompt;
  return 'The warranty answer is ready.';
});
const result = await run(agentJob({
  label: 'answer-from-corpus',
  engine: 'offline',
  prompt: `Use this brief to answer the question:\n\n${context.brief}`,
}), {
  engine: 'offline',
  engines: { offline: engine },
});

console.log(JSON.stringify({
  hits: hits.map((hit) => ({
    path: hit.path,
    startLine: hit.passage.startLine,
    endLine: hit.passage.endLine,
  })),
  grounded: grounded.value.documents.map((document) => document.path),
  brief: context.brief,
  job: result.outcome.status,
  briefReachedJob: receivedPrompt.includes(context.brief),
}, null, 2));
