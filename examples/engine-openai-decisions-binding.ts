import { OpenAIDecisionsEngine } from '@obversa/engine-openai-decisions';

// The key is a placeholder. `admit` checks the request and sends nothing.
const engine = new OpenAIDecisionsEngine({ apiKey: 'example-key' });

const identity = await engine.admit({ workspaceMode: 'none' }, new AbortController().signal);
console.log(JSON.stringify(identity, null, 2));
