#!/usr/bin/env node
/**
 * The changelog gate: refuse to publish a version the changelog does not
 * describe. The Release workflow runs pnpm verify:d15, which chains the
 * tarball check and this gate. This script is not a prepublishOnly hook. That hook
 * is the publish allowlist, and the allowlist requires an exact command.
 * A tarball publish also skips package hooks, so scripts/release.mjs is the
 * only publishing path.
 *
 * Checks, all against the version `package.json` carries:
 *   1. CHANGELOG.md has a `## [<version>]` heading;
 *   2. the section under it has substance (at least one non-empty line);
 *   3. when running on a version tag (GITHUB_REF_NAME=v*), the tag matches
 *      the package version — a mismatched tag would publish one version and
 *      document another.
 *
 * No dependencies, exits 1 with a fix-oriented message.
 */

import { readFileSync } from 'node:fs';
import { repositoryVersion } from './repository-version.mjs';

const cwd = process.cwd();

function fail(message) {
  console.error(`changelog gate: ${message}`);
  process.exit(1);
}

let version;
try {
  version = repositoryVersion(cwd);
} catch (e) {
  fail(`could not read packages/runtime/package.json: ${e.message}`);
}

const tag = process.env.GITHUB_REF_NAME;
if (tag && /^v\d/.test(tag) && tag !== `v${version}`) {
  fail(
    `tag ${tag} does not match package.json version ${version} — ` +
      `retag (git tag -d ${tag}; npm version) or fix package.json before publishing`,
  );
}

let changelog;
try {
  changelog = readFileSync(`${cwd}/CHANGELOG.md`, 'utf8');
} catch {
  fail('CHANGELOG.md is missing — every published version needs an entry');
}

const lines = changelog.split('\n');
const headingAt = lines.findIndex((line) =>
  line.startsWith(`## [${version}]`),
);
if (headingAt === -1) {
  fail(
    `no "## [${version}]" heading in CHANGELOG.md — retitle the Unreleased ` +
      `section to "## [${version}] — <date>" (and refresh the compare links) ` +
      `before tagging`,
  );
}

const section = [];
for (const line of lines.slice(headingAt + 1)) {
  if (line.startsWith('## ')) break;
  section.push(line);
}
const substance = section.filter(
  (line) => line.trim() && !line.startsWith('### '),
);
if (!substance.length) {
  fail(
    `the "## [${version}]" section is empty — a version heading with no ` +
      `entries documents nothing; write what changed`,
  );
}

console.log(
  `changelog gate: ok — ${version} is documented (${substance.length} line(s))`,
);
