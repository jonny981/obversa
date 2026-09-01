import { describe, expect, it } from 'vitest';

import type { MemoryPath } from '@obversa/memory';
import { assertMemoryConformance, runMemoryConformance } from '@obversa/memory/testing';
import { createSimpleMemory } from '../src/index.js';

describe('createSimpleMemory', () => {
  it('passes the public memory conformance kit', async () => {
    const report = await runMemoryConformance(createSimpleMemory);

    expect(report).toEqual({
      ok: true,
      cases: 17,
      failures: [],
    });
    await expect(assertMemoryConformance(createSimpleMemory)).resolves.toBeUndefined();
  });

  it('returns exact view and mutation receipts', async () => {
    const memory = createSimpleMemory({ scope: 'receipts' });

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

    await expect(
      memory.execute({
        command: 'view',
        path: '/memories/notes/plan.md',
        viewRange: [2, -1],
      }),
    ).resolves.toEqual({
      ok: true,
      command: 'view',
      value: {
        kind: 'file',
        path: '/memories/notes/plan.md',
        text: 'two\nthree\n',
        byteLength: 10,
        lines: { start: 2, end: 3, total: 3 },
      },
    });

    await expect(
      memory.execute({ command: 'view', path: '/memories' }),
    ).resolves.toEqual({
      ok: true,
      command: 'view',
      value: {
        kind: 'directory',
        path: '/memories',
        entries: [
          {
            name: 'notes',
            path: '/memories/notes',
            kind: 'directory',
          },
        ],
      },
    });
  });

  it('evicts the least-recently-written file without refreshing on view', async () => {
    const memory = createSimpleMemory({
      scope: 'eviction',
      limits: { maxFiles: 2 },
    });

    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'a' });
    await memory.execute({ command: 'create', path: '/memories/b.md', text: 'b' });
    await memory.execute({ command: 'view', path: '/memories/a.md' });

    await expect(
      memory.execute({ command: 'create', path: '/memories/c.md', text: 'c' }),
    ).resolves.toEqual({
      ok: true,
      command: 'create',
      value: {
        path: '/memories/c.md',
        byteLength: 1,
        evicted: ['/memories/a.md'],
        overwritten: false,
      },
    });

    await expect(
      memory.execute({ command: 'view', path: '/memories/a.md' }),
    ).resolves.toMatchObject({
      ok: false,
      command: 'view',
      error: { code: 'NOT_FOUND' },
    });
  });

  it('keeps failed writes atomic', async () => {
    const memory = createSimpleMemory({
      scope: 'atomic',
      limits: { maxFileBytes: 4, maxTotalBytes: 4, maxFiles: 1 },
    });
    await memory.execute({ command: 'create', path: '/memories/a.md', text: 'safe' });

    await expect(
      memory.execute({ command: 'create', path: '/memories/b.md', text: 'unsafe' }),
    ).resolves.toMatchObject({
      ok: false,
      command: 'create',
      error: { code: 'LIMIT_EXCEEDED' },
    });

    await expect(
      memory.execute({ command: 'view', path: '/memories/a.md' }),
    ).resolves.toMatchObject({
      ok: true,
      command: 'view',
      value: { text: 'safe' },
    });
  });

  it('rejects invalid scopes and limits before creating an adapter', () => {
    expect(() => createSimpleMemory({ scope: '' })).toThrow(TypeError);
    expect(() => createSimpleMemory({ scope: '\uD800' })).toThrow(TypeError);
    expect(() => createSimpleMemory({ scope: '\uDC00' })).toThrow(TypeError);
    expect(() => createSimpleMemory({ scope: 'emoji-🧠' })).not.toThrow();
    expect(() => createSimpleMemory({ scope: 'limits', limits: { maxFiles: 0 } })).toThrow(TypeError);
  });

  it('uses the fixed default file, total-byte, and file-count limits', async () => {
    const fileSize = createSimpleMemory({ scope: 'default-file-size' });
    await expect(fileSize.execute({
      command: 'create',
      path: '/memories/large.md',
      text: 'x'.repeat(65_537),
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'LIMIT_EXCEEDED',
        details: { maxFileBytes: 65_536, maxTotalBytes: 1_048_576 },
      },
    });

    const fileCount = createSimpleMemory({ scope: 'default-file-count' });
    for (let index = 0; index < 256; index += 1) {
      await fileCount.execute({
        command: 'create',
        path: `/memories/${String(index).padStart(3, '0')}.md` as MemoryPath,
        text: '',
      });
    }
    await expect(fileCount.execute({
      command: 'create',
      path: '/memories/256.md',
      text: '',
    })).resolves.toMatchObject({
      ok: true,
      value: { evicted: ['/memories/000.md'] },
    });

    const totalBytes = createSimpleMemory({ scope: 'default-total-bytes' });
    for (let index = 0; index < 16; index += 1) {
      await totalBytes.execute({
        command: 'create',
        path: `/memories/${String(index).padStart(2, '0')}.md` as MemoryPath,
        text: 'x'.repeat(65_536),
      });
    }
    await expect(totalBytes.execute({
      command: 'create',
      path: '/memories/16.md',
      text: 'x'.repeat(65_536),
    })).resolves.toMatchObject({
      ok: true,
      value: { evicted: ['/memories/00.md'] },
    });
  });
});
