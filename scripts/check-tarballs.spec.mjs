// The pass/fail fixtures for the tarball shape check: a manifest whose paths
// lie fails publint, a types condition that resolves to nothing fails attw,
// and a truthful package passes both. Failure assertions first — a check
// that cannot fail proves nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { allowlistedDirectories, checkTarball, EXPECTED_FILES } from "./check-tarballs.mjs";
import { assertPackedPackage } from "./check-packages.mjs";

const fixture = realpathSync(mkdtempSync(join(tmpdir(), "obversa-tarball-spec-")));
test.after(() => rmSync(fixture, { recursive: true, force: true }));

function pkg(name, manifest, files) {
  const directory = join(fixture, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@fixture/${name}`, version: "1.0.0", type: "module", ...manifest }, null, 2));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
}

test("a manifest path that does not exist fails publint", () => {
  const directory = pkg("bad-manifest", { exports: { ".": "./dist/index.js" } }, { "src/index.js": "export const a = 1;\n" });
  const failures = checkTarball(directory);
  assert.ok(failures.some((line) => line.includes("publint")), `publint must fail: ${JSON.stringify(failures)}`);
});

test("types that disagree with the runtime module fail attw", () => {
  // Every file exists, so publint passes; the types declare an ES module
  // while the runtime file is CommonJS, which only attw sees.
  const directory = pkg(
    "bad-types",
    { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.cjs" } } },
    { "dist/index.cjs": "module.exports = { a: 1 };\n", "dist/index.d.ts": "export declare const a: number;\n" },
  );
  const failures = checkTarball(directory);
  assert.ok(failures.some((line) => line.includes("attw")), `attw must fail: ${JSON.stringify(failures)}`);
  assert.ok(!failures.some((line) => line.includes("publint")), `publint must stay silent: ${JSON.stringify(failures)}`);
});

test("an extra file beyond the pinned list fails, named", () => {
  const directory = pkg(
    "extra-file",
    { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
    { "dist/index.js": "export const a = 1;\n", "dist/index.d.ts": "export declare const a: number;\n", "dist/stray.js": "export const s = 1;\n" },
  );
  const failures = checkTarball(directory, {
    expectedFiles: ["package/package.json", "package/dist/index.js", "package/dist/index.d.ts"],
  });
  assert.ok(failures.some((line) => line.includes("not exactly the pinned file list") && line.includes("dist/stray.js")), `the extra file must be named: ${JSON.stringify(failures)}`);
});

test("a truthful package passes both tools", () => {
  const directory = pkg(
    "good",
    { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
    { "dist/index.js": "export const a = 1;\n", "dist/index.d.ts": "export declare const a: number;\n" },
  );
  assert.deepEqual(checkTarball(directory), []);
});

test("the tarball command refuses an allowlisted package with no pinned file list", () => {
  pkg("unpinned-workspace/packages/new", {
    name: "@fixture/unpinned",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  }, { "dist/index.js": "export const a = 1;\n", "dist/index.d.ts": "export declare const a: number;\n" });
  const root = join(fixture, "unpinned-workspace");
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(join(root, "scripts/publish-allowlist.json"), JSON.stringify({ packages: ["@fixture/unpinned"] }));
  for (const name of ["check-tarballs.mjs", "check-publish-allowlist.mjs", "repository-version.mjs"]) {
    copyFileSync(new URL(name, import.meta.url), join(root, "scripts", name));
  }
  symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
  const result = spawnSync(process.execPath, [join(root, "scripts/check-tarballs.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /@fixture\/unpinned: missing pinned file list/);
});

test("a build-hashed chunk matches its chunk-* pin, and a missing chunk still fails", () => {
  const directory = pkg(
    "hashed-chunk",
    { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } },
    { "dist/index.js": "export const a = 1;\n", "dist/index.d.ts": "export declare const a: number;\n", "dist/chunk-Q7ZK2M4P.js": "export const c = 1;\n" },
  );
  const pinned = ["package/package.json", "package/dist/index.js", "package/dist/index.d.ts", "package/dist/chunk-*.js"];
  assert.deepEqual(checkTarball(directory, { expectedFiles: pinned }), [], "the hashed chunk name must satisfy the chunk-* pin");
  const failures = checkTarball(directory, { expectedFiles: [...pinned, "package/dist/chunk-*.js.map"] });
  assert.ok(failures.some((line) => line.includes("missing") && line.includes("chunk-*.js.map")), `a pinned chunk that is not packed must be named: ${JSON.stringify(failures)}`);
});

test("the packed archive checker refuses a package with no pinned file list", () => {
  const directory = pkg("unpinned-archive", {
    publishConfig: { access: "public", registry: "https://publish.invalid.invalid/", "@fixture:registry": "https://publish.invalid.invalid/" },
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  }, {
    "LICENSE": "MIT\n",
    "README.md": "Fixture package.\n",
    "dist/index.js": "export const a = 1;\n",
    "dist/index.d.ts": "export declare const a: number;\n",
  });
  const packed = spawnSync("pnpm", ["--dir", directory, "pack", "--pack-destination", fixture], { encoding: "utf8" });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  assert.throws(
    () => assertPackedPackage({ name: "@fixture/unpinned-archive", version: "1.0.0" }, join(fixture, "fixture-unpinned-archive-1.0.0.tgz")),
    /@fixture\/unpinned-archive: missing pinned file list/,
  );
});

function packageWorkspace(name) {
  const root = pkg(name, { private: true }, {});
  cpSync(new URL(".", import.meta.url), join(root, "scripts"), { recursive: true });
  symlinkSync(new URL("../node_modules", import.meta.url), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(join(root, "scripts/publish-allowlist.json"), JSON.stringify({ packages: ["@obversa/memory-simple"] }));
  const directory = pkg(`${name}/packages/relocated-memory`, {
    name: "@obversa/memory-simple",
    version: "0.1.0",
    publishConfig: { access: "public", registry: "http://publish-guard.invalid/", "@obversa:registry": "http://publish-guard.invalid/" },
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  }, {
    "LICENSE": "MIT\n",
    "README.md": "Fixture package.\n",
    "dist/index.js": "export const a = 1;\n",
    "dist/index.d.ts": "export declare const a: number;\n",
    "dist/index.js.map": "{}\n",
  });
  return { root, directory };
}

test("the allowlisted directory helper names a missing workspace package", () => {
  const { root, directory } = packageWorkspace("missing-package-helper");
  assert.deepEqual(allowlistedDirectories(root), [directory]);
  rmSync(directory, { recursive: true, force: true });

  assert.throws(() => allowlistedDirectories(root), {
    message: "@obversa/memory-simple is on the allowlist but is not a workspace package",
  });
});

for (const script of ["check-tarballs.mjs", "check-packages.mjs"]) {
  test(`${script} names a missing allowlisted workspace package`, () => {
    const { root, directory } = packageWorkspace(`missing-package-${script}`);
    rmSync(directory, { recursive: true, force: true });

    const result = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /@obversa\/memory-simple is on the allowlist but is not a workspace package/);
  });
}

test("the package command follows the allowlist and refuses an added unpinned package", () => {
  const { root } = packageWorkspace("package-allowlist");
  pkg("package-allowlist/packages/new", { name: "@fixture/unpinned" }, {});
  const check = () => spawnSync(process.execPath, [join(root, "scripts/check-packages.mjs")], { cwd: root, encoding: "utf8" });
  const allowed = check();
  assert.equal(allowed.status, 0, `${allowed.stdout}\n${allowed.stderr}`);
  assert.match(allowed.stdout, /@obversa\/memory-simple@0\.1\.0 \(6 files\)/);
  assert.doesNotMatch(allowed.stdout, /@fixture\/unpinned/);

  writeFileSync(join(root, "scripts/publish-allowlist.json"), JSON.stringify({ packages: ["@obversa/memory-simple", "@fixture/unpinned"] }));
  const added = check();
  assert.equal(added.status, 1, `${added.stdout}\n${added.stderr}`);
  assert.match(added.stderr, /@fixture\/unpinned: missing pinned file list/);
});

test("the package command checks the version from the workspace manifest", () => {
  const { root, directory } = packageWorkspace("package-version");
  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "0.2.3" }));

  const result = spawnSync(process.execPath, [join(root, "scripts/check-packages.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /@obversa\/memory-simple@0\.2\.3 \(6 files\)/);
});

test("the packed archive checker reports a missing LICENSE once", () => {
  const { root, directory } = packageWorkspace("package-license");
  rmSync(join(directory, "LICENSE"));
  const packed = spawnSync("pnpm", ["--dir", directory, "pack", "--pack-destination", root], { encoding: "utf8" });
  assert.equal(packed.status, 0, `${packed.stdout}\n${packed.stderr}`);
  assert.throws(
    () => assertPackedPackage({ name: "@obversa/memory-simple", version: "0.1.0" }, join(root, "obversa-memory-simple-0.1.0.tgz")),
    { message: "@obversa/memory-simple archive is invalid:\n- missing LICENSE" },
  );
});

function packedFixture(name, { missing = [], extraChunks = 0, exportTarget = "./dist/index.js" } = {}) {
  const directory = join(fixture, name);
  const files = EXPECTED_FILES['@obversa/runner'].filter((path) => !missing.includes(path))
    .map((path) => path.replace('chunk-*', 'chunk-AAAAAAAA'));
  for (let index = 0; index < extraChunks; index += 1) {
    files.push(`package/dist/chunk-${String(index).padStart(8, 'B')}.js`);
  }
  for (const file of files) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), file === 'package/package.json' ? JSON.stringify({
      name: '@obversa/runner', version: '0.1.0', publishConfig: { access: 'public' },
      exports: { '.': { types: './dist/index.d.ts', import: exportTarget } },
    }) : file.endsWith('.map') ? '{}' : 'fixture\n');
  }
  const archive = join(fixture, `${name}.tgz`);
  const packed = spawnSync('tar', ['-czf', archive, '-C', directory, ...files], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  return archive;
}

test('the packed archive checker rejects an extra hashed chunk', () => {
  assert.equal(assertPackedPackage({ name: '@obversa/runner', version: '0.1.0' }, packedFixture('one-hashed-chunk')), EXPECTED_FILES['@obversa/runner'].length);
  const archive = packedFixture('extra-hashed-chunk', { extraChunks: 1 });
  assert.throws(() => assertPackedPackage({ name: '@obversa/runner', version: '0.1.0' }, archive),
    /unexpected archive path package\/dist\/chunk-\*\.js/);
});

test('the packed archive checker names a missing pinned export only once', () => {
  const archive = packedFixture('missing-pinned-export', { missing: ['package/dist/index.js'] });
  assert.throws(() => assertPackedPackage({ name: '@obversa/runner', version: '0.1.0' }, archive), {
    message: '@obversa/runner archive is invalid:\n- missing dist/index.js',
  });
});

test('importing the packed checker does not resolve the workspace allowlist', () => {
  const { root, directory } = packageWorkspace('lazy-package-import');
  rmSync(directory, { recursive: true, force: true });
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
    "const { assertPackedPackage } = await import('./scripts/check-packages.mjs'); console.log(typeof assertPackedPackage);"],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'function');
});

test('the packed archive checker reads hashed source maps and checks literal hashed exports', () => {
  const definition = { name: '@obversa/runner', version: '0.1.0' };
  const valid = packedFixture('hashed-export', { exportTarget: './dist/chunk-AAAAAAAA.js' });
  assert.equal(assertPackedPackage(definition, valid), EXPECTED_FILES[definition.name].length);
  const missing = packedFixture('wrong-hashed-export', { exportTarget: './dist/chunk-BBBBBBBB.js' });
  assert.throws(() => assertPackedPackage(definition, missing), {
    message: '@obversa/runner archive is invalid:\n- export target dist/chunk-BBBBBBBB.js is missing',
  });
});
