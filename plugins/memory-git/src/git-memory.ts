import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import {
  MEMORY_ROOT,
  type Memory,
  type MemoryCommand,
  type MemoryErrorCode,
  type MemoryLimits,
  type MemoryPath,
  type MemoryResult,
  type MemorySuccess,
} from '@obversa/memory';
import { RunChildError, runChild } from '@obversa/process';

const META_NAME = '.obversa-memory.json';
const REF_PREFIX = 'refs/obversa/memory/v1';
const FORMAT = 1;
const MAX_CAS_ATTEMPTS = 64;
const DEFAULT_LIMITS: MemoryLimits = {
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxFiles: 256,
};
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.py', '.yaml', '.yml']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PATH_BYTES = 1_024;
const MAX_GIT_COMMAND_OUTPUT_BYTES = 1_048_576;
const SMALL_GIT_OUTPUT_BYTES = 8_192;
const GIT_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const GIT_COMMAND_GRACE_MS = 5 * 1_000;
const METADATA_FIXED_BYTES = 1_024;
const METADATA_ENTRY_BYTES = MAX_PATH_BYTES + 128;
const TREE_ENTRY_FIXED_BYTES = 14;

export interface GitMemoryOptions {
  readonly repositoryPath: string;
  readonly scope: string;
  readonly limits?: Partial<MemoryLimits>;
}

interface GitConfig {
  readonly repositoryPath: string;
  readonly ref: string;
  readonly scopeDigest: string;
  readonly limits: MemoryLimits;
  readonly oidLength: number;
}

interface GitOutput {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly name: string;
}

interface StoredFile {
  readonly path: MemoryPath;
  readonly text: string;
  readonly byteLength: number;
  readonly written: number;
}

interface State {
  readonly files: Map<MemoryPath, StoredFile>;
  nextWrite: number;
}

interface Snapshot {
  readonly oid?: string;
  readonly state: State;
}

interface StoredMetadata {
  readonly format: number;
  readonly scopeDigest: string;
  readonly nextWrite: number;
  readonly totalBytes: number;
  readonly entries: readonly {
    readonly path: MemoryPath;
    readonly byteLength: number;
    readonly written: number;
  }[];
}

interface TreeNode {
  readonly files: Map<string, string>;
  readonly dirs: Map<string, TreeNode>;
}

class CommandFault extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    readonly path?: string,
    readonly details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
  }
}

class StorageFault extends Error {
  constructor(
    readonly code: Extract<MemoryErrorCode, 'UNSAFE_STORAGE' | 'STORAGE_ERROR'>,
    message: string,
  ) {
    super(message);
  }
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

/**
 * Open a Memory adapter backed by a private Git ref. The adapter only uses Git
 * plumbing commands, so it never changes the caller's HEAD, index, or worktree.
 */
export async function openGitMemory(options: GitMemoryOptions): Promise<Memory> {
  if (typeof options.repositoryPath !== 'string' || !options.repositoryPath.trim()) {
    throw new TypeError('repositoryPath must be a non-empty string');
  }
  if (
    typeof options.scope !== 'string' ||
    !options.scope.trim() ||
    !isWellFormedUnicode(options.scope) ||
    /[\u0000-\u001f\u007f]/.test(options.scope)
  ) {
    throw new TypeError('scope must be a non-empty, well-formed string without control characters');
  }

  const repositoryPath = await realpath(options.repositoryPath).catch(() => {
    throw new TypeError('repositoryPath must identify an accessible Git repository');
  });
  const limits = resolveLimits(options.limits);
  const probe = await invoke(repositoryPath, ['rev-parse', '--git-dir']);
  if (probe.exitCode !== 0) {
    throw new Error('repositoryPath must identify a Git repository');
  }
  const format = await invoke(repositoryPath, [
    'rev-parse',
    '--show-object-format=storage',
  ]);
  if (format.exitCode !== 0) {
    throw new Error('Git did not report its object format');
  }
  const objectFormat = text(format.stdout).trim();
  const oidLength = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
  if (!oidLength) throw new Error(`unsupported Git object format: ${objectFormat}`);

  const scopeDigest = digest(options.scope);
  const config: GitConfig = {
    repositoryPath,
    ref: `${REF_PREFIX}/${scopeDigest}`,
    scopeDigest,
    limits,
    oidLength,
  };

  return {
    scope: options.scope,
    execute: (command) => execute(config, command),
  };
}

async function execute(config: GitConfig, command: MemoryCommand): Promise<MemoryResult> {
  const name = commandName(command);
  try {
    const checked = validateCommand(command);
    if (checked.command === 'view') {
      const snapshot = await loadSnapshot(config);
      return apply(snapshot.state, checked, config.limits).result;
    }

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const snapshot = await loadSnapshot(config);
      const applied = apply(snapshot.state, checked, config.limits);
      if (!applied.changed || !applied.next) return applied.result;

      const nextTree = await writeState(config, applied.next);
      const updated = await updateRef(config, nextTree, snapshot.oid);
      if (updated === 'updated') return applied.result;
    }

    return failure(name, 'CONFLICT', 'Memory changed repeatedly while writing.');
  } catch (error) {
    if (error instanceof CommandFault) {
      return failure(name, error.code, error.message, error.path, error.details);
    }
    if (error instanceof StorageFault) {
      return failure(name, error.code, error.message);
    }
    return failure(name, 'STORAGE_ERROR', 'Git memory storage failed.');
  }
}

