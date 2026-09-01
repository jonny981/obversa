# @obversa/memory-git

`@obversa/memory-git` stores memory in private Git references. The adapter
does not change the current branch, the index, or the worktree.

## Requirements

- Node.js 22.12 or later
- Git

## Build from the workspace

From the workspace root, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @obversa/memory-git build
```

## Usage

```ts
import { openGitMemory } from '@obversa/memory-git';

const memory = await openGitMemory({
  repositoryPath: process.cwd(),
  scope: 'example-run',
});

await memory.execute({
  command: 'create',
  path: '/memories/notes.md',
  text: 'Keep the result small.\n',
});
```

Each scope gets one private reference below `refs/obversa/memory/v1`. The
reference points to a tree and does not add a commit to the project history.

## Runnable example

The example creates and removes a temporary Git repository:

```bash
pnpm --filter @obversa/memory-git exec tsx ../../examples/packages/memory-git.ts
```

## License

[MIT](LICENSE)
