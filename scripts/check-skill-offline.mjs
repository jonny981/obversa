#!/usr/bin/env node
// The offline skill proof: the
// packed @obversa/source archive carries the review-diff skill and the one
// bin with a matching major; and the skill's exact command line — npx with
// the pinned major — resolves the packed bin from a local registry stand-in,
// prints the loopback URL, and frames the interrupted session with the
// surface identity. Placement is proved through the same command with a
// recording adapter in OBVERSA_SURFACE_BIN, which receives the one-time
// launch URL, never the token.
//
// Nothing reaches a public registry: the stand-in serves the two packed
// surface tarballs, and every external dependency in the closure is
// re-archived from the workspace's own installed copies. The live-client
// discovery checks (step 3) are recorded by hand at gate time, not here.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxSatisfying } from 'semver';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const NPX_CLI = join(dirname(require.resolve('npm/package.json')), 'bin', 'npx-cli.js');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: options.env ?? process.env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

// ---- The closure: every package the source tarball's install needs. ----

// The workspace's installed copy of name@version, from the isolated store.
function installedDirectory(name, version) {
  const hidden = join(root, 'node_modules', '.pnpm');
  const prefix = `${name.replace('/', '+')}@${version}`;
  const entry = readdirSync(hidden).find((candidate) => candidate === prefix || candidate.startsWith(`${prefix}_`));
  if (!entry) throw new Error(`${name}@${version} is not installed in the workspace store`);
  return join(hidden, entry, 'node_modules', ...name.split('/'));
}

// Resolve one declared range to an installed version of the name.
function installedVersion(name, range) {
  const hidden = join(root, 'node_modules', '.pnpm');
  const escaped = `${name.replace('/', '+')}@`;
  const versions = [...new Set(
    readdirSync(hidden)
      .filter((entry) => entry.startsWith(escaped))
      .map((entry) => entry.slice(escaped.length).split('_')[0]),
  )];
  const satisfying = maxSatisfying(versions, range);
  if (!satisfying) throw new Error(`${name}: no installed version satisfies ${range}; found ${versions.join(', ') || 'none'}`);
  return satisfying;
}

function archive(directory, destination) {
  const staging = join(destination, '.staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(directory, join(staging, 'package'), { recursive: true, dereference: true });
  const tarball = join(destination, `${basename(directory)}-${createHash('sha1').update(directory).digest('hex').slice(0, 8)}.tgz`);
  run('tar', ['-czf', tarball, '-C', staging, 'package']);
  rmSync(staging, { recursive: true, force: true });
  return tarball;
}

// ---- The registry stand-in. ----

async function startRegistry(packages) {
  const server = http.createServer((request, response) => {
    const url = decodeURIComponent(request.url.split('?')[0]);
    if (process.env.OBVERSA_PROOF_DEBUG) console.error(`registry: ${request.method} ${url}`);
    if (url.startsWith('/tarballs/')) {
      const entry = [...packages.values()].flatMap((versions) => [...versions.values()]).find((candidate) => candidate.tarballName === url.slice('/tarballs/'.length));
      if (!entry) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      createReadStream(entry.tarball).pipe(response);
      return;
    }
    const name = url.slice(1);
    const versions = packages.get(name);
    if (!versions) { response.writeHead(404); response.end('{"error":"not found"}'); return; }
    const port = server.address().port;
    const document = {
      name,
      'dist-tags': { latest: [...versions.keys()].sort().at(-1) },
      versions: Object.fromEntries([...versions.entries()].map(([version, entry]) => [version, {
        ...entry.manifest,
        dist: { tarball: `http://127.0.0.1:${port}/tarballs/${entry.tarballName}`, shasum: entry.shasum, integrity: entry.integrity },
      }])),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(document));
  });
  // npm reuses sockets aggressively and backs off for tens of seconds when a
  // reused socket dies; node's default 5s keep-alive turnover made the
  // install look deadlocked at the quiet log levels (chattier levels shifted
  // the timing off the closure window). The stand-in outlives the run.
  server.keepAliveTimeout = 180_000;
  server.headersTimeout = 185_000;
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()));
  return server;
}

