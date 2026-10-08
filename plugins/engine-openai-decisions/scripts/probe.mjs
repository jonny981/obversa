// A live experiment against OpenAI's Decisions API: the only file in this
// package that may touch it. It is not packed; run it from a source checkout
// after `pnpm build`. It asks three judge-shaped questions, one of each type,
// and prints the answers, the usage and the time the call took. It reads
// OPENAI_API_KEY from the environment and never prints it.
//
//   OPENAI_API_KEY=... node plugins/engine-openai-decisions/scripts/probe.mjs

import { OpenAIDecisionsEngine } from '../dist/index.js';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set');
  process.exit(2);
}

const prompt = JSON.stringify({
  state: {
    findings: ['The export button has no accessible label.', 'Two adjacent paragraphs repeat one sentence.'],
    rounds: 2,
  },
  questions: {
    holds: {
      type: 'noul',
      instructions: 'Does the draft hold as it stands?',
      criteria: { true: 'Only nits remain', false: 'A finding a user would notice remains' },
    },
    stop_reason: {
      type: 'choice',
      instructions: 'Why stop, if at all?',
      criteria: { holds: 'It holds', over_polishing: 'Remaining findings are polish', continue: 'Another round is worth it' },
    },
    readiness: {
      type: 'score',
      instructions: 'How ready is this to ship?',
      criteria: ['Unsafe to ship', 'Needs another round', 'Ships clean'],
    },
  },
});

const engine = new OpenAIDecisionsEngine({ apiKey });
const started = Date.now();
try {
  const result = await engine.run({ prompt, workspaceMode: 'none', timeoutMs: 30_000 }, () => {}, new AbortController().signal);
  const final = result.parts.find((part) => part.final);
  console.log(JSON.stringify({ ms: Date.now() - started, answers: final.value, usage: result.usage, model: result.effective.model }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ms: Date.now() - started, failed: error.kind, message: error.message }, null, 2));
  process.exit(1);
}
