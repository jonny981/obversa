import { Buffer } from 'node:buffer';

import {
  MEMORY_ROOT,
  type Memory,
  type MemoryCommand,
  type MemoryCommandName,
  type MemoryDirectoryEntry,
  type MemoryError,
  type MemoryErrorCode,
  type MemoryFailure,
  type MemoryLimits,
  type MemoryPath,
  type MemoryResult,
} from '@obversa/memory';

export interface SimpleMemoryOptions {
  readonly scope: string;
  readonly limits?: Partial<MemoryLimits>;
}

interface StoredFile {
  readonly text: string;
  readonly byteLength: number;
  readonly writtenAt: number;
}

interface Valid<T> {
  readonly value: T;
}

interface Invalid {
  readonly error: MemoryError;
}

type Validation<T> = Valid<T> | Invalid;

const DEFAULT_LIMITS: MemoryLimits = {
  maxFileBytes: 65_536,
  maxTotalBytes: 1_048_576,
  maxFiles: 256,
};

const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.py', '.yaml', '.yml']);
const COMMANDS = new Set<MemoryCommandName>([
  'view',
  'create',
  'str_replace',
  'insert',
  'delete',
  'rename',
]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH_BYTES = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
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

function validatePath(value: unknown): Validation<MemoryPath> {
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
  if (value.includes('\\') || value.includes('%') || /[\u0000-\u001f\u007f]/.test(value)) {
    return { error: memoryError('INVALID_PATH', 'The memory path contains an unsafe character.', value) };
  }

  const segments = value.slice(MEMORY_ROOT.length + 1).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || !SEGMENT.test(segment))) {
    return { error: memoryError('INVALID_PATH', 'The memory path contains an invalid segment.', value) };
  }

  return { value: value as MemoryPath };
}

function extension(path: MemoryPath): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function logicalLines(text: string): string[] {
  if (text === '') return [];
  const normalised = text.replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  if (normalised.endsWith('\n')) lines.pop();
  return lines;
}

