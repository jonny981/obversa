import { Buffer } from 'node:buffer';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  MEMORY_ROOT,
  type Memory,
  type MemoryCommand,
  type MemoryCommandName,
  type MemoryDirectoryEntry,
  type MemoryError,
  type MemoryErrorCode,
  type MemoryFailure,
  type MemoryPath,
  type MemoryResult,
} from '@obversa/api';

export interface OpenMarkdownCorpusOptions {
  readonly directory: string;
}

export interface MarkdownSearchOptions {
  readonly limit?: number;
}

export interface MarkdownPassage {
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface MarkdownSearchHit {
  readonly path: MemoryPath;
  readonly passage: MarkdownPassage;
  readonly score: number;
}

export interface MarkdownCorpus {
  readonly memory: Memory;
  search(
    query: string,
    options?: MarkdownSearchOptions,
  ): Promise<readonly MarkdownSearchHit[]>;
}

interface MarkdownFile {
  readonly path: MemoryPath;
  readonly localPath: string;
}

interface RankedHit extends MarkdownSearchHit {
  readonly exact: boolean;
  readonly matchedTerms: number;
  readonly frequency: number;
}

interface Valid<T> {
  readonly value: T;
}

interface Invalid {
  readonly error: MemoryError;
}

type Validation<T> = Valid<T> | Invalid;

const DEFAULT_LIMIT = 20;
const MAX_PATH_BYTES = 1_024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
// Copy of MEMORY_SEGMENT in packages/runtime/src/memory.ts. The package boundary
// forbids importing the runtime, so these expressions must not diverge.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOKEN = /[\p{L}\p{N}]+/gu;
const COMMANDS = new Set<MemoryCommandName>([
  'view',
  'create',
  'str_replace',
  'insert',
  'delete',
  'rename',
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVisibleCorpusEntry(value: string): boolean {
  return !value.startsWith('.') && SEGMENT.test(value);
}

function memoryError(
  code: MemoryErrorCode,
  message: string,
  path?: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): MemoryError {
  return {
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(details === undefined ? {} : { details }),
  };
}

function failed(
  command: string,
  code: MemoryErrorCode,
  message: string,
  path?: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): MemoryFailure {
  return { ok: false, command, error: memoryError(code, message, path, details) };
}

function suppliedCommand(value: unknown): string {
  return isRecord(value) && typeof value.command === 'string' ? value.command : 'unknown';
}

function validateMemoryPath(value: unknown): Validation<MemoryPath> {
  if (typeof value !== 'string') {
    return { error: memoryError('INVALID_ARGUMENT', 'A memory path must be a string.') };
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    return {
      error: memoryError('INVALID_PATH', 'The memory path is too long.', value, {
        maxBytes: MAX_PATH_BYTES,
      }),
    };
  }
  if (value === MEMORY_ROOT) return { value };
  if (!value.startsWith(`${MEMORY_ROOT}/`)) {
    return { error: memoryError('INVALID_PATH', 'The path must be inside /memories.', value) };
  }
  if (value.includes('\\') || value.includes('%') || CONTROL_CHARACTER.test(value)) {
    return { error: memoryError('INVALID_PATH', 'The memory path contains an unsafe character.', value) };
  }

  const segments = value.slice(MEMORY_ROOT.length + 1).split('/');
  if (segments.some((segment) => !SEGMENT.test(segment))) {
    return { error: memoryError('INVALID_PATH', 'The memory path contains an invalid segment.', value) };
  }
  return { value: value as MemoryPath };
}

function pathSegments(path: MemoryPath): readonly string[] {
  return path === MEMORY_ROOT ? [] : path.slice(MEMORY_ROOT.length + 1).split('/');
}

function corpusPath(segments: readonly string[]): MemoryPath {
  const value = `${MEMORY_ROOT}/${segments.join('/')}`;
  if (Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new TypeError(`Corpus path exceeds ${MAX_PATH_BYTES} bytes: ${segments.join('/')}`);
  }
  return value as MemoryPath;
}

async function markdownFiles(directory: string): Promise<readonly MarkdownFile[]> {
  const rootDirectory = await realpath(directory);
  const root = await lstat(rootDirectory);
  if (!root.isDirectory()) throw new TypeError('directory must name a directory.');

  const files: MarkdownFile[] = [];
  async function walk(segments: readonly string[]): Promise<void> {
    const entries = await readdir(join(rootDirectory, ...segments), { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (!isVisibleCorpusEntry(entry.name)) continue;
      const next = [...segments, entry.name];
      if (entry.isDirectory()) {
        await walk(next);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push({ path: corpusPath(next), localPath: join(rootDirectory, ...next) });
      }
    }
  }
  await walk([]);
  return files;
}

function passages(text: string): readonly MarkdownPassage[] {
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  if (normalised.endsWith('\n')) lines.pop();

  const result: MarkdownPassage[] = [];
  let startLine = 0;
  let paragraph: string[] = [];

  function flush(): void {
    if (paragraph.length === 0) return;
    result.push({
      startLine,
      endLine: startLine + paragraph.length - 1,
      text: paragraph.join('\n'),
    });
    paragraph = [];
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim() === '') {
      flush();
    } else if (HEADING.test(line)) {
      flush();
      result.push({ startLine: lineNumber, endLine: lineNumber, text: line });
    } else {
      if (paragraph.length === 0) startLine = lineNumber;
      paragraph.push(line);
    }
  });
  flush();
  return result;
}

function tokens(text: string): readonly string[] {
  return text.normalize('NFKC').toLowerCase().match(TOKEN) ?? [];
}

function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function rank(
  path: MemoryPath,
  passage: MarkdownPassage,
  queryTokens: readonly string[],
): RankedHit | undefined {
  const passageTokens = tokens(passage.text);
  const queryTerms = [...new Set(queryTokens)];
  let matchedTerms = 0;
  let frequency = 0;

  for (const term of queryTerms) {
    const occurrences = passageTokens.filter((token) => token === term).length;
    if (occurrences > 0) matchedTerms += 1;
    frequency += occurrences;
  }
  if (matchedTerms === 0) return undefined;

  const exact = containsPhrase(passageTokens, queryTokens);
  const score = (exact ? 1_000_000_000 : 0) + matchedTerms * 1_000_000 + frequency;
  return { path, passage, score, exact, matchedTerms, frequency };
}

function validateLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_LIMIT : value;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
    throw new TypeError('limit must be a positive safe integer.');
  }
  return limit as number;
}

