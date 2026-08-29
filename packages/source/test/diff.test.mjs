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

test("a quoted binary path is read from the diff --git header, which is all a binary diff has", () => {
  const tab = String.fromCharCode(9);
  const { files } = parseUnifiedDiff(`diff --git "a/image\\tone.png" "b/image\\tone.png"
new file mode 100644
index 0000000..e69de29
Binary files /dev/null and "b/image\\tone.png" differ
`);
  const [file] = files;
  assert.equal(file.binary, true);
  assert.equal(file.status, "added");
  assert.equal(file.path, `image${tab}one.png`);
  assert.equal(file.oldPath, `image${tab}one.png`);
  assert.equal(file.newPath, `image${tab}one.png`);
});

test("a diff --git header with one quoted side, or spaces in an unquoted path, still names both files", () => {
  const tab = String.fromCharCode(9);
  const mixed = parseUnifiedDiff(`diff --git a/plain.png "b/tab\\tname.png"
similarity index 100%
rename from plain.png
rename to "tab\\tname.png"
`).files[0];
  assert.equal(mixed.oldPath, "plain.png");
  assert.equal(mixed.newPath, `tab${tab}name.png`);
  assert.equal(mixed.status, "renamed");
  const spaced = parseUnifiedDiff(`diff --git a/my file.png b/my file.png
Binary files a/my file.png and b/my file.png differ
`).files[0];
  assert.equal(spaced.path, "my file.png");
  assert.equal(spaced.binary, true);
  const escapedQuote = parseUnifiedDiff(`diff --git "a/say \\"hi\\".bin" "b/say \\"hi\\".bin"
Binary files a/say "hi".bin and b/say "hi".bin differ
`).files[0];
  assert.equal(escapedQuote.path, 'say "hi".bin');
});

test("the tab git appends after an unquoted path with spaces in --- and +++ is not part of the name", () => {
  const tab = String.fromCharCode(9);
  const { files } = parseUnifiedDiff(`diff --git a/my file.txt b/my file.txt
--- a/my file.txt${tab}
+++ b/my file.txt${tab}
@@ -1 +1 @@
-x
+y
`);
  const [file] = files;
  assert.equal(file.path, "my file.txt");
  assert.equal(file.oldPath, "my file.txt");
  assert.equal(file.newPath, "my file.txt");
  // A name that really ends in a tab arrives quoted and keeps it.
  const quoted = parseUnifiedDiff(`diff --git "a/ends\\t" "b/ends\\t"
--- "a/ends\\t"
+++ "b/ends\\t"
@@ -1 +1 @@
-x
+y
`).files[0];
  assert.equal(quoted.path, `ends${tab}`);
});

test("a character outside the BMP inside a quoted path survives whole", () => {
  // With core.quotePath=false git leaves the emoji literal and quotes the
  // name only for the tab; the emoji is one code point but two UTF-16 units.
  const tab = String.fromCharCode(9);
  const face = String.fromCodePoint(0x1f600);
  const { files } = parseUnifiedDiff(`diff --git "a/face${face}\\tname.bin" "b/face${face}\\tname.bin"
Binary files a/face${face}\\tname.bin and "b/face${face}\\tname.bin" differ
`);
  const [file] = files;
  assert.equal(file.path, `face${face}${tab}name.bin`);
  assert.equal(file.oldPath, `face${face}${tab}name.bin`);
  assert.equal(file.newPath, `face${face}${tab}name.bin`);
  assert.doesNotMatch(file.path, /�/, "no replacement characters");
  // A surrogate pair before an octal escape, and one escaped itself, decode the same way.
  const mixed = parseUnifiedDiff(`diff --git "a/${face}\\001x" "b/${face}\\001x"
Binary files a/x and b/x differ
`).files[0];
  assert.equal(mixed.path, `${face}${String.fromCharCode(1)}x`);
});

test("git's octal escapes decode to the real bytes, one control byte or a whole UTF-8 sequence", () => {
  const control = String.fromCharCode(1);
  const one = parseUnifiedDiff(`diff --git "a/control\\001name.bin" "b/control\\001name.bin"
Binary files a/control\\001name.bin and "b/control\\001name.bin" differ
`).files[0];
  assert.equal(one.path, `control${control}name.bin`);
  assert.equal(one.oldPath, `control${control}name.bin`);
  // With core.quotePath on, git spells non-ASCII bytes in octal too: two
  // bytes make one character.
  const accented = parseUnifiedDiff(`diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-x
+y
`).files[0];
  assert.equal(accented.path, "café.txt");
  // A one-digit escape followed by a digit that is not part of it.
  const short = parseUnifiedDiff(`diff --git "a/x\\18.bin" "b/x\\18.bin"
Binary files a/x\\18.bin and "b/x\\18.bin" differ
`).files[0];
  assert.equal(short.path, `x${control}8.bin`);
});

