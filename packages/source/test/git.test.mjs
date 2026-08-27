import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeDiff, diffArgs, readNewFileText, listTrackedFiles } from "../src/git.mjs";

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
    "-c", "core.quotePath=false",
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

test("readNewFileText reads worktree and staged content, and returns null when unavailable", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, "code.js"), "const value = 1;\n");
    // Worktree: the file on disk.
    assert.equal(await readNewFileText({ path: "code.js", mode: "worktree", cwd: dir }), "const value = 1;\n");

    // Staged reads the index, which can differ from the working tree.
    git(dir, "add", "code.js");
    writeFileSync(path.join(dir, "code.js"), "const value = 2;\n");
    assert.equal(await readNewFileText({ path: "code.js", mode: "staged", cwd: dir }), "const value = 1;\n");
    assert.equal(await readNewFileText({ path: "code.js", mode: "worktree", cwd: dir }), "const value = 2;\n");

    // Unavailable cases all yield null: /dev/null, a missing file, and range mode.
    assert.equal(await readNewFileText({ path: "/dev/null", mode: "worktree", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: "missing.js", mode: "worktree", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: "code.js", mode: "range", cwd: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTrackedFiles returns the repo's tracked files, or [] outside a repo", async () => {
  const dir = makeRepo();
  const empty = mkdtempSync(path.join(os.tmpdir(), "source-empty-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.js"), "1\n");
    writeFileSync(path.join(dir, "README.md"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "files");
    assert.deepEqual([...(await listTrackedFiles({ cwd: dir }))].sort(), ["README.md", "src/a.js"]);
    assert.deepEqual(await listTrackedFiles({ cwd: empty }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
