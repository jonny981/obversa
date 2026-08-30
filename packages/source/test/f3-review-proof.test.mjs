// F3 composition proof: the review surface really runs on @obversa/surfacer.
//
// This is the F2 completion evidence and the F3 core evidence in one place. It
// wires source's reviewDiff to surfacer's runSurface exactly as the composition
// root does, opens a real diff on a real loopback surface, and drives it with an
// HTTP client that plays the browser. It proves:
//   - the diff opens and its annotations round-trip through the framed handoff,
//   - the diff itself is served only behind the bearer token (the static shell
//     carries none of it; unauth GET is 401) and arrives verbatim, unredacted,
//   - review content survives verbatim through the redacting server,
//   - the bearer token gates the annotation mutation (unauth 401, cross-origin 403),
//   - no server code is copied: source calls the injected runSurface port.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { parseFramedResult, runSurface } from "@obversa/surfacer";
import { computeDiff, parseUnifiedDiff, reviewDiff } from "@obversa/source";

const clientKitSource = await readFile(
  new URL("../../surfacer/src/client.mjs", import.meta.url),
  "utf8",
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// A secret-looking string: the server redacts these in every normal /api body,
// so seeing it intact proves the verbatim lanes (the diff and the annotations).
const SECRET = "token=ghp_ABC123verbatimSECRET";

function makeRepoWithChange() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "f3-proof-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "a.txt"), "alpha\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(path.join(dir, "a.txt"), `alpha\nbeta ${SECRET}\n`);
  return dir;
}

function firstNewAnchor(diffText) {
  const model = parseUnifiedDiff(diffText);
  for (const file of model.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newNumber != null) return { path: file.path, side: "new", line: line.newNumber };
      }
    }
  }
  throw new Error("no anchor found in the diff");
}

// A stdout that models a pipe whose reader has not drained it yet: it holds
// each write's callback until the test releases it. reviewDiff must not
// resolve while the frame is held — a caller that exits on resolution would
// otherwise cut a large result at the pipe buffer — and once released, the
// frame must be complete.
class GatedPipe extends Writable {
  constructor() {
    super({ highWaterMark: 1024 });
    this.text = "";
    this.released = false;
    this.held = [];
  }
  _write(chunk, _encoding, callback) {
    this.text += chunk.toString("utf8");
    if (this.released) callback();
    else this.held.push(callback);
  }
  release() {
    this.released = true;
    for (const callback of this.held.splice(0)) callback();
  }
}

function captureStream() {
  return new GatedPipe();
}

const settledWithin = (promise, ms) =>
  Promise.race([promise.then(() => "settled", () => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), ms))]);

