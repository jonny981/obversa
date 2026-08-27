# @obversa/engine-grok-cli

`@obversa/engine-grok-cli` runs one isolated Obversa engine attempt through a
fresh Grok CLI process.

## Requirements

- Node.js 22.12 or later
- Grok CLI 1.0.5
- Host-selected authentication

## Use

```ts
import { GrokCliEngine } from '@obversa/engine-grok-cli';

const engine = new GrokCliEngine({
  executable: '/absolute/path/to/grok',
  version: '1.0.5',
  identity: { provider: 'xai', modelFamily: 'grok-4' },
  permissionMode: 'dontAsk',
});
```
