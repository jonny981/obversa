import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFileTree, countFiles, fileStats } from "../assets/file-tree.mjs";

const files = (paths) => paths.map((path) => ({ path, status: "modified" }));

test("nests files under their directories and sorts them", () => {
  const tree = buildFileTree(files(["src/b.js", "src/a.js", "README.md"]));
  assert.deepEqual(tree.files.map((f) => f.name), ["README.md"]);
  assert.deepEqual(tree.dirs.map((d) => d.name), ["src"]);
  assert.deepEqual(tree.dirs[0].files.map((f) => f.name), ["a.js", "b.js"]);
});

test("collapses a single-child directory chain into one row", () => {
  const tree = buildFileTree(files(["src/auth/session.js"]));
  // src -> auth -> session.js collapses to a single "src/auth" node.
  assert.equal(tree.dirs.length, 1);
  assert.equal(tree.dirs[0].name, "src/auth");
  assert.deepEqual(tree.dirs[0].files.map((f) => f.name), ["session.js"]);
});

test("does not collapse a directory that also holds files or forks", () => {
  const tree = buildFileTree(files(["src/index.js", "src/auth/session.js"]));
  const src = tree.dirs.find((d) => d.name === "src");
  assert.ok(src, "src stays because it holds a file and a subdir");
  assert.deepEqual(src.files.map((f) => f.name), ["index.js"]);
  assert.deepEqual(src.dirs.map((d) => d.name), ["auth"]);
});

test("carries status and binary through, and counts a subtree", () => {
  const tree = buildFileTree([
    { path: "a/x.js", status: "added" },
    { path: "a/y.png", status: "deleted", binary: true },
    { path: "z.md", status: "modified" },
  ]);
  const a = tree.dirs.find((d) => d.name === "a");
  assert.equal(a.files.find((f) => f.name === "x.js").status, "added");
  assert.equal(a.files.find((f) => f.name === "y.png").binary, true);
  assert.equal(countFiles(tree), 3);
  assert.equal(countFiles(a), 2);
});

test("handles an empty or missing file list", () => {
  assert.deepEqual(buildFileTree([]), { name: "", dirs: [], files: [] });
  assert.deepEqual(buildFileTree(undefined), { name: "", dirs: [], files: [] });
});

test("computes per-file added/deleted counts and attaches them to tree nodes", () => {
  const file = {
    path: "src/a.js",
    status: "modified",
    hunks: [{ lines: [{ type: "context" }, { type: "add" }, { type: "add" }, { type: "del" }] }],
  };
  assert.deepEqual(fileStats(file), { added: 2, deleted: 1 });
  const node = buildFileTree([file]).dirs[0].files[0];
  assert.equal(node.added, 2);
  assert.equal(node.deleted, 1);
});

test("fileStats is zero without hunks", () => {
  assert.deepEqual(fileStats({ path: "x", hunks: [] }), { added: 0, deleted: 0 });
  assert.deepEqual(fileStats({}), { added: 0, deleted: 0 });
});
