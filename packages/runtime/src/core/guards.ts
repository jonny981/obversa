/**
 * Hardening gates that keep a convergence loop honest without spending a
 * model call — deterministic conditions in the supervisor-orchestrator
 * tradition, adapted to the Obversa runtime:
 *
 * - `ratchet`: a measured metric may only hold or improve against a
 *   runtime-owned baseline that is written **only in the improving
 *   direction**, so the agent can never loosen its own bar.
 * - `writeScope`: every pending workspace change introduced since loop entry
 *   must match a declared glob, so pre-existing dirt cannot wedge a scoped job.
 * - `sampled`: run an expensive condition on a deterministic bucket of
 *   iterations (a sha256 cut, so re-runs land on the same side), treating the
 *   unsampled rest as met — how a costly judge stays affordable on a
 *   high-iteration loop.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

import type { Condition, ConditionInput, JobContext } from './types.js';
import {
  prepareCondition,
  toCondition,
  withConditionPreparation,
} from './condition.js';
import { resolveEnv } from './env-overlay.js';
import { setLabel } from './describe.js';
import { workspaceFingerprint } from './git.js';
import { scrubCapture } from './redact.js';

// ── ratchet ────────────────────────────────────────────────────────────────

export interface RatchetOptions {
  /** The metric key to read from the command's JSON output. */
  metric: string;
  /** Which way is better: `down` (default; the value must not rise — lint
   *  errors, bundle bytes, TODO count) or `up` (must not fall — coverage). */
  direction?: 'down' | 'up';
  /** Where baselines live. Default `<OBVERSA_HOME|~/.obversa>/ratchets` — outside
   *  the workspace, so the baseline is never edited or committed by the loop
   *  it constrains. */
  baselineDir?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

interface Baseline {
  value: number;
  updatedAt: number;
}

function baselineHome(opts: RatchetOptions): string {
  return (
    opts.baselineDir ??
    join(process.env.OBVERSA_HOME ?? join(homedir(), '.obversa'), 'ratchets')
  );
}

/** One baseline per (workspace, command, metric): the same recipe ratchets the
 *  same file across runs, and two workspaces never share a bar. */
function baselinePath(
  opts: RatchetOptions,
  dir: string,
  command: string,
  args: string[],
): string {
  const key = createHash('sha256')
    .update([dir, command, ...args, opts.metric].join('\u0000'))
    .digest('hex')
    .slice(0, 16);
  return join(baselineHome(opts), `${key}.json`);
}

function readBaseline(path: string): Baseline | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    return typeof raw.value === 'number' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function writeBaseline(path: string, value: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ value, updatedAt: Date.now() }));
}

/** The last parseable JSON object in the output: metric emitters print the
 *  JSON last, after any human-readable noise. */