function record(packages, manifest, tarball) {
  const bytes = readFileSync(tarball);
  if (!packages.has(manifest.name)) packages.set(manifest.name, new Map());
  packages.get(manifest.name).set(manifest.version, {
    manifest,
    tarball,
    tarballName: basename(tarball),
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  });
}

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'obversa-skill-offline-'));
  const archives = join(directory, 'archives');
  mkdirSync(archives);
  let server;
  let child;
  try {
    // Step 1: the packed archive carries the skill and the bin, majors agree.
    const sourceManifest = JSON.parse(await readFile(join(root, 'packages', 'source', 'package.json'), 'utf8'));
    const sourceTarball = join(archives, 'obversa-source.tgz');
    run('pnpm', ['--dir', join(root, 'packages', 'source'), 'pack', '--pack-destination', archives]);
    run('mv', [join(archives, `obversa-source-${sourceManifest.version}.tgz`), sourceTarball]);
    const entries = run('tar', ['-tzf', sourceTarball]).split('\n');
    assert.ok(entries.includes('package/skills/review-diff/SKILL.md'), 'the packed archive carries the skill');
    assert.ok(entries.includes('package/bin/obversa-review.mjs'), 'the packed archive carries the bin');
    assert.deepEqual(sourceManifest.obversa?.skills, ['review-diff'], 'the manifest lists the skill as audit metadata');
    const skillText = await readFile(join(root, 'packages', 'source', 'skills', 'review-diff', 'SKILL.md'), 'utf8');
    const commandMatch = /npx -y @obversa\/source@(\d+)/.exec(skillText);
    assert.ok(commandMatch, 'the skill carries the one command line');
    assert.equal(commandMatch[1], sourceManifest.version.split('.')[0], "the skill's command major equals the package major");
    assert.match(skillText, /<<<REVIEW_RESULT_V1>>>/, 'the skill names the real frame markers');

    // The registry closure: the packed surfaces plus every external
    // dependency, re-archived from the workspace's installed copies.
    const packages = new Map();
    const packedManifest = (tarball) => {
      const listing = run('tar', ['-xzOf', tarball, 'package/package.json']);
      return JSON.parse(listing);
    };
    const surfacerTarball = join(archives, 'obversa-surfacer.tgz');
    run('pnpm', ['--dir', join(root, 'packages', 'surfacer'), 'pack', '--pack-destination', archives]);
    const surfacerManifest = JSON.parse(await readFile(join(root, 'packages', 'surfacer', 'package.json'), 'utf8'));
    run('mv', [join(archives, `obversa-surfacer-${surfacerManifest.version}.tgz`), surfacerTarball]);
    record(packages, packedManifest(sourceTarball), sourceTarball);
    record(packages, packedManifest(surfacerTarball), surfacerTarball);
    const queue = Object.entries(packedManifest(sourceTarball).dependencies ?? {}).filter(([name]) => !name.startsWith('@obversa/'));
    const seen = new Set();
    while (queue.length > 0) {
      const [name, range] = queue.shift();
      const key = `${name}@${range}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const version = installedVersion(name, range);
      const installed = installedDirectory(name, version);
      const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
      record(packages, manifest, archive(installed, archives));
      queue.push(...Object.entries(manifest.dependencies ?? {}));
    }
    server = await startRegistry(packages);
    const registry = `http://127.0.0.1:${server.address().port}/`;

    // A repository with one change to review.
    const repository = join(directory, 'reviewed-repo');
    mkdirSync(repository);
    const git = (...args) => run('git', args, { cwd: repository });
    git('init', '-q');
    git('config', 'user.email', 'proof@example.com');
    git('config', 'user.name', 'Proof');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repository, 'a.txt'), 'alpha\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(repository, 'a.txt'), 'alpha\nbeta\n');

    const home = join(directory, 'home');
    mkdirSync(home);
    const environment = {
      ...process.env,
      HOME: home,
      npm_config_registry: registry,
      npm_config_cache: join(directory, 'npm-cache'),
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      // Against this registry stand-in, the pinned npm's exec hangs
      // mid-install at the quiet log levels (npm 10.9.2: notice and error
      // deadlock; info and silly complete; stdin open or closed makes no
      // difference, nor does the stand-in's keep-alive). The same npx
      // invocation against the real registry completes at the default level
      // over the same pipes with stdin closed, so the hang is a stand-in
      // interaction, not the skill's real-world behaviour; info keeps this
      // proof deterministic, and the skill's command line sets nothing.
      npm_config_loglevel: 'info',
    };
    delete environment.OBVERSA_SURFACE_BIN;

    // Step 4: the skill's exact command line reaches the packed bin through
    // the stand-in, prints the loopback URL, and the interrupted session
    // frames with the surface identity.
    const runSkillCommand = (extraEnv, args) => {
      const spawned = spawn(process.execPath, [NPX_CLI, '-y', '@obversa/source@0', ...args], {
        cwd: repository,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...environment, ...extraEnv },
      });
      const state = { child: spawned, stdout: '', stderr: '' };
      spawned.stdout.on('data', (chunk) => { state.stdout += chunk; });
      spawned.stderr.on('data', (chunk) => { state.stderr += chunk; });
      state.url = (pattern) => new Promise((resolveUrl, reject) => {
        const timer = setTimeout(() => reject(new Error(`no session url within 120s; stderr:\n${state.stderr}\nstdout:\n${state.stdout}`)), 120_000);
        timer.unref?.();
        const probe = () => {
          const match = pattern.exec(state.stderr);
          if (match) { clearTimeout(timer); resolveUrl(match[1]); }
        };
        spawned.stderr.on('data', probe);
        probe();
        spawned.on('exit', (code) => reject(new Error(`the command exited (${code}) before the session url; stderr:\n${state.stderr}\nstdout:\n${state.stdout}`)));
      });
      state.exit = () => new Promise((resolveExit) => spawned.on('exit', resolveExit));
      return state;
    };

    if (process.env.OBVERSA_PROOF_HOLD) {
      console.log(`registry ${registry} repo ${repository} cache ${environment.npm_config_cache} home ${home}`);
      await new Promise(() => {});
    }
    child = runSkillCommand({}, ['--no-open']);
    const url = await child.url(/Open the review surface at: (\S+)/);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//, 'the loopback url is printed on stderr');
    child.child.kill('SIGINT');
    await child.exit();
    const frame = /<<<REVIEW_RESULT_V1>>>([\s\S]*?)<<<END_REVIEW_RESULT_V1>>>/.exec(child.stdout);
    assert.ok(frame, `the interrupted session still frames; stdout:\n${child.stdout.slice(0, 300)}`);
    const interrupted = JSON.parse(frame[1]);
    assert.equal(interrupted.status, 'interrupted');
    assert.deepEqual(interrupted.surface, { package: '@obversa/source', version: sourceManifest.version }, 'the frame carries the surface identity');

    // Step 5a: with a recording adapter injected, the same command hands the
    // adapter the one-time launch URL, never the token-bearing page URL.
    const recordFile = join(directory, 'placement-record');
    const adapter = join(directory, 'record-placement');
    writeFileSync(adapter, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(recordFile)}\nexit 0\n`);
    chmodSync(adapter, 0o755);
    child = runSkillCommand({ OBVERSA_SURFACE_BIN: adapter }, []);
    await child.url(/(http:\/\/127\.0\.0\.1:\d+)/);
    const placed = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (existsSync(recordFile)) return readFileSync(recordFile, 'utf8');
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      throw new Error(`the adapter was never invoked; stderr:\n${child.stderr}`);
    })();
    assert.match(placed, /^http:\/\/127\.0\.0\.1:\d+\/launch\//, 'the adapter receives the one-time launch url');
    assert.ok(!placed.includes('#'), 'the token never reaches a process argument');
    child.child.kill('SIGINT');
    await child.exit();

    console.log(`Offline skill proof passed: the pinned command resolved @obversa/source@${sourceManifest.version} from the stand-in (${packages.size} packages served), framed the interrupt with the identity, and handed placement the launch url.`);
  } finally {
    try { child?.child.kill('SIGKILL'); } catch {}
    server?.close();
    if (process.env.OBVERSA_PROOF_DEBUG) console.error(`debug: temp tree kept at ${directory}`);
    else await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
