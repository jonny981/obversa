import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runSurface } from "../src/launcher.mjs";
import { parseFramedResult } from "../src/handoff.mjs";

// A stream that behaves like a pipe under back-pressure: a tiny buffer and a
// deferred write. If the launcher resolved before the frame was fully taken,
// `captured` would be short when the caller looked.
class SlowSink extends Writable {
  constructor() {
    super({ highWaterMark: 1024 });
    this.captured = "";
    this.writes = 0;
  }
  _write(chunk, _encoding, callback) {
    this.writes += 1;
    setImmediate(() => { this.captured += chunk.toString("utf8"); callback(); });
  }
}

test("runSurface runs one session end to end and frames the result", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  let captured = "";
  let session;
  const pending = runSurface({
    app: "launcher-test",
    open: false,
    stdout: { write: (text) => { captured += text; } },
    ready: (info) => { session = info; },
    assets: { directory, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ body, session: s }) => {
        s.complete({ got: body.value });
        return null;
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const token = session.url.split("#")[1];
  const reply = await fetch(`${session.origin}/api/answer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin },
    body: JSON.stringify({ value: 7 }),
  }).then((r) => r.json());
  await fetch(`${session.origin}/api/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin },
    body: JSON.stringify({ operationId: reply.operationId }),
  });
  const { result, placement } = await pending;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.payload, { got: 7 });
  assert.deepEqual(placement, { opened: false, via: "disabled" });
  assert.equal(parseFramedResult(captured, "launcher-test").status, "completed");
  assert.equal(parseFramedResult(captured, "other-app"), null);
});

test("runSurface resolves only after a large verbatim frame has been fully taken by a slow stream", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  const sink = new SlowSink();
  // Well past a pipe's 64 KiB buffer, and past what 500 × 4000-character
  // review comments would produce.
  const big = "token=ghp_" + "x".repeat(2_500_000);
  let session;
  const pending = runSurface({
    app: "launcher-big",
    open: false,
    stdout: sink,
    ready: (info) => { session = info; },
    assets: { directory, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session: s }) => {
        s.complete({ big }, { verbatim: true });
        return null;
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const token = session.url.split("#")[1];
  const reply = await fetch(`${session.origin}/api/answer`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin },
    body: JSON.stringify({}),
  }).then((r) => r.json());
  await fetch(`${session.origin}/api/ack`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin },
    body: JSON.stringify({ operationId: reply.operationId }),
  });
  const { result } = await pending;
  // At the moment runSurface resolves the slow stream has already taken the
  // whole frame: it parses, and the payload is intact.
  const parsed = parseFramedResult(sink.captured, "launcher-big");
  assert.ok(parsed, "the frame is complete and parses when runSurface resolves");
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.payload.big.length, big.length);
  assert.equal(parsed.payload.big, result.payload.big);
  assert.ok(sink.writes >= 1);
});
