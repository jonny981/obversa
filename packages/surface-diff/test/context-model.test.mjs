import { test } from "node:test";
import assert from "node:assert/strict";

import { createHighlightRegistry } from "../src/highlight.mjs";
import { boundedReader, contextModel } from "../src/context-model.mjs";
import { navModel } from "../src/nav-model.mjs";

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

test("stops attaching context once the review-wide byte bound is spent", async () => {
  const file = (path) => ({ path, binary: false, hunks: [{ newStart: 2, newLines: 1, lines: [{ type: "add", newNumber: 2, text: "b" }] }] });
  const m = { files: [file("one.js"), file("two.js"), file("three.js")] };
  // Each file reads as 6 bytes; a 15-byte bound admits two files, not three.
  await contextModel(m, { read: async () => "a\nb\nc\n", registry: createHighlightRegistry(), maxTotalBytes: 15 });
  assert.deepEqual(nums(m.files[0].hunks[0].contextBefore), [1]);
  assert.deepEqual(nums(m.files[1].hunks[0].contextBefore), [1]);
  assert.equal(m.files[2].hunks[0].contextBefore, undefined, "the third file gets no context");
  assert.equal(m.files[2].contextAfter, undefined);
});

test("one bounded reader serves context and go-to-source under one bound, reading each file once", async () => {
  // Two 6-byte JavaScript files under a 10-byte bound. Two separate passes
  // each starting from zero would read four times for 24 bytes; one reader
  // reads each file once and lets 6 bytes through in total.
  const file = (path) => ({ path, binary: false, hunks: [{ newStart: 2, newLines: 1, lines: [{ type: "add", newNumber: 2, text: "b" }] }] });
  const m = { files: [file("one.js"), file("two.js")] };
  const rawCalls = [];
  const raw = async ({ path, maxBytes }) => { rawCalls.push({ path, maxBytes }); return "a\nb\nc\n"; };
  const read = boundedReader({ read: raw, maxTotalBytes: 10 });
  await contextModel(m, { read, registry: createHighlightRegistry() });
  await navModel(m, { read });
  assert.deepEqual(rawCalls.map((c) => c.path), ["one.js", "two.js"], "each file is read once across both passes");
  // Each read is asked for at most what is left of the bound.
  assert.deepEqual(rawCalls.map((c) => c.maxBytes), [10, 4]);
  assert.deepEqual(nums(m.files[0].hunks[0].contextBefore), [1], "the first file got context");
  assert.equal(m.files[1].hunks[0].contextBefore, undefined, "the second file would cross the bound");
  // A refused file stays refused without another read; a new file may still
  // be tried, but only for what is left of the bound.
  assert.equal(await read({ path: "two.js", mode: "worktree" }), null);
  assert.equal(rawCalls.length, 2, "a refused file is not re-read");
  assert.equal(await read({ path: "three.js", mode: "worktree" }), null);
  assert.deepEqual(rawCalls[2], { path: "three.js", maxBytes: 4 });
  // Once the bound is spent nothing is read at all.
  const spent = boundedReader({ read: raw, maxTotalBytes: 6 });
  assert.equal(await spent({ path: "one.js", mode: "worktree" }), "a\nb\nc\n");
  const before = rawCalls.length;
  assert.equal(await spent({ path: "two.js", mode: "worktree" }), null);
  assert.equal(rawCalls.length, before, "a spent budget reads nothing");
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
