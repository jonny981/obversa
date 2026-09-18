import assert from "node:assert/strict";
import { test } from "node:test";
import { navIndex } from "../src/navindex.mjs";
import { navOverlay, visibleNewLines } from "../src/navoverlay.mjs";

const FILE = [
  "function read(x) {",
  "  return x;",
  "}",
  "function outer() {",
  "  return read(1);",
  "}",
  "outer();",
  "",
].join("\n");

function index() {
  return navIndex({ code: FILE, lang: "javascript" }).occurrences;
}

test("return shape is only hits", () => {
  const result = navOverlay({ occurrences: index(), visibleLines: [1] });
  assert.deepEqual(Object.keys(result), ["hits"]);
});

test("identifiers on hidden lines are omitted", () => {
  const { hits } = navOverlay({ occurrences: index(), visibleLines: [5, 7] });
  assert.ok(hits.every((hit) => hit.line === 5 || hit.line === 7));
  assert.equal(hits.some((hit) => hit.line === 1), false);
});

test("jump when the def line is also visible", () => {
  const { hits } = navOverlay({ occurrences: index(), visibleLines: [1, 5] });
  const call = hits.find((hit) => hit.name === "read" && hit.line === 5);
  assert.equal(call.action, "jump");
  assert.equal(call.defVisible, true);
  assert.deepEqual(call.def, { line: 1, col: 9 });
});

test("indicate when the identifier is visible but its def is not", () => {
  const { hits } = navOverlay({ occurrences: index(), visibleLines: [5] });
  const call = hits.find((hit) => hit.name === "read" && hit.line === 5);
  assert.equal(call.action, "indicate");
  assert.equal(call.defVisible, false);
  assert.deepEqual(call.def, { line: 1, col: 9 });
});

test("unresolved identifiers are not clickable", () => {
  const { occurrences } = navIndex({ code: "missing();\n", lang: "javascript" });
  const { hits } = navOverlay({ occurrences, visibleLines: [1] });
  const call = hits.find((hit) => hit.name === "missing");
  assert.equal(call.action, "none");
  assert.equal(call.defVisible, false);
  assert.equal(call.def, null);
});

test("visibleNewLines keeps add and context, drops deletions", () => {
  const file = {
    hunks: [{
      lines: [
        { type: "del", oldNumber: 1, newNumber: null },
        { type: "add", oldNumber: null, newNumber: 1 },
        { type: "context", oldNumber: 2, newNumber: 2 },
      ],
    }],
  };
  assert.deepEqual([...visibleNewLines(file)].sort((a, b) => a - b), [1, 2]);
});

test("overlay accepts the diff-file helper", () => {
  const file = {
    hunks: [{
      lines: [
        { type: "context", newNumber: 4 },
        { type: "add", newNumber: 5 },
      ],
    }],
  };
  const { hits } = navOverlay({
    occurrences: index(),
    visibleLines: visibleNewLines(file),
  });
  assert.ok(hits.every((hit) => hit.line === 4 || hit.line === 5));
  const call = hits.find((hit) => hit.name === "read" && hit.line === 5);
  assert.equal(call.action, "indicate");
});
