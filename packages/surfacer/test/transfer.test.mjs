import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createPrivateTransfer, removeTransfer } from "../src/transfer.mjs";

test("a transfer's manifest describes exactly the bytes it wrote, whatever a later read of the content would answer", async () => {
  // A getter that answers differently on every read: the first answer is
  // what is validated, written, hashed, and counted; the manifest must
  // agree with the file on disk, not with a later answer.
  let reads = 0;
  const file = { name: "review.txt", get content() { reads += 1; return `answer ${reads}\n`; } };
  const transfer = await createPrivateTransfer({ app: "test", files: [file] });
  try {
    assert.equal(transfer.files.length, 1);
    const written = readFileSync(transfer.files[0].path);
    assert.equal(written.toString("utf8"), "answer 1\n", "the first read is what was written");
    assert.equal(transfer.files[0].hash, createHash("sha256").update(written).digest("hex"), "the hash is of the written bytes");
    assert.equal(transfer.files[0].bytes, written.length, "the byte count is of the written bytes");
    assert.equal(reads, 1, "the content was read exactly once");
  } finally {
    await removeTransfer(transfer.directory);
  }
});

test("a content that is not NUL-free text is refused before anything is written", async () => {
  await assert.rejects(() => createPrivateTransfer({ app: "test", files: [{ name: "x", content: "a\0b" }] }), /without NUL bytes/);
  await assert.rejects(() => createPrivateTransfer({ app: "test", files: [{ name: "x", content: 42 }] }), /UTF-8 text/);
});
