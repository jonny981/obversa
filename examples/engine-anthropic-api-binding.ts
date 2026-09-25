import { AnthropicApiEngine } from '@obversa/engine-anthropic-api';

// The key is a placeholder. `admit` reads it and sends nothing.
const engine = new AnthropicApiEngine({
  defaultModel: 'claude-haiku-4-5-20251001',
  apiKey: 'example-key',
});

const identity = await engine.admit({ workspaceMode: 'none' }, new AbortController().signal);
console.log(JSON.stringify(identity, null, 2));
