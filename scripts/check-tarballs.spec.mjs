// The pass/fail fixtures for the tarball shape check: a manifest whose paths
// lie fails publint, a types condition that resolves to nothing fails attw,
// and a truthful package passes both. Failure assertions first — a check
// that cannot fail proves nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkTarball } from "./check-tarballs.mjs";
import { assertPackedPackage } from "./check-packages.mjs";

const fixture = mkdtempSync(join(tmpdir(), "obversa-tarball-spec-"));
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
  for (const name of ["check-tarballs.mjs", "check-publish-allowlist.mjs"]) {
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
