import { execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import {
  cloneFrozenJson,
  type JsonObject,
  type Sha256Digest,
} from '../graph/value.js';

const execFileAsync = promisify(execFile);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const POLL_MS = 20;
const FORCE_KILL_WAIT_MS = 1_000;

export interface ProcessIdentity extends JsonObject {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startedAt: string;
}

export interface OwnedProcessTreeRequest {
  readonly attemptId: Sha256Digest;
  readonly rootPid: number;
  readonly rootProcessGroupId: number;
  readonly observed?: readonly ProcessIdentity[];
}

export interface StopOwnedProcessTreeRequest extends OwnedProcessTreeRequest {
  readonly graceMs: number;
}

export interface PipeOwnerProbe {
  readonly fileDescriptors: readonly number[];
  close(): void;
}

interface ProcessSnapshot {
  readonly identity: ProcessIdentity;
  readonly residentBytes: number;
}

function windowsExecutable(...parts: readonly string[]): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || !isAbsolute(systemRoot)) {
    throw new Error(
      'SystemRoot must identify the absolute Windows system directory',
    );
  }
  return join(systemRoot, 'System32', ...parts);
}

function positivePid(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeDuration(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

export function capturePipeOwnerProbe(
  fileDescriptors: readonly number[],
): PipeOwnerProbe {
  if (process.platform !== 'darwin' || fileDescriptors.length === 0) {
    return Object.freeze({
      fileDescriptors: Object.freeze([]),
      close() {},
    });
  }

  const duplicates: number[] = [];
  try {
    for (const descriptor of fileDescriptors) {
      nonNegativeDuration(descriptor, 'pipe file descriptor');
      duplicates.push(openSync(`/dev/fd/${descriptor}`, 'r'));
    }
  } catch (error) {
    for (const descriptor of duplicates) closeSync(descriptor);
    throw error;
  }

  let closed = false;
  return Object.freeze({
    fileDescriptors: Object.freeze(duplicates),
    close(): void {
      if (closed) return;
      closed = true;
      for (const descriptor of duplicates) closeSync(descriptor);
    },
  });
}

function validateAttemptId(value: unknown): Sha256Digest {
  if (typeof value !== 'string' || !SHA256_DIGEST.test(value)) {
    throw new TypeError('attemptId must be a lowercase SHA-256 digest');
  }
  return value as Sha256Digest;
}

function identityKey(identity: ProcessIdentity): string {
  return `${identity.pid}:${identity.startedAt}`;
}

function parseProcessLine(line: string): ProcessSnapshot | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
  if (!match) return undefined;
  const [, pidText, parentText, groupText, rssText, startedAt] = match;
  const pid = Number(pidText);
  const parentPid = Number(parentText);
  const processGroupId = Number(groupText);
  const residentKiB = Number(rssText);
  if (
    startedAt === undefined ||
    !Number.isSafeInteger(pid) ||
    !Number.isSafeInteger(parentPid) ||
    !Number.isSafeInteger(processGroupId) ||
    !Number.isSafeInteger(residentKiB)
  ) {
    return undefined;
  }
  const identity = cloneFrozenJson({
    pid,
    parentPid,
    processGroupId,
    startedAt,
  } satisfies ProcessIdentity);
  return {
    identity,
    residentBytes: residentKiB * 1_024,
  };
}

export function parseWindowsProcessRows(
  output: string,
): readonly ProcessSnapshot[] {
  const snapshots: ProcessSnapshot[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(\d+)\t(\d+)\t(\d+)\t(\d+)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const residentBytes = Number(match[3]);
    const startedAt = match[4];
    if (
      startedAt === undefined ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      !Number.isSafeInteger(residentBytes) ||
      residentBytes < 0
    ) {
      continue;
    }
    snapshots.push({
      identity: cloneFrozenJson({
        pid,
        parentPid,
        processGroupId: 0,
        startedAt,
      } satisfies ProcessIdentity),
      residentBytes,
    });
  }
  return Object.freeze(snapshots);
}

async function windowsProcessTable(): Promise<readonly ProcessSnapshot[]> {
  const executable = windowsExecutable(
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Get-CimInstance -ClassName Win32_Process | ForEach-Object {',
    '  Write-Output "$($_.ProcessId)`t$($_.ParentProcessId)`t' +
      '$($_.WorkingSetSize)`t$($_.CreationDate.ToUniversalTime().Ticks)"',
    '}',
  ].join('; ');
  const { stdout } = await execFileAsync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', maxBuffer: 16 * 1_024 * 1_024 },
  );
  return parseWindowsProcessRows(stdout);
}

async function processTable(): Promise<readonly ProcessSnapshot[]> {
  if (process.platform === 'win32') return await windowsProcessTable();
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,pgid=,rss=,lstart='],
    { encoding: 'utf8', maxBuffer: 16 * 1_024 * 1_024 },
  );
  return stdout
    .split('\n')
    .map(parseProcessLine)
    .filter((entry): entry is ProcessSnapshot => entry !== undefined);
}

