// Compile fixture for the TypeScript snippets in README.md and
// docs/public/packages/engine-openai-decisions.mdx. tests/doc-snippets.spec.ts
// reads those files and asserts every ```ts fenced block appears here
// verbatim, import line included, so every public snippet compiles against
// the real exports under the published package specifier.

import { OpenAIDecisionsEngine } from '@obversa/engine-openai-decisions';
import { openaiDecisions } from '@obversa/engine-openai-decisions';

{
// Reads OPENAI_API_KEY. The model defaults to gpt-6-luna.
const decider = openaiDecisions();
void decider;
}

{
const prices = { 'gpt-6-luna': { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0 } };
void prices;
}

{
// The key is a placeholder. `admit` checks the request and sends nothing.
const engine = new OpenAIDecisionsEngine({ apiKey: 'example-key' });

const identity = await engine.admit({ workspaceMode: 'none' }, new AbortController().signal);
console.log(JSON.stringify(identity, null, 2));
}
