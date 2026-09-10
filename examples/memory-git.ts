import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openGitMemory } from '@obversa/memory-git';

const repositoryPath = await mkdtemp(join(tmpdir(), 'obversa-memory-git-example-'));

try {
  execFileSync('git', ['init', '--quiet', repositoryPath]);
  const memory = await openGitMemory({
    repositoryPath,
    scope: 'memory-git-example',
  });
  await memory.execute({
    command: 'create',
    path: '/memories/notes.md',
    text: 'This note survives a process restart.\n',
  });
  const result = await memory.execute({
    command: 'view',
    path: '/memories/notes.md',
  });

  if (!result.ok || result.command !== 'view' || result.value.kind !== 'file') {
    throw new Error('Git memory could not read its note.');
  }
  console.log(result.value.text);
} finally {
  await rm(repositoryPath, { recursive: true, force: true });
}
