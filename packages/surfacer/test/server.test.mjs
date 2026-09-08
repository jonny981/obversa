import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startSurface, assertExactKeys } from "../src/server.mjs";

const assetsDir = mkdtempSync(path.join(os.tmpdir(), "surfacer-assets-"));
writeFileSync(path.join(assetsDir, "index.html"), "<!doctype html><title>t</title>");
const SURFACER_TEST_TIMEOUT_MS = 60_000;
const SURFACER_HANG_GUARD_TIMEOUT_MS = 20_000;
const ACKNOWLEDGEMENT_SETTLEMENT_MAX_MS = 400;
const DISCONNECT_SETTLEMENT_MAX_MS = 1_000;
const SURFACER_SETUP_ALLOWANCE_MS = 5_000;
const SURFACER_CLEANUP_ALLOWANCE_MS = 10_000;
const SURFACER_TEST_CHAINS = {
  completion: [
    ["setup", SURFACER_SETUP_ALLOWANCE_MS],
    ["response", SURFACER_HANG_GUARD_TIMEOUT_MS],
    ["acknowledgement settlement", ACKNOWLEDGEMENT_SETTLEMENT_MAX_MS],
    ["cleanup", SURFACER_CLEANUP_ALLOWANCE_MS],
  ],
  disconnect: [
    ["setup", SURFACER_SETUP_ALLOWANCE_MS],
    ["decision", SURFACER_HANG_GUARD_TIMEOUT_MS],
    ["cleanup", SURFACER_CLEANUP_ALLOWANCE_MS],
  ],
};
for (const [name, chain] of Object.entries(SURFACER_TEST_CHAINS)) {
  const total = chain.reduce((sum, [, allowance]) => sum + Number(allowance), 0);
  assert.ok(total < SURFACER_TEST_TIMEOUT_MS, `${name} surfacer budget chain exceeds its test budget: ${total}ms >= ${SURFACER_TEST_TIMEOUT_MS}ms`);
}

function boot(overrides = {}) {
  return startSurface({
    app: "test-app",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "POST /api/answer": async ({ body, session }) => {
        assertExactKeys(body, ["value"]);
        session.complete({ value: body.value });
        return { status: 200, body: { ok: true } };
      },
      "GET /api/state": async () => ({ status: 200, body: { fine: true } }),
    },
    ...overrides,
  });
}

function request(surface, pathname, { method = "POST", body = {}, token = tokenOf(surface), headers = {} } = {}) {
  const withBody = method !== "GET";
  return fetch(`${surface.origin}${pathname}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(withBody ? { "Content-Type": "application/json", Origin: surface.origin } : {}),
      ...headers,
    },
    ...(withBody ? { body: JSON.stringify(body) } : {}),
  });
}

function tokenOf(surface) {
  return surface.url.split("#")[1];
}

test("serves the static shell with security headers and no token", async () => {
  const surface = await boot();
  try {
    const response = await fetch(`${surface.origin}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
  } finally {
    await surface.stop();
  }
});

test("rejects a wrong Host header", async () => {
  const surface = await boot();
  try {
    // fetch refuses to override Host, so send the request raw.
    const http = await import("node:http");
    const status = await new Promise((resolve, reject) => {
      const raw = http.request({
        host: "127.0.0.1",
        port: surface.port,
        path: "/api/state",
        method: "GET",
        headers: { Host: "evil.example:80", Authorization: `Bearer ${tokenOf(surface)}` },
      }, (response) => resolve(response.statusCode));
      raw.once("error", reject);
      raw.end();
    });
    assert.equal(status, 421);
  } finally {
    await surface.stop();
  }
});

test("requires the bearer token and a matching origin", async () => {
  const surface = await boot();
  try {
    const unauthorized = await request(surface, "/api/state", { method: "GET", token: null });
    assert.equal(unauthorized.status, 401);
    const badToken = await request(surface, "/api/state", { method: "GET", token: "wrong" });
    assert.equal(badToken.status, 401);
    const badOrigin = await request(surface, "/api/answer", {
      body: { value: 1 },
      headers: { Origin: "http://evil.example" },
    });
    assert.equal(badOrigin.status, 403);
  } finally {
    await surface.stop();
  }
});

