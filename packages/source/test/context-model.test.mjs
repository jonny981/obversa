import { test } from "node:test";
import assert from "node:assert/strict";

import { createHighlightRegistry } from "../src/highlight.mjs";
import { contextModel } from "../src/context-model.mjs";

const CONTENT = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", ""].join("\n");

function model() {
  return {
    files: [{
      path: "x.js",
      binary: false,
      hunks: [
        { newStart: 3, newLines: 2, lines: [{ type: "context", newNumber: 3, text: "a3" }, { type: "add", newNumber: 4, text: "a4" }] },
        { newStart: 7, newLines: 2, lines: [{ type: "context", newNumber: 7, text: "a7" }, { type: "add", newNumber: 8, text: "a8" }] },
      ],
    }],
  };
}
const nums = (ctx) => ctx.map((c) => c.line);
const texts = (ctx) => ctx.map((c) => c.text);

test("collects the unmodified gaps above, between, and below the hunks", async () => {
  const m = model();
  await contextModel(m, { read: async () => CONTENT, registry: createHighlightRegistry() });
  const file = m.files[0];
  assert.deepEqual(nums(file.hunks[0].contextBefore), [1, 2]);
  assert.deepEqual(texts(file.hunks[0].contextBefore), ["a1", "a2"]);
  assert.deepEqual(nums(file.hunks[1].contextBefore), [5, 6]);
  assert.deepEqual(nums(file.contextAfter), [9, 10]);
  for (const c of file.contextAfter) assert.ok(Array.isArray(c.tokens));
});

test("no gap above a hunk that starts at line 1", async () => {
  const m = { files: [{ path: "x.js", binary: false, hunks: [{ newStart: 1, newLines: 2, lines: [] }] }] };
  await contextModel(m, { read: async () => "a1\na2\na3\n", registry: createHighlightRegistry() });
  assert.deepEqual(m.files[0].hunks[0].contextBefore, []);
  assert.deepEqual(nums(m.files[0].contextAfter), [3]);
});

test("degrades to no context without a registry, unreadable content, or binary", async () => {
  const a = model();
  await contextModel(a, { read: async () => CONTENT }); // no registry
  assert.equal(a.files[0].hunks[0].contextBefore, undefined);

  const b = model();
  await contextModel(b, { read: async () => null, registry: createHighlightRegistry() });
  assert.equal(b.files[0].hunks[0].contextBefore, undefined);

  const c = { files: [{ path: "x.png", binary: true, hunks: [{ newStart: 1, newLines: 1, lines: [] }] }] };
  await contextModel(c, { read: async () => "x", registry: createHighlightRegistry() });
  assert.equal(c.files[0].hunks[0].contextBefore, undefined);
});