function commandName(command: unknown): string {
  if (
    command !== null &&
    typeof command === 'object' &&
    typeof (command as { command?: unknown }).command === 'string'
  ) {
    return (command as { command: string }).command;
  }
  return 'unknown';
}

function validateCommand(command: unknown): MemoryCommand {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new CommandFault('INVALID_COMMAND', 'Memory command must be an object.');
  }
  const candidate = command as Record<string, unknown>;
  switch (candidate.command) {
    case 'view':
    case 'create':
    case 'str_replace':
    case 'insert':
    case 'delete':
    case 'rename':
      return command as MemoryCommand;
    default:
      throw new CommandFault('INVALID_COMMAND', 'Unknown memory command.');
  }
}

function apply(
  original: State,
  command: MemoryCommand,
  limits: MemoryLimits,
): { readonly result: MemoryResult; readonly changed: boolean; readonly next?: State } {
  switch (command.command) {
    case 'view':
      return { result: view(original, command), changed: false };
    case 'create':
      return mutateCreate(original, command, limits);
    case 'str_replace':
      return mutateReplace(original, command, limits);
    case 'insert':
      return mutateInsert(original, command, limits);
    case 'delete':
      return mutateDelete(original, command);
    case 'rename':
      return mutateRename(original, command);
  }
}

function view(state: State, command: Extract<MemoryCommand, { command: 'view' }>): MemorySuccess {
  const raw = command as unknown as Record<string, unknown>;
  const info = parsePath(raw.path);
  const file = state.files.get(info.path);
  if (file) {
    const rendered = renderFile(file, raw.viewRange, info.path);
    return {
      ok: true,
      command: 'view',
      value: {
        kind: 'file',
        path: info.path,
        text: rendered.text,
        byteLength: Buffer.byteLength(rendered.text, 'utf8'),
        lines: rendered.lines,
      },
    };
  }

  if (!isDirectory(state, info.path)) {
    throw new CommandFault('NOT_FOUND', `Memory path does not exist: ${info.path}`, info.path);
  }
  if (raw.viewRange !== undefined) {
    throw new CommandFault('INVALID_RANGE', 'A directory view cannot have a line range.', info.path);
  }
  return {
    ok: true,
    command: 'view',
    value: {
      kind: 'directory',
      path: info.path,
      entries: directoryEntries(state, info.path),
    },
  };
}

function mutateCreate(
  original: State,
  command: Extract<MemoryCommand, { command: 'create' }>,
  limits: MemoryLimits,
) {
  const raw = command as unknown as Record<string, unknown>;
  const info = parsePath(raw.path);
  if (info.root) {
    throw new CommandFault('ROOT_PROTECTED', 'The memory root cannot be a file.', info.path);
  }
  assertWriteText(raw.text, 'text');
  assertExtension(info);
  if (isDirectory(original, info.path) && !original.files.has(info.path)) {
    throw new CommandFault('PATH_CONFLICT', `A directory exists at ${info.path}.`, info.path);
  }
  assertNoParentFile(original, info.path);
  const next = cloneState(original);
  const overwritten = original.files.has(info.path);
  const file = writeFile(next, info.path, raw.text);
  const evicted = enforceLimits(next, limits, info.path);
  return {
    changed: true,
    next,
    result: {
      ok: true as const,
      command: 'create' as const,
      value: {
        path: info.path,
        byteLength: file.byteLength,
        evicted,
        overwritten,
      },
    },
  };
}

function mutateReplace(
  original: State,
  command: Extract<MemoryCommand, { command: 'str_replace' }>,
  limits: MemoryLimits,
) {
  const raw = command as unknown as Record<string, unknown>;
  const info = parsePath(raw.path);
  if (
    typeof raw.oldText !== 'string' ||
    raw.oldText.length === 0 ||
    !isWellFormedUnicode(raw.oldText) ||
    typeof raw.newText !== 'string' ||
    !isWellFormedUnicode(raw.newText)
  ) {
    throw new CommandFault('INVALID_ARGUMENT', 'Replace text must be well-formed strings with non-empty oldText.', info.path);
  }
  const existing = requireFile(original, info.path);
  const first = existing.text.indexOf(raw.oldText);
  if (first < 0) {
    throw new CommandFault('MATCH_NOT_FOUND', 'oldText does not occur in the file.', info.path);
  }
  if (existing.text.indexOf(raw.oldText, first + raw.oldText.length) >= 0) {
    throw new CommandFault('MATCH_NOT_UNIQUE', 'oldText occurs more than once in the file.', info.path);
  }
  const next = cloneState(original);
  const text =
    existing.text.slice(0, first) +
    raw.newText +
    existing.text.slice(first + raw.oldText.length);
  const file = writeFile(next, info.path, text);
  const evicted = enforceLimits(next, limits, info.path);
  return {
    changed: true,
    next,
    result: {
      ok: true as const,
      command: 'str_replace' as const,
      value: { path: info.path, byteLength: file.byteLength, evicted },
    },
  };
}

