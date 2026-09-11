import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPackageCounts } from './check-package-counts.mjs';

const validReadme = (packages, plugins, total) => `
## What is in this repository

${total} publishable packages. packages/ holds the ${packages} that define the product: @obversa/runtime is the runtime and its public contract, @obversa/teams is three ready-made teams built on it, @obversa/runner supervises stored runs, @obversa/engine and @obversa/memory are the engine and memory contracts, @obversa/process runs a child process to a deadline, and @obversa/surfacer and @obversa/source are the local review surface. plugins/ holds the ${plugins} adapters: the six engines above and two memories, one in process and one in private Git references.
`;

const validReleasing = (packages, plugins, total) => `
7. **Publish through the guarded script.** At the repository tag, run the script once for every name in scripts/publish-allowlist.json (${total} packages) from a clean main checkout at that tag. ${packages} public packages use packages/<name>; ${plugins} plugin packages use plugins/<name> (six engine adapters and two memory adapters):
`;

test('accepts README and release counts that match the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'obversa-package-counts-'));
  try {
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
    await mkdir(join(root, 'packages', 'one'), { recursive: true });
    await mkdir(join(root, 'packages', 'two'), { recursive: true });
    await mkdir(join(root, 'plugins', 'one'), { recursive: true });
    await mkdir(join(root, 'plugins', 'two'), { recursive: true });
    await mkdir(join(root, 'plugins', 'three'), { recursive: true });
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
    await mkdir(join(root, 'packages', 'one'), { recursive: true });
    await mkdir(join(root, 'packages', 'two'), { recursive: true });
    await mkdir(join(root, 'plugins', 'one'), { recursive: true });
    await mkdir(join(root, 'plugins', 'two'), { recursive: true });
    await mkdir(join(root, 'plugins', 'three'), { recursive: true });
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
