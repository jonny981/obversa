import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPackageCounts } from './check-package-counts.mjs';

const validReadme = (packages, plugins, total) => `
## What is in this repository

${total} publishable packages. packages/ holds the ${packages} that define the product: @obversa/runtime runs workflows, @obversa/builtin-workflows provides three ready-made recipes, @obversa/runner supervises stored runs, @obversa/api holds the engine and memory contracts, @obversa/core runs bounded child processes, and @obversa/surface and @obversa/surface-diff are the local review surface. plugins/ holds the ${plugins} adapters: the six engines above and two memories, one in process and one in private Git references.
`;

const validReleasing = (packages, plugins, total) => `
7. **Publish through the guarded script.** At the repository tag, run the script once for every name in scripts/publish-allowlist.json (${total} packages) from a clean main checkout at that tag. ${packages} public packages use packages/<name>; ${plugins} plugin packages use plugins/<name> (six engine adapters and two memory adapters):
`;

const layout = [
  ['packages', 'one', 'a'],
  ['packages', 'two', 'b'],
  ['plugins', 'one', 'c'],
  ['plugins', 'two', 'd'],
  ['plugins', 'three', 'e'],
];

async function packageDir(root, directory, entry, manifest) {
  await mkdir(join(root, directory, entry), { recursive: true });
  await writeFile(join(root, directory, entry, 'package.json'), JSON.stringify(manifest));
}

test('accepts README and release counts that match the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-package-counts-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    for (const [directory, entry, name] of layout) {
      await packageDir(root, directory, entry, { name });
    }
    await writeFile(join(root, 'scripts/publish-allowlist.json'), JSON.stringify({ packages: ['a', 'b', 'c', 'd', 'e'] }));
    await writeFile(join(root, 'README.md'), validReadme('two', 'three', 5));
    await writeFile(join(root, 'docs/RELEASING.md'), validReleasing('two', 'three', 5));

    assert.deepEqual(await checkPackageCounts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails when a document count is mutated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-package-counts-mutation-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    for (const [directory, entry, name] of layout) {
      await packageDir(root, directory, entry, { name });
    }
    await writeFile(join(root, 'scripts/publish-allowlist.json'), JSON.stringify({ packages: ['a', 'b', 'c', 'd', 'e'] }));
    await writeFile(join(root, 'README.md'), validReadme('two', 'three', 4));
    await writeFile(join(root, 'docs/RELEASING.md'), validReleasing('two', 'three', 5));

    const failures = await checkPackageCounts(root);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /README\.md/);

    await writeFile(join(root, 'README.md'), validReadme('two', 'three', 5));
    await writeFile(join(root, 'docs/RELEASING.md'), validReleasing('two', 'four', 5));
    const releaseFailures = await checkPackageCounts(root);
    assert.equal(releaseFailures.length, 1);
    assert.match(releaseFailures[0], /docs\/RELEASING\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('excludes a private package directory from the public counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-package-counts-private-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    for (const [directory, entry, name] of layout) {
      await packageDir(root, directory, entry, { name });
    }
    // A sixth package directory that is explicitly not publishable: it is
    // neither counted nor required to be on the allowlist.
    await packageDir(root, 'plugins', 'four', { name: 'f', private: true });
    await writeFile(join(root, 'scripts/publish-allowlist.json'), JSON.stringify({ packages: ['a', 'b', 'c', 'd', 'e'] }));
    await writeFile(join(root, 'README.md'), validReadme('two', 'three', 5));
    await writeFile(join(root, 'docs/RELEASING.md'), validReleasing('two', 'three', 5));

    assert.deepEqual(await checkPackageCounts(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails when a public package is missing from the allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-package-counts-omitted-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    for (const [directory, entry, name] of layout) {
      await packageDir(root, directory, entry, { name });
    }
    // A sixth public package no allowlist name covers.
    await packageDir(root, 'plugins', 'four', { name: 'f' });
    await writeFile(join(root, 'scripts/publish-allowlist.json'), JSON.stringify({ packages: ['a', 'b', 'c', 'd', 'e'] }));
    await writeFile(join(root, 'README.md'), validReadme('two', 'four', 6));
    await writeFile(join(root, 'docs/RELEASING.md'), validReleasing('two', 'four', 6));

    const failures = await checkPackageCounts(root);
    assert.ok(failures.some((failure) => /f \(plugins\) is a public package missing from the publish allowlist/.test(failure)));
    assert.ok(failures.some((failure) => /publish allowlist has 5 names, but packages\/ and plugins\/ contain 6 public packages/.test(failure)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
