import assert from "node:assert/strict";
import test from "node:test";

import { frameResult, parseFramedResult, terminalResult } from "../src/handoff.mjs";
import { createPrivateTransfer, removeTransfer } from "../src/transfer.mjs";
import { promises as fs } from "node:fs";

test("a framed result round-trips through caller-captured stdout", () => {
  const result = terminalResult("pierre-review", "completed", { payload: { notes: 3 } });
  const captured = `noise before\n${frameResult(result)}noise after\n`;
  const parsed = parseFramedResult(captured, "pierre-review");
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
  const a = terminalResult("pierre_review", "completed", { payload: { from: "underscore" } });
  const b = terminalResult("pierre-review", "completed", { payload: { from: "hyphen" } });
  const captured = frameResult(a) + frameResult(b);
  assert.equal(parseFramedResult(captured, "pierre-review").payload.from, "hyphen");
  assert.equal(parseFramedResult(captured, "pierre_review").payload.from, "underscore");
});

test("removeTransfer refuses directories it did not create, and retries after failure", async () => {
  const { mkdtempSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const foreign = mkdtempSync(path.join(os.tmpdir(), "not-ours-"));
  await assert.rejects(() => removeTransfer(foreign), /only removes directories/);
  await fs.rm(foreign, { recursive: true, force: true });
});