test("bounds the request body", async () => {
  const surface = await boot();
  try {
    const response = await request(surface, "/api/heartbeat", {
      body: { pad: "x".repeat(5 * 1024 * 1024) },
    });
    assert.equal(response.status, 413);
  } finally {
    await surface.stop();
  }
});

test("app handler completes the session and the decision resolves after ack", async () => {
  const surface = await boot();
  try {
    const response = await request(surface, "/api/answer", { body: { value: 42 } });
    assert.equal(response.status, 200);
    const submitted = await /** @type {any} */ (response.json());
    assert.equal(submitted.ok, true);
    assert.ok(submitted.operationId, "the reply carries the operation id for ack");
    const ack = await request(surface, "/api/ack", { body: { operationId: submitted.operationId } });
    assert.equal(ack.status, 200);
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "completed");
    assert.equal(decision.app, "test-app");
    assert.deepEqual(decision.payload, { value: 42 });
  } finally {
    await surface.stop();
  }
});

test("cancel settles the decision and closes the session", async () => {
  const surface = await boot();
  try {
    const cancelled = await request(surface, "/api/cancel", { body: {} });
    assert.equal(cancelled.status, 200);
    const { operationId } = await /** @type {any} */ (cancelled.json());
    await request(surface, "/api/ack", { body: { operationId } });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "cancelled");
    const afterClose = await request(surface, "/api/answer", { body: { value: 1 } });
    assert.equal(afterClose.status, 409);
  } finally {
    await surface.stop();
  }
});

test("a second terminal decision is refused", async () => {
  const surface = await boot();
  try {
    await request(surface, "/api/answer", { body: { value: 1 } });
    const again = await request(surface, "/api/cancel", { body: {} });
    assert.equal(again.status, 409);
  } finally {
    await surface.stop();
  }
});

test("an expired lease times the session out without an ack", async () => {
  const surface = await boot({ leaseTimeoutMs: 120 });
  try {
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "timed_out");
  } finally {
    await surface.stop();
  }
});

test("heartbeat renews the lease", async () => {
  const surface = await boot({ leaseTimeoutMs: 250 });
  try {
    for (let round = 0; round < 4; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const beat = await request(surface, "/api/heartbeat", { body: {} });
      assert.equal(beat.status, 200);
    }
    const alive = await request(surface, "/api/state", { method: "GET" });
    assert.equal(alive.status, 200);
  } finally {
    await surface.stop();
  }
});

test("a missing ack finalizes after the ack timeout", async () => {
  const surface = await boot({ ackTimeoutMs: 100 });
  try {
    await request(surface, "/api/answer", { body: { value: 7 } });
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "completed");
  } finally {
    await surface.stop();
  }
});

test("interrupt settles the decision immediately", async () => {
  const surface = await boot();
  try {
    surface.interrupt("SIGINT");
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "interrupted");
    assert.match(decision.detail, /SIGINT/);
  } finally {
    await surface.stop();
  }
});

test("unknown routes 404 and schema violations 400", async () => {
  const surface = await boot();
  try {
    const missing = await request(surface, "/api/nothing", { body: {} });
    assert.equal(missing.status, 404);
    const badBody = await request(surface, "/api/answer", { body: { wrong: true } });
    assert.equal(badBody.status, 400);
  } finally {
    await surface.stop();
  }
});

test("a handler finishing after a timeout cannot report success", async () => {
  const surface = await startSurface({
    app: "test-app",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    leaseTimeoutMs: 250,
    api: {
      "POST /api/slow": async () => {
        await new Promise((resolve) => setTimeout(resolve, 900));
        return { status: 200, body: { ok: true } };
      },
    },
  });
  try {
    const response = await request(surface, "/api/slow", { body: {} });
    assert.equal(response.status, 409);
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "timed_out");
  } finally {
    await surface.stop();
  }
});

