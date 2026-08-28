import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