function metricsFrom(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as { metrics?: Record<string, unknown> };
      if (parsed && typeof parsed === 'object') {
        return (parsed.metrics ?? parsed) as Record<string, unknown>;
      }
    } catch {
      /* keep scanning upward */
    }
  }
  try {
    const parsed = JSON.parse(stdout) as { metrics?: Record<string, unknown> };
    return (parsed.metrics ?? parsed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic gate over a **measured, monotone** signal. Runs `command`,
 * reads `metric` from its JSON output (`{"metrics": {"<name>": n}}`, or a
 * bare object), and is met only when the value holds or improves on the
 * stored baseline. The baseline is runtime-owned and written only in the
 * improving direction — the first run seeds it — so the constrained loop can
 * neither loosen nor forget its own bar. Everything else fails closed: a
 * command failure, missing metric, or unparsable output is "not met".
 */
export function ratchet(
  command: string,
  args: string[] = [],
  opts: RatchetOptions,
): Condition {
  const direction = opts.direction ?? 'down';
  return setLabel(async (ctx) => {
    const dir = opts.cwd ?? ctx.workspace.dir;
    const env = resolveEnv(ctx, opts.env);
    let stdout: string;
    try {
      const r = await execa(command, args, {
        cwd: dir,
        timeout: opts.timeoutMs,
        cancelSignal: ctx.signal,
        reject: false,
        stdin: 'ignore',
        env,
      });
      if (r.exitCode !== 0 || r.timedOut) {
        return {
          met: false,
          reason: r.timedOut
            ? `ratchet command \`${command}\` timed out after ${opts.timeoutMs} ms`
            : `ratchet command \`${command}\` exited ${r.exitCode ?? '?'}`,
          output: scrubCapture(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, env, 4000),
        };
      }
      stdout = r.stdout ?? '';
    } catch (e) {
      return {
        met: false,
        reason: `ratchet command \`${command}\` failed to run: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const metrics = metricsFrom(stdout);
    const value = metrics?.[opts.metric];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        met: false,
        reason: `ratchet metric "${opts.metric}" missing from \`${command}\` output (fail-closed)`,
        output: scrubCapture(stdout, env, 2000),
      };
    }
    const path = baselinePath(opts, dir, command, args);
    const baseline = readBaseline(path);
    if (!baseline) {
      writeBaseline(path, value);
      return {
        met: true,
        reason: `ratchet "${opts.metric}" baseline seeded at ${value}`,
      };
    }
    const improvedOrHeld =
      direction === 'down' ? value <= baseline.value : value >= baseline.value;
    if (!improvedOrHeld) {
      return {
        met: false,
        reason: `ratchet "${opts.metric}" regressed: ${value} vs baseline ${baseline.value} (must go ${direction})`,
      };
    }
    // Written only in the improving direction: a held bar stays put.
    if (value !== baseline.value) writeBaseline(path, value);
    return {
      met: true,
      reason: `ratchet "${opts.metric}" ${value === baseline.value ? 'held at' : 'improved to'} ${value} (baseline ${baseline.value})`,
    };
  }, `ratchet ${opts.metric} via ${command}`);
}

// ── writeScope ─────────────────────────────────────────────────────────────

/** Minimal glob → RegExp: `**` crosses directories, `*` stays inside one,
 *  `?` is a single char. Enough for scope declarations without a dependency. */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches nothing (so `src/**/x` covers `src/x`).
        out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += /[a-zA-Z0-9_/-]/.test(ch) ? ch : `\\${ch}`;
    }
  }
  return new RegExp(`${out}$`);
}

export interface WriteScopeOptions {
  cwd?: string;
  /** Compare pending changes with loop entry, or require the whole tree to fit. */
  mode?: 'delta' | 'absolute';
}

interface WorkspaceChanges {
  entries: Map<string, string>;
  error?: string;
}

interface StatusEntry {
  status: string;
  path: string;
}

interface DirtyPath extends StatusEntry {
  kind: 'file' | 'directory' | 'missing';
  mode: number;
}

interface PathProbe {
  values: Map<string, string>;
  error?: string;
}

const PATH_PROBE_CHUNK = 200;

function statusEntries(stdout: string): StatusEntry[] {
  const records = stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    entries.push({ status, path: record.slice(3) });
    // Porcelain v1 -z emits a second path record for renames and copies.
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return entries;
}

function dirtyPath(dir: string, entry: StatusEntry): DirtyPath {
  try {
    const stat = lstatSync(join(dir, entry.path));
    return {
      ...entry,
      kind: stat.isDirectory() ? 'directory' : 'file',
      mode: stat.mode,
    };
  } catch {
    return { ...entry, kind: 'missing', mode: 0 };
  }
}

function pathChunks(paths: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < paths.length; index += PATH_PROBE_CHUNK) {
    chunks.push(paths.slice(index, index + PATH_PROBE_CHUNK));
  }
  return chunks;
}

