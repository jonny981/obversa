/**
 * The host every use-case proof runs its example through.
 *
 * An example does not know it is being tested. The host makes a temporary
 * root with a `workspace/` the example runs in and a `bin/` beside it, puts
 * the repository's stand-in CLI on that PATH under the names `claude`,
 * `codex` and `opencode`, adds a recording stand-in for every other command
 * the example runs (`curl`, `gh`), writes the workspace files the example
 * expects, spawns the example as a plain program and hands the proof what
 * it printed, what each seat was asked and what each command was called
 * with. The stand-ins sit beside the workspace, not inside it, because a
 * read-only reviewer's workspace guard refuses a symlink that resolves
 * outside the workspace.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** One scripted answer from a model seat: the files it writes, then its reply. */
export interface SeatCall {
  readonly writes?: Readonly<Record<string, string>>;
  readonly reply: string;
}

/** A recording stand-in for a command the example runs; `output` is what it prints, or writes to `-o <path>`. */
export interface CommandStandIn {
  readonly output?: string;
}

export interface ProofOptions {
  /** The directory of the proof file; the example is its sibling. */
  readonly here: string;
  /** The example's file stem, `support-triage` for `support-triage.ts`. */
  readonly example: string;
  /** Workspace files present before the run, path to content. */
  readonly files: Readonly<Record<string, string>>;
  /** The scripted answers per seat role: `claude`, `codex`, `opencode`. */
  readonly seats: Readonly<Record<string, readonly SeatCall[]>>;
  /** Other commands to stand in for, by executable name. */
  readonly commands?: Readonly<Record<string, CommandStandIn>>;
  /** Extra environment for the example's process. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface RecordedSeatCall {
  readonly role: string;
  readonly reply: string;
  readonly writes: Readonly<Record<string, string>>;
}

export interface RecordedCommandCall {
  readonly name: string;
  readonly args: readonly string[];
}

export interface StageOutcome {
  readonly status: string;
  readonly summary?: string;
  readonly data?: unknown;
}

export interface PrintedOutcome {
  readonly status: string;
  readonly summary?: string;
  readonly data?: Readonly<Record<string, StageOutcome>>;
}

export type ProofMode = 'compiled-from-dist' | 'repo-tsx' | 'consumer-tsx';

export interface ExampleRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The last JSON object the example printed: the run's outcome. */
  readonly printed: PrintedOutcome;
  readonly seatCalls: readonly RecordedSeatCall[];
  readonly commandCalls: readonly RecordedCommandCall[];
  readonly mode: ProofMode;
  readonly elapsedMs: number;
  read(path: string): Promise<string>;
  exists(path: string): boolean;
}

export const pass = (summary: string): string => JSON.stringify({ status: 'pass', summary });
export const revise = (summary: string, ...findings: string[]): string =>
  JSON.stringify({ status: 'revise', summary, findings: findings.map((evidence) => ({ evidence })) });

/**
 * Where a proof's brief and sample inputs are: beside the proof's source.
 * A proof compiled into a `dist/` directory reads them from the source
 * tree it was compiled from, so the files a page quotes are the files the
 * proof runs.
 */
export function sourceDir(here: string): string {
  const marker = `${sep}dist${sep}`;
  const at = here.indexOf(marker);
  return at === -1 ? here : `${here.slice(0, at)}${sep}${here.slice(at + marker.length)}`;
}

/** The repository root, or the throwaway consumer's root: the nearest directory with a package.json. */
function rootAbove(here: string): string {
  let dir = here;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error(`no package.json above ${here}`);
}

function commandScript(output: string | undefined): string {
  return [
    '#!/usr/bin/env node',
    "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
    "const { dirname } = require('node:path');",
    'const args = process.argv.slice(2);',
    "appendFileSync(`${process.argv[1]}.calls.log`, `${JSON.stringify({ args, cwd: process.cwd() })}\\n`);",
    `const output = ${JSON.stringify(output ?? '')};`,
    "const out = args.indexOf('-o');",
    'if (out !== -1) { mkdirSync(dirname(args[out + 1]), { recursive: true }); writeFileSync(args[out + 1], output); }',
    'else process.stdout.write(output);',
    '',
  ].join('\n');
}

/**
 * Run the example once against the scripted seats and commands, hand the
 * result to `check`, and remove the temporary root whether or not the
 * checks passed.
 */
export async function withExample(options: ProofOptions, check: (run: ExampleRun) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `obversa-${options.example}-proof-`));
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(bin, { recursive: true });
    for (const [path, content] of Object.entries(options.files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), content);
    }
    const repo = rootAbove(options.here);
    await writeFile(join(workspace, '.obversa-stand-in.json'), `${JSON.stringify(options.seats, null, 2)}\n`);
    for (const name of ['claude', 'codex', 'opencode']) {
      await symlink(join(repo, 'scripts', 'stand-in-cli.mjs'), join(bin, name));
    }
    const commands = Object.entries(options.commands ?? {});
    for (const [name, standIn] of commands) {
      await writeFile(join(bin, name), commandScript(standIn.output));
      await chmod(join(bin, name), 0o755);
    }

    // Inside a fresh consumer there is no packages/runtime/tsconfig.json; tsx
    // then reads the nearest tsconfig, which is the consumer's own.
    const repoTsconfig = join(repo, 'packages', 'runtime', 'tsconfig.json');
    const tsconfigArgs = existsSync(repoTsconfig) ? ['--tsconfig', repoTsconfig] : [];
    const compiled = join(options.here, `${options.example}.js`);
    const child = existsSync(compiled)
      ? { file: process.execPath, args: [compiled] }
      : { file: join(repo, 'node_modules', '.bin', 'tsx'), args: [...tsconfigArgs, join(options.here, `${options.example}.ts`)] };
    const mode: ProofMode = existsSync(compiled) ? 'compiled-from-dist' : existsSync(repoTsconfig) ? 'repo-tsx' : 'consumer-tsx';
    const started = Date.now();
    const result = spawnSync(child.file, child.args, {
      cwd: workspace,
      env: { ...process.env, ...options.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      timeout: 120_000,
    });
    const elapsedMs = Date.now() - started;
    const where = `${child.file} ${child.args.join(' ')} in ${mode} mode`;
    if (result.status !== 0) {
      throw new Error(`the example child ${where} exited ${result.status ?? `signal ${result.signal}`} after ${elapsedMs}ms
  spawn error: ${result.error ?? 'none'}
  stdout: ${result.stdout}
  stderr: ${result.stderr}`);
    }
    const printedAt = result.stdout.lastIndexOf('\n{');
    if (printedAt === -1) throw new Error(`the example ${where} printed no outcome\n  stdout: ${result.stdout}`);
    const printed = JSON.parse(result.stdout.slice(printedAt + 1)) as PrintedOutcome;

    const seatCalls = await readLines<RecordedSeatCall>(join(workspace, '.obversa-stand-in-calls.log'));
    const commandCalls: RecordedCommandCall[] = [];
    for (const [name] of commands) {
      for (const call of await readLines<{ args: string[] }>(join(bin, `${name}.calls.log`))) {
        commandCalls.push({ name, args: call.args });
      }
    }
    await check({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      printed,
      seatCalls,
      commandCalls,
      mode,
      elapsedMs,
      read: (path) => readFile(join(workspace, path), 'utf8'),
      exists: (path) => existsSync(join(workspace, path)),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readLines<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}
