import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startSurface } from "../src/server.mjs";

const assetsDir = mkdtempSync(path.join(os.tmpdir(), "surfacer-race-"));
writeFileSync(path.join(assetsDir, "index.html"), "<!doctype html><title>t</title>");

function tokenOf(surface) {
  return surface.url.split("#")[1];
}

function post(surface, pathname, body) {
  return fetch(`${surface.origin}${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tokenOf(surface)}`, "Content-Type": "application/json", Origin: surface.origin },
    body: JSON.stringify(body),
  });
}

test("of two racing completions exactly one reports success; the other gets 409", async () => {
  const surface = await startSurface({
    app: "race",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      // Both handlers are in flight before either completes.
      "POST /api/answer": async ({ body, session }) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        session.complete({ from: body.from });
        return null;
      },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const [first, second] = await Promise.all([post(surface, "/api/answer", { from: "a" }), post(surface, "/api/answer", { from: "b" })]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409], "one winner, one loser");
    const winner = first.status === 200 ? first : second;
    const { operationId } = await winner.json();
    assert.ok(operationId, "the winner receives the operation id to acknowledge");
    const ack = await post(surface, "/api/ack", { operationId });
    assert.equal(ack.status, 200);
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "completed");
    // The framed result is the winner's payload and nothing else.
    assert.ok(["a", "b"].includes(decision.payload.from));
  } finally {
    await surface.stop();
  }
});

test("a bystander in flight during the winner's completion, and a loser that swallows its 409, both get 409", async () => {
  const surface = await startSurface({
    app: "race2",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session }) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        session.complete({ from: "winner" });
        return null;
      },
      // Never completes; merely overlaps the winner.
      "POST /api/bystander": async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return null;
      },
      // Tries to complete after the winner, hides its own 409, returns normally.
      "POST /api/swallow": async ({ session }) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        try { session.complete({ from: "loser" }); } catch { /* swallowed on purpose */ }
        return null;
      },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const [winner, bystander, swallow] = await Promise.all([
      post(surface, "/api/answer", {}),
      post(surface, "/api/bystander", {}),
      post(surface, "/api/swallow", {}),
    ]);
    assert.equal(winner.status, 200);
    const { operationId } = await winner.json();
    assert.ok(operationId);
    assert.equal(bystander.status, 409, "a request that completed nothing must not report success");
    assert.equal(swallow.status, 409, "a loser that hid its 409 must not report success");
    for (const r of [bystander, swallow]) {
      const body = await r.json();
      assert.equal(body.operationId, undefined, "the winner's operation id never reaches another client");
    }
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { from: "winner" });
  } finally {
    await surface.stop();
  }
});

// A POST whose JSON body arrives in two pieces over a real socket. The first
// piece goes out at once; the rest waits for release(). The server sees the
// headers, passes its open-session check, and then sits in the body read.
function stalledPost(surface, pathname, [head, tail] = ['{"half":', "true}"]) {
  const url = new URL(`${surface.origin}${pathname}`);
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const done = new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: { Authorization: `Bearer ${tokenOf(surface)}`, "Content-Type": "application/json", Origin: surface.origin },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    request.on("error", reject);
    request.write(head, () => { released.then(() => request.end(tail)); });
  });
  return { done, release };
}

test("a request whose body is still arriving when the winner completes is refused before its handler runs", async () => {
  // The open-session check runs when the headers arrive; the body can take
  // longer. A session that closes in that gap must not run app code on a
  // closed session, must not report success, and must never hand over the
  // winner's operation id.
  let bystanderCalls = 0;
  const surface = await startSurface({
    app: "race3",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ session }) => { session.complete({ from: "winner" }); return null; },
      "POST /api/bystander": async () => { bystanderCalls += 1; return { body: { ordinary: true } }; },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const stalled = stalledPost(surface, "/api/bystander");
    // Give the loopback server time to take the headers and enter the body read.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const winner = await post(surface, "/api/answer", {});
    assert.equal(winner.status, 200);
    const { operationId } = await winner.json();
    assert.ok(operationId);
    stalled.release();
    const late = await stalled.done;
    assert.equal(late.status, 409, "a body that lands after the session closed is refused");
    assert.equal(late.body.operationId, undefined, "the winner's operation id never reaches the late client");
    assert.equal(late.body.ordinary, undefined, "the late handler's response never reaches the wire");
    assert.equal(bystanderCalls, 0, "app code never runs on a closed session");
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.deepEqual(decision.payload, { from: "winner" });
  } finally {
    await surface.stop();
  }
});

