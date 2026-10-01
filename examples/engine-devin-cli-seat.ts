import { finalResultText } from '@obversa/api';
import { devin } from '@obversa/engine-devin-cli';

// Without a model, Devin runs the default model from your own Devin settings.
const seat = devin();

const result = await seat.engine.run({
  prompt: 'What does a.js export?',
  model: seat.identity.model,
  tools: [...seat.identity.tools],
  workspaceMode: 'read',
  cwd: process.cwd(),
}, () => {}, new AbortController().signal);

console.log(finalResultText(result));
console.log(`model: ${result.effective.model}`);
