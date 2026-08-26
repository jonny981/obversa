// F3 composition proof: the Pierre review surface really runs on @obversa/surfacer.
//
// This is the F2 completion evidence and the F3 core evidence in one place. It
// wires source's reviewDiff to surfacer's runSurface exactly as the composition
// root does, opens a real diff on a real loopback surface, and drives it with an
// HTTP client that plays the browser. It proves:
//   - the diff opens and its annotations round-trip through the framed handoff,
//   - review content survives verbatim through the redacting server,
//   - the bearer token gates the annotation mutation (unauth 401, cross-origin 403),
//   - no server code is copied: source calls the injected runSurface port.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseFramedResult, runSurface } from "../../../packages/surfacer/src/index.mjs";
import { computeDiff, parseUnifiedDiff, reviewDiff } from "../../../packages/source/src/index.mjs";

const clientKitSource = await readFile(
  new URL("../../../packages/surfacer/src/client.mjs", import.meta.url),
  "utf8",
);

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithChange() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "f3-proof-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "a.txt"), "alpha\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-q", "-m", "first");
  writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\n");
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

function captureStream() {
  let text = "";
  return { write(chunk) { text += chunk; return true; }, get text() { return text; } };
}

test("the Pierre review surface runs on surfacer and returns annotations", { timeout: 30_000 }, async () => {
  const repo = makeRepoWithChange();
  const { diffText } = await computeDiff({ mode: "worktree", cwd: repo });
  const anchor = firstNewAnchor(diffText);
  const secret = "token=ghp_ABC123verbatimSECRET";

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

  const reviewPromise = reviewDiff({
    mode: "worktree",
    cwd: repo,
    launchSurface,
    clientKitSource,
    open: false,
  });

  try {
    const { origin, url } = await ready;
    const token = url.split("#")[1];
    assert.ok(token, "the session url carries a token fragment");

    // The shell and the reused client kit are served raw (no auth on statics).
    const shell = await fetch(`${origin}/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /id="review-data"/);
    const kit = await fetch(`${origin}/surface-client.mjs`);
    assert.equal(kit.status, 200);
    assert.equal(await kit.text(), clientKitSource);

    const submitBody = JSON.stringify({ annotations: [{ ...anchor, body: `looks off: ${secret}` }] });

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
    const { operationId } = await submit.json();
    assert.ok(operationId, "the completion returns an operation id to acknowledge");

    const ack = await fetch(`${origin}/api/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Origin: origin },
      body: JSON.stringify({ operationId }),
    });
    assert.equal(ack.status, 200);

    const outcome = await reviewPromise;
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.annotations.length, 1);
    assert.equal(outcome.annotations[0].path, anchor.path);
    // Review content survives verbatim: a normal /api body would redact this.
    assert.match(outcome.annotations[0].body, /ghp_ABC123verbatimSECRET/);

    // The framed stdout carries the same verbatim payload for a pipeline consumer.
    const framed = parseFramedResult(stdout.text, "pierre-review");
    assert.ok(framed, "a framed result is written to stdout");
    assert.equal(framed.status, "completed");
    assert.match(framed.payload.annotations[0].body, /ghp_ABC123verbatimSECRET/);
  } finally {
    await reviewPromise.catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});