test("a heartbeat whose body lands after the session closed is refused, not renewed", async () => {
  // The built-in heartbeat has the same headers-then-body shape as an app
  // route; a session closed during its body read must answer 409, not 200.
  const surface = await startSurface({
    app: "race4",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const stalled = stalledPost(surface, "/api/heartbeat", ["{", "}"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancel = await post(surface, "/api/cancel", {});
    assert.equal(cancel.status, 200);
    const { operationId } = await cancel.json();
    stalled.release();
    const late = await stalled.done;
    assert.equal(late.status, 409, "a heartbeat cannot succeed on a closed session");
    assert.equal(late.body.operationId, undefined);
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "cancelled");
  } finally {
    await surface.stop();
  }
});

test("a cancelled session carries the app's outcome payload, not null", async () => {
  const surface = await startSurface({
    app: "outcome",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: (status) => ({ routed: true, status }),
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const cancel = await post(surface, "/api/cancel", {});
    assert.equal(cancel.status, 200);
    const { operationId } = await cancel.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "cancelled");
    assert.deepEqual(decision.payload, { routed: true, status: "cancelled" });
  } finally {
    await surface.stop();
  }
});

test("an outcome payload is redacted by default and exact with the verbatim opt-in", async () => {
  // A gate id can look like a token to the redactor; a review must be able to
  // keep it exact on every ending, while a generic app keeps the safe default.
  const tokenLike = "ghp_ABCDEFGHIJKLMNOPQRST";
  for (const [verbatim, expected] of [[false, false], [true, true]]) {
    const surface = await startSurface({
      app: "ids",
      assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
      terminalPayload: (status) => ({ gateId: tokenLike, status }),
      terminalPayloadVerbatim: verbatim,
      sessionTimeoutMs: 10_000,
      leaseTimeoutMs: 10_000,
    });
    try {
      const cancel = await post(surface, "/api/cancel", {});
      const { operationId } = await cancel.json();
      await post(surface, "/api/ack", { operationId });
      const decision = await surface.waitForDecision();
      assert.equal(decision.status, "cancelled");
      assert.equal(decision.payload.gateId === tokenLike, expected, `verbatim=${verbatim}: gateId ${decision.payload.gateId}`);
      if (!expected) assert.notEqual(decision.payload.gateId, tokenLike, "the default redacts a token-shaped value");
    } finally {
      await surface.stop();
    }
  }
});

test("a completion the frame cannot carry is refused and the session stays open", async () => {
  // The claim is a promise to frame the result on stdout. A payload JSON
  // cannot serialise must fail here, before the browser is told the session
  // completed, or the caller waits for a frame that never comes.
  const circular = { self: null };
  circular.self = circular;
  const surface = await startSurface({
    app: "frame",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/bigint": async ({ session }) => { session.complete({ x: 1n }); return null; },
      "POST /api/cycle": async ({ session }) => { session.complete(circular, { verbatim: true }); return null; },
      "POST /api/good": async ({ session }) => { session.complete({ ok: 1 }); return null; },
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    for (const route of ["/api/bigint", "/api/cycle"]) {
      const refused = await post(surface, route, {});
      assert.equal(refused.status, 500, `${route}: an unframeable completion is an error, not a success`);
      const body = await refused.json();
      assert.equal(body.operationId, undefined);
      assert.match(body.error, /cannot be framed/);
    }
    // Nothing was claimed: a frameable completion still succeeds afterwards.
    const good = await post(surface, "/api/good", {});
    assert.equal(good.status, 200, "the session stayed open");
    const { operationId } = await good.json();
    await post(surface, "/api/ack", { operationId });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "completed");
    assert.deepEqual(decision.payload, { ok: 1 });
  } finally {
    await surface.stop();
  }
});

test("an outcome payload the frame cannot carry becomes null, and the ending still arrives", async () => {
  const surface = await startSurface({
    app: "outcome-bigint",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: () => ({ x: 1n }),
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const decision = surface.waitForDecision();
    surface.interrupt("test");
    const ending = await decision;
    assert.equal(ending.status, "interrupted");
    assert.equal(ending.payload, null);
  } finally {
    await surface.stop();
  }
});

test("terminalPayload must be a function, and a throwing one yields null", async () => {
  await assert.rejects(() => startSurface({
    app: "bad",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: "nope",
  }), TypeError);
  const surface = await startSurface({
    app: "throws",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    terminalPayload: () => { throw new Error("boom"); },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const decision = surface.waitForDecision();
    surface.interrupt("test");
    assert.equal((await decision).payload, null);
  } finally {
    await surface.stop();
  }
});
