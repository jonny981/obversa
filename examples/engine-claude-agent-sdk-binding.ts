import type { Engine } from '@obversa/api';
import { AgentSdkEngine } from '@obversa/engine-claude-agent-sdk';

// The SDK engine has no `admit`: it reports its identity when it runs.
const engine: Engine = new AgentSdkEngine({
  defaultModel: 'claude-sonnet-4-5',
});

console.log(JSON.stringify({
  name: engine.name,
  admits: typeof engine.admit === 'function',
}, null, 2));