async function worktreeHashes(
  dir: string,
  paths: string[],
  signal: AbortSignal,
): Promise<PathProbe> {
  const values = new Map<string, string>();
  for (const chunk of pathChunks(paths)) {
    const result = await execa(
      'git',
      ['hash-object', '--no-filters', '--', ...chunk],
      {
        cwd: dir,
        cancelSignal: signal,
        reject: false,
        stdin: 'ignore',
      },
    );
    const hashes = (result.stdout ?? '').split('\n').filter(Boolean);
    if (result.exitCode !== 0 || hashes.length !== chunk.length) {
      return {
        values,
        error: 'writeScope: file hashing failed (fail-closed)',
      };
    }
    chunk.forEach((path, index) => values.set(path, hashes[index]!));
  }
  return { values };
}

async function indexEntries(
  dir: string,
  paths: string[],
  signal: AbortSignal,
): Promise<PathProbe> {
  const values = new Map<string, string>();
  for (const chunk of pathChunks(paths)) {
    const result = await execa(
      'git',
      [
        '--literal-pathspecs',
        'ls-files',
        '--stage',
        '-z',
        '--',
        ...chunk,
      ],
      {
        cwd: dir,
        cancelSignal: signal,
        reject: false,
        stdin: 'ignore',
        stripFinalNewline: false,
      },
    );
    if (result.exitCode !== 0) {
      return {
        values,
        error: 'writeScope: index inspection failed (fail-closed)',
      };
    }
    for (const record of (result.stdout ?? '').split('\0')) {
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const path = record.slice(tab + 1);
      const state = record.slice(0, tab);
      values.set(path, [values.get(path), state].filter(Boolean).join('\n'));
    }
  }
  return { values };
}

async function nestedFingerprints(
  dir: string,
  paths: string[],
  signal: AbortSignal,
): Promise<PathProbe> {
  const values = new Map<string, string>();
  const fingerprints = await Promise.all(
    paths.map(async (path) => [
      path,
      await workspaceFingerprint({ cwd: join(dir, path), signal }),
    ] as const),
  );
  for (const [path, fingerprint] of fingerprints) {
    if (!fingerprint) {
      return {
        values,
        error: `writeScope: cannot fingerprint directory "${path}" (fail-closed)`,
      };
    }
    values.set(path, fingerprint);
  }
  return { values };
}

