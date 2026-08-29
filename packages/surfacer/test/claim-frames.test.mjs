import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { frameOf, recordFrame } from "../src/claim-frames.mjs";

test("the frame store answers for the claim it recorded and nothing else, through functions bound before any app code ran", () => {
  const claim = { status: "completed" };
  assert.equal(frameOf(claim), undefined);
  recordFrame(claim, "<<<A>>>\n{}\n<<<END_A>>>\n");
  assert.equal(frameOf(claim), "<<<A>>>\n{}\n<<<END_A>>>\n");
  assert.equal(frameOf({ status: "completed" }), undefined, "keyed by identity, not by shape");
  const realGet = WeakMap.prototype.get;
  const realSet = WeakMap.prototype.set;
  try {
    WeakMap.prototype.get = function () { return "FORGED"; };
    WeakMap.prototype.set = function () { return this; };
    assert.equal(frameOf(claim), "<<<A>>>\n{}\n<<<END_A>>>\n", "a replaced prototype get is never consulted");
    const another = {};
    recordFrame(another, "kept");
    assert.equal(frameOf(another), "kept", "a replaced prototype set is never consulted");
  } finally {
    WeakMap.prototype.get = realGet;
    WeakMap.prototype.set = realSet;
  }
});

test("the store holds no reference of its own: a claim the caller drops is collected, and its frame with it", () => {
  // Reachability is proved in a child with garbage collection exposed: a
  // claim held only through a WeakRef, with a 2 MB frame recorded for it,
  // is gone after a collection — the store kept neither.
  const module = fileURLToPath(new URL("../src/claim-frames.mjs", import.meta.url));
  const script = `
    const { recordFrame, frameOf } = await import(${JSON.stringify(module)});
    let claim = { status: "completed" };
    const ref = new WeakRef(claim);
    recordFrame(claim, "x".repeat(2 * 1024 * 1024));
    if (frameOf(claim).length !== 2 * 1024 * 1024) throw new Error("recorded");
    claim = null;
    await new Promise((resolve) => setTimeout(resolve, 0));
    global.gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
    global.gc();
    console.log(ref.deref() === undefined ? "collected" : "retained");
  `;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "collected");
});