function logicalLines(text: string): readonly string[] {
  if (text === '') return [];
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  if (normalised.endsWith('\n')) lines.pop();
  return lines;
}

function viewRange(
  input: unknown,
  text: string,
  path: MemoryPath,
): Validation<{
  readonly text: string;
  readonly lines: { readonly start: number; readonly end: number; readonly total: number };
}> {
  const lines = logicalLines(text);
  const hasFinalLineBreak = text.endsWith('\n') || text.endsWith('\r');
  const total = lines.length;

  if (input === undefined) {
    return {
      value: {
        text,
        lines: total === 0 ? { start: 0, end: 0, total: 0 } : { start: 1, end: total, total },
      },
    };
  }
  if (!Array.isArray(input) || input.length !== 2) {
    return { error: memoryError('INVALID_RANGE', 'viewRange must contain two line numbers.', path) };
  }
  const [start, requestedEnd] = input as unknown[];
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) {
    return { error: memoryError('INVALID_RANGE', 'Line numbers must be safe integers.', path) };
  }
  const startLine = start as number;
  const endLine = requestedEnd === -1 ? total : requestedEnd as number;
  if (startLine < 1 || endLine < startLine || endLine > total) {
    return {
      error: memoryError('INVALID_RANGE', 'The requested line range is outside the file.', path, {
        totalLines: total,
      }),
    };
  }

  let selected = lines.slice(startLine - 1, endLine).join('\n');
  if (endLine < total || hasFinalLineBreak) selected += '\n';
  return { value: { text: selected, lines: { start: startLine, end: endLine, total } } };
}

