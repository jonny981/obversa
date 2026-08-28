// The obversa-review command's argument contract: a bad argument is a usage
// error (exit 2, message on stderr, nothing on stdout) and never opens a
// surface. In particular a value-taking option with a missing or flag-shaped
// value must not fall through to reviewing the current directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseArgs } from "../lib/review-args.mjs";

const COMMAND = fileURLToPath(new URL("../bin/obversa-review", import.meta.url));

test("parseArgs accepts the documented shapes", () => {
  assert.equal(parseArgs([]).mode, "worktree");
  assert.equal(parseArgs(["--staged"]).mode, "staged");
  assert.deepEqual({ ...parseArgs(["--range", "main..HEAD"]) }, { ...parseArgs([]), mode: "range", range: "main..HEAD" });
  assert.equal(parseArgs(["--cwd", "/tmp/repo"]).cwd, "/tmp/repo");
  assert.equal(parseArgs(["--app", "my-review"]).app, "my-review");
  assert.equal(parseArgs(["--no-open"]).open, false);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs refuses a value-taking option with a missing or flag-shaped value", () => {
  assert.throws(() => parseArgs(["--cwd"]), /--cwd needs a value/);
  assert.throws(() => parseArgs(["--cwd", "--no-open"]), /--cwd needs a value, got --no-open/);
  assert.throws(() => parseArgs(["--range"]), /--range needs a value/);
  assert.throws(() => parseArgs(["--range", "--staged"]), /--range needs a value, got --staged/);
  assert.throws(() => parseArgs(["--app"]), /--app needs a value/);
  assert.throws(() => parseArgs(["--app", "--no-open"]), /--app needs a value/);
  assert.throws(() => parseArgs(["--app", "bad name"]), /--app must be letters/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument: --bogus/);
});

test("the command exits 2 on a bad argument, prints usage, writes nothing to stdout, and opens no surface", () => {
  const cases = [
    ["--cwd"],
    ["--cwd", "--no-open"],
    ["--range"],
    ["--range", "--staged"],
    ["--app"],
    ["--app", "--no-open"],
    ["--bogus"],
  ];
  for (const args of cases) {
    // A surface would wait for a browser; a five-second cap turns a launched
    // surface into a failure of this test rather than a hang.
    const run = spawnSync(process.execPath, [COMMAND, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(run.signal, null, `${args.join(" ")}: the command must exit on its own, not be killed`);
    assert.equal(run.status, 2, `${args.join(" ")}: exit code`);
    assert.equal(run.stdout, "", `${args.join(" ")}: nothing on stdout`);
    assert.match(run.stderr, /needs a value|Unknown argument/, `${args.join(" ")}: the reason`);
    assert.match(run.stderr, /Usage:/, `${args.join(" ")}: usage shown`);
    assert.doesNotMatch(run.stderr, /Open the review surface at/, `${args.join(" ")}: no surface launched`);
  }
});

test("the command exits 0 on --help and prints usage on stdout", () => {
  const run = spawnSync(process.execPath, [COMMAND, "--help"], { encoding: "utf8", timeout: 5000 });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /Usage:/);
});

// A disposable consumer: the command and its argument parser copied beside a
// node_modules holding stub @obversa packages, so what the command resolves
// is decided by those stubs' exports maps alone.
function consumer(clientExports) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-cli-consumer-"));
  const write = (relative, text) => {
    const file = path.join(dir, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write("package.json", JSON.stringify({ name: "consumer", type: "module", private: true }));
  write("bin/obversa-review", readFileSync(COMMAND, "utf8"));
  write("lib/review-args.mjs", readFileSync(fileURLToPath(new URL("../lib/review-args.mjs", import.meta.url)), "utf8"));
  write("node_modules/@obversa/surfacer/package.json", JSON.stringify({ name: "@obversa/surfacer", type: "module", exports: { ".": "./index.mjs", "./client": clientExports } }));
  write("node_modules/@obversa/surfacer/index.mjs", "export async function runSurface() { throw new Error('not used by this test'); }\n");
  write("node_modules/@obversa/surfacer/client.mjs", "export const kit = 'esm';\n");
  write("node_modules/@obversa/surfacer/client.cjs", "module.exports = { kit: 'cjs' };\n");
  write("node_modules/@obversa/source/package.json", JSON.stringify({ name: "@obversa/source", type: "module", exports: { ".": "./index.mjs" } }));
  write("node_modules/@obversa/source/index.mjs", [
    "export async function reviewDiff({ clientKitSource }) {",
    "  process.stdout.write('KIT:' + clientKitSource);",
    "  return { status: 'completed', result: { decision: 'approved', annotations: [] }, meta: { label: 'stub' } };",
    "}",
    "",
  ].join("\n"));
  return dir;
}

test("the client kit is resolved under the import condition, the one the browser's module import matches", () => {
  // Distinct import/require targets: the page must get the ESM file. A
  // createRequire lookup would follow the require condition and hand the
  // browser CommonJS.
  const split = consumer({ import: "./client.mjs", require: "./client.cjs" });
  try {
    const run = spawnSync(process.execPath, [path.join(split, "bin", "obversa-review"), "--no-open"], { encoding: "utf8", timeout: 5000, cwd: split });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /KIT:export const kit = 'esm';/, "the ESM client kit reached the review");
    assert.doesNotMatch(run.stdout, /cjs/);
  } finally {
    rmSync(split, { recursive: true, force: true });
  }
  // An import-only export: the command must still load, so --help works. A
  // require-condition lookup has nothing to resolve and fails before main.
  const importOnly = consumer({ import: "./client.mjs" });
  try {
    const help = spawnSync(process.execPath, [path.join(importOnly, "bin", "obversa-review"), "--help"], { encoding: "utf8", timeout: 5000, cwd: importOnly });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
  } finally {
    rmSync(importOnly, { recursive: true, force: true });
  }
});

test("the command behaves the same when run through a symlink, as a bin install does", () => {
  // Node resolves the real path for import.meta but keeps the symlink in
  // process.argv, which is how a "am I main" guard once skipped main silently.
  const dir = mkdtempSync(path.join(os.tmpdir(), "review-cli-link-"));
  const link = path.join(dir, "obversa-review");
  symlinkSync(COMMAND, link);
  try {
    const help = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8", timeout: 5000 });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/, "help must print through a symlink");
    const bad = spawnSync(process.execPath, [link, "--cwd"], { encoding: "utf8", timeout: 5000 });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--cwd needs a value/);
    assert.equal(bad.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
