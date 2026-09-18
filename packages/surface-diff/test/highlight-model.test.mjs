import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUnifiedDiff } from "../src/diff.mjs";
import { highlightModel } from "../src/highlight-model.mjs";
import { registryToCss } from "../src/highlight.mjs";

const DIFF = `diff --git a/x.js b/x.js
index 1111111..2222222 100644
--- a/x.js
+++ b/x.js
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

function lineText(tokens) {
  return tokens.map((t) => t.text).join("");
}

test("attaches tokens to every content line and returns a stylesheet", async () => {
  const model = parseUnifiedDiff(DIFF);
  const css = registryToCss(await highlightModel(model));

  const lines = model.files[0].hunks[0].lines;
  assert.equal(lines.length, 4);
  for (const line of lines) {
    assert.ok(Array.isArray(line.tokens), "each line has a tokens array");
    // Concatenated token text reproduces the exact source line (no escaping loss).
    assert.equal(lineText(line.tokens), line.text);
  }
  assert.match(css, /:root \{/);
  assert.match(css, /--hl-fg:/);
  assert.match(css, /\.tok-\d+ \{/);
});

test("del line paints from the old side, add line from the new side", async () => {
  const model = parseUnifiedDiff(DIFF);
  await highlightModel(model);
  const [ctxA, del, add, ctxC] = model.files[0].hunks[0].lines;
  assert.equal(lineText(del.tokens), "const b = 2;");
  assert.equal(lineText(add.tokens), "const b = 3;");
  assert.equal(lineText(ctxA.tokens), "const a = 1;");
  assert.equal(lineText(ctxC.tokens), "const c = 4;");
});

test("leaves binary and hunkless files untouched and still returns css", async () => {
  const model = { files: [{ path: "img.png", binary: true, hunks: [] }, { path: "empty.js", binary: false, hunks: [] }] };
  const css = registryToCss(await highlightModel(model));
  assert.equal(typeof css, "string");
  assert.ok(model.files[0].hunks.length === 0);
});
