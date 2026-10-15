import { execFile, execFileSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import {
  cloneFrozenJson,
  type JsonObject,
  type Sha256Digest,
} from '@obversa/api';

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
  /**
   * The root's start time, read while it was alive. The root's pid counts
   * only while a process with this pid and start time is alive. Its process
   * group counts while the root is alive and, when the group id is the root's
   * pid, after the root exits until a different process holds that pid.
   * Without it, neither counts on Linux or macOS, and only processes already
   * observed, matched by pid and start time, count.
   */
  readonly rootStartedAt?: string;
  readonly observed?: readonly ProcessIdentity[];
}

export interface StopOwnedProcessTreeRequest extends OwnedProcessTreeRequest {
  readonly graceMs: number;
  /** Only the outer command request may sweep an inherited owner. */
  readonly ownerId?: Sha256Digest;
  /**
   * The runner's own output pipe descriptors. On macOS each discovery pass
   * re-finds every process still holding the child side of one of them, so
   * a helper started while teardown is already running is still stopped.
   */
  readonly pipeFileDescriptors?: readonly number[];
  /**
   * Called after each signal pass with the processes the signal was sent
   * to, so the caller can record what teardown stopped.
   */
  readonly onSignal?: (processes: readonly ProcessIdentity[]) => void;
}

export interface PipeOwnerProbe {
  readonly fileDescriptors: readonly number[];
  close(): void;
}

export interface ProcessSnapshot extends JsonObject {
  readonly identity: ProcessIdentity;
  readonly residentBytes: number;
}

/**
 * A process that counted against a memory limit, with the command line and
 * the reasons it counted. `command` holds the raw command line as read;
 * the caller scrubs it and cuts it to 200 characters for the record.
 */
export interface CountedProcess extends JsonObject {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
  readonly residentBytes: number;
  readonly root: boolean;
  readonly descendant: boolean;
  readonly groupMember: boolean;
  readonly earlierObserved: boolean;
}

/** The total resident memory of the owned set and every process in it. */
export interface OwnedMemoryMeasure {
  readonly residentBytes: number;
  readonly counted: readonly ProcessSnapshot[];
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
    // Pin the C locale and UTC: lstart spells its date with the caller's
    // locale and timezone, so a worker with a restricted environment and a
    // host watchdog would record two spellings of one start time and never
    // match unless both are fixed.
    { encoding: 'utf8', maxBuffer: 16 * 1_024 * 1_024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
  );
  return stdout
    .split('\n')
    .map(parseProcessLine)
    .filter((entry): entry is ProcessSnapshot => entry !== undefined);
}

/**
 * Read one live process's identity before this call returns, to pass its
 * start time as `rootStartedAt` and to record the process when the first
 * signal already stops it. Node cannot reap its own child while this call
 * blocks, so a child read right after it starts is still that child, even
 * if it has already exited. On Windows the identity's start time is the
 * process's creation tick count and its group is zero, and a process that
 * is already gone reads as nothing instead of throwing.
 */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  positivePid(pid, 'pid');
  if (process.platform === 'win32') {
    const script =
      `Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${pid}" ` +
      '| ForEach-Object { Write-Output "$($_.ProcessId)`t' +
      '$($_.ParentProcessId)`t$($_.WorkingSetSize)`t' +
      '$($_.CreationDate.ToUniversalTime().Ticks)" }';
    const stdout = execFileSync(
      windowsExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', maxBuffer: 1 * 1_024 * 1_024 },
    );
    return parseWindowsProcessRows(stdout).find(
      (snapshot) => snapshot.identity.pid === pid,
    )?.identity;
  }
  const stdout = execFileSync(
    '/bin/ps',
    ['-o', 'pid=,ppid=,pgid=,rss=,lstart=', '-p', String(pid)],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
  );
  const identity = parseProcessLine(stdout.split('\n')[0] ?? '')?.identity;
  if (identity?.pid !== pid) throw new Error(`process ${pid} could not be read`);
  return identity;
}

/**
 * Read every live process's identity before this call returns, so a stop can
 * run inside an exit or signal handler.
 */
