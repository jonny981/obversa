import { test } from "node:test";
import assert from "node:assert/strict";

import { overlaySegments } from "../assets/nav-segments.mjs";

const jumpHit = (col, endCol, name) => ({ col, endCol, name, action: "jump", def: { line: 1, col } });

function joined(segments) {
  return segments.map((s) => s.text).join("");
}

test("with no hits, segments mirror the tokens and round-trip", () => {
  const tokens = [{ text: "const ", cls: null }, { text: "x", cls: "tok-1" }, { text: " = 1;", cls: null }];
  const segs = overlaySegments(tokens, []);
  assert.equal(joined(segs), "const x = 1;");
  assert.equal(segs.length, 3);
  assert.ok(segs.every((s) => !s.hit));
});

test("a hit that exactly covers a token marks that token clickable", () => {
  // "read" occupies columns 0..4 as its own token.
  const tokens = [{ text: "read", cls: "tok-2" }, { text: "(1);", cls: null }];
  const segs = overlaySegments(tokens, [jumpHit(0, 4, "read")]);
  assert.equal(joined(segs), "read(1);");
  const hitSeg = segs.find((s) => s.hit);
  assert.equal(hitSeg.text, "read");
  assert.equal(hitSeg.cls, "tok-2");
  assert.equal(hitSeg.hit.name, "read");
});

test("a hit inside a larger token splits it into before / hit / after", () => {
  // The whole "read(1)" arrived as one token; the identifier is columns 0..4.
  const tokens = [{ text: "read(1)", cls: "tok-3" }];
  const segs = overlaySegments(tokens, [jumpHit(0, 4, "read")]);
  assert.equal(joined(segs), "read(1)");
  assert.deepEqual(segs.map((s) => s.text), ["read", "(1)"]);
  assert.equal(segs[0].hit.name, "read");
  assert.equal(segs[1].hit, undefined);
});

test("a hit in the middle of a token yields before / hit / after", () => {
  const tokens = [{ text: "a.read.b", cls: null }]; // 'read' at cols 2..6
  const segs = overlaySegments(tokens, [jumpHit(2, 6, "read")]);
  assert.deepEqual(segs.map((s) => s.text), ["a.", "read", ".b"]);
  assert.equal(segs[1].hit.name, "read");
});

test("a hit spanning two tokens marks the overlap in each", () => {
  // 'name' split by the highlighter into 'na' + 'me' (cols 0..2, 2..4).
  const tokens = [{ text: "na", cls: "tok-a" }, { text: "me", cls: "tok-b" }];
  const segs = overlaySegments(tokens, [jumpHit(0, 4, "name")]);
  assert.equal(joined(segs), "name");
  assert.ok(segs.every((s) => s.hit && s.hit.name === "name"));
  assert.deepEqual(segs.map((s) => s.cls), ["tok-a", "tok-b"]);
});

test("an unresolved (action none) hit is not clickable", () => {
  const tokens = [{ text: "missing", cls: null }];
  const segs = overlaySegments(tokens, [{ col: 0, endCol: 7, name: "missing", action: "none", def: null }]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].hit, undefined);
});

test("indicate hits are clickable segments too", () => {
  const tokens = [{ text: "read", cls: null }];
  const segs = overlaySegments(tokens, [{ col: 0, endCol: 4, name: "read", action: "indicate", def: { line: 9, col: 0 } }]);
  assert.equal(segs[0].hit.action, "indicate");
});

test("columns are counted in UTF-16 units, matching the highlighter and navindex", () => {
  // 'café' is 4 UTF-16 units; the following identifier 'café' starts at col 0 on its line.
  const tokens = [{ text: "café", cls: "tok-x" }, { text: ";", cls: null }];
  const segs = overlaySegments(tokens, [jumpHit(0, 4, "café")]);
  assert.equal(segs[0].text, "café");
  assert.equal(segs[0].hit.name, "café");
  assert.equal(segs[1].text, ";");
});
