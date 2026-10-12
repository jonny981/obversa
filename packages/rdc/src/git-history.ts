import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  asSourceReadError,
  canonicalPath,
  commitDate,
  GitFailure,
  pathNames,
  probeWorkTree,
  resolveCommit,
  runGit,
} from './git.js';
import { hits, taskTerms } from './markdown.js';
import type { MemoryCandidate } from './pick.js';
import {
  SourceReadError,
  type CandidateReadRequest,
  type CandidateReadResult,
  type CandidateSource,
} from './source.js';

export interface GitHistoryOptions {
  /** The source's stable id; defaults to `gitHistory:<resolved repo>`. */
  readonly id?: string;
  /** The repository key candidates declare. A link needs an equal value
   *  on both sides; defaults to the work-tree toplevel, and a
   *  caller-supplied key wins when it is set. */
  readonly repository?: string;
  /** Adds a `live_lines` signal to commits that wrote lines still live
   *  in the task's named paths. Costs one blame call per named file, so
   *  it runs only when asked. */
  readonly blame?: boolean;
  /** Adds a `co_change` signal to commits that touched files which
   *  historically change with the task's named paths. Costs extra log
   *  passes, so it runs only when asked. */
  readonly coChange?: boolean;
}

interface LogCommit {
  readonly sha: string;
  readonly short: string;
  readonly date: string;
  readonly subject: string;
  readonly body: string;
  readonly changedPaths: readonly string[];
}

/** Records are separated by \x1e and fields by \x1f; `-z` leaves paths
 *  literal and NUL-separated, so a name with spaces or non-ASCII bytes is
 *  never quoted. */
const FULL_FORMAT = '%x1e%H%x1f%h%x1f%cI%x1f%s%x1f%b%x1f';
const META_FORMAT = '%x1e%H%x1f%h%x1f%cI%x1f%s';

function parseLog(output: string, withBody: boolean): LogCommit[] {
  const commits: LogCommit[] = [];
  for (const record of output.split('\x1e')) {
    if (record.trim() === '') continue;
    const fields = record.split('\x1f');
    const [sha = '', short = '', date = ''] = fields;
    let subject = '';
    let body = '';
    let pathBlock = '';
    if (withBody) {
      subject = fields[3] ?? '';
      body = fields[4] ?? '';
      pathBlock = fields[5] ?? '';
    } else {
      const last = fields[3] ?? '';
      const boundary = last.indexOf('\0');
      subject = boundary < 0 ? last : last.slice(0, boundary);
      pathBlock = boundary < 0 ? '' : last.slice(boundary);
    }
    commits.push({
      sha,
      short,
      date: commitDate(date),
      subject,
      body: body.trim(),
      changedPaths: pathNames(pathBlock),
    });
  }
  return commits;
}

/** The body of each named commit, in one call. The SHAs ride on stdin
 *  rather than the command line: a kept list in the tens of thousands
 *  would overflow the argument cap before git ran. `--no-walk=unsorted`
 *  prints each commit in input order, so the records zip back to the
 *  SHAs that asked for them. */
async function readBodies(
  toplevel: string,
  shas: readonly string[],
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  if (shas.length === 0) return [];
  const output = await runGit(
    toplevel,
    ['log', '--no-walk=unsorted', '--stdin', '--format=%x1e%b'],
    { input: `${shas.join('\n')}\n`, signal },
  );
  return output.split('\x1e').slice(1).map((body) => body.trim());
}

/** A path a caller wrote, as a repository-relative path. Absolute paths
 *  are relativised against the toplevel: outside it they can match
 *  nothing. The root itself, or an ancestor of it (a relative form of
 *  only `..` segments), comes back as '', which names every repository
 *  path beneath it. Relative ones are cleaned of `./` and trailing
 *  slashes; '.', './' and '' name the root the same way. */
function repoPath(entry: string, toplevel: string): string | undefined {
  if (isAbsolute(entry)) {
    const within = relative(toplevel, entry).split(sep).join('/');
    const segments = within.split('/');
    if (within === '' || segments.every((segment) => segment === '..')) {
      return '';
    }
    return segments[0] === '..' ? undefined : within;
  }
  const cleaned = entry.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return cleaned === '' || cleaned === '.' ? '' : cleaned;
}

function touches(changedPaths: readonly string[], named: readonly string[]): boolean {
  // '' is the repository root: every changed path sits beneath it.
  return named.some((path) => path === ''
    || changedPaths.some((changed) => changed === path || changed.startsWith(`${path}/`)));
}

const NO_COMMIT = /Needed a single revision|does not have any commits|unknown revision|ambiguous argument/i;
/** How many files blame may open per read; the signal stays cheap even
 *  when the task names a large tree. */
const BLAME_FILE_CAP = 60;
/** Co-change looks back this many commits touching the named paths. */
const CO_CHANGE_WINDOW = 200;
/** A file becomes a co-change neighbour once it changed beside a named
 *  path this often inside the window. */
const CO_CHANGE_MIN_TOUCHES = 3;
const CO_CHANGE_NEIGHBOUR_CAP = 10;