function missingPath(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

class MarkdownCorpusMemory implements Memory {
  readonly scope: string;

  constructor(private readonly directory: string) {
    this.scope = `search-markdown:${directory}`;
  }

  async execute(command: MemoryCommand): Promise<MemoryResult> {
    const raw: unknown = command;
    const name = suppliedCommand(raw);
    if (!isRecord(raw) || !COMMANDS.has(name as MemoryCommandName)) {
      return failed(name, 'INVALID_COMMAND', 'The memory command is not supported.');
    }
    if (name !== 'view') {
      return failed(name, 'INVALID_COMMAND', 'The markdown corpus is read-only.');
    }

    try {
      return await this.view(raw);
    } catch (error) {
      const checked = validateMemoryPath(raw.path);
      const path = 'value' in checked ? checked.value : undefined;
      return missingPath(error)
        ? failed(name, 'NOT_FOUND', 'The memory path does not exist.', path)
        : failed(
            name,
            'STORAGE_ERROR',
            error instanceof Error ? error.message : 'The markdown corpus could not be read.',
            path,
          );
    }
  }

  private async view(raw: Record<string, unknown>): Promise<MemoryResult> {
    const checked = validateMemoryPath(raw.path);
    if ('error' in checked) return { ok: false, command: 'view', error: checked.error };
    const path = checked.value;
    const segments = pathSegments(path);
    if (segments.some((segment) => !isVisibleCorpusEntry(segment))) {
      return failed('view', 'NOT_FOUND', 'The memory path does not exist.', path);
    }
    let localPath = await realpath(this.directory);

    for (const segment of segments) {
      localPath = join(localPath, segment);
      const part = await lstat(localPath);
      if (part.isSymbolicLink()) {
        return failed('view', 'UNSAFE_STORAGE', 'The corpus path crosses a symbolic link.', path);
      }
    }

    const target = await lstat(localPath);
    if (target.isDirectory()) {
      if (raw.viewRange !== undefined) {
        return failed('view', 'INVALID_RANGE', 'A directory view cannot have a line range.', path);
      }
      const entries = await readdir(localPath, { withFileTypes: true });
      const visible: MemoryDirectoryEntry[] = [];
      for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
        if (!isVisibleCorpusEntry(entry.name) || entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !(entry.isFile() && entry.name.endsWith('.md'))) continue;
        const entryPath = `${path === MEMORY_ROOT ? MEMORY_ROOT : path}/${entry.name}` as MemoryPath;
        visible.push({
          name: entry.name,
          path: entryPath,
          kind: entry.isDirectory() ? 'directory' : 'file',
        });
      }
      return {
        ok: true,
        command: 'view',
        value: { kind: 'directory', path, entries: visible },
      };
    }

    if (!target.isFile() || !localPath.endsWith('.md')) {
      return failed('view', 'NOT_FOUND', 'The memory path does not exist.', path);
    }
    const text = await readFile(localPath, 'utf8');
    const range = viewRange(raw.viewRange, text, path);
    if ('error' in range) return { ok: false, command: 'view', error: range.error };
    return {
      ok: true,
      command: 'view',
      value: {
        kind: 'file',
        path,
        text: range.value.text,
        byteLength: Buffer.byteLength(range.value.text, 'utf8'),
        lines: range.value.lines,
      },
    };
  }
}

export function openMarkdownCorpus(options: OpenMarkdownCorpusOptions): MarkdownCorpus {
  if (!isRecord(options) || typeof options.directory !== 'string' || options.directory.trim() === '') {
    throw new TypeError('directory must be a non-empty string.');
  }
  const directory = resolve(options.directory);
  const memory = new MarkdownCorpusMemory(directory);

  return {
    memory,
    async search(query, searchOptions = {}) {
      if (typeof query !== 'string') throw new TypeError('query must be a string.');
      const queryTokens = tokens(query);
      if (queryTokens.length === 0) return [];
      const limit = validateLimit(searchOptions.limit);
      const hits: RankedHit[] = [];

      for (const file of await markdownFiles(directory)) {
        const text = await readFile(file.localPath, 'utf8');
        for (const passage of passages(text)) {
          const hit = rank(file.path, passage, queryTokens);
          if (hit !== undefined) hits.push(hit);
        }
      }

      hits.sort((left, right) =>
        Number(right.exact) - Number(left.exact) ||
        right.matchedTerms - left.matchedTerms ||
        right.frequency - left.frequency ||
        compareText(left.path, right.path) ||
        left.passage.startLine - right.passage.startLine);
      return hits.slice(0, limit).map(({
        exact: _exact,
        matchedTerms: _matchedTerms,
        frequency: _frequency,
        ...hit
      }) => hit);
    },
  };
}