function mutateInsert(
  original: State,
  command: Extract<MemoryCommand, { command: 'insert' }>,
  limits: MemoryLimits,
) {
  const raw = command as unknown as Record<string, unknown>;
  const info = parsePath(raw.path);
  assertWriteText(raw.text, 'text');
  const insertLine = raw.insertLine;
  if (typeof insertLine !== 'number' || !Number.isSafeInteger(insertLine) || insertLine < 0) {
    throw new CommandFault('INVALID_RANGE', 'insertLine must be a zero-based line slot.', info.path);
  }
  const existing = requireFile(original, info.path);
  const lines = logicalLines(existing.text);
  if (insertLine > lines.length) {
    throw new CommandFault('INVALID_RANGE', 'insertLine is outside the file.', info.path, {
      maxInsertLine: lines.length,
    });
  }
  const inserted = logicalLines(raw.text);
  const nextText = [
    ...lines.slice(0, insertLine),
    ...inserted,
    ...lines.slice(insertLine),
  ].join('\n') + '\n';
  const next = cloneState(original);
  const file = writeFile(next, info.path, nextText);
  const evicted = enforceLimits(next, limits, info.path);
  return {
    changed: true,
    next,
    result: {
      ok: true as const,
      command: 'insert' as const,
      value: { path: info.path, byteLength: file.byteLength, evicted },
    },
  };
}

function mutateDelete(
  original: State,
  command: Extract<MemoryCommand, { command: 'delete' }>,
) {
  const raw = command as unknown as Record<string, unknown>;
  const info = parsePath(raw.path);
  if (info.root) {
    throw new CommandFault('ROOT_PROTECTED', 'The memory root cannot be deleted.', info.path);
  }
  const files = matchingFiles(original, info.path);
  if (!files.length) {
    throw new CommandFault('NOT_FOUND', `Memory path does not exist: ${info.path}`, info.path);
  }
  const kind: 'file' | 'directory' = original.files.has(info.path) ? 'file' : 'directory';
  const next = cloneState(original);
  for (const file of files) next.files.delete(file.path);
  return {
    changed: true,
    next,
    result: {
      ok: true as const,
      command: 'delete' as const,
      value: {
        path: info.path,
        kind,
        deletedFiles: files.length,
        freedBytes: files.reduce((total, file) => total + file.byteLength, 0),
      },
    },
  };
}

function mutateRename(
  original: State,
  command: Extract<MemoryCommand, { command: 'rename' }>,
) {
  const raw = command as unknown as Record<string, unknown>;
  const oldInfo = parsePath(raw.oldPath);
  const newInfo = parsePath(raw.newPath);
  if (oldInfo.root || newInfo.root) {
    throw new CommandFault('ROOT_PROTECTED', 'The memory root cannot be renamed.', oldInfo.path);
  }
  const exact = original.files.get(oldInfo.path);
  const files = exact === undefined ? matchingFiles(original, oldInfo.path) : [exact];
  if (files.length === 0) {
    throw new CommandFault('NOT_FOUND', `Memory path does not exist: ${oldInfo.path}`, oldInfo.path);
  }
  const kind: 'file' | 'directory' = exact === undefined ? 'directory' : 'file';
  if (isDirectory(original, newInfo.path) || original.files.has(newInfo.path)) {
    throw new CommandFault('ALREADY_EXISTS', `Destination already exists: ${newInfo.path}`, newInfo.path);
  }
  if (kind === 'directory' && newInfo.path.startsWith(`${oldInfo.path}/`)) {
    throw new CommandFault('CONFLICT', 'A directory cannot be moved into itself.', newInfo.path);
  }
  if (kind === 'file') assertExtension(newInfo);
  assertNoParentFile(original, newInfo.path);

  const movedPaths = new Set(files.map((file) => file.path));
  const destinations: Array<readonly [MemoryPath, StoredFile]> = [];
  for (const file of files) {
    const destination = parsePath(`${newInfo.path}${file.path.slice(oldInfo.path.length)}`);
    destinations.push([destination.path, file]);
  }
  for (const [destination] of destinations) {
    if (original.files.has(destination) && !movedPaths.has(destination)) {
      throw new CommandFault('ALREADY_EXISTS', 'The destination path already exists.', destination);
    }
    const ancestor = fileAncestor(original, destination);
    if (ancestor !== undefined && !movedPaths.has(ancestor)) {
      throw new CommandFault('PATH_CONFLICT', 'A destination parent is a file.', destination);
    }
  }

  const next = cloneState(original);
  for (const file of files) next.files.delete(file.path);
  for (const [path, file] of destinations) {
    next.files.set(path, { ...file, path });
  }
  return {
    changed: true,
    next,
    result: {
      ok: true as const,
      command: 'rename' as const,
      value: {
        oldPath: oldInfo.path,
        newPath: newInfo.path,
        kind,
        movedFiles: files.length,
      },
    },
  };
}

