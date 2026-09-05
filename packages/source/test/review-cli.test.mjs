// The obversa-review command's argument contract: a bad argument is a usage
// error (exit 2, message on stderr, nothing on stdout) and never opens a
// surface. In particular a value-taking option with a missing or flag-shaped
// value must not fall through to reviewing the current directory.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseArgs } from "../src/review-args.mjs";

const COMMAND = fileURLToPath(new URL("../bin/obversa-review.mjs", import.meta.url));

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

test("--no-open prints the reachable page URL on stderr and never runs placement", { timeout: 25_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "review-cli-no-open-"));
  const calls = path.join(directory, "placement.calls");
  const placement = path.join(directory, "placement");
  let child;
  let exited;
  try {
    writeFileSync(placement, `#!/bin/sh\nprintf 'called\\n' >> '${calls}'\n`);
    chmodSync(placement, 0o755);
    const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "Review Test");
    git("config", "user.email", "review@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(directory, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "seed");
    writeFileSync(path.join(directory, "a.txt"), "one\ntwo\n");
    child = spawn(process.execPath, [COMMAND, "--no-open", "--cwd", directory], {
      env: { ...process.env, OBVERSA_SURFACE_BIN: placement },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no page URL on stderr: ${stderr}`)), 10_000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = /Open the review surface at: (\S+)/.exec(stderr);
        if (match) { clearTimeout(timer); resolve(new URL(match[1])); }
      });
      exited.then(() => { clearTimeout(timer); reject(new Error(`command closed before URL: ${stderr}`)); }, reject);
    });
    assert.ok(url.hash.length > 1, "the page URL carries its access token");
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    const model = await fetch(`${url.origin}/api/model`, { headers, signal: AbortSignal.timeout(5_000) });
    assert.equal(model.status, 200, "the URL reaches the review's authenticated model");
    const body = /** @type {{ model: { files: { path: string }[] } }} */ (await model.json());
    assert.equal(body.model.files[0].path, "a.txt");
    const submitted = await fetch(`${url.origin}/api/submit`, {
      method: "POST", headers, signal: AbortSignal.timeout(5_000),
      body: JSON.stringify({ decision: "approved", annotations: [] }),
    });
    assert.equal(submitted.status, 200);
    const { operationId } = /** @type {{ operationId: string }} */ (await submitted.json());
    const acknowledged = await fetch(`${url.origin}/api/ack`, {
      method: "POST", headers, signal: AbortSignal.timeout(5_000), body: JSON.stringify({ operationId }),
    });
    assert.equal(acknowledged.status, 200);
    assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
    assert.match(stdout, /<<<REVIEW_RESULT_V1>>>/);
    assert.doesNotMatch(stdout, /Open the review surface at:|http:\/\/127\.0\.0\.1/);
    assert.equal(existsSync(calls), false, "--no-open must not run the supplied placement command");
  } finally {
    child?.kill("SIGKILL");
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
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
  write("bin/obversa-review.mjs", readFileSync(COMMAND, "utf8"));
  write("src/review-cli.mjs", readFileSync(fileURLToPath(new URL("../src/review-cli.mjs", import.meta.url)), "utf8"));
  write("src/review-args.mjs", readFileSync(fileURLToPath(new URL("../src/review-args.mjs", import.meta.url)), "utf8"));
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
    const run = spawnSync(process.execPath, [path.join(split, "bin", "obversa-review.mjs"), "--no-open"], { encoding: "utf8", timeout: 5000, cwd: split });
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
    const help = spawnSync(process.execPath, [path.join(importOnly, "bin", "obversa-review.mjs"), "--help"], { encoding: "utf8", timeout: 5000, cwd: importOnly });
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

test("two review modes on one command line are a usage error, whatever their order", () => {
  assert.throws(() => parseArgs(["--range", "main..HEAD", "--staged"]), /--staged and --range name different review modes/);
  assert.throws(() => parseArgs(["--staged", "--range", "main..HEAD"]), /--range and --staged name different review modes/);
  assert.throws(() => parseArgs(["--worktree", "--cached"]), /--cached and --worktree name different review modes/);
  assert.equal(parseArgs(["--staged", "--cached"]).mode, "staged", "the same mode named twice is one choice");
  assert.equal(parseArgs(["--worktree", "--worktree"]).mode, "worktree");
});