function unixSocketPeer(line: string): string | undefined {
  return /\sunix\s+0x[0-9a-f]+\s+.*\s+->(0x[0-9a-f]+)\s*$/iu.exec(
    line,
  )?.[1]?.toLowerCase();
}

function unixSocketOwner(
  line: string,
): { readonly pid: number; readonly device: string } | undefined {
  const match = /^\S+\s+(\d+)\s+\S+\s+\S+\s+unix\s+(0x[0-9a-f]+)\s+/iu.exec(
    line,
  );
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  return { pid, device: match[2]!.toLowerCase() };
}

/**
 * Find macOS processes that still hold the child side of one of this runner's
 * output pipes. This closes the narrow race where a helper detaches and its
 * direct parent exits before the ancestry sampler sees it.
 */
export async function inspectPipeHoldingProcesses(
  fileDescriptors: readonly number[],
): Promise<readonly ProcessIdentity[]> {
  if (process.platform !== 'darwin' || fileDescriptors.length === 0) {
    return Object.freeze([]);
  }
  for (const descriptor of fileDescriptors) {
    nonNegativeDuration(descriptor, 'pipe file descriptor');
  }

  const own = await execFileAsync(
    '/usr/sbin/lsof',
    [
      '-n',
      '-P',
      '-a',
      '-p',
      String(process.pid),
      '-d',
      fileDescriptors.join(','),
    ],
    { encoding: 'utf8', maxBuffer: 4 * 1_024 * 1_024 },
  );
  const peers = new Set(
    own.stdout
      .split('\n')
      .map(unixSocketPeer)
      .filter((peer): peer is string => peer !== undefined),
  );
  if (peers.size === 0) return Object.freeze([]);

  const allSockets = await execFileAsync(
    '/usr/sbin/lsof',
    ['-n', '-P', '-U'],
    { encoding: 'utf8', maxBuffer: 32 * 1_024 * 1_024 },
  );
  const holderPids = new Set<number>();
  for (const line of allSockets.stdout.split('\n')) {
    const owner = unixSocketOwner(line);
    if (owner && peers.has(owner.device) && owner.pid !== process.pid) {
      holderPids.add(owner.pid);
    }
  }

  const table = await processTable();
  return Object.freeze(
    table
      .filter(({ identity }) => holderPids.has(identity.pid))
      .map(({ identity }) => identity),
  );
}

export async function readAttemptMarkerProcessIds(
  rawAttemptId: Sha256Digest,
  procRoot = '/proc',
): Promise<readonly number[]> {
  const attemptId = validateAttemptId(rawAttemptId);
  const marker = Buffer.from(`LINES_ATTEMPT_ID=${attemptId}`, 'utf8');
  const entries = await readdir(procRoot, { withFileTypes: true });
  const found: number[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid)) continue;
    let environment: Buffer;
    try {
      environment = await readFile(join(procRoot, entry.name, 'environ'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') continue;
      throw error;
    }

    let start = 0;
    for (let index = 0; index <= environment.byteLength; index += 1) {
      if (index !== environment.byteLength && environment[index] !== 0) continue;
      if (environment.subarray(start, index).equals(marker)) {
        found.push(pid);
        break;
      }
      start = index + 1;
    }
  }

  return Object.freeze(found.sort((left, right) => left - right));
}

/**
 * Find Linux processes carrying this runner's exact attempt marker. This
 * catches a helper that creates a new session and exits its parent before the
 * ancestry sampler observes it.
 */
export async function inspectAttemptMarkedProcesses(
  attemptId: Sha256Digest,
): Promise<readonly ProcessIdentity[]> {
  validateAttemptId(attemptId);
  if (process.platform !== 'linux') return Object.freeze([]);
  const markedPids = new Set(await readAttemptMarkerProcessIds(attemptId));
  const table = await processTable();
  return Object.freeze(
    table
      .filter(({ identity }) => markedPids.has(identity.pid))
      .map(({ identity }) => identity),
  );
}

function currentObserved(
  table: readonly ProcessSnapshot[],
  observed: readonly ProcessIdentity[],
): Set<number> {
  const keys = new Set(observed.map(identityKey));
  return new Set(
    table
      .filter(({ identity }) => keys.has(identityKey(identity)))
      .map(({ identity }) => identity.pid),
  );
}