function parsePath(value: unknown): { readonly path: MemoryPath; readonly root: boolean; readonly segments: readonly string[] } {
  if (typeof value !== 'string') {
    throw new CommandFault('INVALID_ARGUMENT', 'A memory path must be a string.');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES) {
    throw new CommandFault('INVALID_PATH', 'The memory path is too long.', value, {
      maxBytes: MAX_PATH_BYTES,
    });
  }
  if (value === MEMORY_ROOT) return { path: MEMORY_ROOT, root: true, segments: [] };
  if (!value.startsWith(`${MEMORY_ROOT}/`)) {
    throw new CommandFault('INVALID_PATH', 'The path must be inside /memories.', value);
  }
  const tail = value.slice(MEMORY_ROOT.length + 1);
  const segments = tail.split('/');
  if (value.includes('\\') || value.includes('%') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CommandFault('INVALID_PATH', 'The memory path contains an unsafe character.', value);
  }
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || !SEGMENT.test(segment)) {
      throw new CommandFault('INVALID_PATH', 'The memory path contains an invalid segment.', value);
    }
  }
  return { path: value as MemoryPath, root: false, segments };
}

function assertFilePath(value: unknown): { readonly path: MemoryPath; readonly root: false; readonly segments: readonly string[] } {
  const info = parsePath(value);
  if (info.root) {
    throw new CommandFault('ROOT_PROTECTED', 'The memory root is a directory.', info.path);
  }
  assertExtension(info);
  return { path: info.path, root: false, segments: info.segments };
}

function assertExtension(info: { readonly path: MemoryPath; readonly segments: readonly string[] }): void {
  const name = info.path.slice(info.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new CommandFault('INVALID_EXTENSION', 'The file extension is not allowed.', info.path);
  }
}

function assertWriteText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !isWellFormedUnicode(value)) {
    throw new CommandFault('INVALID_ARGUMENT', `${name} must be a well-formed string.`);
  }
}

function renderFile(
  file: StoredFile,
  input: unknown,
  path: MemoryPath,
): { readonly text: string; readonly lines: { readonly start: number; readonly end: number; readonly total: number } } {
  const lines = logicalLines(file.text);
  const hasFinalLineBreak = file.text.endsWith('\n') || file.text.endsWith('\r');
  const total = lines.length;
  if (input === undefined) {
    return {
      text: file.text,
      lines: { start: total ? 1 : 0, end: total, total },
    };
  }
  if (!Array.isArray(input) || input.length !== 2) {
    throw new CommandFault('INVALID_RANGE', 'viewRange must contain two line numbers.', path);
  }
  const [start, requestedEnd] = input;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) {
    throw new CommandFault('INVALID_RANGE', 'Line numbers must be safe integers.', path);
  }
  const end = requestedEnd === -1 ? total : requestedEnd;
  if (start < 1 || end < start || end > total) {
    throw new CommandFault('INVALID_RANGE', 'The requested line range is outside the file.', path, {
      totalLines: total,
    });
  }
  let text = lines.slice(start - 1, end).join('\n');
  if (end < total || hasFinalLineBreak) text += '\n';
  return {
    text,
    lines: { start, end, total },
  };
}

function logicalLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

function cloneState(state: State): State {
  return {
    files: new Map(state.files),
    nextWrite: state.nextWrite,
  };
}

function writeFile(state: State, path: MemoryPath, text: string): StoredFile {
  if (state.nextWrite >= Number.MAX_SAFE_INTEGER) {
    throw new StorageFault('STORAGE_ERROR', 'Memory write clock is exhausted.');
  }
  state.nextWrite += 1;
  const file: StoredFile = {
    path,
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
    written: state.nextWrite,
  };
  state.files.set(path, file);
  return file;
}

function enforceLimits(state: State, limits: MemoryLimits, protectedPath: MemoryPath): MemoryPath[] {
  const target = state.files.get(protectedPath)!;
  if (target.byteLength > limits.maxFileBytes || target.byteLength > limits.maxTotalBytes) {
    throw new CommandFault('LIMIT_EXCEEDED', 'The target file exceeds a memory limit.', protectedPath, {
      byteLength: target.byteLength,
      maxFileBytes: limits.maxFileBytes,
      maxTotalBytes: limits.maxTotalBytes,
    });
  }
  const evicted: MemoryPath[] = [];
  while (state.files.size > limits.maxFiles || totalBytes(state) > limits.maxTotalBytes) {
    const candidate = [...state.files.values()]
      .filter((file) => file.path !== protectedPath)
      .sort((left, right) => left.written - right.written || comparePath(left.path, right.path))[0];
    if (!candidate) {
      throw new CommandFault('LIMIT_EXCEEDED', 'Memory limits cannot retain the target file.', protectedPath);
    }
    state.files.delete(candidate.path);
    evicted.push(candidate.path);
  }
  return evicted;
}

