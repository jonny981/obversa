import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUnifiedDiff } from "../src/diff.mjs";
import { navModel } from "../src/nav-model.mjs";

// A new .js file whose whole content is shown in the diff.
const CONTENT = "function read(x) {\n  return x;\n}\nread(1);\n";
const DIFF = `diff --git a/x.js b/x.js
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/x.js
@@ -0,0 +1,4 @@
+function read(x) {
+  return x;
+}
+read(1);
`;

function lineByNew(model, n) {
  return model.files[0].hunks[0].lines.find((line) => line.newNumber === n);
}

test("stops indexing once the review-wide byte bound is spent", async () => {
  const one = parseUnifiedDiff(DIFF).files[0];
  const two = { ...parseUnifiedDiff(DIFF.replace(/x\.js/g, "y.js")).files[0] };
  const three = { ...parseUnifiedDiff(DIFF.replace(/x\.js/g, "z.js")).files[0] };
  const model = { files: [one, two, three] };
  // Each file reads as CONTENT (42 bytes); a bound of 100 admits two files (84), not three (126).
  await navModel(model, { read: async () => CONTENT, maxTotalBytes: 100 });
  assert.ok(lineByNew({ files: [one] }, 4).hits, "first file indexed");
  assert.ok(lineByNew({ files: [two] }, 4).hits, "second file indexed");
  assert.equal(lineByNew({ files: [three] }, 4).hits, undefined, "third file skipped");
});

test("attaches jump hits when an identifier and its def are both shown", async () => {
  const model = parseUnifiedDiff(DIFF);
  await navModel(model, { read: async () => CONTENT });

  const call = lineByNew(model, 4).hits.find((h) => h.name === "read");
  assert.equal(call.action, "jump");
  assert.equal(call.defVisible, true);
  assert.deepEqual(call.def, { line: 1, col: 9 });

  // The def line itself carries the definition hit.
  const def = lineByNew(model, 1).hits.find((h) => h.name === "read" && h.isDef);
  assert.deepEqual(def.def, { line: 1, col: 9 });
});

test("indicates when the def is outside the shown lines", async () => {
  // Only line 4 (the call) is shown; the def on line 1 is not in the diff.
  const partial = `diff --git a/x.js b/x.js
index 1111111..2222222 100644
--- a/x.js
+++ b/x.js
@@ -4,1 +4,1 @@
-read(0);
+read(1);
`;
  const model = parseUnifiedDiff(partial);
  await navModel(model, { read: async () => CONTENT });
  const call = lineByNew(model, 4).hits.find((h) => h.name === "read");
  assert.equal(call.action, "indicate");
  assert.equal(call.defVisible, false);
});

test("skips binary, non-JS, and unreadable files without throwing", async () => {
  const binModel = { files: [{ path: "img.png", binary: true, hunks: [{ lines: [] }] }] };
  await navModel(binModel, { read: async () => "ignored" });
  assert.ok(!("hits" in (binModel.files[0].hunks[0] ?? {})));

  const cssModel = parseUnifiedDiff("diff --git a/a.css b/a.css\n--- a/a.css\n+++ b/a.css\n@@ -1 +1 @@\n-a{}\n+b{}\n");
  let readCalled = false;
  await navModel(cssModel, { read: async () => { readCalled = true; return "b{}"; } });
  assert.equal(readCalled, false, "a non-JS file is never read");

  const jsModel = parseUnifiedDiff(DIFF);
  await navModel(jsModel, { read: async () => null }); // unreadable
  assert.equal(lineByNew(jsModel, 4).hits, undefined);
});