test("the review surface runs on surfacer and returns annotations", { timeout: 30_000 }, async () => {
  const repo = makeRepoWithChange();
  const { diffText } = await computeDiff({ mode: "worktree", cwd: repo });
  const anchor = firstNewAnchor(diffText);
  const secret = SECRET;

  const stdout = captureStream();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  // The composition root's binding, with a captured stdout and bounded timeouts.
  const launchSurface = (options) => runSurface({
    ...options,
    stdout,
    ready: (info) => resolveReady(info),
    leaseTimeoutMs: 15_000,
    sessionTimeoutMs: 25_000,
  });

  // Run from a subdirectory of the repository: the command is documented as
  // working anywhere inside it, and git's diff paths are repository-relative,
  // so full-file context and the tree must still resolve.
  const subdirectory = path.join(repo, "sub", "dir");
  mkdirSync(subdirectory, { recursive: true });
  const reviewPromise = reviewDiff({
    mode: "worktree",
    cwd: subdirectory,
    launchSurface,
    clientKitSource,
    open: false,
  });

  try {
    const { origin, url } = await ready;
    const token = url.split("#")[1];
    assert.ok(token, "the session url carries a token fragment");

    // The shell and the reused client kit are served raw (no auth on statics),
    // so the shell must carry none of the diff.
    const shell = await fetch(`${origin}/`);
    assert.equal(shell.status, 200);
    const shellText = await shell.text();
    assert.doesNotMatch(shellText, /review-data/);
    assert.doesNotMatch(shellText, /beta/);
    assert.doesNotMatch(shellText, /verbatimSECRET/);
    const kit = await fetch(`${origin}/surface-client.mjs`);
    assert.equal(kit.status, 200);
    assert.equal(await kit.text(), clientKitSource);

    // The diff is fetched behind the bearer token and arrives verbatim.
    const noAuthModel = await fetch(`${origin}/api/model`, { headers: { Origin: origin } });
    assert.equal(noAuthModel.status, 401);
    const modelResponse = await fetch(`${origin}/api/model`, {
      headers: { Authorization: `Bearer ${token}`, Origin: origin },
    });
    assert.equal(modelResponse.status, 200);
    const { model, meta } = await /** @type {any} */ (modelResponse.json());
    assert.equal(meta.label, "working tree");
    const addedTexts = model.files[0].hunks.flatMap((h) => h.lines).map((l) => l.text);
    assert.ok(addedTexts.some((t) => t.includes(secret)), "the diff line reaches the browser unredacted");
    // Started from a subdirectory, the diff path is still repository-relative,
    // the tree lists root-relative paths, and full-file context was read (an
    // unreadable file leaves contextBefore undefined).
    assert.equal(model.files[0].path, "a.txt");
    assert.deepEqual(meta.allFiles, ["a.txt"]);
    assert.ok(Array.isArray(model.files[0].hunks[0].contextBefore), "full-file context resolves from a subdirectory");

    // The browser returns the surface contract: a decision and annotations
    // pinned to offered anchors. This is the largest result the contract
    // allows — 500 annotations at the 4000-character body cap, over 2 MB —
    // so the framed handoff is proven at full size through the slow stream.
    const maxBody = `looks off: ${secret} ` + "y".repeat(4000);
    const annotations = Array.from({ length: 500 }, () => ({
      anchor: { target: anchor.path, side: anchor.side, position: anchor.line },
      body: maxBody,
    }));
    const submitBody = JSON.stringify({ decision: "changes-requested", annotations });

    // The mutation is gated: no token is 401, a foreign origin is 403.
    const noAuth = await fetch(`${origin}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: submitBody,
    });
    assert.equal(noAuth.status, 401);
    const badOrigin = await fetch(`${origin}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: "http://evil.test" },
      body: submitBody,
    });
    assert.equal(badOrigin.status, 403);

    // The real submission from the session origin with the bearer token.
    const submit = await fetch(`${origin}/api/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: origin },
      body: submitBody,
    });
    assert.equal(submit.status, 200);
    const { operationId } = await /** @type {any} */ (submit.json());
    assert.ok(operationId, "the completion returns an operation id to acknowledge");

    const ack = await fetch(`${origin}/api/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: origin },
      body: JSON.stringify({ operationId }),
    });
    assert.equal(ack.status, 200);

    // The session is decided, but the pipe has not drained the frame: the
    // review must still be pending. Release it, then it resolves.
    assert.equal(await settledWithin(reviewPromise, 500), "pending", "reviewDiff must not resolve before stdout has taken the frame");
    stdout.release();
    const outcome = await reviewPromise;
    assert.equal(outcome.status, "completed");
    // The result is the SurfaceResult: routable, decided, contract anchors.
    assert.equal(typeof outcome.result.surfaceId, "string");
    assert.equal(outcome.result.gateId, null, "a directly opened review has no gate");
    assert.equal(outcome.result.decision, "changes-requested");
    assert.equal(outcome.result.annotations.length, 500, "the contract's count bound");
    assert.deepEqual(outcome.result.annotations[0].anchor, { target: anchor.path, position: anchor.line, side: anchor.side });
    assert.equal(outcome.result.annotations[0].body.length, 4000, "the contract's body bound");
    // Review content survives verbatim: a normal /api body would redact this.
    assert.match(outcome.result.annotations[0].body, /ghp_ABC123verbatimSECRET/);

    // The framed stdout carries the same SurfaceResult, verbatim and COMPLETE
    // — over 2 MB through a slow pipe-like stream — at the moment reviewDiff
    // resolved, so a caller that exits on resolution loses nothing.
    assert.ok(stdout.text.length > 2_000_000, `the frame is large (${stdout.text.length} bytes)`);
    const framed = parseFramedResult(stdout.text, "review");
    assert.ok(framed, "a complete framed result is on stdout when reviewDiff resolves");
    assert.equal(framed.status, "completed");
    assert.equal(framed.payload.surfaceId, outcome.result.surfaceId);
    assert.equal(framed.payload.decision, "changes-requested");
    assert.equal(framed.payload.annotations.length, 500);
    assert.match(framed.payload.annotations[499].body, /ghp_ABC123verbatimSECRET/);
  } finally {
    await reviewPromise.catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

// A gate id shaped like a token: the runtime's redaction would rewrite it, so
// keeping it exact on every ending proves the review's verbatim opt-in.
const TOKEN_LIKE_GATE = "ghp_ABCDEFGHIJKLMNOPQRST";

test("a cancelled review still frames the exact surface and gate ids with a cancelled decision", { timeout: 30_000 }, async () => {
  const repo = makeRepoWithChange();
  const stdout = captureStream();
  stdout.release(); // the frame is small; no back-pressure to model here
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const launchSurface = (options) => runSurface({ ...options, stdout, ready: (info) => resolveReady(info), leaseTimeoutMs: 15_000, sessionTimeoutMs: 25_000 });
  const gate = { gateId: TOKEN_LIKE_GATE, callback: { address: "http://127.0.0.1:9/cb", token: "t" } };
  const reviewPromise = reviewDiff({ mode: "worktree", cwd: repo, launchSurface, clientKitSource, open: false, gate });
  try {
    const { origin, url } = await ready;
    const token = url.split("#")[1];
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: origin };
    const cancel = await fetch(`${origin}/api/cancel`, { method: "POST", headers, body: "{}" });
    assert.equal(cancel.status, 200);
    const { operationId } = await /** @type {any} */ (cancel.json());
    assert.equal((await fetch(`${origin}/api/ack`, { method: "POST", headers, body: JSON.stringify({ operationId }) })).status, 200);

    const outcome = await reviewPromise;
    assert.equal(outcome.status, "cancelled");
    assert.equal(typeof outcome.result.surfaceId, "string");
    assert.equal(outcome.result.gateId, TOKEN_LIKE_GATE, "the exact gate binding survives cancellation, even a token-shaped id");
    assert.equal(outcome.result.decision, "cancelled");
    assert.deepEqual(outcome.result.annotations, []);
    // The framed record carries the same routable outcome for a pipeline consumer.
    const framed = parseFramedResult(stdout.text, "review");
    assert.equal(framed.status, "cancelled");
    assert.equal(framed.payload.gateId, TOKEN_LIKE_GATE);
    assert.equal(framed.payload.decision, "cancelled");
    assert.equal(framed.payload.surfaceId, outcome.result.surfaceId);
  } finally {
    await reviewPromise.catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a timed-out review frames the exact gate binding with a timed-out decision", { timeout: 30_000 }, async () => {
  const repo = makeRepoWithChange();
  const stdout = captureStream();
  stdout.release();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  // A short lease with no heartbeat: the session times out on its own.
  const launchSurface = (options) => runSurface({ ...options, stdout, ready: (info) => resolveReady(info), leaseTimeoutMs: 400, sessionTimeoutMs: 25_000 });
  const gate = { gateId: TOKEN_LIKE_GATE, callback: { address: "http://127.0.0.1:9/cb", token: "t" } };
  const reviewPromise = reviewDiff({ mode: "worktree", cwd: repo, launchSurface, clientKitSource, open: false, gate });
  try {
    await ready;
    const outcome = await reviewPromise;
    assert.equal(outcome.status, "timed_out");
    assert.equal(outcome.result.gateId, TOKEN_LIKE_GATE, "the exact gate binding survives a timeout");
    assert.equal(outcome.result.decision, "timed-out");
    assert.deepEqual(outcome.result.annotations, []);
    const framed = parseFramedResult(stdout.text, "review");
    assert.equal(framed.status, "timed_out");
    assert.equal(framed.payload.gateId, TOKEN_LIKE_GATE);
    assert.equal(framed.payload.decision, "timed-out");
  } finally {
    await reviewPromise.catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});
