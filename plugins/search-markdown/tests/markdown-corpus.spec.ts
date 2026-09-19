import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { MemoryCommand } from '@obversa/api';
import { afterEach, describe, expect, it } from 'vitest';

import { openMarkdownCorpus } from '../src/index.js';

const temporaryDirectories: string[] = [];

async function corpus(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-search-markdown-'));
  temporaryDirectories.push(directory);
  for (const [path, text] of Object.entries(files)) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, text);
  }
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe('openMarkdownCorpus', () => {
  it('ranks an exact phrase first and reports its source lines', async () => {
    const directory = await corpus({
      'guide.md': [
        '# Battery policy',
        '',
        'The battery warranty lasts eight years.',
        'Keep the purchase receipt.',
        '',
        'Charging guidance is separate.',
        '',
      ].join('\n'),
      'nested/terms.md': [
        '# Warranty terms',
        '',
        'Warranty cover applies when a battery remains installed.',
        '',
      ].join('\n'),
      'repeated.md': 'Battery cover applies. Warranty claims mention the battery again.\n',
      'ignored notes.txt': 'battery warranty',
    });

    const opened = openMarkdownCorpus({ directory });
    const hits = await opened.search('battery warranty', { limit: 3 });

    expect(hits).toHaveLength(3);
    expect(hits[0]).toEqual({
      path: '/memories/guide.md',
      passage: {
        startLine: 3,
        endLine: 4,
        text: 'The battery warranty lasts eight years.\nKeep the purchase receipt.',
      },
      score: expect.any(Number),
    });
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(hits[1]!.score).toBeGreaterThan(hits[2]!.score);
    expect(hits.map((hit) => hit.path)).toEqual([
      '/memories/guide.md',
      '/memories/repeated.md',
      '/memories/nested/terms.md',
    ]);
  });

  it('returns stable path order for tied passages and nothing for a miss', async () => {
    const directory = await corpus({
      'b.md': 'Solar guidance.\n',
      'a.md': 'Solar guidance.\n',
    });

    const opened = openMarkdownCorpus({ directory });

    await expect(opened.search('solar')).resolves.toMatchObject([
      { path: '/memories/a.md', passage: { startLine: 1, endLine: 1 } },
      { path: '/memories/b.md', passage: { startLine: 1, endLine: 1 } },
    ]);
    await expect(opened.search('wind')).resolves.toEqual([]);
    await expect(opened.search('   ')).resolves.toEqual([]);
  });

  it('searches ordinary names through a symlinked root while hiding dot entries', async () => {
    const directory = await corpus({
      '.private/hidden.md': 'Planted searchable phrase.\n',
      'notes with spaces.md': 'Planted searchable phrase.\n',
      'included.md': 'Planted searchable phrase.\n',
    });
    const linkedDirectory = `${directory}-link`;
    await symlink(directory, linkedDirectory, 'dir');
    temporaryDirectories.push(linkedDirectory);

    const expected = [
      { path: '/memories/included.md' },
      { path: '/memories/notes with spaces.md' },
    ];
    const opened = openMarkdownCorpus({ directory });
    const linked = openMarkdownCorpus({ directory: linkedDirectory });

    await expect(opened.search('planted searchable phrase')).resolves.toMatchObject(expected);
    await expect(linked.search('planted searchable phrase')).resolves.toMatchObject(expected);
    for (const corpus of [opened, linked]) {
      await expect(corpus.memory.execute({
        command: 'view',
        path: '/memories/notes with spaces.md',
      })).resolves.toMatchObject({
        ok: true,
        value: {
          path: '/memories/notes with spaces.md',
          text: 'Planted searchable phrase.\n',
        },
      });
    }
    await expect(opened.memory.execute({
      command: 'view',
      path: '/memories/../outside.md',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_PATH' },
    });
  });

  it('exposes only the files selected by search for grounding', async () => {
    const directory = await corpus({
      'selected.md': 'A planted warranty phrase lives here.\n',
      'unselected.md': 'Private notes that must not enter the prompt.\n',
    });
    const opened = openMarkdownCorpus({ directory });
    const hits = await opened.search('planted warranty phrase');
    const paths = [...new Set(hits.map((hit) => hit.path))];
    const selected = await Promise.all(paths.map((path) =>
      opened.memory.execute({ command: 'view', path })));

    expect(paths).toEqual(['/memories/selected.md']);
    expect(selected).toMatchObject([{
      ok: true,
      command: 'view',
      value: {
        kind: 'file',
          path: '/memories/selected.md',
          text: 'A planted warranty phrase lives here.\n',
      },
    }]);
    expect(JSON.stringify(selected)).not.toContain('Private notes');
  });

  it('exposes markdown through a read-only Memory view', async () => {
    const directory = await corpus({
      'nested/guide.md': 'one\ntwo\nthree\n',
    });
    const { memory } = openMarkdownCorpus({ directory });

    await expect(memory.execute({ command: 'view', path: '/memories' })).resolves.toEqual({
      ok: true,
      command: 'view',
      value: {
        kind: 'directory',
        path: '/memories',
        entries: [{
          name: 'nested',
          path: '/memories/nested',
          kind: 'directory',
        }],
      },
    });
    await expect(memory.execute({
      command: 'view',
      path: '/memories/nested/guide.md',
      viewRange: [2, -1],
    })).resolves.toEqual({
      ok: true,
      command: 'view',
      value: {
        kind: 'file',
        path: '/memories/nested/guide.md',
        text: 'two\nthree\n',
        byteLength: 10,
        lines: { start: 2, end: 3, total: 3 },
      },
    });

    const writes = [
      { command: 'create', path: '/memories/new.md', text: 'new' },
      { command: 'str_replace', path: '/memories/nested/guide.md', oldText: 'one', newText: 'changed' },
      { command: 'insert', path: '/memories/nested/guide.md', insertLine: 1, text: 'changed' },
      { command: 'delete', path: '/memories/nested/guide.md' },
      { command: 'rename', oldPath: '/memories/nested/guide.md', newPath: '/memories/moved.md' },
    ] as const satisfies readonly MemoryCommand[];

    for (const command of writes) {
      await expect(memory.execute(command)).resolves.toEqual({
        ok: false,
        command: command.command,
        error: {
          code: 'INVALID_COMMAND',
          message: 'The markdown corpus is read-only.',
        },
      });
    }
  });
});
