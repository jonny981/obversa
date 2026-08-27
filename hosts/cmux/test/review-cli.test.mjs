// The obversa-review command's argument contract: a bad argument is a usage
// error (exit 2, message on stderr, nothing on stdout) and never opens a
// surface. In particular a value-taking option with a missing or flag-shaped
// value must not fall through to reviewing the current directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseArgs } from "../bin/obversa-review";

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
