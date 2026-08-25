import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemoryPath } from '@obversa/memory';
import { assertMemoryConformance } from '@obversa/memory/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openGitMemory } from '../src/index.js';

const repos: string[] = [];
const temporaryDirectories: string[] = [];
const gitBinary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}

function git(repo: string, args: string[], input?: string): string {
  return execFileSync(gitBinary, ['-C', repo, ...args], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    input,
  }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'obversa-memory-git-'));
  repos.push(repo);
  git(repo, ['init', '--initial-branch=main']);
  git(repo, ['config', 'user.name', 'Memory Test']);
  git(repo, ['config', 'user.email', 'memory-test@example.invalid']);
  writeFileSync(join(repo, 'keep.txt'), 'worktree must stay unchanged\n');
  git(repo, ['add', 'keep.txt']);
  git(repo, ['commit', '-m', 'seed']);
  return repo;
}

function refFor(scope: string): string {
  const digest = createHash('sha256').update(scope).digest('hex');
  return `refs/obversa/memory/v1/${digest}`;
}

function treeEntryOid(repo: string, tree: string, name: string): string {
  const row = git(repo, ['ls-tree', tree, '--', name]);
  const found = /\b([0-9a-f]{40,64})\t/.exec(row);
  if (!found?.[1]) throw new Error(`missing ${name} in ${tree}`);
  return found[1];
}

function hashBlob(repo: string, text: string): string {
  return git(repo, ['hash-object', '-w', '--no-filters', '--stdin'], text);
}

function hashRawBlob(repo: string, value: Buffer): string {
  return execFileSync(gitBinary, ['-C', repo, 'hash-object', '-w', '--no-filters', '--stdin'], {
    encoding: 'utf8',
    env: cleanGitEnvironment(),
    input: value,
  }).trim();
}

function makeTree(repo: string, entries: string[]): string {
  return git(repo, ['mktree', '-z'], entries.length ? `${entries.join('\0')}\0` : '');
}

function makeTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function replaceMetadata(
  repo: string,
  scope: string,
  transform: (metadata: Record<string, unknown>) => Record<string, unknown>,
): { readonly oldTree: string; readonly nextTree: string } {
  const ref = refFor(scope);
  const oldTree = git(repo, ['rev-parse', ref]);
  const metadata = treeEntryOid(repo, oldTree, '.obversa-memory.json');
  const memories = treeEntryOid(repo, oldTree, 'memories');
  const current = JSON.parse(git(repo, ['cat-file', 'blob', metadata])) as Record<string, unknown>;
  const nextMetadata = hashBlob(repo, JSON.stringify(transform(current)));
  const nextTree = makeTree(repo, [
    `100644 blob ${nextMetadata}\t.obversa-memory.json`,
    `040000 tree ${memories}\tmemories`,
  ]);
  git(repo, ['update-ref', ref, nextTree, oldTree]);
  return { oldTree, nextTree };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('openGitMemory', () => {
  it('passes the public memory conformance kit', async () => {
    const repo = makeRepo();

    await expect(
      assertMemoryConformance(({ scope, limits }) => openGitMemory({
        repositoryPath: repo,
        scope,
        limits,
      })),
    ).resolves.toBeUndefined();
  }, 20_000);

  it('rejects lone-surrogate scopes without rejecting emoji scopes', async () => {
    const repo = makeRepo();

    await expect(openGitMemory({ repositoryPath: repo, scope: '\uD800' })).rejects.toThrow(TypeError);
    await expect(openGitMemory({ repositoryPath: repo, scope: '\uDC00' })).rejects.toThrow(TypeError);
    await expect(openGitMemory({ repositoryPath: repo, scope: 'emoji-🧠' })).resolves.toMatchObject({
      scope: 'emoji-🧠',
    });
  });

  it('survives reopen without changing HEAD, index, or worktree', async () => {
    const repo = makeRepo();
    const before = {
      head: git(repo, ['rev-parse', 'HEAD']),
      index: git(repo, ['ls-files', '--stage']),
      status: git(repo, ['status', '--porcelain=v1']),
      worktree: readFileSync(join(repo, 'keep.txt'), 'utf8'),
    };

    const memory = await openGitMemory({ repositoryPath: repo, scope: 'durable' });
    await expect(
      memory.execute({
        command: 'create',
        path: '/memories/notes/plan.md',
        text: 'one\ntwo\nthree\n',
      }),
    ).resolves.toEqual({
      ok: true,
      command: 'create',
      value: {
        path: '/memories/notes/plan.md',
        byteLength: 14,
        evicted: [],
        overwritten: false,
      },
    });

    const reopened = await openGitMemory({ repositoryPath: repo, scope: 'durable' });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/notes/plan.md' }),
    ).resolves.toMatchObject({
      ok: true,
      command: 'view',
      value: { kind: 'file', text: 'one\ntwo\nthree\n' },
    });

    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before.head);
    expect(git(repo, ['ls-files', '--stage'])).toBe(before.index);
    expect(git(repo, ['status', '--porcelain=v1'])).toBe(before.status);
    expect(readFileSync(join(repo, 'keep.txt'), 'utf8')).toBe(before.worktree);
    expect(git(repo, ['cat-file', '-t', refFor('durable')])).toBe('tree');
  });

  it('clears inherited Git repository variables', async () => {
    const repo = makeRepo();
    const poison = makeRepo();
    vi.stubEnv('GIT_DIR', join(poison, '.git'));
    vi.stubEnv('GIT_WORK_TREE', poison);
    vi.stubEnv('GIT_INDEX_FILE', join(poison, '.git', 'index.poison'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.hooksPath');
    vi.stubEnv('GIT_CONFIG_VALUE_0', join(poison, 'hooks'));

    const memory = await openGitMemory({ repositoryPath: repo, scope: 'clean-environment' });
    await expect(
      memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' }),
    ).resolves.toMatchObject({ ok: true });

    vi.unstubAllEnvs();
    expect(git(repo, ['cat-file', '-t', refFor('clean-environment')])).toBe('tree');
  });

  it('disables lazy object fetches for every Git command', async () => {
    const repo = makeRepo();
    const wrapperDirectory = makeTemporaryDirectory('obversa-memory-git-wrapper-');
    const wrapper = join(wrapperDirectory, 'git');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      'if [ "${GIT_NO_LAZY_FETCH:-}" != 1 ]; then',
      "  printf 'lazy fetch guard is missing\\n' >&2",
      '  exit 97',
      'fi',
      'exec "$OBVERSA_MEMORY_GIT_REAL_GIT" "$@"',
      '',
    ].join('\n'));
    chmodSync(wrapper, 0o755);
    vi.stubEnv('PATH', `${wrapperDirectory}:${process.env.PATH ?? ''}`);
    vi.stubEnv('OBVERSA_MEMORY_GIT_REAL_GIT', gitBinary);

    const memory = await openGitMemory({ repositoryPath: repo, scope: 'no-lazy-fetch' });
    await expect(
      memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('does not run repository reference hooks', async () => {
    const repo = makeRepo();
    const marker = join(repo, 'reference-hook-ran');
    const hook = join(repo, '.git', 'hooks', 'reference-transaction');
    writeFileSync(hook, `#!/bin/sh\nprintf hook > '${marker}'\n`);
    chmodSync(hook, 0o755);

    const memory = await openGitMemory({ repositoryPath: repo, scope: 'hooks' });
    await expect(
      memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' }),
    ).resolves.toMatchObject({ ok: true });
    expect(existsSync(marker)).toBe(false);
  });

  it('persists deterministic least-recently-written eviction metadata', async () => {
    const repo = makeRepo();
    const memory = await openGitMemory({
      repositoryPath: repo,
      scope: 'eviction',
      limits: { maxFiles: 2 },
    });

    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'a' });
    await memory.execute({ command: 'create', path: '/memories/b.md', text: 'b' });
    await memory.execute({ command: 'view', path: '/memories/a.md' });

    await expect(
      memory.execute({ command: 'create', path: '/memories/c.md', text: 'c' }),
    ).resolves.toMatchObject({
      ok: true,
      command: 'create',
      value: { evicted: ['/memories/a.md'] },
    });

    const reopened = await openGitMemory({
      repositoryPath: repo,
      scope: 'eviction',
      limits: { maxFiles: 2 },
    });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/a.md' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/b.md' }),
    ).resolves.toMatchObject({ ok: true, value: { text: 'b' } });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/c.md' }),
    ).resolves.toMatchObject({ ok: true, value: { text: 'c' } });
  });

  it('uses persisted recency for the next eviction after reopening', async () => {
    const repo = makeRepo();
    const options = {
      repositoryPath: repo,
      scope: 'next-eviction',
      limits: { maxFiles: 2 },
    };
    const initial = await openGitMemory(options);
    await initial.execute({ command: 'create', path: '/memories/a.md', text: 'a' });
    await initial.execute({ command: 'create', path: '/memories/b.md', text: 'b' });

    const firstReopen = await openGitMemory(options);
    await expect(
      firstReopen.execute({ command: 'create', path: '/memories/c.md', text: 'c' }),
    ).resolves.toMatchObject({ ok: true, value: { evicted: ['/memories/a.md'] } });

    const secondReopen = await openGitMemory(options);
    await expect(
      secondReopen.execute({ command: 'create', path: '/memories/d.md', text: 'd' }),
    ).resolves.toMatchObject({ ok: true, value: { evicted: ['/memories/b.md'] } });
  });

  it('does not publish an over-limit write', async () => {
    const repo = makeRepo();
    const options = {
      repositoryPath: repo,
      scope: 'atomic-limit',
      limits: { maxFileBytes: 4, maxTotalBytes: 4, maxFiles: 1 },
    };
    const memory = await openGitMemory(options);
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });
    const ref = refFor('atomic-limit');
    const before = git(repo, ['rev-parse', ref]);

    await expect(
      memory.execute({ command: 'create', path: '/memories/b.md', text: 'large' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'LIMIT_EXCEEDED' } });
    expect(git(repo, ['rev-parse', ref])).toBe(before);

    const reopened = await openGitMemory(options);
    await expect(
      reopened.execute({ command: 'view', path: '/memories/a.md' }),
    ).resolves.toMatchObject({ ok: true, value: { text: 'safe' } });
  });

  it('checks the current limits before reading stored files', async () => {
    const repo = makeRepo();
    const writer = await openGitMemory({
      repositoryPath: repo,
      scope: 'current-limits',
      limits: { maxFileBytes: 8, maxTotalBytes: 8, maxFiles: 1 },
    });
    await writer.execute({ command: 'create', path: '/memories/a.md', text: '12345' });

    const restricted = await openGitMemory({
      repositoryPath: repo,
      scope: 'current-limits',
      limits: { maxFileBytes: 4, maxTotalBytes: 4, maxFiles: 1 },
    });
    await expect(
      restricted.execute({ command: 'view', path: '/memories' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNSAFE_STORAGE' } });
  });

  it('rejects a symlink stored in its private tree', async () => {
    const repo = makeRepo();
    const scope = 'poison';
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });

    const ref = refFor(scope);
    const oldTree = git(repo, ['rev-parse', ref]);
    const metadata = treeEntryOid(repo, oldTree, '.obversa-memory.json');
    const link = hashBlob(repo, '../outside.md');
    const memories = makeTree(repo, [`120000 blob ${link}\tevil.md`]);
    const poisoned = makeTree(repo, [
      `100644 blob ${metadata}\t.obversa-memory.json`,
      `040000 tree ${memories}\tmemories`,
    ]);
    git(repo, ['update-ref', ref, poisoned, oldTree]);

    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories' }),
    ).resolves.toMatchObject({
      ok: false,
      command: 'view',
      error: { code: 'UNSAFE_STORAGE' },
    });
  });

  it('rejects a non-blob stored in its private tree', async () => {
    const repo = makeRepo();
    const scope = 'non-blob-poison';
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });

    const ref = refFor(scope);
    const oldTree = git(repo, ['rev-parse', ref]);
    const metadata = treeEntryOid(repo, oldTree, '.obversa-memory.json');
    const commit = git(repo, ['rev-parse', 'HEAD']);
    const memories = makeTree(repo, [`160000 commit ${commit}\tevil.md`]);
    const poisoned = makeTree(repo, [
      `100644 blob ${metadata}\t.obversa-memory.json`,
      `040000 tree ${memories}\tmemories`,
    ]);
    git(repo, ['update-ref', ref, poisoned, oldTree]);

    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories' }),
    ).resolves.toMatchObject({
      ok: false,
      command: 'view',
      error: { code: 'UNSAFE_STORAGE' },
    });
  });

  it('rejects invalid UTF-8 stored in a private blob', async () => {
    const repo = makeRepo();
    const scope = 'invalid-utf8';
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });

    const ref = refFor(scope);
    const oldTree = git(repo, ['rev-parse', ref]);
    const metadata = treeEntryOid(repo, oldTree, '.obversa-memory.json');
    const invalidText = hashRawBlob(repo, Buffer.from([0xf0, 0x28, 0x8c, 0xbc]));
    const memories = makeTree(repo, [`100644 blob ${invalidText}\ta.md`]);
    const poisoned = makeTree(repo, [
      `100644 blob ${metadata}\t.obversa-memory.json`,
      `040000 tree ${memories}\tmemories`,
    ]);
    git(repo, ['update-ref', ref, poisoned, oldTree]);

    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/a.md' }),
    ).resolves.toMatchObject({
      ok: false,
      command: 'view',
      error: { code: 'UNSAFE_STORAGE' },
    });
  });

  it('rejects an empty directory hidden below a valid private tree', async () => {
    const repo = makeRepo();
    const scope = 'empty-directory-poison';
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({
      command: 'create',
      path: '/memories/branch/a.md',
      text: 'safe',
    });

    const ref = refFor(scope);
    const oldTree = git(repo, ['rev-parse', ref]);
    const metadata = treeEntryOid(repo, oldTree, '.obversa-memory.json');
    const oldMemories = treeEntryOid(repo, oldTree, 'memories');
    const oldBranch = treeEntryOid(repo, oldMemories, 'branch');
    const file = treeEntryOid(repo, oldBranch, 'a.md');
    const empty = makeTree(repo, []);
    const hidden = makeTree(repo, [`040000 tree ${empty}\tdeeper`]);
    const branch = makeTree(repo, [
      `100644 blob ${file}\ta.md`,
      `040000 tree ${hidden}\thidden`,
    ]);
    const memories = makeTree(repo, [`040000 tree ${branch}\tbranch`]);
    const poisoned = makeTree(repo, [
      `100644 blob ${metadata}\t.obversa-memory.json`,
      `040000 tree ${memories}\tmemories`,
    ]);
    git(repo, ['update-ref', ref, poisoned, oldTree]);

    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories' }),
    ).resolves.toMatchObject({
      ok: false,
      command: 'view',
      error: { code: 'UNSAFE_STORAGE' },
    });
  });

  it('reopens one valid file below many directories', async () => {
    const repo = makeRepo();
    const options = {
      repositoryPath: repo,
      scope: 'deep-path',
      limits: { maxFiles: 1 },
    };
    const path = `/memories/${Array.from({ length: 100 }, () => 'a').join('/')}/note.md` as MemoryPath;
    const memory = await openGitMemory(options);

    await expect(memory.execute({
      command: 'create',
      path,
      text: 'safe',
    })).resolves.toMatchObject({ ok: true });

    const reopened = await openGitMemory(options);
    await expect(reopened.execute({ command: 'view', path })).resolves.toMatchObject({
      ok: true,
      value: { kind: 'file', text: 'safe' },
    });
  });

  it('rejects a symbolic private ref even when it resolves to a tree', async () => {
    const repo = makeRepo();
    const scope = 'symbolic-ref';
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });

    const ref = refFor(scope);
    const tree = git(repo, ['rev-parse', ref]);
    const target = 'refs/obversa/memory-git-test-target';
    git(repo, ['update-ref', target, tree]);
    git(repo, ['symbolic-ref', ref, target]);

    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNSAFE_STORAGE' } });
  });

  it('rejects oversized metadata before accepting a private tree', async () => {
    const repo = makeRepo();
    const scope = 'metadata-bound';
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });
    replaceMetadata(repo, scope, (metadata) => ({
      ...metadata,
      padding: 'x'.repeat(512 * 1024),
    }));

    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'UNSAFE_STORAGE' } });
  });

  it('does not advance an exhausted persisted write clock', async () => {
    const repo = makeRepo();
    const scope = 'write-clock';
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });
    const { nextTree } = replaceMetadata(repo, scope, (metadata) => ({
      ...metadata,
      nextWrite: Number.MAX_SAFE_INTEGER,
    }));

    await expect(
      memory.execute({ command: 'create', path: '/memories/b.md', text: 'next' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
    expect(git(repo, ['rev-parse', refFor(scope)])).toBe(nextTree);

    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/a.md' }),
    ).resolves.toMatchObject({ ok: true, value: { text: 'safe' } });
  });

  it('retries a stale compare-and-swap after an unrecognised Git failure', async () => {
    const repo = makeRepo();
    const scope = 'forced-stale-cas';
    const ref = refFor(scope);
    const memory = await openGitMemory({ repositoryPath: repo, scope });
    await memory.execute({ command: 'create', path: '/memories/base.md', text: 'base' });
    const baseTree = git(repo, ['rev-parse', ref]);

    const racer = await openGitMemory({ repositoryPath: repo, scope });
    await racer.execute({ command: 'create', path: '/memories/raced.md', text: 'raced' });
    const racedTree = git(repo, ['rev-parse', ref]);
    git(repo, ['update-ref', ref, baseTree, racedTree]);

    const wrapperDirectory = makeTemporaryDirectory('obversa-memory-git-wrapper-');
    const marker = join(wrapperDirectory, 'raced');
    const wrapper = join(wrapperDirectory, 'git');
    writeFileSync(wrapper, [
      '#!/bin/sh',
      'for argument in "$@"; do',
      '  if [ "$argument" = update-ref ] && [ ! -e "$OBVERSA_MEMORY_GIT_RACE_MARKER" ]; then',
      '    : > "$OBVERSA_MEMORY_GIT_RACE_MARKER"',
      '    "$OBVERSA_MEMORY_GIT_REAL_GIT" -C "$OBVERSA_MEMORY_GIT_RACE_REPOSITORY" update-ref "$OBVERSA_MEMORY_GIT_RACE_REF" "$OBVERSA_MEMORY_GIT_RACE_TREE"',
      "    printf 'unrecognised update-ref failure\\n' >&2",
      '    exit 1',
      '  fi',
      'done',
      'exec "$OBVERSA_MEMORY_GIT_REAL_GIT" "$@"',
      '',
    ].join('\n'));
    chmodSync(wrapper, 0o755);
    vi.stubEnv('PATH', `${wrapperDirectory}:${process.env.PATH ?? ''}`);
    vi.stubEnv('OBVERSA_MEMORY_GIT_RACE_MARKER', marker);
    vi.stubEnv('OBVERSA_MEMORY_GIT_REAL_GIT', gitBinary);
    vi.stubEnv('OBVERSA_MEMORY_GIT_RACE_REPOSITORY', repo);
    vi.stubEnv('OBVERSA_MEMORY_GIT_RACE_REF', ref);
    vi.stubEnv('OBVERSA_MEMORY_GIT_RACE_TREE', racedTree);

    await expect(
      memory.execute({ command: 'create', path: '/memories/wanted.md', text: 'wanted' }),
    ).resolves.toMatchObject({ ok: true });

    vi.unstubAllEnvs();
    expect(existsSync(marker)).toBe(true);
    const reopened = await openGitMemory({ repositoryPath: repo, scope });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/raced.md' }),
    ).resolves.toMatchObject({ ok: true, value: { text: 'raced' } });
    await expect(
      reopened.execute({ command: 'view', path: '/memories/wanted.md' }),
    ).resolves.toMatchObject({ ok: true, value: { text: 'wanted' } });
  });

  it('keeps concurrent accepted writes', async () => {
    const repo = makeRepo();
    const left = await openGitMemory({ repositoryPath: repo, scope: 'race' });
    const right = await openGitMemory({ repositoryPath: repo, scope: 'race' });
    const writes = Array.from({ length: 8 }, (_, index) => {
      const memory = index % 2 === 0 ? left : right;
      return memory.execute({
        command: 'create',
        path: `/memories/${index}.md`,
        text: String(index),
      });
    });

    const results = await Promise.all(writes);
    expect(results.every((result) => result.ok)).toBe(true);

    const reopened = await openGitMemory({ repositoryPath: repo, scope: 'race' });
    await expect(
      reopened.execute({ command: 'view', path: '/memories' }),
    ).resolves.toMatchObject({
      ok: true,
      value: { kind: 'directory', entries: expect.any(Array) },
    });
    const directory = await reopened.execute({ command: 'view', path: '/memories' });
    if (!directory.ok || directory.command !== 'view' || directory.value.kind !== 'directory') {
      throw new Error('The race scope did not reopen as a directory.');
    }
    expect(directory.value.entries).toHaveLength(8);
  });
});