async function workspaceChanges(
  dir: string,
  signal: AbortSignal,
): Promise<WorkspaceChanges> {
  try {
    const status = await execa(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      {
        cwd: dir,
        cancelSignal: signal,
        reject: false,
        stdin: 'ignore',
        stripFinalNewline: false,
      },
    );
    if (status.exitCode !== 0) {
      return {
        entries: new Map(),
        error: 'writeScope: not a git repository (fail-closed)',
      };
    }

    const dirty = statusEntries(status.stdout ?? '').map((entry) =>
      dirtyPath(dir, entry),
    );
    const filePaths = dirty
      .filter((entry) => entry.kind === 'file')
      .map((entry) => entry.path);
    const directoryPaths = dirty
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => entry.path);
    const allPaths = dirty.map((entry) => entry.path);
    const [worktree, index, nested] = await Promise.all([
      worktreeHashes(dir, filePaths, signal),
      indexEntries(dir, allPaths, signal),
      nestedFingerprints(dir, directoryPaths, signal),
    ]);
    const probeError = worktree.error ?? index.error ?? nested.error;
    if (probeError) return { entries: new Map(), error: probeError };

    const entries = new Map<string, string>();
    for (const entry of dirty) {
      const signature = createHash('sha256')
        .update(entry.status)
        .update('\0')
        .update(String(entry.mode))
        .update('\0')
        .update(
          entry.kind === 'file'
            ? worktree.values.get(entry.path)!
            : entry.kind === 'directory'
              ? nested.values.get(entry.path)!
              : '[missing]',
        )
        .update('\0')
        .update(index.values.get(entry.path) ?? '[not-indexed]')
        .digest('hex');
      entries.set(entry.path, signature);
    }
    return { entries };
  } catch (error) {
    return {
      entries: new Map(),
      error: `writeScope: git status failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function changedSince(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path));
}

/**
 * Met only when every staged, unstaged, or untracked change introduced since
 * the enclosing loop started matches a declared glob. This ignores untouched
 * pre-existing dirt without hiding a body edit to an already-dirty file. Use
 * `mode: 'absolute'` when the complete pending state must fit the scope.
 * Outside a loop, evaluation is absolute. A workspace that is not a git
 * repository fails closed.
 */
export function writeScope(
  globs: string[],
  opts: WriteScopeOptions = {},
): Condition {
  const patterns = globs.map(globToRegExp);
  const label = `writeScope ${globs.join(', ')}`;
  const condition = (baseline?: WorkspaceChanges): Condition =>
    setLabel(async (ctx) => {
      if (baseline?.error) return { met: false, reason: baseline.error };
      const current = await workspaceChanges(
        opts.cwd ?? ctx.workspace.dir,
        ctx.signal,
      );
      if (current.error) return { met: false, reason: current.error };
      const changed = baseline
        ? changedSince(baseline.entries, current.entries)
        : [...current.entries.keys()];
      const out = changed.filter((file) =>
        !patterns.some((pattern) => pattern.test(file)),
      );
      if (!out.length) {
        return {
          met: true,
          reason: changed.length
            ? `all ${changed.length} changed file(s) inside scope`
            : baseline
              ? 'no workspace changes since loop entry'
              : 'clean tree',
        };
      }
      const shown = out.slice(0, 3);
      const omitted = out.length - shown.length;
      return {
        met: false,
        reason:
          `${out.length} file(s) outside the declared write scope: ` +
          `${shown.join(', ')}${omitted ? ` (+${omitted} more)` : ''}`,
        output: `declared scope:\n${globs.map((g) => `  ${g}`).join('\n')}\n\nout of scope:\n${out
          .slice(0, 50)
          .map((file) => `  ${file}`)
          .join('\n')}`,
      };
    }, label);

  const base = condition();
  if (opts.mode === 'absolute') return base;
  return withConditionPreparation(base, async (ctx) =>
    condition(
      await workspaceChanges(opts.cwd ?? ctx.workspace.dir, ctx.signal),
    ),
  );
}

// ── sampled ────────────────────────────────────────────────────────────────

export interface SampledOptions {
  /** Stable sampling key; default `<path>:<iteration>`, so a re-run of the
   *  same iteration lands on the same side of the cut. */
  key?: string | ((ctx: JobContext) => string);
}

/**
 * Run `condition` on a deterministic fraction of evaluations and treat the
 * rest as met. The bucket is a sha256 cut of a stable key (not `Math.random`),
 * so the same iteration always samples the same way — an expensive judge on
 * `rate: 0.25` really runs every ~4th iteration, reproducibly. Deterministic
 * gates cost nothing; sample only what spends.
 */
export function sampled(
  rate: number,
  condition: ConditionInput,
  opts: SampledOptions = {},
): Condition {
  if (!(rate >= 0 && rate <= 1)) {
    throw new RangeError(`sampled rate must be within [0, 1], got ${rate}`);
  }
  const inner = toCondition(condition);
  const sampledCondition: Condition = setLabel(async (ctx, last) => {
    const key =
      typeof opts.key === 'function'
        ? opts.key(ctx)
        : (opts.key ?? `${ctx.path.join('/')}:${ctx.iteration}`);
    const bucket =
      createHash('sha256').update(key).digest().readUInt32BE(0) / 0xffffffff;
    if (bucket >= rate) {
      return {
        met: true,
        reason: `sampled out (rate ${rate}, key "${key}")`,
      };
    }
    const result = await inner(ctx, last);
    return {
      ...result,
      reason: `sampled in (rate ${rate}): ${result.reason}`,
    };
  }, `sampled ${rate}`);
  return withConditionPreparation(sampledCondition, async (ctx) =>
    sampled(rate, await prepareCondition(condition, ctx), opts),
  );
}