function ownedFromTable(
  table: readonly ProcessSnapshot[],
  request: OwnedProcessTreeRequest,
): readonly ProcessSnapshot[] {
  const ownedPids = currentObserved(table, request.observed ?? []);
  if (process.platform === 'win32') ownedPids.add(request.rootPid);
  for (const { identity } of table) {
    if (
      identity.pid === request.rootPid ||
      identity.processGroupId === request.rootProcessGroupId
    ) {
      ownedPids.add(identity.pid);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const { identity } of table) {
      if (!ownedPids.has(identity.pid) && ownedPids.has(identity.parentPid)) {
        ownedPids.add(identity.pid);
        changed = true;
      }
    }
  }

  return table
    .filter(({ identity }) => ownedPids.has(identity.pid))
    .sort((left, right) => left.identity.pid - right.identity.pid);
}

async function terminateWindowsTree(
  rootPid: number,
  force: boolean,
): Promise<void> {
  if (process.platform !== 'win32') return;
  const executable = windowsExecutable('taskkill.exe');
  const args = ['/PID', String(rootPid), '/T'];
  if (force) args.push('/F');
  try {
    await execFileAsync(executable, args, {
      encoding: 'utf8',
      maxBuffer: 1 * 1_024 * 1_024,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
    // The root may already have exited. The identity scan below still finds
    // and stops children whose recorded parent is that root.
  }
}

function validateRequest(request: OwnedProcessTreeRequest): void {
  validateAttemptId(request.attemptId);
  positivePid(request.rootPid, 'rootPid');
  positivePid(request.rootProcessGroupId, 'rootProcessGroupId');
}

export async function inspectOwnedProcessTree(
  request: OwnedProcessTreeRequest,
): Promise<readonly ProcessIdentity[]> {
  validateRequest(request);
  const owned = ownedFromTable(await processTable(), request);
  return Object.freeze(owned.map(({ identity }) => identity));
}

export async function measureOwnedProcessMemory(
  request: OwnedProcessTreeRequest,
): Promise<number> {
  validateRequest(request);
  const owned = ownedFromTable(await processTable(), request);
  return owned.reduce((total, process) => {
    const next = total + process.residentBytes;
    if (!Number.isSafeInteger(next)) {
      throw new TypeError('owned process memory must remain a safe integer');
    }
    return next;
  }, 0);
}

async function signalMatching(
  request: OwnedProcessTreeRequest,
  signal: NodeJS.Signals,
): Promise<readonly ProcessIdentity[]> {
  const owned = await inspectOwnedProcessTree(request);
  for (const identity of owned) {
    if (identity.pid === process.pid) continue;
    try {
      process.kill(identity.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  return owned;
}

function mergeObserved(
  left: readonly ProcessIdentity[],
  right: readonly ProcessIdentity[],
): readonly ProcessIdentity[] {
  const merged = new Map(
    left.map((identity) => [identityKey(identity), identity]),
  );
  for (const identity of right) merged.set(identityKey(identity), identity);
  return [...merged.values()];
}

export async function stopOwnedProcessTree(
  request: StopOwnedProcessTreeRequest,
): Promise<readonly ProcessIdentity[]> {
  validateRequest(request);
  const graceMs = nonNegativeDuration(request.graceMs, 'graceMs');
  let observed = request.observed ?? [];
  if (process.platform === 'win32') {
    await terminateWindowsTree(request.rootPid, false);
    observed = mergeObserved(
      observed,
      await inspectOwnedProcessTree({ ...request, observed }),
    );
  } else {
    observed = mergeObserved(
      observed,
      await signalMatching({ ...request, observed }, 'SIGTERM'),
    );
  }

  const gracefulDeadline = Date.now() + graceMs;
  while (Date.now() < gracefulDeadline) {
    const remaining = await inspectOwnedProcessTree({ ...request, observed });
    if (remaining.length === 0) return Object.freeze([]);
    observed = mergeObserved(observed, remaining);
    await delay(Math.min(POLL_MS, Math.max(1, gracefulDeadline - Date.now())));
  }

  await terminateWindowsTree(request.rootPid, true);
  observed = mergeObserved(
    observed,
    await signalMatching({ ...request, observed }, 'SIGKILL'),
  );
  const forceDeadline = Date.now() + FORCE_KILL_WAIT_MS;
  while (Date.now() < forceDeadline) {
    const remaining = await inspectOwnedProcessTree({ ...request, observed });
    if (remaining.length === 0) return Object.freeze([]);
    observed = mergeObserved(observed, remaining);
    await delay(POLL_MS);
  }

  return await inspectOwnedProcessTree({ ...request, observed });
}
