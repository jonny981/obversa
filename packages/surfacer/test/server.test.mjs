import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startSurface, assertExactKeys } from "../src/server.mjs";

const assetsDir = mkdtempSync(path.join(os.tmpdir(), "surfacer-assets-"));
writeFileSync(path.join(assetsDir, "index.html"), "<!doctype html><title>t</title>");

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
    const submitted = await response.json();
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
    const { operationId } = await cancelled.json();
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
