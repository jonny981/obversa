#!/usr/bin/env node
/**
 * Print one version's section body from CHANGELOG.md — the release notes.
 * Writes the section body to standard output. Exits 1 when the changelog
 * file or requested section is missing, or the section body is empty.
 *
 *   node scripts/changelog-section.mjs <version>
 */

import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('usage: changelog-section.mjs <version>');
  process.exit(1);
}

let changelog;
try {
  changelog = readFileSync(`${process.cwd()}/CHANGELOG.md`, 'utf8');
} catch {
  console.error('changelog-section: CHANGELOG.md is missing');
  process.exit(1);
}

const lines = changelog.split('\n');
const headingAt = lines.findIndex((line) =>
  line.startsWith(`## [${version}]`),
);
if (headingAt === -1) {
  console.error(`changelog-section: no "## [${version}]" heading`);
  process.exit(1);
}
const section = [];
for (const line of lines.slice(headingAt + 1)) {
  if (line.startsWith('## ')) break;
  section.push(line);
}
const body = section.join('\n').trim();
if (!body) {
  console.error(`changelog-section: the "## [${version}]" section is empty`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
