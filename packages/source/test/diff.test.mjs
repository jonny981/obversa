import assert from "node:assert/strict";
import test from "node:test";

import { parseUnifiedDiff } from "../src/diff.mjs";

test("a single modified file tracks line numbers on both sides", () => {
  const { files } = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`);
  assert.equal(files.length, 1);
  const [file] = files;
  assert.equal(file.path, "a.txt");
  assert.equal(file.status, "modified");
  assert.equal(file.hunks.length, 1);
  assert.deepEqual(file.hunks[0].lines, [
    { type: "context", oldNumber: 1, newNumber: 1, text: "one" },
    { type: "del", oldNumber: 2, newNumber: null, text: "two" },
    { type: "add", oldNumber: null, newNumber: 2, text: "TWO" },
    { type: "context", oldNumber: 3, newNumber: 3, text: "three" },
  ]);
});

test("multiple files in one diff become separate entries", () => {
  const { files } = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
+b
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-c
+d
`);
  assert.deepEqual(files.map((f) => f.path), ["a.txt", "b.txt"]);
});

test("an added file has only add lines with a null old number", () => {
  const { files } = parseUnifiedDiff(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+alpha
+beta
`);
  const [file] = files;
  assert.equal(file.status, "added");
  assert.equal(file.path, "new.txt");
  assert.ok(file.hunks[0].lines.every((l) => l.type === "add" && l.oldNumber === null));
  assert.deepEqual(file.hunks[0].lines.map((l) => l.newNumber), [1, 2]);
});

test("a deleted file has only del lines with a null new number", () => {
  const { files } = parseUnifiedDiff(`diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1234567..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-alpha
-beta
`);
  const [file] = files;
  assert.equal(file.status, "deleted");
  assert.equal(file.path, "gone.txt");
  assert.ok(file.hunks[0].lines.every((l) => l.type === "del" && l.newNumber === null));
  assert.deepEqual(file.hunks[0].lines.map((l) => l.oldNumber), [1, 2]);
});

test("a hunk header with an omitted count parses the count as 1", () => {
  const { files } = parseUnifiedDiff(`diff --git a/c.txt b/c.txt
--- a/c.txt
+++ b/c.txt
@@ -1 +1 @@
-x
+y
`);
  const [hunk] = files[0].hunks;
  assert.equal(hunk.oldLines, 1);
  assert.equal(hunk.newLines, 1);
});

test("the no-newline marker is skipped and does not shift numbering", () => {
  const { files } = parseUnifiedDiff(`diff --git a/d.txt b/d.txt
--- a/d.txt
+++ b/d.txt
@@ -1,2 +1,2 @@
 keep
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);
  assert.deepEqual(files[0].hunks[0].lines, [
    { type: "context", oldNumber: 1, newNumber: 1, text: "keep" },
    { type: "del", oldNumber: 2, newNumber: null, text: "old" },
    { type: "add", oldNumber: null, newNumber: 2, text: "new" },
  ]);
});

test("a binary file is flagged with no hunks", () => {
  const { files } = parseUnifiedDiff(`diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abcdef1
Binary files /dev/null and b/img.png differ
`);
  const [file] = files;
  assert.equal(file.binary, true);
  assert.equal(file.hunks.length, 0);
  assert.equal(file.path, "img.png");
});

test("a pure rename has renamed status and no hunks", () => {
  const { files } = parseUnifiedDiff(`diff --git a/old.txt b/new.txt
similarity index 100%
rename from old.txt
rename to new.txt
`);
  const [file] = files;
  assert.equal(file.status, "renamed");
  assert.equal(file.oldPath, "old.txt");
  assert.equal(file.path, "new.txt");
  assert.equal(file.hunks.length, 0);
});

test("a section heading after the closing @@ is kept in the header", () => {
  const { files } = parseUnifiedDiff(`diff --git a/e.js b/e.js
--- a/e.js
+++ b/e.js
@@ -10,3 +10,4 @@ function greet() {
 const a = 1;
+const b = 2;
 const c = 3;
 return a;
`);
  const [hunk] = files[0].hunks;
  assert.equal(hunk.header, "function greet() {");
  assert.equal(hunk.oldStart, 10);
  assert.equal(hunk.lines[0].oldNumber, 10);
  assert.equal(hunk.lines[1].newNumber, 11);
});

test("a git-quoted path with a tab decodes to the real filename", () => {
  const tab = String.fromCharCode(9);
  const { files } = parseUnifiedDiff(`diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"
--- "a/tab\\tname.txt"
+++ "b/tab\\tname.txt"
@@ -1 +1 @@
-x
+y
`);
  const [file] = files;
  assert.equal(file.path, `tab${tab}name.txt`);
  assert.equal(file.oldPath, `tab${tab}name.txt`);
  assert.equal(file.newPath, `tab${tab}name.txt`);
});

test("a hunk line that starts with --- or +++ is content, not a file header", () => {
  // Deleting a SQL comment "-- drop leftover" arrives as "--- drop leftover";
  // adding a C statement "++ i;" arrives as "+++ i;". Both are hunk lines.
  const { files } = parseUnifiedDiff(`diff --git a/q.sql b/q.sql
--- a/q.sql
+++ b/q.sql
@@ -1,3 +1,3 @@
 select 1;
--- drop leftover
+++ i;
 select 2;
`);
  assert.equal(files.length, 1);
  const [file] = files;
  assert.equal(file.path, "q.sql");
  assert.equal(file.oldPath, "q.sql");
  assert.equal(file.newPath, "q.sql");
  const lines = file.hunks[0].lines.map((l) => [l.type, l.text, l.oldNumber, l.newNumber]);
  assert.deepEqual(lines, [
    ["context", "select 1;", 1, 1],
    ["del", "-- drop leftover", 2, null],
    ["add", "++ i;", null, 2],
    ["context", "select 2;", 3, 3],
  ]);
});

test("an empty line inside a hunk is a blank context line, and the hunk continues", () => {
  // git's diff.suppressBlankEmpty writes a blank context line as an empty
  // line rather than a single space; the change after it must still parse.
  const { files } = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,4 +1,4 @@
 one

 two
-three
+THREE
`);
  const lines = files[0].hunks[0].lines.map((l) => [l.type, l.text, l.oldNumber, l.newNumber]);
  assert.deepEqual(lines, [
    ["context", "one", 1, 1],
    ["context", "", 2, 2],
    ["context", "two", 3, 3],
    ["del", "three", 4, null],
    ["add", "THREE", null, 4],
  ]);
});

test("a second file header after a spent hunk still starts a new file", () => {
  const { files } = parseUnifiedDiff(`diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-a
+b
diff --git a/y.txt b/y.txt
--- a/y.txt
+++ b/y.txt
@@ -1 +1 @@
-c
+d
`);
  assert.deepEqual(files.map((f) => f.path), ["x.txt", "y.txt"]);
  assert.equal(files[1].hunks[0].lines[1].text, "d");
});
