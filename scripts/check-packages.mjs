#!/usr/bin/env node

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { allowlistedDirectories, EXPECTED_FILES, withoutChunkHash } from './check-tarballs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function workspacePackages() {
  return Promise.all(allowlistedDirectories(root).map(async (directory) => {
    const { name, version } = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    return { directory, name, version };
  }));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result.stdout;
}

function archiveEntries(tarball) {
  return run('tar', ['-tzf', tarball])
    .split(/\r?\n/)
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean)
    .sort();
}

function archiveText(tarball, path) {
  return run('tar', ['-xOzf', tarball, path]);
}

function exportTargets(value, output = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) output.push(value.slice(2));
    return output;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) exportTargets(nested, output);
  }
  return output;
}

export function assertPackedPackage(definition, tarball) {
  const entries = archiveEntries(tarball);
  const failures = [];
  const pinnedFiles = EXPECTED_FILES[definition.name];

  if (!pinnedFiles) throw new Error(`${definition.name}: missing pinned file list`);

  const remaining = entries.map(withoutChunkHash);
  for (const path of pinnedFiles) {
    const index = remaining.indexOf(path);
    if (index === -1) failures.push(`missing ${path.slice('package/'.length)}`);
    else remaining.splice(index, 1);
  }
  for (const path of remaining) failures.push(`unexpected archive path ${path}`);

  const manifest = JSON.parse(archiveText(tarball, 'package/package.json'));
  if (manifest.name !== definition.name) failures.push(`manifest name is ${manifest.name}`);
  if (manifest.version !== definition.version) failures.push(`manifest version is ${manifest.version}`);
  if (manifest.publishConfig?.access !== 'public') failures.push('publish access is not public');
  if (JSON.stringify(manifest).includes('workspace:')) failures.push('workspace protocol leaked into the archive');

  const targets = new Set([
    ...exportTargets(manifest.exports),
    ...exportTargets(manifest.main),
    ...exportTargets(manifest.types),
  ]);
  for (const target of targets) {
    if (!entries.includes(`package/${target}`) && !pinnedFiles.includes(`package/${target}`)) failures.push(`export target ${target} is missing`);
  }

  for (const path of entries.filter((entry) => entry.endsWith('.map'))) {
    const sourceMap = archiveText(tarball, path);
    if (sourceMap.includes(root)) failures.push(`${path} exposes the local checkout path`);
  }

  if (failures.length) {
    throw new Error(`${definition.name} archive is invalid:\n- ${failures.join('\n- ')}`);
  }

  const dryRun = run('npm', [
    'publish',
    tarball,
    '--dry-run',
    '--ignore-scripts',
    '--access',
    'public',
    '--json',
  ]);
  const report = JSON.parse(dryRun);
  if (report.name !== definition.name || report.version !== definition.version) {
    throw new Error(`${definition.name} npm dry-run reported the wrong package identity`);
  }

  return entries.length;
}

export async function packWorkspacePackages(destination) {
  return packPackages(destination, await workspacePackages());
}

async function packPackages(destination, packages) {
  const archives = new Map();
  for (const definition of packages) {
    const before = new Set(await readdir(destination));
    run('pnpm', [
      '--dir',
      definition.directory,
      'pack',
      '--pack-destination',
      destination,
    ]);
    const created = (await readdir(destination)).filter(
      (path) => path.endsWith('.tgz') && !before.has(path),
    );
    if (created.length !== 1) {
      throw new Error(`${definition.name} pack created ${created.length} archives instead of one`);
    }
    archives.set(definition.name, join(destination, created[0]));
  }
  return archives;
}

export async function verifyPackedPackages(destination) {
  const packages = await workspacePackages();
  const archives = await packPackages(destination, packages);
  const reports = [];
  for (const definition of packages) {
    const tarball = archives.get(definition.name);
    const fileCount = assertPackedPackage(definition, tarball);
    reports.push(`${definition.name}@${definition.version} (${fileCount} files)`);
  }
  return { archives, reports };
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-packages-'));
  try {
    const { reports } = await verifyPackedPackages(directory);
    console.log(`Package archives and npm dry-runs passed:\n- ${reports.join('\n- ')}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
