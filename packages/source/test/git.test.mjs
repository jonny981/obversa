import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeDiff, diffArgs, readNewFileText, listTrackedFiles, rangeEnd, repositoryRoot, MAX_FILE_BYTES } from "../src/git.mjs";

test("rangeEnd asks git: a range ends at its first positive revision (the right side), a single revision (even one whose text holds two dots) ends at the worktree", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, "committed.txt"), "1\n");
    git(dir, "add", "committed.txt");
    git(dir, "commit", "-q", "-m", "one");
    writeFileSync(path.join(dir, "second.txt"), "2\n");
    git(dir, "add", "second.txt");
    git(dir, "commit", "-q", "-m", "fix..bug");
    const head = git(dir, "rev-parse", "HEAD").trim();
    const first = git(dir, "rev-parse", "HEAD~1").trim();
    // Staged only: in the index, not in HEAD.
    writeFileSync(path.join(dir, "staged-only.txt"), "3\n");
    git(dir, "add", "staged-only.txt");

    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD~1..HEAD" }), head);
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD~1...HEAD" }), head, "a symmetric range ends at its right side");
    assert.equal(await rangeEnd({ cwd: dir, range: "..HEAD" }), head);
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD~1.." }), head, "an omitted right side is HEAD");
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD~1..." }), head, "an omitted right side is HEAD in the three-dot form too");
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD.." }), head);
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD~1" }), undefined, "a single revision ends at the worktree");
    assert.equal(await rangeEnd({ cwd: dir, range: ":/fix..bug" }), undefined, "a search text with two dots is one commit");
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD^{/fix..bug}" }), undefined, "a search suffix with two dots is one commit");
    assert.equal(git(dir, "rev-parse", ":/fix..bug").trim(), head, "git itself reads it as one commit");
    assert.equal(first.length, 40);
    await assert.rejects(() => rangeEnd({ cwd: dir, range: "HEAD~1..nope" }), /could not be resolved/, "an unresolvable token is an error, not the index");

    // What a range review lists: the end tree, never the live index.
    const committed = ["committed.txt", "second.txt"];
    for (const range of ["HEAD~1..HEAD", "HEAD~1..", "HEAD~1...", "HEAD~1...HEAD"]) {
      assert.deepEqual([...(await listTrackedFiles({ cwd: dir, ref: await rangeEnd({ cwd: dir, range }) }))].sort(), committed, `${range} lists the HEAD tree`);
    }
    // What a single-revision review lists: the index, staged-only file included.
    for (const range of ["HEAD~1", ":/fix..bug", "HEAD^{/fix..bug}"]) {
      assert.deepEqual([...(await listTrackedFiles({ cwd: dir, ref: await rangeEnd({ cwd: dir, range }) }))].sort(), [...committed, "staged-only.txt"], `${range} lists the index`);
    }

    // A non-linear three-dot range, last because it moves the index: `side`
    // forks from HEAD~1, so the merge base is neither endpoint; git prints
    // right, left, ^base, and the end is the right side whichever way round
    // the range is written.
    git(dir, "branch", "side", "HEAD~1");
    git(dir, "checkout", "-q", "side");
    writeFileSync(path.join(dir, "side.txt"), "s\n");
    git(dir, "add", "side.txt");
    git(dir, "commit", "-q", "-m", "side");
    const side = git(dir, "rev-parse", "side").trim();
    git(dir, "checkout", "-q", "-");
    assert.equal(await rangeEnd({ cwd: dir, range: "side...HEAD" }), head, "side...HEAD ends at HEAD");
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD...side" }), side, "HEAD...side ends at side");
    // The staged-only file was in the index when `side` was committed, so it
    // is part of the side tree; second.txt (HEAD's second commit) is not.
    assert.deepEqual([...(await listTrackedFiles({ cwd: dir, ref: await rangeEnd({ cwd: dir, range: "HEAD...side" }) }))].sort(), ["committed.txt", "side.txt", "staged-only.txt"], "the side tree is listed for HEAD...side");

    // A merge's parents, `HEAD^@`: one token, several positive revisions, no
    // exclusion. git diffs the parents against each other, so it is neither
    // a single revision nor a range the review knows the end of; it must be
    // refused before the review opens, never listed from the index.
    git(dir, "merge", "-q", "--no-ff", "--no-edit", "side");
    const parents = git(dir, "rev-parse", "--revs-only", "HEAD^@", "--").trim().split("\n");
    assert.equal(parents.length, 2, "the merge has two parents and git prints both as positives");
    assert.ok(parents.every((line) => !line.startsWith("^")), "with no exclusion");
    await assert.rejects(() => rangeEnd({ cwd: dir, range: "HEAD^@" }), /revision set the review does not support/, "a merge's parents are refused, not read as one object");
    await assert.rejects(() => rangeEnd({ cwd: dir, range: "^HEAD" }), /names no revision|could not be resolved/, "a bare exclusion names nothing to review");
    assert.equal(await rangeEnd({ cwd: dir, range: "HEAD^1..HEAD^2" }), git(dir, "rev-parse", "HEAD^2").trim(), "the explicit parent range still ends at its right side");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    "-c", "diff.suppressBlankEmpty=false",
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

