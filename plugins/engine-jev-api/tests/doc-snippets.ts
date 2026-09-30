// Compile fixture for the TypeScript snippets in README.md and
// docs/public/packages/engine-jev-api.mdx. tests/doc-snippets.spec.ts reads
// those files and asserts every ```ts fenced block appears here verbatim —
// including the import line — so every public snippet compiles against the
// real exports under the published package specifier.

import type { TeamSeat } from '@obversa/api';
import { JevApiEngine } from '@obversa/engine-jev-api';
import { jev } from '@obversa/engine-jev-api';

// The runtime's recorded seat, declared by type only: a plugin never imports
// the runtime, and this fixture is compiled, not run.
declare function recordedJudge(path: string): TeamSeat;

{
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  throw new Error('TYPESAFE_API_KEY is not set');
}

const engine = new JevApiEngine({
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  apiKey,
  adapterVersion: '0.1.0',
});
void engine;
}

{
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  throw new Error('TYPESAFE_API_KEY is not set');
}

const engine = new JevApiEngine({
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  apiKey,
});
void engine;
}

{
// The key is a placeholder. `admit` checks the request and sends nothing.
const engine = new JevApiEngine({
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  apiKey: 'example-key',
});

const identity = await engine.admit({ workspaceMode: 'none' }, new AbortController().signal);
console.log(JSON.stringify(identity, null, 2));
}

{
const judgeSeat = process.env.JUDGE === 'jev' ? jev() : recordedJudge('judge.json');
void judgeSeat;
}
