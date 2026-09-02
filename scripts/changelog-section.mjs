#!/usr/bin/env node
/**
 * Print one version's section body from CHANGELOG.md — the release notes.
 * The Release workflow feeds this to `gh release create`, so the GitHub
 * Release body is always the changelog section, never a second hand-written
 * copy. Exits 1 when the section is missing or empty (the changelog gate
 * enforces the same bar before anything publishes).
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
