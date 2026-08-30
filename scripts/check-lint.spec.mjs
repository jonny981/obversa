// The pass/fail fixture matrix for the ESLint loader-form bans
// (an internal note).
//
// One disposable tree gets a file per banned form; the real root config lints
// it, and the spec asserts each file is reported under the rule that bans its
// form while the clean file reports nothing. A config edit that silently
// stops a ban firing fails here, not just in review.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const eslintBin = join(repoRoot, "node_modules", "eslint", "bin", "eslint.js");
const configFile = join(repoRoot, "eslint.config.mjs");

// realpath: the platform temp directory can be a symlink, and ESLint reports
// real paths; the keys below must match them.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), "obversa-lint-")));
test.after(() => rmSync(fixture, { recursive: true, force: true }));

function file(path, content) {
  const absolute = join(fixture, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

// A fake package with an exports map, so the resolver's encapsulation is
// proved: the exported name resolves, the deep path past the map does not.
file(
  "node_modules/fake-pkg/package.json",
  JSON.stringify({ name: "fake-pkg", version: "1.0.0", type: "module", exports: { ".": "./src/index.mjs" } }) + "\n",
);
file("node_modules/fake-pkg/src/index.mjs", "export const ok = 1;\n");
file("node_modules/fake-pkg/src/private.mjs", "export const priv = 1;\n");

// One file per banned form: [path, content, rule that must report it].
const banned = [
  ["src/a-eval.mjs", "export const v = eval('1');\n", "no-eval"],
  ["src/b-func.mjs", "export const f = new Function('return 1');\n", "no-new-func"],
  ["src/c-builtin.mjs", "export const m = process.getBuiltinModule('fs');\n", "no-restricted-properties"],
  ["src/d-ctor.cjs", "module.exports = module.constructor;\n", "no-restricted-properties"],
  ["src/e-binding.mjs", "export const b = process.binding('fs');\n", "no-restricted-properties"],
  ["src/f-dlopen.mjs", "export const d = process.dlopen;\n", "no-restricted-properties"],
  ["src/g-main.cjs", "module.exports = process.mainModule;\n", "no-restricted-properties"],
  ["src/h-vm.mjs", "import 'vm';\n", "no-restricted-imports"],
  ["src/i-nodevm.mjs", "import 'node:vm';\n", "no-restricted-imports"],
  ["src/j-missing.mjs", "import './missing.mjs';\n", "import-x/no-unresolved"],
  ["src/k-deep.mjs", "import 'fake-pkg/src/private.mjs';\n", "import-x/no-unresolved"],
  ["src/l-dynvm.mjs", "export const p = import('node:vm');\n", "no-restricted-syntax"],
  ["src/m-reqvm.cjs", "module.exports = require('vm');\n", "no-restricted-syntax"],
];
for (const [path, content] of banned) file(path, content);
file("src/clean.mjs", "import { ok } from 'fake-pkg';\nimport './local.mjs';\nexport const c = ok;\n");
file("src/local.mjs", "export const l = 1;\n");

// A flat config anchors its file patterns at its own directory, so the
// fixture re-exports the real config from its own root: the rules under test
// are the repository's, the base path is the fixture's.
file("eslint.config.mjs", `export { default } from ${JSON.stringify(pathToFileURL(configFile).href)};\n`);

const run = spawnSync(
  process.execPath,
  [eslintBin, "--format", "json", "src"],
  { cwd: fixture, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const results = JSON.parse(run.stdout);
const byFile = new Map(results.map((entry) => [entry.filePath.slice(fixture.length + 1), entry.messages]));

test("every banned form is reported under the rule that bans it", () => {
  for (const [path, , rule] of banned) {
    const messages = byFile.get(path) ?? [];
    assert.ok(
      messages.some((message) => message.ruleId === rule && message.severity === 2),
      `${rule} must report ${path}; saw ${JSON.stringify(messages.map((message) => message.ruleId))}`,
    );
  }
});

test("the clean file reports nothing", () => {
  assert.deepEqual(byFile.get("src/clean.mjs") ?? [], []);
  assert.equal(run.status, 1, "banned forms must fail the lint run");
});

test("the browser page is linted in full, not ignored", () => {
  // The page once sat on the ignore list for its served-at-runtime import;
  // the declaration beside it resolves that import now, so every ban
  // applies to the page like any other file.
  const page = spawnSync(
    process.execPath,
    [eslintBin, "--format", "json", join(repoRoot, "packages", "source", "assets", "app.js")],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(page.status, 0, page.stderr);
  const results = JSON.parse(page.stdout);
  assert.equal(results.length, 1, "the page produced a lint result, not an ignored-file error");
});

test("only one import plugin is installed", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  assert.equal(declared["eslint-plugin-import"], undefined, "eslint-plugin-import must never sit beside import-x");
  assert.equal(declared["eslint-plugin-import-x"], "4.17.1");
});