/**
 * A repository's commit history: one candidate per non-merge commit,
 * newest first, carrying its subject, body, commit date and the files it
 * changed. Git runs through the package's own helper: `execFile` with no
 * shell, a scrubbed environment, a time limit, an output limit, and the
 * request's abort signal reaching the process.
 *
 * With no exclusions, one `git log` pass enumerates commits and paths.
 * With exclusions, a metadata pass lists paths first and a commit that
 * touched any excluded path is dropped before its body is ever fetched.
 * `blame` and `coChange` are opt-in extras on top.
 */
export function gitHistory(
  repo: string | URL,
  options: GitHistoryOptions = {},
): CandidateSource {
  const directory = repo instanceof URL ? fileURLToPath(repo) : repo;
  if (typeof directory !== 'string' || directory.trim() === '') {
    throw new TypeError('repo must be a directory path or a file: URL.');
  }
  const resolved = resolve(directory);
  const id = options.id ?? `gitHistory:${resolved}`;
  return {
    id,
    role: 'reference',
    async read(request) {
      const signal = request.signal;
      if (signal?.aborted) throw new SourceReadError('cancelled', 'The read was cancelled.');
      if (request.limit !== undefined
        && (!Number.isSafeInteger(request.limit) || request.limit < 1)) {
        throw new TypeError('limit must be a positive safe integer.');
      }
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { status: 'absent', reason: 'not-a-directory' };
        }
        throw new SourceReadError('failed', `Could not inspect ${resolved}: ${String(error)}`);
      }
      if (!info.isDirectory()) return { status: 'absent', reason: 'not-a-directory' };

      let probe;
      let toplevel: string;
      try {
        probe = await probeWorkTree(resolved, signal);
        // realpath matches knowledgeBase's canonicalisation, so a
        // repository key is the same value on both sides of a link.
        toplevel = probe.status === 'worktree' ? await realpath(probe.toplevel) : '';
      } catch (error) {
        throw asSourceReadError(error);
      }
      if (probe.status === 'absent') return probe;

      // The pinned revision (HEAD by default) is resolved once here, at
      // read start; every git call below addresses the SHA it returned,
      // so the whole read sees one snapshot even when HEAD moves on.
      let sha: string;
      try {
        sha = await resolveCommit(toplevel, request.revision ?? 'HEAD', signal);
      } catch (error) {
        if (error instanceof GitFailure) {
          if (error.kind === 'cancelled') throw new SourceReadError('cancelled', 'The read was cancelled.');
          if (request.revision !== undefined || !NO_COMMIT.test(error.stderr)) {
            throw new SourceReadError(
              'failed',
              request.revision === undefined
                ? `Could not resolve the default revision: ${error.message}`
                : `The pinned revision ${request.revision} is not in this repository.`,
            );
          }
          return { status: 'absent', reason: 'no-history' };
        }
        throw error;
      }

      try {
        // Exclusions are resolved to repository-relative paths first.
        // An absolute entry is canonicalised through realpath, because
        // the toplevel is: an entry written through a symlinked path (a
        // /var tmpdir, a linked workspace) would otherwise escape the
        // toplevel spelling and be dropped, failing the exclusion open.
        const excluded = new Set<string>();
        for (const entry of request.exclude ?? []) {
          const path = repoPath(
            isAbsolute(entry) ? await canonicalPath(entry) : entry,
            toplevel,
          );
          if (path !== undefined) excluded.add(path);
        }
        // With no exclusions, one more commit than the limit is
        // enumerated so `complete` knows whether the list was truncated,
        // and the single log pass carries bodies with it. With
        // exclusions the order changes: a metadata pass enumerates
        // everything without the limit, the excluded-path filter admits
        // commits first, and the limit slices the admitted set — a run
        // of excluded commits can never eat the window. The bodies of
        // admitted commits come from one batched `git log --stdin` below.
        const wanted = excluded.size === 0 && request.limit !== undefined
          ? request.limit + 1
          : undefined;
        const logArgs = [
          'log', '--no-merges', '--no-renames', '-z',
          `--format=${excluded.size === 0 ? FULL_FORMAT : META_FORMAT}`,
          '--name-only',
        ];
        if (wanted !== undefined) logArgs.push('-n', String(wanted));
        logArgs.push(sha);
        const enumerated = parseLog(
          await runGit(toplevel, logArgs, { signal }),
          excluded.size === 0,
        );
        // A commit touching any excluded path is not admitted, even when
        // it also touched an allowed one; its body is never fetched.
        const admitted = excluded.size === 0
          ? enumerated
          : enumerated.filter((commit) => !touches(commit.changedPaths, [...excluded]));
        const truncated = request.limit !== undefined && admitted.length > request.limit;
        const kept = request.limit === undefined ? admitted : admitted.slice(0, request.limit);
        const commits: LogCommit[] = excluded.size === 0
          ? kept
          : (await readBodies(toplevel, kept.map((commit) => commit.sha), signal))
            .map((body, index) => ({ ...kept[index]!, body }));

        const terms = taskTerms(request.task, request.paths ?? []);
        const named: string[] = [];
        for (const path of request.paths ?? []) {
          const name = repoPath(
            isAbsolute(path) ? await canonicalPath(path) : path,
            toplevel,
          );
          if (name !== undefined) named.push(name);
        }
        // '' (a hint that named the root) is not a pathspec git accepts;
        // '.' under `git -C <toplevel>` names the same whole tree.
        const pathspec = named.map((name) => (name === '' ? '.' : name));
        const now = Date.now();
        const bySha = new Map(commits.map((commit) => [commit.sha, commit] as const));
        const liveLines = new Map<string, number>();
        const coChange = new Map<string, number>();
        if (options.blame === true && named.length > 0) {
          // `paths` hints are not exempt from exclusion: a hint naming
          // an excluded file still never has its contents opened. The
          // filter runs before the cap so excluded files cannot eat it.
          const files = (
            await runGit(toplevel, ['ls-tree', '-r', '-z', '--name-only', sha, '--', ...pathspec], { signal })
          ).split('\0').filter((name) => name !== '')
            .filter((file) => !touches([file], [...excluded]))
            .slice(0, BLAME_FILE_CAP);
          for (const file of files) {
            let output = '';
            try {
              output = await runGit(toplevel, ['blame', '--line-porcelain', sha, '--', file], { signal });
            } catch (error) {
              // A file that cannot be blamed contributes nothing; an
              // abort is never swallowed.
              if (error instanceof GitFailure && error.kind === 'cancelled') throw error;
              continue;
            }
            const counts = new Map<string, number>();
            for (const match of output.matchAll(/^([0-9a-f]{40}) /gm)) {
              counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
            }
            for (const [blamed, lines] of counts) {
              if (bySha.has(blamed)) {
                liveLines.set(blamed, (liveLines.get(blamed) ?? 0) + lines);
              }
            }
          }
        }
        if (options.coChange === true && named.length > 0) {
          // The window pass names only the commits that touched a named
          // path; a `--name-only` log under the pathspec would list just
          // the named files, so the full path lists come from one
          // batched `git show` over those commits instead.
          const windowShas = (await runGit(toplevel, [
            'log', '--no-merges', '--format=%H',
            '-n', String(CO_CHANGE_WINDOW), sha, '--', ...pathspec,
          ], { signal }))
            .split('\n').map((line) => line.trim()).filter((line) => line !== '');
          const together = new Map<string, number>();
          if (windowShas.length > 0) {
            const detail = await runGit(toplevel, [
              'show', '-z', '--format=%x1e%H', '--no-renames', '--name-only', ...windowShas,
            ], { signal });
            for (const record of detail.split('\x1e')) {
              if (record.trim() === '') continue;
              const boundary = record.indexOf('\0');
              for (const file of pathNames(boundary < 0 ? '' : record.slice(boundary))) {
                if (!touches([file], named)) together.set(file, (together.get(file) ?? 0) + 1);
              }
            }
          }
          const neighbours = [...together.entries()]
            .filter(([, count]) => count >= CO_CHANGE_MIN_TOUCHES)
            .sort((left, right) => right[1] - left[1])
            .slice(0, CO_CHANGE_NEIGHBOUR_CAP)
            .map(([file]) => file);
          if (neighbours.length > 0) {
            const touched = await runGit(toplevel, [
              'log', '--no-merges', '--format=%H', '-n', '300', sha, '--', ...neighbours,
            ], { signal });
            for (const line of touched.split('\n')) {
              const commitSha = line.trim();
              if (bySha.has(commitSha)) coChange.set(commitSha, 1);
            }
          }
        }

        const candidates: MemoryCandidate[] = commits.map((commit) => {
          const signals: Record<string, number> = {};
          const shared = hits(`${commit.subject}\n${commit.body}`, terms);
          if (shared > 0) signals['shared_words'] = Math.min(3, shared);
          const ageDays = (now - Date.parse(commit.date)) / 86_400_000;
          signals['recency'] = Math.exp(-Math.max(0, ageDays) / 60);
          if (named.length > 0 && touches(commit.changedPaths, named)) {
            signals['named_path_touch'] = 3;
          }
          const lines = liveLines.get(commit.sha);
          if (lines !== undefined) signals['live_lines'] = 2 + Math.log10(lines);
          if (coChange.has(commit.sha)) signals['co_change'] = 1;
          return {
            sourceId: id,
            sourceRevision: sha,
            role: 'reference',
            id: `commit ${commit.short}`,
            title: commit.subject,
            text: commit.body,
            contentRef: commit.sha,
            date: { value: commit.date, meaning: 'recorded' as const },
            changedPaths: commit.changedPaths,
            repository: options.repository ?? toplevel,
            signals,
          };
        });

        return {
          status: 'read',
          revision: sha,
          candidates,
          complete: !truncated,
          ...(truncated
            ? {
                partial: excluded.size === 0
                  ? `the limit kept ${kept.length} ${kept.length === 1 ? 'commit' : 'commits'}; more exist`
                  : `the limit kept ${kept.length} of ${admitted.length} admitted commits`,
              }
            : {}),
        };
      } catch (error) {
        throw asSourceReadError(error);
      }
    },
  };
}
