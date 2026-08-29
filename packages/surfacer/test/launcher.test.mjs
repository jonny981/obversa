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

test("the frame written is the frame claimed: a toJSON injected after the completion returns cannot change it", async () => {
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
        // App code after the claim: a serialiser hook on every object. A
        // second JSON.stringify of the result would now write {"forged":true}.
        Object.defineProperty(Object.prototype, "toJSON", { value() { return { forged: true }; }, configurable: true, writable: true, enumerable: false });
        return null;
      },
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const token = session.url.split("#")[1];
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin };
    const reply = await fetch(`${session.origin}/api/answer`, { method: "POST", headers, body: JSON.stringify({ value: 7 }) }).then((r) => r.json());
    await fetch(`${session.origin}/api/ack`, { method: "POST", headers, body: JSON.stringify({ operationId: reply.operationId }) });
    const { result, frame } = await pending;
    assert.equal(typeof frame, "string");
    assert.equal(Reflect.ownKeys(result).includes("frame"), false, "the public decision carries no hidden field; the frame is handed back beside it");
    assert.equal(captured, frame, "written verbatim");
    assert.match(captured, /"payload":\{"got":7\}/, "the claimed payload, not the hook's answer");
    assert.doesNotMatch(captured, /forged/);
  } finally {
    delete Object.prototype.toJSON;
  }
});

// (Under the hook the test's own JSON.stringify of an object is forged as
// well, so every request body below is built from primitives.)
// A serialiser hook present BEFORE the claim. The payload's snapshot keeps
// its documented semantics — one callable toJSON, own or inherited, is
// applied exactly once and what it returns is the payload — but the fixed
// envelope around it is written by the data walker, so the hook cannot
// replace the envelope or run again, on a completion and on an ending alike.
async function withHook(run) {
  let calls = 0;
  Object.defineProperty(Object.prototype, "toJSON", { value() { calls += 1; return { forged: true }; }, configurable: true, writable: true, enumerable: false });
  try {
    return await run(() => calls);
  } finally {
    delete Object.prototype.toJSON;
  }
}

test("a toJSON present on Object.prototype before the claim defines the completion payload exactly once and leaves the envelope alone", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  let captured = "";
  let session;
  await withHook(async (calls) => {
    const pending = runSurface({
      app: "launcher-test",
      open: false,
      stdout: { write: (text) => { captured += text; } },
      ready: (info) => { session = info; },
      assets: { directory, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
      api: { "POST /api/answer": async ({ body, session: s }) => { s.complete({ got: body.value }); return null; } },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const token = session.url.split("#")[1];
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin };
    const before = calls();
    const reply = await fetch(`${session.origin}/api/answer`, { method: "POST", headers, body: '{"value":7}' }).then((r) => r.json());
    await fetch(`${session.origin}/api/ack`, { method: "POST", headers, body: `{"operationId":${JSON.stringify(reply.operationId)}}` });
    const { result, frame } = await pending;
    assert.deepEqual(result.payload, { forged: true }, "the hook answered the payload, once, as the documented semantics say");
    assert.equal(captured, frame);
    const parsed = parseFramedResult(captured, "launcher-test");
    assert.equal(parsed.status, "completed", "the envelope is intact: the frame parses and names its status");
    assert.equal(parsed.app, "launcher-test");
    assert.deepEqual(parsed.payload, { forged: true });
    assert.equal(captured.split("forged").length - 1, 1, "the hook's answer appears once, as the payload, never as the envelope");
    // How often the hook ran across the whole session is not the probe (the
    // server's own HTTP replies serialise their bodies); the frame's walker
    // consulting it zero times is proved at the handoff unit level.
    assert.ok(calls() > before, "the hook did run, for the payload");
  });
});

test("a toJSON present on Object.prototype before an interrupt defines the ending's payload once and leaves its envelope alone", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  let captured = "";
  await withHook(async () => {
    const pending = runSurface({
      app: "launcher-test",
      open: false,
      stdout: { write: (text) => { captured += text; } },
      ready: () => setTimeout(() => process.emit("SIGINT"), 50),
      assets: { directory, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
      terminalPayload: (status) => ({ outcome: status }),
    });
    const { result, frame } = await pending;
    assert.equal(result.status, "interrupted");
    assert.deepEqual(result.payload, { forged: true }, "the ending payload's one serialisation applied the hook");
    assert.equal(captured, frame);
    const parsed = parseFramedResult(captured, "launcher-test");
    assert.equal(parsed.status, "interrupted", "the envelope is intact");
    assert.equal(parsed.app, "launcher-test");
    assert.equal(captured.split("forged").length - 1, 1);
  });
});

test("with a toJSON on Object.prototype before the claim, the protocol replies still carry the real operation id and the explicit acknowledgement settles the session at once", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launcher-assets-"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>x</title>");
  for (const route of ["answer", "cancel"]) {
    let session;
    await withHook(async () => {
      const pending = runSurface({
        app: "launcher-test",
        open: false,
        stdout: { write: () => {} },
        ready: (info) => { session = info; },
        ackTimeoutMs: 20_000,
        assets: { directory, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
        api: { "POST /api/answer": async ({ session: s }) => { s.complete({ got: 1 }); return null; } },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const token = session.url.split("#")[1];
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Origin: session.origin };
      const response = await fetch(`${session.origin}/api/${route}`, { method: "POST", headers, body: "{}" });
      assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
      const reply = await response.json();
      assert.match(String(reply.operationId), /^[0-9a-f-]{36}$/, `${route}: the reply carries the real operation id, not the hook's answer`);
      assert.equal(reply.forged, undefined, `${route}: the protocol reply is not the hook's`);
      const acked = await fetch(`${session.origin}/api/ack`, { method: "POST", headers, body: `{"operationId":${JSON.stringify(reply.operationId)}}` });
      assert.equal(acked.status, 200, `${route}: the acknowledgement is accepted`);
      const started = Date.now();
      const { result } = await pending;
      assert.ok(Date.now() - started < 2_000, `${route}: the explicit acknowledgement settled the session, not the 20 s clock`);
      assert.equal(result.status, route === "answer" ? "completed" : "cancelled");
    });
  }
});
