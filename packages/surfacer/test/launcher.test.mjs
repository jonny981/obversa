import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { runSurface } from "../src/launcher.mjs";
import { parseFramedResult } from "../src/handoff.mjs";

// A stream that models a pipe whose reader has not drained it yet: it holds
// every write's callback until the test releases it. That makes the contract
// testable without timing: if runSurface resolves while the sink is still
// held, it resolved before the stream took the frame — exactly the bug where a
// caller exits on resolution and a large result is cut at the pipe buffer.
// (Earlier slow-but-unheld sinks drained faster than the session shutdown the
// launcher performs after writing, so an un-awaited write still passed; a
// mutation check caught that.)
class GatedSink extends Writable {
  constructor() {
    super({ highWaterMark: 1024 });
    this.captured = "";
    this.writes = 0;
    this.released = false;
    this.held = [];
  }
  _write(chunk, _encoding, callback) {
    this.writes += 1;
    this.captured += chunk.toString("utf8");
    if (this.released) callback();
    else this.held.push(callback);
  }
  release() {
    this.released = true;
    for (const callback of this.held.splice(0)) callback();
  }
}

const settledWithin = (promise, ms) =>
  Promise.race([promise.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), ms))]);

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

test("runSurface resolves only after the stream has taken a large verbatim frame", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  const sink = new GatedSink();
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
  // The session is decided, but the stream has not taken the frame yet:
  // runSurface must still be pending.
  assert.equal(await settledWithin(pending, 500), "pending", "runSurface must not resolve before the stream has taken the frame");
  assert.ok(sink.writes >= 1, "the frame was written to the stream");
  sink.release();
  const { result } = await pending;
  // Once the stream has taken it, runSurface resolves and the frame is
  // complete: it parses, and the payload is intact.
  const parsed = parseFramedResult(sink.captured, "launcher-big");
  assert.ok(parsed, "the frame is complete and parses when runSurface resolves");
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.payload.big.length, big.length);
  assert.equal(parsed.payload.big, result.payload.big);
});

test("once the session is decided the signal handlers are gone, before the frame is written: a signal during a blocked write ends the process the default way", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  const baseline = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
  let duringWrite = null;
  let captured = "";
  // A stream whose write completes only later: what the process's signal
  // handlers look like while the frame is still being taken is what counts.
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      captured += chunk;
      duringWrite = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") };
      setTimeout(callback, 50);
    },
  });
  let session;
  let installed = null;
  const pending = runSurface({
    app: "launcher-test",
    open: false,
    stdout,
    ready: (info) => { session = info; installed = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }; },
    assets: { directory, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: { "POST /api/answer": async ({ body, session: s }) => { s.complete({ got: body.value }); return null; } },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const token = session.url.split("#")[1];
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin };
  const reply = await fetch(`${session.origin}/api/answer`, { method: "POST", headers, body: JSON.stringify({ value: 1 }) }).then((r) => r.json());
  await fetch(`${session.origin}/api/ack`, { method: "POST", headers, body: JSON.stringify({ operationId: reply.operationId }) });
  await pending;
  assert.deepEqual(installed, { SIGINT: baseline.SIGINT + 1, SIGTERM: baseline.SIGTERM + 1 }, "the handlers are installed while the session runs");
  assert.deepEqual(duringWrite, baseline, "and gone before the frame is written");
  assert.equal(parseFramedResult(captured, "launcher-test").status, "completed");
});
