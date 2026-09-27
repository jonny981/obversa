#!/usr/bin/env node
import { readRecordFile, renderRecord, summarizeRecord } from '../runtime/render-record.js';

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith('--'));
const flags = args.filter((a) => a.startsWith('--'));
const json = flags.includes('--json');

if (!path || flags.some((f) => f !== '--json')) {
  process.stderr.write('usage: obversa-record <path> [--json]\n');
  process.exitCode = 1;
} else {
  const { events, unreadable } = readRecordFile(path);
  process.stdout.write(
    json ? `${JSON.stringify(summarizeRecord(events), null, 2)}\n` : renderRecord(events),
  );
  if (unreadable > 0) {
    process.stderr.write(`obversa-record: ${unreadable} line(s) could not be read as JSON\n`);
  }
}