test("computeDiff neutralises diff.suppressBlankEmpty so a blank context line cannot end a hunk early", async () => {
  const dir = makeRepo();
  try {
    git(dir, "config", "diff.suppressBlankEmpty", "true");
    writeFileSync(path.join(dir, "a.txt"), "one\n\ntwo\nthree\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-q", "-m", "first");
    // Change a line after the blank one: with the setting honoured, the blank
    // context line would be empty, the parser would end the hunk, and the
    // change below it would vanish from the review.
    writeFileSync(path.join(dir, "a.txt"), "one\n\ntwo\nTHREE\n");
    const { diffText } = await computeDiff({ mode: "worktree", cwd: dir });
    assert.match(diffText, /\n \n/, "the blank context line is emitted as a single space");
    const { parseUnifiedDiff } = await import("../src/diff.mjs");
    const model = parseUnifiedDiff(diffText);
    const types = model.files[0].hunks.flatMap((h) => h.lines).map((l) => `${l.type}:${l.text}`);
    assert.ok(types.includes("add:THREE"), `the change after the blank line is in the model: ${types.join(", ")}`);
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

test("readNewFileText never reads outside the repository and bounds the size", async () => {
  const dir = makeRepo();
  const outside = mkdtempSync(path.join(os.tmpdir(), "source-outside-"));
  try {
    writeFileSync(path.join(outside, "secret.txt"), "outside\n");
    writeFileSync(path.join(dir, "ok.js"), "const ok = 1;\n");
    // A diff can be caller-supplied, so its paths are untrusted: parent
    // traversal and absolute paths resolve outside cwd and yield null.
    assert.equal(await readNewFileText({ path: "../" + path.basename(outside) + "/secret.txt", mode: "worktree", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: path.join(outside, "secret.txt"), mode: "worktree", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: ".", mode: "worktree", cwd: dir }), null);
    // A symlink is never read as the named file, wherever it points: git's
    // content for a symlink is its link text, so the target's bytes would be
    // false review content. A symlinked directory on the way to a file is
    // refused when it leaves the repository.
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
    assert.equal(await readNewFileText({ path: "link.txt", mode: "worktree", cwd: dir }), null);
    symlinkSync(path.join(dir, "ok.js"), path.join(dir, "ok-link.js"));
    assert.equal(await readNewFileText({ path: "ok-link.js", mode: "worktree", cwd: dir }), null);
    symlinkSync(outside, path.join(dir, "linked-dir"));
    assert.equal(await readNewFileText({ path: "linked-dir/secret.txt", mode: "worktree", cwd: dir }), null);
    // A directory is not a file.
    mkdirSync(path.join(dir, "sub"));
    assert.equal(await readNewFileText({ path: "sub", mode: "worktree", cwd: dir }), null);
    // An oversized file gets no context; the bound also caps the highlighter's parse.
    writeFileSync(path.join(dir, "big.js"), Buffer.alloc(MAX_FILE_BYTES + 1, 0x20));
    assert.equal(await readNewFileText({ path: "big.js", mode: "worktree", cwd: dir }), null);
    git(dir, "add", "big.js");
    assert.equal(await readNewFileText({ path: "big.js", mode: "staged", cwd: dir }), null);
    // A normal in-repo file still reads.
    assert.equal(await readNewFileText({ path: "ok.js", mode: "worktree", cwd: dir }), "const ok = 1;\n");

    // Staged mode applies the same path rules, and the index entry must be a
    // regular file: a symlink entry (mode 120000) and a tree are refused.
    writeFileSync(path.join(dir, "sub", "inner.js"), "const inner = 2;\n");
    git(dir, "add", "ok.js", "link.txt", "sub/inner.js");
    assert.equal(await readNewFileText({ path: "../" + path.basename(outside) + "/secret.txt", mode: "staged", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: path.join(outside, "secret.txt"), mode: "staged", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: "link.txt", mode: "staged", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: "sub", mode: "staged", cwd: dir }), null);
    assert.equal(await readNewFileText({ path: "sub/inner.js", mode: "staged", cwd: dir }), "const inner = 2;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
    // From a subdirectory the paths are still repository-relative, so the
    // tree's "All files" view matches the diff's paths.
    assert.deepEqual([...(await listTrackedFiles({ cwd: path.join(dir, "src") }))].sort(), ["README.md", "src/a.js"]);
    assert.deepEqual(await listTrackedFiles({ cwd: empty }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a staged read returns the blob of exactly the named path, even when the name looks like stage syntax", async () => {
  // `git show :0:secret.js` means stage 0 of secret.js, not a file named
  // `0:secret.js`. The index holds both here; each path must read as itself.
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, "secret.js"), "FROM_SECRET_JS\n");
    writeFileSync(path.join(dir, "0:secret.js"), "FROM_ZERO_COLON_FILE\n");
    git(dir, "add", "--", "secret.js", "0:secret.js");
    assert.equal(await readNewFileText({ path: "0:secret.js", mode: "staged", cwd: dir }), "FROM_ZERO_COLON_FILE\n");
    assert.equal(await readNewFileText({ path: "secret.js", mode: "staged", cwd: dir }), "FROM_SECRET_JS\n");
    // A glob-looking name is read literally, never expanded.
    writeFileSync(path.join(dir, "s*.js"), "FROM_GLOB_NAME\n");
    git(dir, "add", "--", "s*.js");
    assert.equal(await readNewFileText({ path: "s*.js", mode: "staged", cwd: dir }), "FROM_GLOB_NAME\n");
    assert.equal(await readNewFileText({ path: "s?cret.js", mode: "staged", cwd: dir }), null, "a pattern that is not itself an index path");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readNewFileText honours a lower per-read byte limit in both modes", async () => {
  const dir = makeRepo();
  try {
    writeFileSync(path.join(dir, "code.js"), "const value = 1;\n"); // 17 bytes
    git(dir, "add", "code.js");
    for (const mode of ["worktree", "staged"]) {
      assert.equal(await readNewFileText({ path: "code.js", mode, cwd: dir, maxBytes: 17 }), "const value = 1;\n", `${mode}: exactly the limit reads`);
      assert.equal(await readNewFileText({ path: "code.js", mode, cwd: dir, maxBytes: 16 }), null, `${mode}: one byte over the limit is refused`);
      assert.equal(await readNewFileText({ path: "code.js", mode, cwd: dir, maxBytes: 0 }), null, `${mode}: a spent budget reads nothing`);
      // The limit never rises above the per-file bound.
      assert.equal(await readNewFileText({ path: "code.js", mode, cwd: dir, maxBytes: MAX_FILE_BYTES * 10 }), "const value = 1;\n");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repositoryRoot finds the top level from any subdirectory, or null outside a repository", async () => {
  const dir = makeRepo();
  const empty = mkdtempSync(path.join(os.tmpdir(), "source-empty-"));
  try {
    mkdirSync(path.join(dir, "deep", "er"), { recursive: true });
    const { realpathSync } = await import("node:fs");
    const root = realpathSync(dir);
    assert.equal(await repositoryRoot({ cwd: dir }), root);
    assert.equal(await repositoryRoot({ cwd: path.join(dir, "deep", "er") }), root);
    assert.equal(await repositoryRoot({ cwd: empty }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