export function readProcessIdentities(): readonly ProcessIdentity[] {
  const stdout = execFileSync(
    '/bin/ps',
    ['-axo', 'pid=,ppid=,pgid=,rss=,lstart='],
    { encoding: 'utf8', maxBuffer: 16 * 1_024 * 1_024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
  );
  return stdout
    .split('\n')
    .map((line) => parseProcessLine(line)?.identity)
    .filter((identity): identity is ProcessIdentity => identity !== undefined);
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

  const ownPeers = async (): Promise<Set<string>> => {
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
    return new Set(
      own.stdout
        .split('\n')
        .map(unixSocketPeer)
        .filter((peer): peer is string => peer !== undefined),
    );
  };
  const peers = await ownPeers();
  if (peers.size === 0) return Object.freeze([]);

  const allSockets = await execFileAsync(
    '/usr/sbin/lsof',
    ['-n', '-P', '-U'],
    { encoding: 'utf8', maxBuffer: 32 * 1_024 * 1_024 },
  );
  // A peer that closes during the scan frees its address, and macOS can give
  // that address to a socket in an unrelated process at once. A second look
  // after the scan drops every address that is already gone by then.
  const connected = await ownPeers();
  const holderPids = new Set<number>();
  for (const line of allSockets.stdout.split('\n')) {
    const owner = unixSocketOwner(line);
    if (
      owner &&
      peers.has(owner.device) &&
      connected.has(owner.device) &&
      owner.pid !== process.pid
    ) {
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
  return await readMarkerProcessIds(`OBVERSA_ATTEMPT_ID=${attemptId}`, procRoot);
}

async function readMarkerProcessIds(
  value: string,
  procRoot = '/proc',
): Promise<readonly number[]> {
  const marker = Buffer.from(value, 'utf8');
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
      // ESRCH: the process exited after the listing, so it is gone like ENOENT.
      if (code === 'ENOENT' || code === 'ESRCH' || code === 'EACCES' || code === 'EPERM') continue;
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
 * Discover an inherited command owner through exact Linux environment entries.
 * Other platforms retain process-tree cleanup without owner-marker discovery.
 */
export async function inspectOwnerMarkedProcesses(
  ownerId: Sha256Digest,
): Promise<readonly ProcessIdentity[]> {
  if (typeof ownerId !== 'string' || !SHA256_DIGEST.test(ownerId)) {
    throw new TypeError('ownerId must be a lowercase SHA-256 digest');
  }
  if (process.platform !== 'linux') {
    return Object.freeze([]);
  }
  const before = await processTable();
  const marker = `OBVERSA_RUN_OWNER=${ownerId}`;
  const markedPids = new Set(await readMarkerProcessIds(marker));
  const previous = new Set(before.map(({ identity }) => identityKey(identity)));
  return Object.freeze((await processTable())
    .filter(({ identity }) => markedPids.has(identity.pid) && previous.has(identityKey(identity)))
    .map(({ identity }) => identity));
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
  // Once the root is gone, the system can give its pid to a new process, which
  // can lead a group with that same id. A recorded start time tells the two
  // apart. The system never gives a group's id to a new process while any
  // process is left in that group, so the root's own group stays this
  // command's after the root exits, until a different process holds its id.
  // While one does, its group is left alone. If it exits too while others
  // remain in its group, those others match.
  const holder = table.find(({ identity }) => identity.pid === request.rootPid)?.identity;
  const rootAlive = request.rootStartedAt !== undefined && holder?.startedAt === request.rootStartedAt;
  const groupOwned = rootAlive || (
    request.rootStartedAt !== undefined &&
    holder === undefined &&
    request.rootProcessGroupId === request.rootPid
  );
  for (const { identity } of table) {
    if (
      (rootAlive && identity.pid === request.rootPid) ||
      (groupOwned && identity.processGroupId === request.rootProcessGroupId)
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
    // The process may already have exited; the rest are still stopped.
  }
}

/**
 * Signal every owned process on Windows. `taskkill /T` reaches only the
 * tree under a live root; a root that already exited leaves observed
 * children standing, so each other target gets the same stop by its own id.
 */
async function terminateWindowsTargets(
  rootPid: number,
  targets: readonly ProcessIdentity[],
  force: boolean,
): Promise<void> {
  await terminateWindowsTree(rootPid, force);
  for (const identity of targets) {
    if (identity.pid !== rootPid) await terminateWindowsTree(identity.pid, force);
  }
}

function validateRequest(request: OwnedProcessTreeRequest): void {
  validateAttemptId(request.attemptId);
  positivePid(request.rootPid, 'rootPid');
  positivePid(request.rootProcessGroupId, 'rootProcessGroupId');
  if (
    request.rootStartedAt !== undefined &&
    (typeof request.rootStartedAt !== 'string' || request.rootStartedAt.length === 0)
  ) {
    throw new TypeError('rootStartedAt must be a non-empty string');
  }
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
  return (await measureOwnedProcessTree(request)).residentBytes;
}

export async function measureOwnedProcessTree(
  request: OwnedProcessTreeRequest,
): Promise<OwnedMemoryMeasure> {
  validateRequest(request);
  const owned = ownedFromTable(await processTable(), request);
  let residentBytes = 0;
  for (const snapshot of owned) {
    residentBytes += snapshot.residentBytes;
    if (!Number.isSafeInteger(residentBytes)) {
      throw new TypeError('owned process memory must remain a safe integer');
    }
  }
  return Object.freeze({
    residentBytes,
    counted: Object.freeze(owned),
  });
}

async function commandLines(
  pids: readonly number[],
): Promise<ReadonlyMap<number, string>> {
  if (pids.length === 0) return new Map();
  if (process.platform === 'win32') {
    const executable = windowsExecutable(
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const script =
      `Get-CimInstance -ClassName Win32_Process -Filter "${filter}" ` +
      '| ForEach-Object { Write-Output "$($_.ProcessId)`t$($_.CommandLine)" }';
    const { stdout } = await execFileAsync(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', maxBuffer: 4 * 1_024 * 1_024 },
    );
    const lines = new Map<number, string>();
    for (const line of stdout.split(/\r?\n/u)) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const pid = Number(line.slice(0, tab));
      if (Number.isSafeInteger(pid)) lines.set(pid, line.slice(tab + 1));
    }
    return lines;
  }
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-o', 'pid=,command=', '-p', pids.join(',')],
    { encoding: 'utf8', maxBuffer: 4 * 1_024 * 1_024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
  );
  const lines = new Map<number, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    if (Number.isSafeInteger(pid)) lines.set(pid, match[2] ?? '');
  }
  return lines;
}

/**
 * Describe every process a measure counted, for a memory-limit record.
 * `request.observed` decides `earlierObserved`: pass the observed list from
 * before the measure's own look, so a process carried in through an earlier
 * sample is marked. The root seeds that list, so it never carries the mark.
 * Each `command` is the raw command line; the caller scrubs it before the
 * 200-character cap so a split secret cannot reach the record.
 */
export async function describeCountedProcesses(
  request: OwnedProcessTreeRequest,
  counted: readonly ProcessSnapshot[],
): Promise<readonly CountedProcess[]> {
  validateRequest(request);
  const countedPids = new Set(counted.map(({ identity }) => identity.pid));
  const observedKeys = new Set(
    (request.observed ?? []).map((identity) => identityKey(identity)),
  );
  const holder = counted.find(
    ({ identity }) => identity.pid === request.rootPid,
  )?.identity;
  const rootAlive =
    process.platform === 'win32' ||
    (request.rootStartedAt !== undefined &&
      holder?.startedAt === request.rootStartedAt);
  let commands: ReadonlyMap<number, string> = new Map();
  try {
    commands = await commandLines([...countedPids]);
  } catch {
    // A stopped process may be gone before its command is read; the record
    // still holds its identity and resident memory.
  }
  return Object.freeze(
    counted.map(({ identity, residentBytes }) => {
      const root = rootAlive && identity.pid === request.rootPid;
      return cloneFrozenJson({
        pid: identity.pid,
        parentPid: identity.parentPid,
        command: commands.get(identity.pid) ?? '',
        residentBytes,
        root,
        descendant: countedPids.has(identity.parentPid),
        groupMember: identity.processGroupId === request.rootProcessGroupId,
        earlierObserved: !root && observedKeys.has(identityKey(identity)),
      } satisfies CountedProcess);
    }),
  );
}

async function signalList(
  targets: readonly ProcessIdentity[],
  signal: NodeJS.Signals,
): Promise<void> {
  for (const identity of targets) {
    if (identity.pid === process.pid) continue;
    try {
      process.kill(positivePid(identity.pid, 'owned process id'), signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
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
  const ownerId = process.platform === 'linux' ? request.ownerId : undefined;
  let observed = request.observed ?? [];
  // Identities that already received the graceful signal. A helper first
  // seen while teardown runs gets that signal and what remains of the
  // period; no owned process meets the forced signal first.
  const graceful = new Set<string>();
  const sendGraceful = async (
    identities: readonly ProcessIdentity[],
  ): Promise<readonly ProcessIdentity[]> => {
    const fresh = identities.filter((identity) => !graceful.has(identityKey(identity)));
    for (const identity of fresh) graceful.add(identityKey(identity));
    await signalList(fresh, 'SIGTERM');
    if (fresh.length > 0) request.onSignal?.(fresh);
    return fresh;
  };
  const sendForced = async (): Promise<void> => {
    const owned = await inspectOwnedProcessTree({ ...request, observed });
    observed = mergeObserved(observed, owned);
    // A process found only now, by a marker or a kept pipe, has had no
    // signal yet; the forced pass leaves it to the next look.
    const fresh = new Set((await sendGraceful(owned)).map(identityKey));
    const forced = owned.filter((identity) => !fresh.has(identityKey(identity)));
    await signalList(forced, 'SIGKILL');
    if (forced.length > 0) request.onSignal?.(forced);
  };
  // On Windows the graceful stop is a plain taskkill and the forced one is
  // taskkill /F. The same order holds: a target first found while teardown
  // runs gets the graceful stop and the forced pass leaves it to the next
  // look.
  const stopWindows = async (
    targets: readonly ProcessIdentity[],
    force: boolean,
  ): Promise<void> => {
    observed = mergeObserved(observed, targets);
    const fresh = targets.filter((identity) => !graceful.has(identityKey(identity)));
    for (const identity of fresh) graceful.add(identityKey(identity));
    if (fresh.length > 0) {
      request.onSignal?.(fresh);
      await terminateWindowsTargets(request.rootPid, fresh, false);
    }
    const freshKeys = new Set(fresh.map(identityKey));
    const forced = targets.filter((identity) => !freshKeys.has(identityKey(identity)));
    if (force && forced.length > 0) {
      request.onSignal?.(forced);
      await terminateWindowsTargets(request.rootPid, forced, true);
    }
  };
  // On Linux every process of this attempt carries the attempt's exact
  // marker, so a detached helper whose parent has already exited is still
  // found, though no parent, group or earlier sample leads to it. On macOS
  // a helper that still holds the command's pipes is found on each pass,
  // so one started while teardown is already running is not missed.
  const discover = async (): Promise<void> => {
    if (ownerId !== undefined) {
      observed = mergeObserved(observed, await inspectOwnerMarkedProcesses(ownerId));
    }
    if (process.platform === 'linux') {
      observed = mergeObserved(observed, await inspectAttemptMarkedProcesses(request.attemptId));
    }
    observed = mergeObserved(
      observed,
      await inspectPipeHoldingProcesses(request.pipeFileDescriptors ?? []),
    );
  };
  // A table can show nothing owned and still miss a helper forked just
  // before its parent exited, after the discovery that came before the
  // table. A second discovery after that table finds it, so nothing is
  // reported stopped on one look.
  const inspectRemaining = async (): Promise<readonly ProcessIdentity[]> => {
    await discover();
    const remaining = await inspectOwnedProcessTree({ ...request, observed });
    if (remaining.length > 0 || process.platform === 'win32') return remaining;
    await discover();
    return await inspectOwnedProcessTree({ ...request, observed });
  };
  await discover();
  if (process.platform === 'win32') {
    await stopWindows(await inspectOwnedProcessTree({ ...request, observed }), false);
  } else {
    observed = mergeObserved(
      observed,
      await sendGraceful(await inspectOwnedProcessTree({ ...request, observed })),
    );
  }

  const gracefulDeadline = Date.now() + graceMs;
  while (Date.now() < gracefulDeadline) {
    const remaining = await inspectRemaining();
    if (remaining.length === 0 && ownerId === undefined) return Object.freeze([]);
    observed = mergeObserved(observed, remaining);
    if (process.platform === 'win32') await stopWindows(remaining, false);
    else await sendGraceful(remaining);
    await delay(Math.min(POLL_MS, Math.max(1, gracefulDeadline - Date.now())));
  }

  if (process.platform === 'win32') {
    await stopWindows(await inspectOwnedProcessTree({ ...request, observed }), true);
  }
  await discover();
  if (process.platform === 'win32') {
    await stopWindows(await inspectOwnedProcessTree({ ...request, observed }), true);
  } else {
    await sendForced();
  }
  const forceDeadline = Date.now() + FORCE_KILL_WAIT_MS;
  while (Date.now() < forceDeadline) {
    const remaining = await inspectRemaining();
    if (remaining.length === 0) return Object.freeze([]);
    observed = mergeObserved(observed, remaining);
    if (process.platform === 'win32') await stopWindows(remaining, true);
    else await sendForced();
    await delay(POLL_MS);
  }

  await discover();
  return await inspectOwnedProcessTree({ ...request, observed });
}
