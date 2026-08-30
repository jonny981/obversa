import assert from "node:assert/strict";
import test from "node:test";

import { frameResult, parseFramedResult, terminalResult, dataJson } from "../src/handoff.mjs";
import { createPrivateTransfer, removeTransfer } from "../src/transfer.mjs";
import { promises as fs } from "node:fs";

test("a framed result round-trips through caller-captured stdout", () => {
  const result = terminalResult("code-review", "completed", { payload: { notes: 3 } });
  const captured = `noise before\n${frameResult(result)}noise after\n`;
  const parsed = parseFramedResult(captured, "code-review");
  assert.equal(parsed.operationId, result.operationId);
  assert.deepEqual(parsed.payload, { notes: 3 });
  assert.equal(parseFramedResult(captured, "other-app"), null);
});

test("terminal results redact secrets and cap detail", () => {
  const result = terminalResult("x", "error", { detail: `token=abc123 ${"y".repeat(600)}` });
  assert.match(result.detail, /\[REDACTED\]/);
  assert.ok(result.detail.length <= 500);
  assert.throws(() => terminalResult("x", "nonsense"), /Unsupported terminal status/);
});

test("a private transfer writes 0600 files with matching hashes", async () => {
  const transfer = await createPrivateTransfer({
    app: "test app",
    files: [{ name: "draft.md", content: "hello\n" }],
  });
  try {
    const [file] = transfer.files;
    const stat = await fs.stat(file.path);
    assert.equal(stat.mode & 0o777, 0o600);
    const directoryStat = await fs.stat(transfer.directory);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    const content = await fs.readFile(file.path, "utf8");
    assert.equal(content, "hello\n");
    assert.equal(file.bytes, 6);
    assert.match(file.hash, /^[0-9a-f]{64}$/);
  } finally {
    await removeTransfer(transfer.directory);
  }
  await assert.rejects(() => createPrivateTransfer({ app: "x", files: [{ content: "a\0b" }] }), /NUL/);
});

test("a verbatim completion carries secret-shaped content unmangled", async () => {
  const raw = { annotation: 'set password = "hunter2" on line 4' };
  const result = terminalResult("review", "completed", { payload: raw, verbatim: true });
  assert.equal(result.payload.annotation, raw.annotation);
  const framed = frameResult(result);
  assert.match(framed, /hunter2/);
  const guarded = terminalResult("review", "completed", { payload: raw });
  assert.match(guarded.payload.annotation, /\[REDACTED\]/);
});

test("a colliding earlier frame does not hide the exact later frame", () => {
  const a = terminalResult("code_review", "completed", { payload: { from: "underscore" } });
  const b = terminalResult("code-review", "completed", { payload: { from: "hyphen" } });
  const captured = frameResult(a) + frameResult(b);
  assert.equal(parseFramedResult(captured, "code-review").payload.from, "hyphen");
  assert.equal(parseFramedResult(captured, "code_review").payload.from, "underscore");
});

test("removeTransfer refuses foreign directories and stays retryable after a failed removal", async () => {
  const { mkdtempSync, chmodSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const foreign = mkdtempSync(path.join(os.tmpdir(), "not-ours-"));
  await assert.rejects(() => removeTransfer(foreign), /only removes directories/);
  await fs.rm(foreign, { recursive: true, force: true });

  // A real removal that fails once must remain retryable: the authorization
  // is kept until fs.rm actually succeeds. Force a failure by making a file
  // inside the transfer, then the parent, unwritable, then restore and retry.
  const t = await createPrivateTransfer({ app: "retry", files: [{ name: "a.md", content: "x" }] });
  chmodSync(t.directory, 0o500);
  let failed = false;
  try { await removeTransfer(t.directory); } catch { failed = true; }
  chmodSync(t.directory, 0o700);
  if (failed) {
    await removeTransfer(t.directory); // authorization survived the failure
  } else {
    await removeTransfer(t.directory).catch(() => {});
  }
});

test("the data walker writes plain data without consulting toJSON, and refuses what JSON could not carry whole", () => {
  assert.equal(dataJson({ a: 1, b: "x", c: [true, null, { d: -1.5 }] }), '{"a":1,"b":"x","c":[true,null,{"d":-1.5}]}');
  assert.equal(dataJson("s"), '"s"');
  // An own toJSON is a function-valued property: not data.
  assert.throws(() => dataJson({ toJSON() { return {}; } }), /a function/);
  // An inherited toJSON, Object.prototype's included, is never consulted.
  let calls = 0;
  Object.defineProperty(Object.prototype, "toJSON", { value() { calls += 1; return { forged: true }; }, configurable: true, writable: true, enumerable: false });
  try {
    assert.equal(dataJson({ a: 1 }), '{"a":1}');
    assert.equal(calls, 0, "the walker never consulted the hook");
    assert.equal(dataJson([1, "two"]), '[1,"two"]');
    assert.equal(JSON.stringify({ a: 1 }), '{"forged":true}', "JSON.stringify itself would be fooled");
    assert.match(frameResult(terminalResult("probe", "interrupted", { detail: "x" })), /"status":"interrupted"/);
    const before = calls;
    assert.doesNotMatch(frameResult(terminalResult("probe", "interrupted", { detail: "x" })), /forged/);
    assert.equal(calls, before, "framing an envelope consulted it zero times");
  } finally {
    delete (/** @type {any} */ (Object.prototype)).toJSON;
  }
  for (const [name, value] of /** @type {[string, any][]} */ ([["a cycle", (() => { const o = {}; o.self = o; return o; })()], ["a BigInt", { n: 1n }], ["an undefined value", { u: undefined }], ["a non-finite number", { n: Infinity }], ["negative zero", { n: -0 }], ["Map", new Map()], ["Date", new Date(0)], ["a Proxy", new Proxy({}, {})], ["an accessor", { get x() { return 1; } }], ["a symbol-keyed property", { [Symbol("k")]: 1 }], ["an array with extra properties or holes", Object.assign([1], { extra: 2 })]])) {
    assert.throws(() => dataJson(value), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), name);
  }
});