function validateLimits(input: Partial<MemoryLimits> | undefined): MemoryLimits {
  const limits: MemoryLimits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

class InProcessMemory implements Memory {
  readonly scope: string;

  readonly #limits: MemoryLimits;
  #files = new Map<MemoryPath, StoredFile>();
  #writeClock = 0;

  constructor(options: SimpleMemoryOptions) {
    if (
      typeof options.scope !== 'string' ||
      options.scope.trim() === '' ||
      !isWellFormedUnicode(options.scope) ||
      /[\u0000-\u001f\u007f]/.test(options.scope)
    ) {
      throw new TypeError('scope must be a non-empty, well-formed string without control characters.');
    }
    this.scope = options.scope;
    this.#limits = validateLimits(options.limits);
  }

  async execute(command: MemoryCommand): Promise<MemoryResult> {
    const raw: unknown = command;
    const name = suppliedCommand(raw);
    if (!isRecord(raw) || !COMMANDS.has(name as MemoryCommandName)) {
      return failed(name, 'INVALID_COMMAND', 'The memory command is not supported.');
    }
    const commandName = name as MemoryCommandName;

    try {
      switch (commandName) {
        case 'view':
          return this.#view(raw, commandName);
        case 'create':
          return this.#create(raw, commandName);
        case 'str_replace':
          return this.#replace(raw, commandName);
        case 'insert':
          return this.#insert(raw, commandName);
        case 'delete':
          return this.#delete(raw, commandName);
        case 'rename':
          return this.#rename(raw, commandName);
      }
    } catch (error) {
      return failed(
        name,
        'STORAGE_ERROR',
        error instanceof Error ? error.message : 'The memory adapter failed.',
      );
    }
  }

  #view(raw: Record<string, unknown>, command: 'view'): MemoryResult {
    const checked = validatePath(raw.path);
    if ('error' in checked) return { ok: false, command, error: checked.error };
    const path = checked.value;
    const file = this.#files.get(path);

    if (file !== undefined) {
      const range = this.#validateViewRange(raw.viewRange, file.text, path);
      if ('error' in range) return { ok: false, command, error: range.error };
      return {
        ok: true,
        command,
        value: {
          kind: 'file',
          path,
          text: range.value.text,
          byteLength: byteLength(range.value.text),
          lines: range.value.lines,
        },
      };
    }

    if (!this.#directoryExists(path)) {
      return failed(command, 'NOT_FOUND', 'The memory path does not exist.', path);
    }
    if (raw.viewRange !== undefined) {
      return failed(command, 'INVALID_RANGE', 'A directory view cannot have a line range.', path);
    }

    return {
      ok: true,
      command,
      value: {
        kind: 'directory',
        path,
        entries: this.#directoryEntries(path),
      },
    };
  }

  #create(raw: Record<string, unknown>, command: 'create'): MemoryResult {
    const checked = validatePath(raw.path);
    if ('error' in checked) return { ok: false, command, error: checked.error };
    const path = checked.value;
    if (path === MEMORY_ROOT) return failed(command, 'ROOT_PROTECTED', 'The memory root cannot be a file.', path);
    if (typeof raw.text !== 'string' || !isWellFormedUnicode(raw.text)) {
      return failed(command, 'INVALID_ARGUMENT', 'Create text must be a well-formed string.', path);
    }
    const extensionFailure = this.#extensionFailure(path, command);
    if (extensionFailure !== undefined) return extensionFailure;
    if (this.#fileAncestor(path) !== undefined || (!this.#files.has(path) && this.#directoryExists(path))) {
      return failed(command, 'PATH_CONFLICT', 'A file and directory cannot use the same path.', path);
    }

    const overwritten = this.#files.has(path);
    return this.#write(command, path, raw.text, overwritten);
  }

  #replace(raw: Record<string, unknown>, command: 'str_replace'): MemoryResult {
    const checked = validatePath(raw.path);
    if ('error' in checked) return { ok: false, command, error: checked.error };
    const path = checked.value;
    if (
      typeof raw.oldText !== 'string' ||
      raw.oldText.length === 0 ||
      !isWellFormedUnicode(raw.oldText) ||
      typeof raw.newText !== 'string' ||
      !isWellFormedUnicode(raw.newText)
    ) {
      return failed(command, 'INVALID_ARGUMENT', 'Replace text must be well-formed strings with non-empty oldText.', path);
    }
    const file = this.#files.get(path);
    if (file === undefined) return this.#missingFile(command, path);

    const first = file.text.indexOf(raw.oldText);
    if (first < 0) return failed(command, 'MATCH_NOT_FOUND', 'oldText was not found.', path);
    if (file.text.indexOf(raw.oldText, first + raw.oldText.length) >= 0) {
      return failed(command, 'MATCH_NOT_UNIQUE', 'oldText occurs more than once.', path);
    }

    const text = `${file.text.slice(0, first)}${raw.newText}${file.text.slice(first + raw.oldText.length)}`;
    return this.#write(command, path, text, false);
  }

  #insert(raw: Record<string, unknown>, command: 'insert'): MemoryResult {
    const checked = validatePath(raw.path);
    if ('error' in checked) return { ok: false, command, error: checked.error };
    const path = checked.value;
    if (typeof raw.text !== 'string' || !isWellFormedUnicode(raw.text)) {
      return failed(command, 'INVALID_ARGUMENT', 'Insert text must be a well-formed string.', path);
    }
    if (!Number.isSafeInteger(raw.insertLine) || (raw.insertLine as number) < 0) {
      return failed(command, 'INVALID_RANGE', 'insertLine must be a zero-based line slot.', path);
    }
    const file = this.#files.get(path);
    if (file === undefined) return this.#missingFile(command, path);

    const lines = logicalLines(file.text);
    const insertLine = raw.insertLine as number;
    if (insertLine > lines.length) {
      return failed(command, 'INVALID_RANGE', 'insertLine is outside the file.', path, {
        maxInsertLine: lines.length,
      });
    }
    const inserted = logicalLines(raw.text);
    lines.splice(insertLine, 0, ...inserted);
    const text = `${lines.join('\n')}\n`;
    return this.#write(command, path, text, false);
  }

  #delete(raw: Record<string, unknown>, command: 'delete'): MemoryResult {
    const checked = validatePath(raw.path);
    if ('error' in checked) return { ok: false, command, error: checked.error };
    const path = checked.value;
    if (path === MEMORY_ROOT) return failed(command, 'ROOT_PROTECTED', 'The memory root cannot be deleted.', path);

    const exact = this.#files.get(path);
    const descendants = exact === undefined ? this.#descendants(path) : [];
    if (exact === undefined && descendants.length === 0) {
      return failed(command, 'NOT_FOUND', 'The memory path does not exist.', path);
    }

    const removed = exact === undefined ? descendants : [[path, exact] as const];
    const draft = new Map(this.#files);
    for (const [removedPath] of removed) draft.delete(removedPath);
    this.#files = draft;

    return {
      ok: true,
      command,
      value: {
        path,
        kind: exact === undefined ? 'directory' : 'file',
        deletedFiles: removed.length,
        freedBytes: removed.reduce((total, [, file]) => total + file.byteLength, 0),
      },
    };
  }

  #rename(raw: Record<string, unknown>, command: 'rename'): MemoryResult {
    const oldChecked = validatePath(raw.oldPath);
    if ('error' in oldChecked) return { ok: false, command, error: oldChecked.error };
    const newChecked = validatePath(raw.newPath);
    if ('error' in newChecked) return { ok: false, command, error: newChecked.error };
    const oldPath = oldChecked.value;
    const newPath = newChecked.value;
    if (oldPath === MEMORY_ROOT || newPath === MEMORY_ROOT) {
      return failed(command, 'ROOT_PROTECTED', 'The memory root cannot be renamed.', oldPath);
    }

    const exact = this.#files.get(oldPath);
    const moved = exact === undefined ? this.#descendants(oldPath) : [[oldPath, exact] as const];
    if (moved.length === 0) return failed(command, 'NOT_FOUND', 'The source path does not exist.', oldPath);
    const kind = exact === undefined ? 'directory' : 'file';

    if (newPath === oldPath || this.#files.has(newPath) || this.#directoryExists(newPath)) {
      return failed(command, 'ALREADY_EXISTS', 'The destination path already exists.', newPath);
    }
    if (kind === 'directory' && newPath.startsWith(`${oldPath}/`)) {
      return failed(command, 'CONFLICT', 'A directory cannot move inside itself.', newPath);
    }
    if (kind === 'file') {
      const extensionFailure = this.#extensionFailure(newPath, command);
      if (extensionFailure !== undefined) return extensionFailure;
    }
    if (this.#fileAncestor(newPath) !== undefined) {
      return failed(command, 'PATH_CONFLICT', 'A destination parent is a file.', newPath);
    }

    const movedPaths = new Set(moved.map(([path]) => path));
    const destinations: Array<readonly [MemoryPath, StoredFile]> = [];
    for (const [sourcePath, file] of moved) {
      const destination = validatePath(`${newPath}${sourcePath.slice(oldPath.length)}`);
      if ('error' in destination) return { ok: false, command, error: destination.error };
      destinations.push([destination.value, file]);
    }
    for (const [destination] of destinations) {
      if (this.#files.has(destination) && !movedPaths.has(destination)) {
        return failed(command, 'ALREADY_EXISTS', 'The destination path already exists.', destination);
      }
      const ancestor = this.#fileAncestor(destination);
      if (ancestor !== undefined && !movedPaths.has(ancestor)) {
        return failed(command, 'PATH_CONFLICT', 'A destination parent is a file.', destination);
      }
    }

    const draft = new Map(this.#files);
    for (const [sourcePath] of moved) draft.delete(sourcePath);
    for (const [destination, file] of destinations) draft.set(destination, file);
    this.#files = draft;

    return {
      ok: true,
      command,
      value: { oldPath, newPath, kind, movedFiles: moved.length },
    };
  }

  #write(
    command: 'create' | 'str_replace' | 'insert',
    path: MemoryPath,
    text: string,
    overwritten: boolean,
  ): MemoryResult {
    const size = byteLength(text);
    if (size > this.#limits.maxFileBytes || size > this.#limits.maxTotalBytes) {
      return failed(command, 'LIMIT_EXCEEDED', 'The target file exceeds a memory limit.', path, {
        byteLength: size,
        maxFileBytes: this.#limits.maxFileBytes,
        maxTotalBytes: this.#limits.maxTotalBytes,
      });
    }

    const nextWrite = this.#writeClock + 1;
    const draft = new Map(this.#files);
    draft.set(path, { text, byteLength: size, writtenAt: nextWrite });

    const candidates = [...draft.entries()]
      .filter(([candidate]) => candidate !== path)
      .sort(([leftPath, left], [rightPath, right]) =>
        left.writtenAt - right.writtenAt || compareText(leftPath, rightPath));
    const evicted: MemoryPath[] = [];
    let totalBytes = [...draft.values()].reduce((total, file) => total + file.byteLength, 0);
    let nextCandidate = 0;

    while (draft.size > this.#limits.maxFiles || totalBytes > this.#limits.maxTotalBytes) {
      const candidate = candidates[nextCandidate];
      if (candidate === undefined) {
        return failed(command, 'LIMIT_EXCEEDED', 'The write cannot fit without evicting its target.', path);
      }
      nextCandidate += 1;
      const [candidatePath, candidateFile] = candidate;
      draft.delete(candidatePath);
      totalBytes -= candidateFile.byteLength;
      evicted.push(candidatePath);
    }

    this.#files = draft;
    this.#writeClock = nextWrite;

    if (command === 'create') {
      return {
        ok: true,
        command,
        value: { path, byteLength: size, evicted, overwritten },
      };
    }
    return { ok: true, command, value: { path, byteLength: size, evicted } };
  }

  #validateViewRange(
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
          lines: total === 0
            ? { start: 0, end: 0, total: 0 }
            : { start: 1, end: total, total },
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
    return {
      value: {
        text: selected,
        lines: { start: startLine, end: endLine, total },
      },
    };
  }

  #extensionFailure(
    path: MemoryPath,
    command: 'create' | 'rename',
  ): MemoryFailure | undefined {
    if (ALLOWED_EXTENSIONS.has(extension(path))) return undefined;
    return failed(command, 'INVALID_EXTENSION', 'The file extension is not allowed.', path);
  }

  #missingFile(command: 'str_replace' | 'insert', path: MemoryPath): MemoryFailure {
    return this.#directoryExists(path)
      ? failed(command, 'PATH_CONFLICT', 'The memory path is a directory.', path)
      : failed(command, 'NOT_FOUND', 'The memory file does not exist.', path);
  }

  #directoryExists(path: MemoryPath): boolean {
    if (path === MEMORY_ROOT) return true;
    const prefix = `${path}/`;
    for (const filePath of this.#files.keys()) {
      if (filePath.startsWith(prefix)) return true;
    }
    return false;
  }

  #fileAncestor(path: MemoryPath): MemoryPath | undefined {
    let slash = path.lastIndexOf('/');
    while (slash > MEMORY_ROOT.length) {
      const ancestor = path.slice(0, slash) as MemoryPath;
      if (this.#files.has(ancestor)) return ancestor;
      slash = ancestor.lastIndexOf('/');
    }
    return undefined;
  }

  #descendants(path: MemoryPath): Array<readonly [MemoryPath, StoredFile]> {
    const prefix = `${path}/`;
    return [...this.#files.entries()]
      .filter(([filePath]) => filePath.startsWith(prefix))
      .sort(([left], [right]) => compareText(left, right));
  }

  #directoryEntries(path: MemoryPath): readonly MemoryDirectoryEntry[] {
    const prefix = path === MEMORY_ROOT ? `${MEMORY_ROOT}/` : `${path}/`;
    const entries = new Map<string, MemoryDirectoryEntry>();

    for (const filePath of this.#files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      const name = slash < 0 ? remainder : remainder.slice(0, slash);
      const entryPath = `${prefix}${name}` as MemoryPath;
      const kind = slash < 0 ? 'file' : 'directory';
      const existing = entries.get(name);
      if (existing === undefined || kind === 'directory') {
        entries.set(name, { name, path: entryPath, kind });
      }
    }

    return [...entries.values()].sort((left, right) => compareText(left.name, right.name));
  }
}

export function createSimpleMemory(options: SimpleMemoryOptions): Memory {
  return new InProcessMemory(options);
}
