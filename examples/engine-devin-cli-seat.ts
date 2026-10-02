import { finalResultText } from '@obversa/api';
import { devin } from '@obversa/engine-devin-cli';

// Without a model, Devin runs its own default model, or the one your Devin settings choose with clean: false.
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
