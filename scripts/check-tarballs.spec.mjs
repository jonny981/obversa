// The pass/fail fixtures for the tarball shape check: a manifest whose paths
// lie fails publint, a types condition that resolves to nothing fails attw,
// and a truthful package passes both. Failure assertions first — a check
// that cannot fail proves nothing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { checkTarball } from "./check-tarballs.mjs";

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