test("authorization, cookie, and Basic values are redacted", async () => {
  const { sanitizeValue, redactText } = await import("../src/sanitize.mjs");
  const clean = sanitizeValue({ authorization: "Basic YWRtaW46cGFzc3dvcmQ=", cookie: "sid=abc", authToken: "x" });
  assert.equal(clean.authorization, "[REDACTED]");
  assert.equal(clean.cookie, "[REDACTED]");
  assert.equal(clean.authToken, "[REDACTED]");
  assert.match(redactText("Basic YWRtaW46cGFzc3dvcmQ="), /Basic \[REDACTED\]/);
});

test("session.run refuses work after the session closes", async () => {
  let capturedSession;
  const surface = await boot({
    api: {
      "POST /api/grab": async ({ session }) => { capturedSession = session; return { status: 200, body: { ok: true } }; },
    },
  });
  try {
    await request(surface, "/api/grab", { body: {} });
    await request(surface, "/api/cancel", { body: {} });
    await assert.rejects(() => capturedSession.run(async () => "work"), /session is closed/);
  } finally {
    await surface.stop();
  }
});

test("a handler that completes and then throws still reports the completion", async () => {
  const surface = await boot({
    api: {
      "POST /api/boom": async ({ session }) => {
        session.complete({ fine: true });
        throw new Error("late failure");
      },
    },
  });
  try {
    const response = await request(surface, "/api/boom", { body: {} });
    assert.equal(response.status, 200);
    const body = await /** @type {any} */ (response.json());
    assert.equal(body.ok, true);
    assert.ok(body.operationId);
    const decision = await surface.waitForDecision();
    assert.equal(decision.status, "completed");
  } finally {
    await surface.stop();
  }
});

// Hold the end of every response to one route for a while: a barrier that
// makes "the response has not gone out yet" a fact the test controls, so an
// acknowledgement clock that started at the claim (wrong) settles the
// decision while the response is still held, and one that starts when the
// response goes out (right) cannot.
function holdResponseEnd(pathname, ms) {
  const original = ServerResponse.prototype.end;
  ServerResponse.prototype.end = function held(...args) {
    if (this.req?.url === pathname) {
      setTimeout(() => original.apply(this, args), ms);
      return this;
    }
    return original.apply(this, args);
  };
  return () => { ServerResponse.prototype.end = original; };
}

