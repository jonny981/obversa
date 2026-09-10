import { createSimpleMemory } from '@obversa/memory-simple';

const memory = createSimpleMemory({ scope: 'memory-simple-example' });
await memory.execute({
  command: 'create',
  path: '/memories/notes.md',
  text: 'Keep the result small.\n',
});
const result = await memory.execute({
  command: 'view',
  path: '/memories/notes.md',
});

if (!result.ok || result.command !== 'view' || result.value.kind !== 'file') {
  throw new Error('The in-process memory could not read its note.');
}
console.log(result.value.text);
