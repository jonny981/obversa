import { JevApiEngine } from '@obversa/engine-jev-api';

// The key is a placeholder. `admit` checks the request and sends nothing.
const engine = new JevApiEngine({
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  apiKey: 'example-key',
});

const identity = await engine.admit({ workspaceMode: 'none' }, new AbortController().signal);
console.log(JSON.stringify(identity, null, 2));
