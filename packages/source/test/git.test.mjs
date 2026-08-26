import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeDiff, diffArgs } from "../src/git.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "source-git-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

test("diffArgs maps each mode to the right git arguments", () => {
  const base = [
    "-c", "diff.noprefix=false",
    "-c", "diff.mnemonicPrefix=false",
    "--no-pager", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
  ];
  assert.deepEqual(diffArgs({ mode: "worktree" }), base);
  assert.deepEqual(diffArgs({ mode: "staged" }), [...base, "--cached"]);
  assert.deepEqual(diffArgs({ mode: "range", range: "main..HEAD" }), [...base, "main..HEAD", "--"]);
});

test("diffArgs rejects an unsafe or missing ref range", () => {
  assert.throws(() => diffArgs({ mode: "range" }), /ref range is required/);
  assert.throws(() => diffArgs({ mode: "range", range: "--output=/tmp/x" }), /must not start with '-'/);
  assert.throws(() => diffArgs({ mode: "range", range: "a b" }), /whitespace or control/);
  assert.throws(() => diffArgs({ mode: "bogus" }), /Unknown diff mode/);
});

test("computeDiff reads the working tree, the staged changes, and a ref range", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "first");

    // Working tree: an unstaged edit shows up.
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
    const worktree = await computeDiff({ mode: "worktree", cwd: dir });
    assert.match(worktree.diffText, /\+four/);
    assert.equal(worktree.range, null);

    // Staged: nothing staged yet, so the staged diff is empty; after add, it appears.
    const stagedEmpty = await computeDiff({ mode: "staged", cwd: dir });
    assert.equal(stagedEmpty.diffText.trim(), "");
    git(dir, "add", "a.txt");
    const staged = await computeDiff({ mode: "staged", cwd: dir });
    assert.match(staged.diffText, /\+four/);

    // Range: diff between the two commits.
    git(dir, "commit", "-q", "-m", "second");
    const range = await computeDiff({ mode: "range", range: "HEAD~1..HEAD", cwd: dir });
    assert.match(range.diffText, /\+four/);
    assert.equal(range.range, "HEAD~1..HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