function totalBytes(state: State): number {
  return [...state.files.values()].reduce((total, file) => total + file.byteLength, 0);
}

function requireFile(state: State, path: MemoryPath): StoredFile {
  const file = state.files.get(path);
  if (!file) {
    if (isDirectory(state, path)) {
      throw new CommandFault('PATH_CONFLICT', 'The memory path is a directory.', path);
    }
    throw new CommandFault('NOT_FOUND', 'The memory file does not exist.', path);
  }
  return file;
}

function matchingFiles(state: State, path: MemoryPath): StoredFile[] {
  const prefix = `${path}/`;
  return [...state.files.values()]
    .filter((file) => file.path === path || file.path.startsWith(prefix))
    .sort((left, right) => comparePath(left.path, right.path));
}

function isDirectory(state: State, path: MemoryPath): boolean {
  if (path === MEMORY_ROOT) return true;
  return [...state.files.keys()].some((candidate) => candidate.startsWith(`${path}/`));
}

function assertNoParentFile(state: State, path: MemoryPath): void {
  const ancestor = fileAncestor(state, path);
  if (ancestor !== undefined) {
    throw new CommandFault('PATH_CONFLICT', `A file blocks ${path}.`, ancestor);
  }
}

function fileAncestor(state: State, path: MemoryPath): MemoryPath | undefined {
  let slash = path.lastIndexOf('/');
  while (slash > MEMORY_ROOT.length) {
    const ancestor = path.slice(0, slash) as MemoryPath;
    if (state.files.has(ancestor)) return ancestor;
    slash = ancestor.lastIndexOf('/');
  }
  return undefined;
}

function directoryEntries(state: State, path: MemoryPath) {
  const prefix = path === MEMORY_ROOT ? `${MEMORY_ROOT}/` : `${path}/`;
  const entries = new Map<string, { path: MemoryPath; kind: 'file' | 'directory' }>();
  for (const file of state.files.values()) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const [name, ...remaining] = rest.split('/');
    if (!name) continue;
    entries.set(name, {
      path: `${prefix}${name}` as MemoryPath,
      kind: remaining.length ? 'directory' : 'file',
    });
  }
  return [...entries.entries()]
    .sort(([left], [right]) => compareName(left, right))
    .map(([name, entry]) => ({ name, ...entry }));
}

async function loadSnapshot(config: GitConfig): Promise<Snapshot> {
  const oid = await readRef(config);
  if (!oid) return { state: { files: new Map(), nextWrite: 0 } };
  const type = await objectType(config, oid);
  if (type !== 'tree') {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory ref does not point to a tree.');
  }

  const root = await listTree(config, oid, SMALL_GIT_OUTPUT_BYTES);
  if (root.length !== 2) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory root tree has an unexpected layout.');
  }
  const metadataEntry = root.find((entry) => entry.name === META_NAME);
  const memoriesEntry = root.find((entry) => entry.name === 'memories');
  if (
    !metadataEntry ||
    metadataEntry.mode !== '100644' ||
    metadataEntry.type !== 'blob' ||
    !memoriesEntry ||
    memoriesEntry.mode !== '040000' ||
    memoriesEntry.type !== 'tree'
  ) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory root tree has an unsafe layout.');
  }

  const metadata = parseMetadata(
    await readBlob(config, metadataEntry.oid, metadataOutputLimit(config.limits)),
    config.scopeDigest,
  );
  validateStoredLimits(metadata, config.limits);
  const expectedDirectories = storedDirectories(metadata.entries);
  const entries = await listRecursiveTree(
    config,
    oid,
    treeOutputLimit(metadata.entries, expectedDirectories, config.oidLength),
  );
  const seenDirectories = new Set<string>();
  const files = new Map<MemoryPath, StoredFile>();
  for (const entry of entries) {
    if (entry.name === 'memories') {
      if (
        entry.mode !== memoriesEntry.mode ||
        entry.type !== memoriesEntry.type ||
        entry.oid !== memoriesEntry.oid
      ) {
        throw new StorageFault('UNSAFE_STORAGE', 'Memory tree contains an unsafe entry.');
      }
      continue;
    }
    if (entry.mode === '040000' && entry.type === 'tree') {
      if (!expectedDirectories.has(entry.name) || seenDirectories.has(entry.name)) {
        throw new StorageFault('UNSAFE_STORAGE', 'Memory tree contains an unsafe directory.');
      }
      seenDirectories.add(entry.name);
      continue;
    }
    if (
      entry.mode !== '100644' ||
      entry.type !== 'blob' ||
      !entry.name.startsWith('memories/')
    ) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory tree contains an unsafe entry.');
    }
    const publicPath = `/${entry.name}` as MemoryPath;
    const info = safeStoredFilePath(publicPath);
    const meta = metadata.entries.find((candidate) => candidate.path === info.path);
    if (!meta || files.has(info.path)) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata does not match stored content.');
    }
    const textValue = decode(await readBlob(config, entry.oid, meta.byteLength));
    if (meta.byteLength !== Buffer.byteLength(textValue, 'utf8')) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata does not match stored content.');
    }
    files.set(info.path, {
      path: info.path,
      text: textValue,
      byteLength: meta.byteLength,
      written: meta.written,
    });
  }

  if (
    seenDirectories.size !== expectedDirectories.size ||
    files.size !== metadata.entries.length ||
    totalBytes({ files, nextWrite: metadata.nextWrite }) !== metadata.totalBytes
  ) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata does not match the tree.');
  }
  const state: State = { files, nextWrite: metadata.nextWrite };
  for (const file of files.values()) {
    if (fileAncestor(state, file.path) !== undefined) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory tree contains a file and directory path conflict.');
    }
  }
  return { oid, state };
}

