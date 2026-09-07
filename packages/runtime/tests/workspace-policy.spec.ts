import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureWorkspaceEntry,
  inspectWorkspaceExit,
  validateWorkspacePolicy,
  WorkspacePolicyError,
  type NodeWorkspacePolicy,
} from '../src/runtime/workspace-policy.ts';
import { vi } from 'vitest';

// Real work: these tests create temporary Git repositories and write files
// to disk, so this file declares its own time limit; the suite default is a
// hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = [];
const signal = new AbortController().signal;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryDirectory(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), label)));
  roots.push(root);
  return root;
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
  }).trim();
}

function repository(): string {
  const root = temporaryDirectory('lines-workspace-policy-');
  git(root, 'init', '-q');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'allowed.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'notes.md'), 'clean\n');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Test User',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'initial',
  );
  return root;
}

function policy(
  directory: string,
  mode: 'read' | 'write' = 'write',
): NodeWorkspacePolicy {
  return {
    mode,
    directory,
    allowedPaths: mode === 'write' ? ['src/**'] : [],
  };
}

describe('node workspace policy', () => {
  it('requires data-only attempts to have no repository and no write paths', () => {
    expect(validateWorkspacePolicy({
      mode: 'none',
      directory: null,
      allowedPaths: [],
    })).toEqual({
      mode: 'none',
      directory: null,
      allowedPaths: [],
    });

    expect(() => validateWorkspacePolicy({
      mode: 'none',
      directory: '/tmp/repository',
      allowedPaths: [],
    })).toThrow('mode none');
    expect(() => validateWorkspacePolicy({
      mode: 'read',
      directory: '/tmp/repository',
      allowedPaths: ['src/**'],
    })).toThrow('read mode');
    expect(() => validateWorkspacePolicy({
      mode: 'write',
      directory: '/tmp/repository',
      allowedPaths: ['../outside'],
    })).toThrow('allowedPaths');
  });

  it('ignores untouched pre-existing dirt and reports only the attempt delta', async () => {
    const root = repository();
    writeFileSync(join(root, 'notes.md'), 'pre-existing\n');
    const entry = await captureWorkspaceEntry(policy(root), signal);

    writeFileSync(join(root, 'src', 'allowed.ts'), 'export const value = 2;\n');
    writeFileSync(join(root, 'src', 'new.ts'), 'export {};\n');
    const evidence = await inspectWorkspaceExit(policy(root), entry, signal);

    expect(evidence).toMatchObject({
      headChanged: false,
      changedPaths: ['src/allowed.ts', 'src/new.ts'],
      foreignPaths: [],
      filesChanged: 2,
      linesChanged: 3,
    });
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('pre-existing\n');
  });

  it('catches a change to pre-existing dirt and preserves every byte', async () => {
    const root = repository();
    writeFileSync(join(root, 'notes.md'), 'pre-existing\n');
    const entry = await captureWorkspaceEntry(policy(root), signal);

    writeFileSync(join(root, 'src', 'allowed.ts'), 'export const value = 2;\n');
    writeFileSync(join(root, 'notes.md'), 'changed by attempt\n');
    const evidence = await inspectWorkspaceExit(policy(root), entry, signal);

    expect(evidence.changedPaths).toEqual(['notes.md', 'src/allowed.ts']);
    expect(evidence.foreignPaths).toEqual(['notes.md']);
    expect(evidence.filesChanged).toBe(2);
    expect(evidence.linesChanged).toBe(4);
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe(
      'changed by attempt\n',
    );
  });

  it('treats every read-only workspace change as foreign', async () => {
    const root = repository();
    const readOnly = policy(root, 'read');
    const entry = await captureWorkspaceEntry(readOnly, signal);

    writeFileSync(join(root, 'src', 'allowed.ts'), 'export const value = 2;\n');
    const evidence = await inspectWorkspaceExit(readOnly, entry, signal);

    expect(evidence.changedPaths).toEqual(['src/allowed.ts']);
    expect(evidence.foreignPaths).toEqual(['src/allowed.ts']);
  });

  it('reports an empty commit separately from a failed Git inspection', async () => {
    const root = repository();
    const entry = await captureWorkspaceEntry(policy(root), signal);
    git(
      root,
      '-c',
      'user.name=Test User',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'empty',
    );

    const evidence = await inspectWorkspaceExit(policy(root), entry, signal);
    expect(evidence).toMatchObject({
      headChanged: true,
      changedPaths: [],
      foreignPaths: ['@git/HEAD'],
      filesChanged: 0,
      linesChanged: 0,
    });

    const plain = temporaryDirectory('lines-not-git-');
    await expect(captureWorkspaceEntry(policy(plain), signal)).rejects.toEqual(
      expect.objectContaining<Partial<WorkspacePolicyError>>({
        name: 'WorkspacePolicyError',
        code: 'NOT_GIT_REPOSITORY',
      }),
    );
  });
});
