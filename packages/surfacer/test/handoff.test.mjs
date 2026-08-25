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