test("an unquoted binary name that itself contains ' b/' is read by the header's symmetry", () => {
  // Exactly what git emits for a binary file named "foo b/bar": no quoting,
  // and no ---/+++ lines to repair the split from.
  const same = parseUnifiedDiff(`diff --git a/foo b/bar b/foo b/bar
new file mode 100644
index 0000000..e69de29
Binary files /dev/null and b/foo b/bar differ
`).files[0];
  assert.equal(same.oldPath, "foo b/bar");
  assert.equal(same.newPath, "foo b/bar");
  assert.equal(same.path, "foo b/bar");
  assert.equal(same.binary, true);
  // A rename with such names is set exactly by its rename lines.
  const renamed = parseUnifiedDiff(`diff --git a/x b/y b/x b/z
similarity index 100%
rename from x b/y
rename to x b/z
`).files[0];
  assert.equal(renamed.oldPath, "x b/y");
  assert.equal(renamed.newPath, "x b/z");
  assert.equal(renamed.status, "renamed");
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

test("a combined diff — what git emits for an unresolved merge conflict — is refused whole, never read as an empty review", () => {
  const combined = `diff --cc conflicted.txt
index 1111111,2222222..0000000
--- a/conflicted.txt
+++ b/conflicted.txt
@@@ -1,1 -1,1 +1,5 @@@
++<<<<<<< HEAD
 +ours
++=======
+ theirs
++>>>>>>> branch
`;
  assert.throws(() => parseUnifiedDiff(combined), /unresolved merge conflict \(conflicted\.txt\)/);
  assert.throws(() => parseUnifiedDiff(`diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n${combined}`), /unresolved merge conflict/, "a conflict after a clean file is refused too");
  assert.throws(() => parseUnifiedDiff(combined.replace("diff --cc", "diff --combined")), /unresolved merge conflict/);
});

test("a truncated or malformed hunk is refused whole, never read as a smaller review", () => {
  const twoFiles = (firstHunkBody) => `diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,2 +1,2 @@
${firstHunkBody}diff --git a/b.js b/b.js
--- a/b.js
+++ b/b.js
@@ -1 +1 @@
-x
+y
`;
  const whole = parseUnifiedDiff(twoFiles("-one\n+ONE\n-two\n+TWO\n"));
  assert.deepEqual(whole.files.map((f) => f.path), ["a.js", "b.js"], "a whole diff parses both files");
  // The first hunk claims two lines a side and supplies one: the next file's
  // header arrives while lines are still owed.
  assert.throws(() => parseUnifiedDiff(twoFiles("-one\n+ONE\n")), /truncated: the hunk at -1,2 \+1,2 in a\.js still owes 1 old and 1 new lines when "diff --git a\/b\.js b\/b\.js" arrived/);
  // The diff ends while lines are still owed.
  assert.throws(() => parseUnifiedDiff("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n-one\n+ONE\n"), /still owes 1 old and 1 new lines at the end of the diff/);
  // More content than the header declared.
  assert.throws(() => parseUnifiedDiff("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y\n+extra\n"), /content outside a hunk in a\.js: "\+extra" exceeds the hunk header's counts/);
  // A marker for a side already spent: the old side declared one line and a
  // second deletion arrives.
  assert.throws(() => parseUnifiedDiff("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-x\n+y\n-z\n+w\n"), /malformed: the hunk at -1,1 \+1,2 in a\.js has no old lines left when "-z" arrived/);
  // The text's final newline is not a line: a hunk owing one context line
  // at the end of the text is truncated, not satisfied by the split artifact.
  assert.throws(() => parseUnifiedDiff("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n-x\n+y\n"), /still owes 1 old and 1 new lines at the end of the diff/);
  // A genuine blank context line (suppressBlankEmpty) in the middle still counts.
  const blankInside = parseUnifiedDiff("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,2 +1,2 @@\n\n-x\n+y\n");
  assert.deepEqual(blankInside.files[0].hunks[0].lines.map((l) => l.type), ["context", "del", "add"]);
});

test("file metadata after hunk content is a malformed diff, refused whole: a binary marker or fresh headers cannot relabel what was reviewed", () => {
  const hunk = "diff --git a/visible.js b/visible.js\n--- a/visible.js\n+++ b/visible.js\n@@ -1 +1 @@\n-safe\n+dangerous()\n";
  assert.throws(() => parseUnifiedDiff(`${hunk}Binary files a/visible.js and b/visible.js differ\n`), /file metadata "Binary files a\/visible\.js and b\/visible\.js differ" arrives after hunk content in visible\.js/);
  assert.throws(() => parseUnifiedDiff(`${hunk}--- a/other.js\n+++ b/other.js\n@@ -1 +1 @@\n-a\n+b\n`), /file metadata "--- a\/other\.js" arrives after hunk content/);
  assert.throws(() => parseUnifiedDiff(`${hunk}new file mode 100644\n`), /file metadata "new file mode 100644" arrives after hunk content/);
  assert.throws(() => parseUnifiedDiff(`${hunk}index 1111111..2222222 100644\n@@ -3 +3 @@\n-c\n+d\n`), /file metadata "index 1111111\.\.2222222 100644" arrives after hunk content/);
  // A second hunk for the same file is content, not metadata.
  const two = parseUnifiedDiff(`${hunk}@@ -3 +3 @@\n-c\n+d\n`);
  assert.equal(two.files[0].hunks.length, 2);
  assert.equal(two.files[0].binary, false);
});

test("a diff whose whole stream was CRLF-converted parses with its headers matched and no carriage return in a path or a line; a diff of a CRLF file keeps the CR as content", () => {
  const converted = parseUnifiedDiff("diff --git a/x.js b/x.js\r\n--- a/x.js\r\n+++ b/x.js\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n");
  assert.equal(converted.files.length, 1);
  assert.equal(converted.files[0].path, "x.js");
  assert.deepEqual(converted.files[0].hunks[0].lines.map((l) => [l.type, l.text]), [["del", "x"], ["add", "y"]]);
  // Headers in LF, content in CRLF: the file under review has CRLF endings.
  const crlfFile = parseUnifiedDiff("diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-x\r\n+y\r\n");
  assert.deepEqual(crlfFile.files[0].hunks[0].lines.map((l) => l.text), ["x\r", "y\r"], "the file's own carriage returns are reviewed as content");
});
