import { afterEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGitWorktreeProvider } from '../src/workspace/git-provider.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'obversa-workspace-scope-'));
  roots.push(root);
  await execa('git', ['init', '-q'], { cwd: root });
  await execa('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'reviewed.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'notes.md'), 'outside scope\n');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-qm', 'initial'], { cwd: root });
  return root;
}

describe('Git workspace scope', () => {
  it('keeps a scoped anchor limited to included paths', async () => {
    const root = await repository();
    const provider = createGitWorktreeProvider({ repositoryPath: root });
    const anchor = await provider.capture(['src/**']);

    expect(anchor.files.map((file) => file.path)).toEqual(['src/reviewed.ts']);

    await writeFile(join(root, 'notes.md'), 'changed outside scope\n');

    expect(await provider.verify(anchor)).toEqual({ ok: true });
  });
});