test("the caller learns of a completion only after the winning request has been answered", async () => {
  // The route completes, then keeps the browser waiting longer than the
  // acknowledgement timeout before it returns, and its answer is held a
  // while longer still. The clock must not start until that answer has gone
  // out: when the browser finally has its 200 and the operation id, the
  // decision has not settled; the acknowledgement settles it.
  const surface = await boot({
    ackTimeoutMs: 50,
    api: {
      "POST /api/slow": async ({ session }) => {
        session.complete({ value: 1 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        return null;
      },
    },
  });
  const release = holdResponseEnd("/api/slow", 250);
  try {
    let settled = false;
    const decided = surface.waitForDecision().then((decision) => { settled = true; return decision; });
    const answered = await request(surface, "/api/slow", { body: {} });
    assert.equal(answered.status, 200);
    const { operationId } = await /** @type {any} */ (answered.json());
    assert.equal(typeof operationId, "string", "the browser gets the operation id to acknowledge");
    assert.equal(settled, false, "the decision had not settled when the browser was answered: the clock starts after the answer, not at the claim");
    const ack = await request(surface, "/api/ack", { body: { operationId } });
    assert.equal(ack.status, 200, "the acknowledgement is accepted");
    const decision = await decided;
    assert.equal(decision.status, "completed");
  } finally {
    release();
    await surface.stop();
  }
});

test("a handler that completes and then never returns is answered at the claim, and the caller learns of the completion", { timeout: SURFACER_TEST_TIMEOUT_MS }, async () => {
  // Once the claim wins, the session and lease clocks are gone. The fixed
  // answer goes out at the claim itself, so the browser holds its 200 and the
  // operation id while the handler is still pending, its acknowledgement is
  // accepted, and the caller learns of the completion. The handler never
  // returning changes nothing.
  let handlerReturned = false;
  const surface = await boot({
    sessionTimeoutMs: 60,
    leaseTimeoutMs: 60,
    ackTimeoutMs: 1_000,
    api: {
      "POST /api/hang": async ({ session }) => {
        session.complete({ value: 1 });
        await new Promise(() => {});
        handlerReturned = true;
      },
    },
  });
  try {
    // The race bounds the whole answer — headers and body — so a regression
    // that writes headers and never ends the body fails here too.
    const { status, operationId } = await Promise.race([
      request(surface, "/api/hang", { body: {} }).then(async (response) => ({ status: response.status, ...(await /** @type {any} */ (response.json())) })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the browser was not answered at the claim")), SURFACER_HANG_GUARD_TIMEOUT_MS)),
    ]);
    assert.equal(status, 200, "the browser is answered at the claim while the handler remains pending");
    assert.equal(typeof operationId, "string");
    const ack = await request(surface, "/api/ack", { body: { operationId } });
    assert.equal(ack.status, 200, "the acknowledgement is accepted");
    const decision = await Promise.race([
      surface.waitForDecision(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the decision stayed pending after the acknowledgement")), ACKNOWLEDGEMENT_SETTLEMENT_MAX_MS)),
    ]);
    assert.equal(decision.status, "completed");
    assert.equal(handlerReturned, false, "the handler is still pending when the caller has the completion");
  } finally {
    await surface.stop();
  }
});

test("a client that vanishes while its completion answer is in flight starts the acknowledgement clock at the disconnect", { timeout: SURFACER_TEST_TIMEOUT_MS }, async () => {
  // The answer sent at the claim is held on the way out and the browser's
  // connection goes away meanwhile; the handler never returns. The hook
  // attached at the claim sees the response close and starts the clock
  // then, so the decision settles one acknowledgement window after the
  // disconnect — before the held answer would ever have finished.
  const ackTimeoutMs = 200;
  let claimed;
  const claimedPromise = new Promise((resolve) => { claimed = resolve; });
  const surface = await boot({
    ackTimeoutMs,
    api: {
      "POST /api/hang": async ({ session }) => {
        session.complete({ value: 1 });
        claimed();
        await new Promise(() => {});
      },
    },
  });
  const release = holdResponseEnd("/api/hang", 1_000);
  const controller = new AbortController();
  try {
    fetch(`${surface.origin}/api/hang`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenOf(surface)}`, "Content-Type": "application/json", Origin: surface.origin },
      body: "{}",
      signal: controller.signal,
    }).catch(() => null);
    await claimedPromise;
    const disconnectedAt = Date.now();
    controller.abort();
    const decision = await Promise.race([
      surface.waitForDecision(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the decision stayed pending after the client vanished")), SURFACER_HANG_GUARD_TIMEOUT_MS)),
    ]);
    const elapsed = Date.now() - disconnectedAt;
    assert.equal(decision.status, "completed");
    assert.ok(elapsed < DISCONNECT_SETTLEMENT_MAX_MS, `the clock started at the disconnect, not when the held answer finished (settled after ${elapsed}ms)`);
  } finally {
    release();
    await surface.stop();
  }
});

test("a cancel is answered before the caller learns of it, and its acknowledgement is accepted", async () => {
  // The cancel route claims the session; the clock that would settle the
  // decision without an acknowledgement must not start before the cancel
  // response, which carries the operation id, has gone out.
  const surface = await boot({ ackTimeoutMs: 50 });
  const release = holdResponseEnd("/api/cancel", 250);
  try {
    let settled = false;
    const decided = surface.waitForDecision().then((decision) => { settled = true; return decision; });
    const answered = await request(surface, "/api/cancel", { body: {} });
    assert.equal(answered.status, 200);
    const { operationId } = await /** @type {any} */ (answered.json());
    assert.equal(typeof operationId, "string");
    assert.equal(settled, false, "the decision had not settled when the cancel was answered");
    const ack = await request(surface, "/api/ack", { body: { operationId } });
    assert.equal(ack.status, 200, "the acknowledgement is accepted");
    const decision = await decided;
    assert.equal(decision.status, "cancelled");
  } finally {
    release();
    await surface.stop();
  }
});
