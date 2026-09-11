import { curate, type GroundedMemory } from '@obversa/memory';

const grounded: GroundedMemory = {
  documents: [
    {
      path: '/memories/project.md',
      text: 'Keep the public API small.',
      truncated: false,
    },
  ],
  missing: [],
  prompt: '',
};

const result = await curate(grounded, {
  intent: 'Prepare the next task.',
  decide: async () => ({
    brief: 'Use the project constraint.',
    sources: ['/memories/project.md'],
  }),
});

if (result.mode !== 'curated') throw new Error('Memory curation did not complete.');
console.log(JSON.stringify({ mode: result.mode, sources: result.sources }, null, 2));