function parseMetadata(data: Buffer, scopeDigest: string): StoredMetadata {
  let raw: unknown;
  try {
    raw = JSON.parse(decode(data));
  } catch {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata is not valid JSON.');
  }
  if (!isRecord(raw) || raw.format !== FORMAT || raw.scopeDigest !== scopeDigest) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata belongs to another scope or format.');
  }
  const nextWrite = raw.nextWrite;
  const totalBytes = raw.totalBytes;
  const rawEntries = raw.entries;
  if (!isSafeCount(nextWrite) || !isSafeCount(totalBytes) || !Array.isArray(rawEntries)) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata is malformed.');
  }
  const paths = new Set<string>();
  const entries = rawEntries.map((entry): StoredMetadata['entries'][number] => {
    if (!isRecord(entry) || !isSafeCount(entry.byteLength) || !isPositiveCount(entry.written)) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata contains an invalid entry.');
    }
    const info = safeStoredFilePath(entry.path);
    if (paths.has(info.path) || entry.written > nextWrite) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata contains conflicting entries.');
    }
    paths.add(info.path);
    return { path: info.path, byteLength: entry.byteLength, written: entry.written };
  });
  return {
    format: raw.format,
    scopeDigest: raw.scopeDigest,
    nextWrite,
    totalBytes,
    entries,
  };
}

function validateStoredLimits(metadata: StoredMetadata, limits: MemoryLimits): void {
  if (metadata.entries.length > limits.maxFiles || metadata.totalBytes > limits.maxTotalBytes) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory storage exceeds the current limits.');
  }

  let declaredBytes = 0;
  for (const entry of metadata.entries) {
    if (entry.byteLength > limits.maxFileBytes || declaredBytes > Number.MAX_SAFE_INTEGER - entry.byteLength) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory storage exceeds the current limits.');
    }
    declaredBytes += entry.byteLength;
  }
  if (declaredBytes !== metadata.totalBytes) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory metadata does not match its declared byte total.');
  }
}

function storedDirectories(entries: StoredMetadata['entries']): Set<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.slice(`${MEMORY_ROOT}/`.length).split('/');
    let directory = 'memories';
    for (const segment of segments.slice(0, -1)) {
      directory = `${directory}/${segment}`;
      directories.add(directory);
    }
  }
  return directories;
}

async function writeState(config: GitConfig, state: State): Promise<string> {
  const root = treeNode();
  const metadata = metadataFor(state, config.scopeDigest);
  root.files.set(META_NAME, await hashBlob(config, Buffer.from(JSON.stringify(metadata), 'utf8')));
  const memories = treeNode();
  root.dirs.set('memories', memories);

  for (const file of [...state.files.values()].sort((left, right) => comparePath(left.path, right.path))) {
    const segments = file.path.slice(`${MEMORY_ROOT}/`.length).split('/');
    let node = memories;
    for (const segment of segments.slice(0, -1)) {
      const existing = node.dirs.get(segment);
      if (existing) node = existing;
      else {
        const child = treeNode();
        node.dirs.set(segment, child);
        node = child;
      }
    }
    node.files.set(segments.at(-1)!, await hashBlob(config, Buffer.from(file.text, 'utf8')));
  }
  return writeTree(config, root);
}

function metadataFor(state: State, scopeDigest: string): StoredMetadata {
  return {
    format: FORMAT,
    scopeDigest,
    nextWrite: state.nextWrite,
    totalBytes: totalBytes(state),
    entries: [...state.files.values()]
      .sort((left, right) => comparePath(left.path, right.path))
      .map((file) => ({
        path: file.path,
        byteLength: file.byteLength,
        written: file.written,
      })),
  };
}

function treeNode(): TreeNode {
  return { files: new Map(), dirs: new Map() };
}

