# @obversa/engine-agent-sdk

`@obversa/engine-agent-sdk` runs Obversa engine requests through the Claude
Agent SDK. It uses the host's Claude Code authentication.

## Requirements

- Node.js 22.12 or later

## Use

```ts
import { AgentSdkEngine } from '@obversa/engine-agent-sdk';

const engine = new AgentSdkEngine({
  defaultModel: 'claude-sonnet-4-5',
});
```

Pass the engine instance to an Obversa runtime. Pass an `@obversa/memory`
instance in the constructor when the agent needs the memory tool.

## License

[MIT](LICENSE)
