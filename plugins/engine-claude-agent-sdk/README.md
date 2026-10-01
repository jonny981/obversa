# @obversa/engine-claude-agent-sdk

`@obversa/engine-claude-agent-sdk` runs Obversa engine requests through the Claude
Agent SDK. It uses your own Claude Code login, and it loads the same
settings Claude Code loads (`user`, `project` and `local`), the same as
every other Obversa engine. It adds only what the step needs: the tools the
step may use, and no MCP servers for a step that only reads or has no
workspace.

It is tested with Claude Agent SDK 0.3.241, the version it depends on.

## Requirements

- Node.js 22.12 or later

## Install

```bash
pnpm add @obversa/engine-claude-agent-sdk
```

## Use

```ts
import { AgentSdkEngine } from '@obversa/engine-claude-agent-sdk';

const engine = new AgentSdkEngine({
  defaultModel: 'claude-sonnet-4-5',
});
```

Pass the engine instance to an Obversa runtime. Pass an `@obversa/api` memory
instance in the constructor when the agent needs the memory tool.

## License

[MIT](LICENSE)
