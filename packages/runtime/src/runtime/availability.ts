/**
 * The file-backed `AvailabilityStore` a host can hand a run: one small JSON
 * file that remembers, per access route (`adapter`, `provider`, `model`),
 * a candidate that failed on billing or quota and the epoch-millisecond
 * reset it gave. The runtime opens no file on its own; the store exists
 * only where the host passes it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { AvailabilityStore, AvailabilityTarget, UnavailableEntry } from '@obversa/api';

interface AvailabilityFile {
  readonly version: 1;
  readonly entries: readonly (AvailabilityTarget & UnavailableEntry)[];
}

const key = (target: AvailabilityTarget) => `${target.adapter}/${target.provider}/${target.model}`;

function isEntry(value: unknown): value is AvailabilityTarget & UnavailableEntry {
  const entry = value as (AvailabilityTarget & UnavailableEntry) | undefined;
  return typeof entry === 'object' && entry !== null
    && typeof entry.adapter === 'string' && entry.adapter.trim() !== ''
    && typeof entry.provider === 'string' && entry.provider.trim() !== ''
    && typeof entry.model === 'string' && entry.model.trim() !== ''
    && typeof entry.until === 'number' && Number.isFinite(entry.until)
    && (entry.failure === 'billing' || entry.failure === 'quota');
}

/**
 * A store over one plain JSON file: `{ version: 1, entries: [...] }`.
 * A missing file reads as empty. A file that cannot be read or parsed, or
 * whose shape is wrong, reads as empty too, and the reason is reported once
 * through `takeProblems`. Writes that fail are reported the same way and
 * never fail the run.
 */
export function fileAvailabilityStore(path: string): AvailabilityStore {
  const problems: string[] = [];
  let loaded: Map<string, AvailabilityTarget & UnavailableEntry> | undefined;
  const load = (): Map<string, AvailabilityTarget & UnavailableEntry> => {
    if (loaded !== undefined) return loaded;
    loaded = new Map();
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      // A missing file is just an empty store; any other read failure is a
      // problem worth recording but still reads as empty.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        problems.push(`the availability file ${path} could not be read: ${(error as Error).message}`);
      }
      return loaded;
    }
    try {
      const parsed = JSON.parse(text) as Partial<AvailabilityFile>;
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
        throw new TypeError('expected { version: 1, entries: [...] }');
      }
      for (const entry of parsed.entries) {
        if (!isEntry(entry)) throw new TypeError(`bad entry ${JSON.stringify(entry)}`);
        loaded.set(key(entry), entry);
      }
    } catch (error) {
      loaded = new Map();
      problems.push(`the availability file ${path} is corrupt and reads as empty: ${(error as Error).message}`);
    }
    return loaded;
  };
  const save = (entries: Map<string, AvailabilityTarget & UnavailableEntry>) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ version: 1, entries: [...entries.values()] } as AvailabilityFile, null, 2)}\n`, 'utf8');
    } catch (error) {
      problems.push(`the availability file ${path} could not be written: ${(error as Error).message}`);
    }
  };
  return {
    unavailableUntil(target, now) {
      const entry = load().get(key(target));
      return entry !== undefined && entry.until > now ? { until: entry.until, failure: entry.failure } : undefined;
    },
    markUnavailable(target, entry) {
      const entries = load();
      // Entries whose time has passed are dropped with the write, so the
      // file never grows on stale memory.
      const now = Date.now();
      for (const [entryKey, held] of entries) {
        if (held.until <= now) entries.delete(entryKey);
      }
      entries.set(key(target), { ...target, until: entry.until, failure: entry.failure });
      save(entries);
    },
    takeProblems() {
      return problems.splice(0);
    },
  };
}
