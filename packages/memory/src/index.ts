export const MEMORY_ROOT = '/memories' as const;

export type MemoryPath = typeof MEMORY_ROOT | `${typeof MEMORY_ROOT}/${string}`;

export type MemoryCommandName =
  | 'view'
  | 'create'
  | 'str_replace'
  | 'insert'
  | 'delete'
  | 'rename';

export interface MemoryViewCommand {
  readonly command: 'view';
  readonly path: MemoryPath;
  readonly viewRange?: readonly [startLine: number, endLine: number | -1];
}

export interface MemoryCreateCommand {
  readonly command: 'create';
  readonly path: MemoryPath;
  readonly text: string;
}

export interface MemoryStrReplaceCommand {
  readonly command: 'str_replace';
  readonly path: MemoryPath;
  readonly oldText: string;
  readonly newText: string;
}

export interface MemoryInsertCommand {
  readonly command: 'insert';
  readonly path: MemoryPath;
  readonly insertLine: number;
  readonly text: string;
}

export interface MemoryDeleteCommand {
  readonly command: 'delete';
  readonly path: MemoryPath;
}

export interface MemoryRenameCommand {
  readonly command: 'rename';
  readonly oldPath: MemoryPath;
  readonly newPath: MemoryPath;
}

export type MemoryCommand =
  | MemoryViewCommand
  | MemoryCreateCommand
  | MemoryStrReplaceCommand
  | MemoryInsertCommand
  | MemoryDeleteCommand
  | MemoryRenameCommand;

export interface MemoryDirectoryEntry {
  readonly name: string;
  readonly path: MemoryPath;
  readonly kind: 'file' | 'directory';
}

export interface MemoryDirectoryView {
  readonly kind: 'directory';
  readonly path: MemoryPath;
  readonly entries: readonly MemoryDirectoryEntry[];
}

export interface MemoryFileView {
  readonly kind: 'file';
  readonly path: MemoryPath;
  readonly text: string;
  readonly byteLength: number;
  readonly lines: {
    readonly start: number;
    readonly end: number;
    readonly total: number;
  };
}

export type MemoryView = MemoryDirectoryView | MemoryFileView;

export interface MemoryCreateReceipt {
  readonly path: MemoryPath;
  readonly byteLength: number;
  readonly evicted: readonly MemoryPath[];
  readonly overwritten: boolean;
}

export interface MemoryWriteReceipt {
  readonly path: MemoryPath;
  readonly byteLength: number;
  readonly evicted: readonly MemoryPath[];
}

export interface MemoryDeleteReceipt {
  readonly path: MemoryPath;
  readonly kind: 'file' | 'directory';
  readonly deletedFiles: number;
  readonly freedBytes: number;
}

export interface MemoryRenameReceipt {
  readonly oldPath: MemoryPath;
  readonly newPath: MemoryPath;
  readonly kind: 'file' | 'directory';
  readonly movedFiles: number;
}

export type MemoryErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_ARGUMENT'
  | 'INVALID_PATH'
  | 'ROOT_PROTECTED'
  | 'INVALID_EXTENSION'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PATH_CONFLICT'
  | 'INVALID_RANGE'
  | 'MATCH_NOT_FOUND'
  | 'MATCH_NOT_UNIQUE'
  | 'LIMIT_EXCEEDED'
  | 'CONFLICT'
  | 'UNSAFE_STORAGE'
  | 'STORAGE_ERROR';

export interface MemoryError {
  readonly code: MemoryErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export type MemorySuccess =
  | { readonly ok: true; readonly command: 'view'; readonly value: MemoryView }
  | { readonly ok: true; readonly command: 'create'; readonly value: MemoryCreateReceipt }
  | { readonly ok: true; readonly command: 'str_replace'; readonly value: MemoryWriteReceipt }
  | { readonly ok: true; readonly command: 'insert'; readonly value: MemoryWriteReceipt }
  | { readonly ok: true; readonly command: 'delete'; readonly value: MemoryDeleteReceipt }
  | { readonly ok: true; readonly command: 'rename'; readonly value: MemoryRenameReceipt };

export interface MemoryFailure {
  readonly ok: false;
  readonly command: string;
  readonly error: MemoryError;
}

export type MemoryResult = MemorySuccess | MemoryFailure;

export interface MemoryLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxFiles: number;
}

export interface Memory {
  readonly scope: string;
  execute(command: MemoryCommand): Promise<MemoryResult>;
}

export * from './mechanics.js';
