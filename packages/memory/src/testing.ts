import { isDeepStrictEqual } from 'node:util';

import type {
  Memory,
  MemoryCommand,
  MemoryErrorCode,
  MemoryLimits,
  MemoryPath,
  MemoryResult,
  MemorySuccess,
} from './index.js';

export interface MemoryConformanceOptions {
  readonly scope: string;
  readonly limits?: Partial<MemoryLimits>;
}

export type MemoryConformanceFactory = (
  options: MemoryConformanceOptions,
) => Memory | Promise<Memory>;

export interface MemoryConformanceFailure {
  readonly case: string;
  readonly message: string;
}

export interface MemoryConformanceReport {
  readonly ok: boolean;
  readonly cases: number;
  readonly failures: readonly MemoryConformanceFailure[];
}

interface ConformanceCase {
  readonly name: string;
  run(factory: MemoryConformanceFactory, scope: string): Promise<void>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, message: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${message} Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

async function success(
  memory: Memory,
  command: MemoryCommand,
): Promise<MemorySuccess> {
  const result = await memory.execute(command);
  if (!result.ok) {
    throw new Error(`Expected ${command.command} to succeed, received ${result.error.code}.`);
  }
  return result;
}

async function failure(
  memory: Memory,
  command: MemoryCommand,
  code: MemoryErrorCode,
): Promise<Extract<MemoryResult, { ok: false }>> {
  const result = await memory.execute(command);
  if (result.ok) throw new Error(`Expected ${command.command} to fail with ${code}.`);
  if (result.error.code !== code) {
    throw new Error(`Expected ${code}, received ${result.error.code}.`);
  }
  return result;
}

const cases: readonly ConformanceCase[] = [
  {
    name: 'empty root view',
    async run(factory, scope) {
      const result = await success(await factory({ scope }), {
        command: 'view',
        path: '/memories',
      });
      same(result, {
        ok: true,
        command: 'view',
        value: { kind: 'directory', path: '/memories', entries: [] },
      }, 'The empty root view was not stable.');
    },
  },
  {
    name: 'create, overwrite, and ranged view',
    async run(factory, scope) {
      const memory = await factory({ scope });
      const created = await success(memory, {
        command: 'create',
        path: '/memories/notes/plan.md',
        text: 'first\nsecond\nthird\n',
      });
      check(created.command === 'create', 'Create returned the wrong receipt.');
      check(created.value.overwritten === false, 'First create reported an overwrite.');

      const viewed = await success(memory, {
        command: 'view',
        path: '/memories/notes/plan.md',
        viewRange: [2, -1],
      });
      check(viewed.command === 'view' && viewed.value.kind === 'file', 'File view returned the wrong result.');
      same(viewed.value.lines, { start: 2, end: 3, total: 3 }, 'The line range was wrong.');
      check(viewed.value.text === 'second\nthird\n', 'The ranged text was wrong.');

      const overwritten = await success(memory, {
        command: 'create',
        path: '/memories/notes/plan.md',
        text: 'new',
      });
      check(overwritten.command === 'create' && overwritten.value.overwritten, 'Create did not overwrite.');
    },
  },
  {
    name: 'sorted immediate directory entries',
    async run(factory, scope) {
      const memory = await factory({ scope });
      await success(memory, { command: 'create', path: '/memories/z.md', text: 'z' });
      await success(memory, { command: 'create', path: '/memories/a/file.txt', text: 'a' });
      await success(memory, { command: 'create', path: '/memories/b.json', text: '{}' });
      const viewed = await success(memory, { command: 'view', path: '/memories' });
      check(viewed.command === 'view' && viewed.value.kind === 'directory', 'Root was not a directory.');
      same(viewed.value.entries, [
        { name: 'a', path: '/memories/a', kind: 'directory' },
        { name: 'b.json', path: '/memories/b.json', kind: 'file' },
        { name: 'z.md', path: '/memories/z.md', kind: 'file' },
      ], 'Directory entries were not immediate and sorted.');
    },
  },
  {
    name: 'unique string replacement',
    async run(factory, scope) {
      const memory = await factory({ scope });
      await success(memory, { command: 'create', path: '/memories/a.md', text: 'one two' });
      await success(memory, {
        command: 'str_replace',
        path: '/memories/a.md',
        oldText: 'one',
        newText: 'three',
      });
      await failure(memory, {
        command: 'str_replace',
        path: '/memories/a.md',
        oldText: 'missing',
        newText: 'x',
      }, 'MATCH_NOT_FOUND');
      await success(memory, { command: 'create', path: '/memories/a.md', text: 'x x' });
      await failure(memory, {
        command: 'str_replace',
        path: '/memories/a.md',
        oldText: 'x',
        newText: 'y',
      }, 'MATCH_NOT_UNIQUE');
      await failure(memory, {
        command: 'str_replace',
        path: '/memories/a.md',
        oldText: '',
        newText: 'y',
      }, 'INVALID_ARGUMENT');
    },
  },
  {
    name: 'consistent ranged view and zero-based insertion lines',
    async run(factory, scope) {
      const memory = await factory({ scope });
      const original = 'a\r\nc\rd\r\n';
      await success(memory, { command: 'create', path: '/memories/a.md', text: original });

      const fullView = await success(memory, { command: 'view', path: '/memories/a.md' });
      check(fullView.command === 'view' && fullView.value.kind === 'file', 'Full file could not be viewed.');
      check(fullView.value.text === original, 'A full view changed the stored line endings.');

      const rangedView = await success(memory, {
        command: 'view',
        path: '/memories/a.md',
        viewRange: [2, 2],
      });
      check(rangedView.command === 'view' && rangedView.value.kind === 'file', 'Line range could not be viewed.');
      same(rangedView.value.lines, { start: 2, end: 2, total: 3 }, 'The ranged view used different line numbers from insert.');
      check(rangedView.value.text === 'c\n', 'The ranged view did not return the selected logical line.');

      await success(memory, {
        command: 'insert',
        path: '/memories/a.md',
        insertLine: 2,
        text: 'b',
      });
      const viewed = await success(memory, { command: 'view', path: '/memories/a.md' });
      check(viewed.command === 'view' && viewed.value.kind === 'file', 'Inserted file could not be viewed.');
      check(viewed.value.text === 'a\nc\nb\nd\n', 'Insert did not use the ranged view line numbers.');
      await failure(memory, {
        command: 'insert',
        path: '/memories/a.md',
        insertLine: 5,
        text: 'e',
      }, 'INVALID_RANGE');
    },
  },
  {
    name: 'recursive delete and protected root',
    async run(factory, scope) {
      const memory = await factory({ scope });
      await success(memory, { command: 'create', path: '/memories/a/one.md', text: '1' });
      await success(memory, { command: 'create', path: '/memories/a/two.md', text: '22' });
      const deleted = await success(memory, { command: 'delete', path: '/memories/a' });
      same(deleted, {
        ok: true,
        command: 'delete',
        value: {
          path: '/memories/a',
          kind: 'directory',
          deletedFiles: 2,
          freedBytes: 3,
        },
      }, 'Directory deletion returned the wrong receipt.');
      await failure(memory, { command: 'delete', path: '/memories' }, 'ROOT_PROTECTED');
    },
  },
  {
    name: 'file and directory rename without overwrite',
    async run(factory, scope) {
      const memory = await factory({ scope });
      await success(memory, { command: 'create', path: '/memories/a/one.md', text: '1' });
      const renamed = await success(memory, {
        command: 'rename',
        oldPath: '/memories/a',
        newPath: '/memories/b',
      });
      check(renamed.command === 'rename' && renamed.value.kind === 'directory', 'Directory rename failed.');
      check(renamed.value.movedFiles === 1, 'Directory rename moved the wrong file count.');
      await success(memory, { command: 'create', path: '/memories/c.md', text: 'c' });
      await failure(memory, {
        command: 'rename',
        oldPath: '/memories/b/one.md',
        newPath: '/memories/c.md',
      }, 'ALREADY_EXISTS');
      await failure(memory, {
        command: 'rename',
        oldPath: '/memories',
        newPath: '/memories/root',
      }, 'ROOT_PROTECTED');
    },
  },
  {
    name: 'path and extension safety',
    async run(factory, scope) {
      const memory = await factory({ scope });
      await failure(memory, {
        command: 'create',
        path: '/memories/../escape.md',
        text: 'x',
      }, 'INVALID_PATH');
      await failure(memory, {
        command: 'create',
        path: '/memories/a%2Fescape.md',
        text: 'x',
      }, 'INVALID_PATH');
      await failure(memory, {
        command: 'create',
        path: '/memories/code.ts',
        text: 'x',
      }, 'INVALID_EXTENSION');
      await success(memory, {
        command: 'create',
        path: '/memories/note.md',
        text: 'x',
      });
      await failure(memory, {
        command: 'rename',
        oldPath: '/memories/note.md',
        newPath: '/memories/code.ts',
      }, 'INVALID_EXTENSION');
      await failure(memory, {
        command: 'create',
        path: '/memories',
        text: 'x',
      }, 'ROOT_PROTECTED');
    },
  },
  {
    name: 'path conflict safety',
    async run(factory, scope) {
      const memory = await factory({ scope });
      await success(memory, { command: 'create', path: '/memories/file.md', text: 'x' });
      await failure(memory, {
        command: 'create',
        path: '/memories/file.md/child.txt',
        text: 'y',
      }, 'PATH_CONFLICT');
      await success(memory, { command: 'create', path: '/memories/dir/child.md', text: 'y' });
      await failure(memory, {
        command: 'create',
        path: '/memories/dir',
        text: 'z',
      }, 'INVALID_EXTENSION');
    },
  },
  {
    name: 'invalid line ranges',
    async run(factory, scope) {
      const memory = await factory({ scope });
      await success(memory, { command: 'create', path: '/memories/a.md', text: 'one\ntwo' });
      await failure(memory, {
        command: 'view',
        path: '/memories/a.md',
        viewRange: [0, 1],
      }, 'INVALID_RANGE');
      await failure(memory, {
        command: 'view',
        path: '/memories/a.md',
        viewRange: [1, 3],
      }, 'INVALID_RANGE');
    },
  },
  {
    name: 'deterministic least-recently-written eviction',
    async run(factory, scope) {
      const memory = await factory({ scope, limits: { maxFiles: 2 } });
      await success(memory, { command: 'create', path: '/memories/a.md', text: 'a' });
      await success(memory, { command: 'create', path: '/memories/b.md', text: 'b' });
      await success(memory, { command: 'view', path: '/memories/a.md' });
      const created = await success(memory, { command: 'create', path: '/memories/c.md', text: 'c' });
      check(created.command === 'create', 'Create returned the wrong receipt.');
      same(created.value.evicted, ['/memories/a.md'], 'View changed eviction recency.');
      await failure(memory, { command: 'view', path: '/memories/a.md' }, 'NOT_FOUND');

      const overwritten = await factory({ scope: `${scope}-overwrite`, limits: { maxFiles: 2 } });
      await success(overwritten, { command: 'create', path: '/memories/a.md', text: 'a' });
      await success(overwritten, { command: 'create', path: '/memories/b.md', text: 'b' });
      await success(overwritten, { command: 'create', path: '/memories/a.md', text: 'new' });
      const afterOverwrite = await success(overwritten, {
        command: 'create',
        path: '/memories/c.md',
        text: 'c',
      });
      check(afterOverwrite.command === 'create', 'Create returned the wrong receipt.');
      same(afterOverwrite.value.evicted, ['/memories/b.md'], 'Overwrite did not refresh write recency.');

      const renamed = await factory({ scope: `${scope}-rename`, limits: { maxFiles: 2 } });
      await success(renamed, { command: 'create', path: '/memories/a.md', text: 'a' });
      await success(renamed, { command: 'create', path: '/memories/b.md', text: 'b' });
      await success(renamed, {
        command: 'rename',
        oldPath: '/memories/a.md',
        newPath: '/memories/renamed.md',
      });
      const afterRename = await success(renamed, {
        command: 'create',
        path: '/memories/c.md',
        text: 'c',
      });
      check(afterRename.command === 'create', 'Create returned the wrong receipt.');
      same(afterRename.value.evicted, ['/memories/renamed.md'], 'Rename changed write recency.');
    },
  },
  {
    name: 'total-byte eviction',
    async run(factory, scope) {
      const memory = await factory({
        scope,
        limits: { maxFileBytes: 4, maxTotalBytes: 4, maxFiles: 3 },
      });
      await success(memory, { command: 'create', path: '/memories/a.md', text: 'aa' });
      await success(memory, { command: 'create', path: '/memories/b.md', text: 'bb' });
      const created = await success(memory, { command: 'create', path: '/memories/c.md', text: 'cc' });
      check(created.command === 'create', 'Create returned the wrong receipt.');
      same(created.value.evicted, ['/memories/a.md'], 'Total-byte eviction chose the wrong file.');
    },
  },
  {
    name: 'limit failure is atomic and never evicts the target',
    async run(factory, scope) {
      const memory = await factory({
        scope,
        limits: { maxFileBytes: 4, maxTotalBytes: 4, maxFiles: 1 },
      });
      await success(memory, { command: 'create', path: '/memories/a.md', text: 'safe' });
      await failure(memory, { command: 'create', path: '/memories/b.md', text: 'large' }, 'LIMIT_EXCEEDED');
      const viewed = await success(memory, { command: 'view', path: '/memories/a.md' });
      check(viewed.command === 'view' && viewed.value.kind === 'file', 'Atomic failure removed the old file.');
      check(viewed.value.text === 'safe', 'Atomic failure changed the old file.');
    },
  },
  {
    name: 'scope isolation',
    async run(factory, scope) {
      const first = await factory({ scope: `${scope}-first` });
      const second = await factory({ scope: `${scope}-second` });
      await success(first, { command: 'create', path: '/memories/a.md', text: 'private' });
      await failure(second, { command: 'view', path: '/memories/a.md' }, 'NOT_FOUND');
    },
  },
  {
    name: 'rename validates every moved path atomically',
    async run(factory, scope) {
      const memory = await factory({ scope });
      const segment = 's'.repeat(128);
      const fileName = `${'f'.repeat(125)}.md`;
      const sourcePath = `/memories/a/${[segment, segment, segment, segment, segment, segment, fileName].join('/')}` as MemoryPath;
      const destination = `/memories/${'b'.repeat(128)}` as MemoryPath;
      await success(memory, { command: 'create', path: sourcePath, text: 'safe' });
      await failure(memory, {
        command: 'rename',
        oldPath: '/memories/a',
        newPath: destination,
      }, 'INVALID_PATH');
      await success(memory, { command: 'view', path: sourcePath });
    },
  },
  {
    name: 'UTF-8 byte limits',
    async run(factory, scope) {
      const memory = await factory({ scope, limits: { maxFileBytes: 4 } });
      const created = await success(memory, { command: 'create', path: '/memories/a.md', text: '££' });
      check(created.command === 'create' && created.value.byteLength === 4, 'Byte length was not UTF-8.');
      await failure(memory, { command: 'create', path: '/memories/b.md', text: '£££' }, 'LIMIT_EXCEEDED');

      const emoji = await success(memory, {
        command: 'create',
        path: '/memories/emoji.md',
        text: '🧠',
      });
      check(emoji.command === 'create' && emoji.value.byteLength === 4, 'A valid surrogate pair was rejected.');
      await failure(memory, {
        command: 'create',
        path: '/memories/high.md',
        text: '\uD800',
      }, 'INVALID_ARGUMENT');
      await failure(memory, {
        command: 'str_replace',
        path: '/memories/emoji.md',
        oldText: '\uDC00',
        newText: 'x',
      }, 'INVALID_ARGUMENT');
      await failure(memory, {
        command: 'str_replace',
        path: '/memories/emoji.md',
        oldText: '🧠',
        newText: '\uD800',
      }, 'INVALID_ARGUMENT');
      await failure(memory, {
        command: 'insert',
        path: '/memories/emoji.md',
        insertLine: 0,
        text: '\uDC00',
      }, 'INVALID_ARGUMENT');
    },
  },
  {
    name: 'invalid command and argument errors',
    async run(factory, scope) {
      const memory = await factory({ scope });
      const invalidCommand = await memory.execute({ command: 'write' } as unknown as MemoryCommand);
      check(!invalidCommand.ok, 'An unknown command succeeded.');
      check(invalidCommand.command === 'write', 'The failure did not retain the supplied command.');
      check(invalidCommand.error.code === 'INVALID_COMMAND', 'An unknown command returned the wrong code.');

      const invalidPath = await memory.execute({ command: 'view' } as unknown as MemoryCommand);
      check(!invalidPath.ok && invalidPath.error.code === 'INVALID_ARGUMENT', 'A missing path returned the wrong code.');
    },
  },
];

export async function runMemoryConformance(
  factory: MemoryConformanceFactory,
): Promise<MemoryConformanceReport> {
  const failures: MemoryConformanceFailure[] = [];

  for (const [index, testCase] of cases.entries()) {
    try {
      await testCase.run(factory, `memory-conformance-${index + 1}`);
    } catch (error) {
      failures.push({
        case: testCase.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: failures.length === 0,
    cases: cases.length,
    failures,
  };
}

export async function assertMemoryConformance(
  factory: MemoryConformanceFactory,
): Promise<void> {
  const report = await runMemoryConformance(factory);
  if (report.ok) return;

  const details = report.failures
    .map((failure) => `${failure.case}: ${failure.message}`)
    .join('\n');
  throw new Error(`Memory adapter failed ${report.failures.length} conformance case(s).\n${details}`);
}
