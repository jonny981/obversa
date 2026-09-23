// Compile fixture for the TypeScript snippets in README.md and
// docs/public/packages/engine-jev-api.mdx. tests/doc-snippets.spec.ts reads
// those files and asserts every ```ts fenced block appears here verbatim —
// including the import line — so every public snippet compiles against the
// real exports under the published package specifier.

import { JevApiEngine } from '@obversa/engine-jev-api';

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
