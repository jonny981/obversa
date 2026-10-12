import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { SourceReadError } from './source.js';

/** How long one git call may run before the process is killed. */
const GIT_TIMEOUT_MS = 30_000;
/** Cap on each output stream (stdout, stderr) of one git call; beyond it the read fails. */
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** Why a git invocation did not produce output. */
export type GitFailureKind = 'spawn' | 'exit' | 'timeout' | 'output' | 'cancelled';

export class GitFailure extends Error {
  readonly kind: GitFailureKind;
  readonly code: number | null;
  readonly stderr: string;

  constructor(kind: GitFailureKind, message: string, code: number | null = null, stderr = '') {
    super(message);
    this.name = 'GitFailure';
    this.kind = kind;
    this.code = code;
    this.stderr = stderr;
  }
}

/** The caller's environment minus every GIT_* variable, so a repository
 *  the caller had open (GIT_DIR, GIT_WORK_TREE, an in-progress rebase)
 *  cannot steer the read. On git 2.44 and later, GIT_NO_LAZY_FETCH makes a
 *  partial clone read local objects or fail fast rather than hang on a
 *  fetch; older git ignores it. LC_ALL pins the message locale:
 *  git translates its stderr and the absent/throw decision matches the
 *  English text, which LC_ALL 'C' guarantees (it overrides LANGUAGE). */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    ),
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C',
  };
}

interface GitOptions {
  readonly input?: string;
  readonly signal?: AbortSignal;
}

function exec(repo: string, args: readonly string[], options: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      // hooksPath keeps the person's hooks out of the read; a caller's
      // log.showSignature would print signature lines the parsers do not
      // expect, so it is turned off the same way.
      ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'log.showSignature=false', ...args],
      {
        encoding: 'buffer',
        env: gitEnvironment(),
        timeout: GIT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        signal: options.signal,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        const detail = stderr.toString('utf8').trim();
        if (options.signal?.aborted) {
          reject(new GitFailure('cancelled', 'The read was cancelled.'));
        } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new GitFailure('spawn', 'git could not start'));
        } else if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new GitFailure('output', 'git output exceeded the read limit'));
        } else if (error.killed) {
          reject(new GitFailure('timeout', `git did not finish within ${GIT_TIMEOUT_MS} ms`));
        } else {
          reject(new GitFailure(
            'exit',
            detail || error.message,
            typeof error.code === 'number' ? error.code : null,
            detail,
          ));
        }
      },
    );
    if (options.input !== undefined) {
      // A child that exits before the input lands reports EPIPE here; the
      // real error already reached the callback, so the write error is noise.
      child.stdin!.on('error', () => {});
      child.stdin!.end(options.input);
    }
  });
}

/** One git call inside `repo`: no shell, the scrubbed environment, the
 *  timeout, the output cap, and the request's abort signal reaching the
 *  process. Rejects with GitFailure; callers map its kind onto their own
 *  absent/throw contract. */
export async function runGit(
  repo: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  return (await exec(repo, args, options)).toString('utf8');
}

/** The same call for byte output (cat-file streams), where lossy text
 *  decoding would corrupt the size-prefixed parse. */
export async function runGitBytes(
  repo: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<Buffer> {
  return exec(repo, args, options);
}

export type WorkTreeProbe =
  | { readonly status: 'worktree'; readonly toplevel: string }
  | { readonly status: 'absent'; readonly reason: 'no-git-binary' | 'no-history' };

// 'must be run in a work tree' is a bare repository or a .git directory.
const NOT_A_REPOSITORY = /not a git repository|not in a work tree|must be run in a work tree/i;

/** Whether `directory` sits inside a git work tree. A missing git binary
 *  and a directory with no repository are the expected absences; a
 *  repository the caller cannot read (permissions, unsafe-ownership
 *  refusal) still throws. */
export async function probeWorkTree(
  directory: string,
  signal: AbortSignal | undefined,
): Promise<WorkTreeProbe> {
  try {
    const output = await runGit(directory, ['rev-parse', '--show-toplevel'], { signal });
    return { status: 'worktree', toplevel: output.trim() };
  } catch (error) {
    if (error instanceof GitFailure) {
      if (error.kind === 'cancelled') throw error;
      if (error.kind === 'spawn') return { status: 'absent', reason: 'no-git-binary' };
      if (error.kind === 'exit' && NOT_A_REPOSITORY.test(error.stderr)) {
        return { status: 'absent', reason: 'no-history' };
      }
    }
    throw error;
  }
}

/** Resolve a revision string to its commit SHA. An unresolvable revision
 *  arrives as a GitFailure('exit'); the caller decides whether that is an
 *  absence or a read failure. */
export async function resolveCommit(
  repo: string,
  revision: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const output = await runGit(repo, ['rev-parse', '--verify', `${revision}^{commit}`], { signal });
  return output.trim();
}

/** `log`/`show -z` print a commit's path list as `\x00\n` + NUL-separated
 *  names, so the first name carries git's newline separator; later names
 *  are raw (a real file name may itself contain a newline). */
export function pathNames(pathBlock: string): string[] {
  const names = pathBlock.split('\0').filter((name) => name !== '');
  if (names.length > 0 && names[0]!.startsWith('\n')) names[0] = names[0]!.slice(1);
  return names;
}

/** The canonical absolute form of a caller-written path: the deepest
 *  existing ancestor realpath'd with the tail rejoined, so a path
 *  written through a symlink (a /var tmpdir, a linked workspace) names
 *  the same file the realpath'd toplevel names. An exclusion that
 *  silently failed to canonicalise would fail open, so a path that
 *  exists nowhere still resolves lexically. */
export async function canonicalPath(entry: string): Promise<string> {
  let pending = resolve(entry);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(pending), ...tail);
    } catch {
      const parent = dirname(pending);
      if (parent === pending) return pending;
      tail.unshift(basename(pending));
      pending = parent;
    }
  }
}

/** Fold a git failure into the source contract's error. Cancellation
 *  keeps its own code so a caller can tell an aborted read from a broken
 *  one. */
export function asSourceReadError(error: unknown): SourceReadError {
  if (error instanceof SourceReadError) return error;
  if (error instanceof GitFailure && error.kind === 'cancelled') {
    return new SourceReadError('cancelled', 'The read was cancelled.');
  }
  return new SourceReadError('failed', error instanceof Error ? error.message : String(error));
}
