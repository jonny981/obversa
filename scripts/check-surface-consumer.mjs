#!/usr/bin/env node
// The standalone surface-consumer proof (an internal note; the F2b
// complete-when): a clean consumer with nothing but the packed
// @obversa/source tarball and its declared dependencies opens a review with
// --no-open, completes it over HTTP the way the browser would, and reads
// the framed result carrying the surface identity.
//
// Everything resolves from the tarballs and the offline store: the packed
// source depends on the packed surfacer through one override, install runs
// --offline with scripts ignored, and the command under test is the bin the
// install linked — never the working tree.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

async function pack(directory, destination) {
  const before = new Set(await readdir(destination));
  run('pnpm', ['--dir', join(root, 'packages', directory), 'pack', '--pack-destination', destination]);
  const created = (await readdir(destination)).filter((entry) => entry.endsWith('.tgz') && !before.has(entry));
  if (created.length !== 1) throw new Error(`${directory} pack created ${created.length} archives instead of one`);
  return join(destination, created[0]);
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-surface-consumer-'));
  const archives = join(directory, 'archives');
  const consumer = join(directory, 'consumer');
  const repository = join(directory, 'reviewed-repo');
  try {
    await mkdir(archives);
    await mkdir(consumer);
    await mkdir(repository);

    const surfacerTarball = await pack('surfacer', archives);
    const sourceTarball = await pack('source', archives);
    await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
      name: 'obversa-surface-consumer-proof',
      private: true,
      type: 'module',
      dependencies: { '@obversa/source': `file:${sourceTarball}` },
      // pnpm pack rewrote the workspace range into a registry version; the
      // override points that name at the packed surfacer instead, so nothing
      // resolves outside the two tarballs and the offline store.
      pnpm: { overrides: { '@obversa/surfacer': `file:${surfacerTarball}` } },
    }, null, 2)}\n`);
    run('pnpm', ['install', '--offline', '--ignore-scripts'], {
      cwd: consumer,
      env: { CI: 'true', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    });
    // The isolated linker keeps the transitive surfacer out of the top-level
    // node_modules; both installed manifests are read from the store layout.
    const hidden = join(consumer, 'node_modules', '.pnpm');
    const surfacerEntry = (await readdir(hidden)).find((entry) => entry.startsWith('@obversa+surfacer@'));
    assert.ok(surfacerEntry, 'the packed surfacer installed as a dependency of the packed source');
    for (const manifestPath of [
      join(consumer, 'node_modules', '@obversa', 'source', 'package.json'),
      join(hidden, surfacerEntry, 'node_modules', '@obversa', 'surfacer', 'package.json'),
    ]) {
      const installed = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (JSON.stringify(installed).includes('workspace:')) {
        throw new Error(`${installed.name} retained a workspace dependency after installation`);
      }
    }
    // The command as the install linked it, run under this Node by its real
    // path: the .bin entry is a shell shim, and the bin field names the file.
    const installedSource = JSON.parse(await readFile(join(consumer, 'node_modules', '@obversa', 'source', 'package.json'), 'utf8'));
    const command = join(consumer, 'node_modules', '@obversa', 'source', installedSource.bin['obversa-review']);

    // The linked bin loads and answers --help from the packed tree alone.
    const help = spawnSync(process.execPath, [command, '--help'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);

    // A repository with one change to review.
    const git = (...args) => run('git', args, { cwd: repository });
    git('init', '-q');
    git('config', 'user.email', 'proof@example.com');
    git('config', 'user.name', 'Proof');
    git('config', 'commit.gpgsign', 'false');
    await writeFile(join(repository, 'a.txt'), 'alpha\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    await writeFile(join(repository, 'a.txt'), 'alpha\nbeta\n');

    // Open the review with --no-open: the session URL is printed on stderr,
    // and this proof plays the browser over HTTP.
    const child = spawn(process.execPath, [command, '--no-open', '--cwd', repository], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const url = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(() => reject(new Error(`no session url within 30s; stderr so far:\n${stderr}`)), 30_000);
      timer.unref?.();
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        const match = /Open the review surface at: (\S+)/.exec(stderr);
        if (match) { clearTimeout(timer); resolveUrl(match[1]); }
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`the command exited (${code}) before the session url; stderr:\n${stderr}`)));
    });

    const token = url.split('#')[1];
    assert.ok(token, 'the session url carries the token fragment');
    const origin = new URL(url).origin;
    const headers = { Authorization: `Bearer ${token}`, Origin: origin, 'Content-Type': 'application/json' };
    const model = await (await fetch(`${origin}/api/model`, { headers })).json();
    assert.equal(model.meta.label, 'working tree');
    assert.equal(model.model.files[0].path, 'a.txt');
    const line = model.model.files[0].hunks[0].lines.find((entry) => entry.newNumber != null);
    const submitResponse = await fetch(`${origin}/api/submit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision: 'changes-requested',
        annotations: [{ anchor: { target: 'a.txt', side: 'new', position: line.newNumber }, body: 'looks right' }],
      }),
    });
    const submitted = await submitResponse.json();
    assert.ok(submitted.operationId, `the completion answers with the operation id to acknowledge; got ${submitResponse.status}: ${JSON.stringify(submitted)}`);
    await fetch(`${origin}/api/ack`, { method: 'POST', headers, body: JSON.stringify({ operationId: submitted.operationId }) });

    const exitCode = await new Promise((resolveExit) => child.on('exit', resolveExit));
    assert.equal(exitCode, 0, `the command exits 0 on a completed review; stderr:\n${stderr}`);

    // The framed result, read as a consumer reads it: between the markers,
    // with the surface identity naming the packed package and version.
    const frame = /<<<REVIEW_RESULT_V1>>>([\s\S]*?)<<<END_REVIEW_RESULT_V1>>>/.exec(stdout);
    assert.ok(frame, `a framed result is on stdout; got:\n${stdout.slice(0, 400)}`);
    const result = JSON.parse(frame[1]);
    const packedVersion = JSON.parse(await readFile(join(consumer, 'node_modules', '@obversa', 'source', 'package.json'), 'utf8')).version;
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.surface, { package: '@obversa/source', version: packedVersion }, 'the frame names the surface package and its resolved version');
    assert.equal(result.payload.decision, 'changes-requested');
    assert.equal(result.payload.annotations.length, 1);
    assert.match(stderr, /finished: changes-requested, 1 annotation returned/);

    console.log(`Surface consumer proof passed: ${result.surface.package}@${result.surface.version} reviewed, framed, and acknowledged from the packed tarballs alone.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