async function writeTree(config: GitConfig, node: TreeNode): Promise<string> {
  const entries: { name: string; mode: string; type: string; oid: string }[] = [];
  for (const [name, oid] of node.files) entries.push({ name, mode: '100644', type: 'blob', oid });
  for (const [name, child] of node.dirs) {
    entries.push({ name, mode: '040000', type: 'tree', oid: await writeTree(config, child) });
  }
  entries.sort((left, right) => compareTreeName(left.name, left.type, right.name, right.type));
  const input = Buffer.concat(
    entries.map((entry) => Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t${entry.name}\0`, 'utf8')),
  );
  const result = await invoke(config.repositoryPath, ['mktree', '-z'], input);
  if (result.exitCode !== 0) throw new StorageFault('STORAGE_ERROR', 'Git could not write a memory tree.');
  return oid(text(result.stdout).trim(), config.oidLength);
}

async function hashBlob(config: GitConfig, value: Buffer): Promise<string> {
  const result = await invoke(config.repositoryPath, [
    'hash-object',
    '-w',
    '--no-filters',
    '--stdin',
  ], value);
  if (result.exitCode !== 0) throw new StorageFault('STORAGE_ERROR', 'Git could not write a memory blob.');
  return oid(text(result.stdout).trim(), config.oidLength);
}

async function updateRef(
  config: GitConfig,
  next: string,
  observed: string | undefined,
): Promise<'updated' | 'stale'> {
  const expected = observed ?? '0'.repeat(config.oidLength);
  const result = await invoke(config.repositoryPath, ['update-ref', config.ref, next, expected]);
  if (result.exitCode === 0) return 'updated';
  const actual = await readRef(config);
  if (actual !== observed) return 'stale';
  throw new StorageFault('STORAGE_ERROR', 'Git could not update the memory ref.');
}

async function readRef(config: GitConfig): Promise<string | undefined> {
  const symbolic = await invoke(config.repositoryPath, [
    'symbolic-ref',
    '--quiet',
    '--no-recurse',
    config.ref,
  ], undefined, SMALL_GIT_OUTPUT_BYTES);
  if (symbolic.exitCode === 0) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory ref must not be symbolic.');
  }
  if (symbolic.exitCode !== 1) {
    throw new StorageFault('STORAGE_ERROR', 'Git could not inspect the memory ref.');
  }
  const result = await invoke(config.repositoryPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    config.ref,
  ]);
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw new StorageFault('STORAGE_ERROR', 'Git could not read the memory ref.');
  return oid(text(result.stdout).trim(), config.oidLength);
}

async function objectType(config: GitConfig, value: string): Promise<string> {
  const result = await invoke(config.repositoryPath, ['cat-file', '-t', value], undefined, SMALL_GIT_OUTPUT_BYTES);
  if (result.exitCode !== 0) throw new StorageFault('UNSAFE_STORAGE', 'Memory ref points to a missing object.');
  return text(result.stdout).trim();
}

async function listTree(config: GitConfig, value: string, maxOutputBytes: number): Promise<TreeEntry[]> {
  const result = await invoke(config.repositoryPath, ['ls-tree', '-z', value], undefined, maxOutputBytes);
  if (result.exitCode !== 0) throw new StorageFault('UNSAFE_STORAGE', 'Memory tree cannot be read.');
  return parseTreeEntries(result.stdout, config.oidLength);
}

async function listRecursiveTree(
  config: GitConfig,
  value: string,
  maxOutputBytes: number,
): Promise<TreeEntry[]> {
  const result = await invoke(
    config.repositoryPath,
    ['ls-tree', '-r', '-t', '-z', value, '--', 'memories'],
    undefined,
    maxOutputBytes,
  );
  if (result.exitCode !== 0) throw new StorageFault('UNSAFE_STORAGE', 'Memory entries cannot be read.');
  return parseTreeEntries(result.stdout, config.oidLength);
}

async function readBlob(config: GitConfig, value: string, maxBytes: number): Promise<Buffer> {
  const size = await objectSize(config, value);
  if (size > maxBytes) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory blob exceeds its allowed size.');
  }
  const result = await invoke(config.repositoryPath, ['cat-file', 'blob', value], undefined, maxBytes);
  if (result.exitCode !== 0) throw new StorageFault('UNSAFE_STORAGE', 'Memory blob cannot be read.');
  if (result.stdout.byteLength !== size) {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory blob size changed while reading.');
  }
  return result.stdout;
}

async function objectSize(config: GitConfig, value: string): Promise<number> {
  const result = await invoke(config.repositoryPath, ['cat-file', '-s', value], undefined, SMALL_GIT_OUTPUT_BYTES);
  if (result.exitCode !== 0) throw new StorageFault('UNSAFE_STORAGE', 'Memory blob cannot be sized.');
  const raw = text(result.stdout).trim();
  if (!/^\d+$/.test(raw)) throw new StorageFault('UNSAFE_STORAGE', 'Git returned an invalid object size.');
  const size = Number(raw);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new StorageFault('UNSAFE_STORAGE', 'Git returned an invalid object size.');
  }
  return size;
}

async function invoke(
  repositoryPath: string,
  args: string[],
  input?: Buffer,
  maxOutputBytes = MAX_GIT_COMMAND_OUTPUT_BYTES,
): Promise<GitOutput> {
  try {
    const result = await runChild({
      executable: 'git',
      args: ['-C', repositoryPath, '-c', 'core.hooksPath=/dev/null', ...args],
      env: cleanGitEnvironment(),
      inheritParentEnv: false,
      ...(input === undefined ? {} : { stdin: input }),
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      killGraceMs: GIT_COMMAND_GRACE_MS,
      maxOutputBytes,
    });
    return {
      exitCode: result.exitCode ?? 1,
      stdout: Buffer.from(result.stdout),
      stderr: Buffer.from(result.stderr),
    };
  } catch (error) {
    if (error instanceof StorageFault) throw error;
    if (error instanceof RunChildError && error.code === 'OUTPUT_LIMIT') {
      throw new StorageFault('UNSAFE_STORAGE', 'Git output exceeded the memory storage limit.');
    }
    throw new StorageFault('STORAGE_ERROR', 'Git could not start.');
  }
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    ),
    GIT_NO_LAZY_FETCH: '1',
  };
}

function metadataOutputLimit(limits: MemoryLimits): number {
  return boundedOutputLimit(limits.maxFiles, METADATA_ENTRY_BYTES);
}

function treeOutputLimit(
  entries: StoredMetadata['entries'],
  directories: ReadonlySet<string>,
  oidLength: number,
): number {
  let bytes = treeEntryBytes('memories', oidLength);
  for (const directory of directories) bytes += treeEntryBytes(directory, oidLength);
  for (const entry of entries) bytes += treeEntryBytes(entry.path.slice(1), oidLength);
  return bytes;
}

function treeEntryBytes(path: string, oidLength: number): number {
  return TREE_ENTRY_FIXED_BYTES + oidLength + Buffer.byteLength(path, 'utf8');
}

function boundedOutputLimit(count: number, perEntryBytes: number): number {
  if (count > Math.floor((MAX_GIT_COMMAND_OUTPUT_BYTES - METADATA_FIXED_BYTES) / perEntryBytes)) {
    return MAX_GIT_COMMAND_OUTPUT_BYTES;
  }
  return Math.max(METADATA_FIXED_BYTES, METADATA_FIXED_BYTES + count * perEntryBytes);
}

function parseTreeEntries(value: Buffer, oidLength: number): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let start = 0;
  while (start < value.length) {
    const end = value.indexOf(0, start);
    if (end < 0) throw new StorageFault('UNSAFE_STORAGE', 'Git returned a malformed tree.');
    const record = value.subarray(start, end);
    start = end + 1;
    if (!record.length) continue;
    const tab = record.indexOf(9);
    if (tab < 0) throw new StorageFault('UNSAFE_STORAGE', 'Git returned a malformed tree entry.');
    const [mode, type, object] = text(record.subarray(0, tab)).split(' ');
    if (!mode || !type || !object) throw new StorageFault('UNSAFE_STORAGE', 'Git returned a malformed tree entry.');
    entries.push({
      mode,
      type,
      oid: oid(object, oidLength),
      name: decode(record.subarray(tab + 1)),
    });
  }
  return entries;
}

function resolveLimits(input: Partial<MemoryLimits> | undefined): MemoryLimits {
  const limits: MemoryLimits = {
    maxFileBytes: input?.maxFileBytes ?? DEFAULT_LIMITS.maxFileBytes,
    maxTotalBytes: input?.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
    maxFiles: input?.maxFiles ?? DEFAULT_LIMITS.maxFiles,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!isPositiveCount(value)) throw new TypeError(`${name} must be a positive safe integer`);
  }
  return limits;
}

function failure(
  command: string,
  code: MemoryErrorCode,
  message: string,
  path?: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): MemoryResult {
  return {
    ok: false,
    command,
    error: {
      code,
      message,
      ...(path === undefined ? {} : { path }),
      ...(details === undefined ? {} : { details }),
    },
  };
}

function digest(scope: string): string {
  return createHash('sha256').update(scope, 'utf8').digest('hex');
}

function oid(value: string, length: number): string {
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(value)) {
    throw new StorageFault('UNSAFE_STORAGE', 'Git returned an invalid object id.');
  }
  return value;
}

function text(value: Buffer): string {
  return value.toString('utf8');
}

function decode(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new StorageFault('UNSAFE_STORAGE', 'Memory content is not valid UTF-8.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function safeStoredFilePath(value: unknown): { readonly path: MemoryPath; readonly root: false; readonly segments: readonly string[] } {
  try {
    return assertFilePath(value);
  } catch (error) {
    if (error instanceof CommandFault) {
      throw new StorageFault('UNSAFE_STORAGE', 'Memory storage contains an invalid file path.');
    }
    throw error;
  }
}

function compareName(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function comparePath(left: string, right: string): number {
  return compareName(left, right);
}

function compareTreeName(
  leftName: string,
  leftType: string,
  rightName: string,
  rightType: string,
): number {
  return compareName(
    `${leftName}${leftType === 'tree' ? '/' : ''}`,
    `${rightName}${rightType === 'tree' ? '/' : ''}`,
  );
}
