import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startSurface } from "../src/server.mjs";

// Static files are served before the bearer check. If an app could map an
// /api/ path as a static file, an unauthenticated loopback request would read
// it and the promise that every API request needs the token would be broken.
// Both halves of the guard are checked: the route map is refused at startup,
// and the request path decides /api/ before any static lookup.

const assetsDir = mkdtempSync(path.join(os.tmpdir(), "surfacer-api-guard-"));
writeFileSync(path.join(assetsDir, "index.html"), "<!doctype html><title>t</title>");
writeFileSync(path.join(assetsDir, "leak.json"), '{"secret":"do-not-serve"}');

test("a static route under /api/ is refused at startup", async () => {
  for (const route of ["/api/model", "/api", "/api/x/y"]) {
    await assert.rejects(
      () => startSurface({
        app: "guard",
        assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"], [route]: ["leak.json", "application/json"] } },
      }),
      (error) => error instanceof TypeError && /must not live under \/api\//.test(error.message),
      `${route} must be refused`,
    );
  }
});

test("an /api/ request never resolves to a static file, and an unknown /api/ path without a token is 401", async () => {
  const surface = await startSurface({
    app: "guard",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"], "/leak.json": ["leak.json", "application/json"] } },
    api: { "GET /api/state": async () => ({ status: 200, body: { fine: true } }) },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    // The static file is reachable on its own path, as designed.
    assert.equal((await fetch(`${surface.origin}/leak.json`)).status, 200);
    // Any /api/ path without the token is 401, including one that names a
    // static file's basename or an undeclared route.
    assert.equal((await fetch(`${surface.origin}/api/leak.json`)).status, 401);
    assert.equal((await fetch(`${surface.origin}/api/state`)).status, 401);
    assert.equal((await fetch(`${surface.origin}/api/whatever`)).status, 401);
  } finally {
    await surface.stop();
  }
});

test("the static route map and directory are copied at startup: mutating the caller's objects afterwards changes nothing served", async () => {
  const files = { "/": ["index.html", "text/html; charset=utf-8"], "/leak.json": ["leak.json", "application/json"] };
  const assets = { directory: assetsDir, files };
  const surface = await startSurface({ app: "guard", assets, sessionTimeoutMs: 10_000, leaseTimeoutMs: 10_000 });
  try {
    assert.equal((await fetch(`${surface.origin}/leak.json`)).status, 200);
    // The caller rewrites its tuple to a path outside the directory, and the
    // directory itself to the repository root: the validated copies serve.
    files["/leak.json"][0] = "../package.json";
    files["/"][0] = "../../package.json";
    assets.directory = path.join(assetsDir, "..", "..");
    const leak = await fetch(`${surface.origin}/leak.json`);
    assert.equal(leak.status, 200);
    assert.equal(await leak.text(), '{"secret":"do-not-serve"}', "the file validated at startup, not the rewritten tuple");
    const root = await fetch(`${surface.origin}/`);
    assert.match(await root.text(), /<title>t<\/title>/, "the root route still serves the validated index");
  } finally {
    await surface.stop();
  }
});

test("an app handler's outcome is read exactly once: a body getter cannot hand the snapshot one value and the reply another", async () => {
  let reads = 0;
  const surface = await startSurface({
    app: "guard",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "GET /api/flip": async () => ({ status: 200, get body() { reads += 1; return reads === 1 ? new Map([["k", 1]]) : undefined; } }),
      "GET /api/plain": async () => ({ status: 200, body: { fine: true, list: [1, "two"] } }),
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const token = surface.url.split("#")[1];
    const headers = { Authorization: `Bearer ${token}`, Origin: surface.origin };
    const flipped = await fetch(`${surface.origin}/api/flip`, { headers });
    assert.equal(reads, 1, "the body was read once");
    assert.equal(flipped.status, 400, "a Map is not a reply the transport can carry: refused, not written as {}");
    assert.match((await /** @type {any} */ (flipped.json())).error, /JSON cannot carry \[object Map\]/);
    const plain = await fetch(`${surface.origin}/api/plain`, { headers });
    assert.equal(plain.status, 200);
    assert.deepEqual(await /** @type {any} */ (plain.json()), { fine: true, list: [1, "two"] });
  } finally {
    surface.interrupt();
    await surface.waitForDecision();
    await surface.stop();
  }
});

test("a handler that returns body null gets the JSON null it asked for; one that returns no body gets { ok: true }", async () => {
  const surface = await startSurface({
    app: "guard",
    assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } },
    api: {
      "GET /api/nothing": async () => ({ status: 200, body: null }),
      "GET /api/unsaid": async () => ({ status: 202 }),
    },
    sessionTimeoutMs: 10_000,
    leaseTimeoutMs: 10_000,
  });
  try {
    const token = surface.url.split("#")[1];
    const headers = { Authorization: `Bearer ${token}`, Origin: surface.origin };
    const nothing = await fetch(`${surface.origin}/api/nothing`, { headers });
    assert.equal(nothing.status, 200);
    assert.equal(await nothing.text(), "null");
    const unsaid = await fetch(`${surface.origin}/api/unsaid`, { headers });
    assert.equal(unsaid.status, 202);
    assert.deepEqual(await /** @type {any} */ (unsaid.json()), { ok: true });
  } finally {
    surface.interrupt();
    await surface.waitForDecision();
    await surface.stop();
  }
});

test("the launch URL redirects once to the page URL and carries no token itself; a second use, and an unknown code, are 404", async () => {
  const surface = await startSurface({ app: "guard", assets: { directory: assetsDir, files: { "/": ["index.html", "text/html; charset=utf-8"] } }, sessionTimeoutMs: 10_000, leaseTimeoutMs: 10_000 });
  try {
    const token = surface.url.split("#")[1];
    assert.doesNotMatch(surface.launchUrl, new RegExp(token), "the launch URL carries no token");
    assert.match(surface.launchUrl, /^http:\/\/127\.0\.0\.1:\d+\/launch\/[A-Za-z0-9_-]{40,}$/);
    const first = await fetch(surface.launchUrl, { redirect: "manual" });
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), `/#${token}`, "one redirect to the page URL, fragment and all");
    assert.equal(first.headers.get("cache-control"), "no-store");
    const second = await fetch(surface.launchUrl, { redirect: "manual" });
    assert.equal(second.status, 404, "single use");
    const unknown = await fetch(`${surface.origin}/launch/${"x".repeat(43)}`, { redirect: "manual" });
    assert.equal(unknown.status, 404);
  } finally {
    surface.interrupt();
    await surface.waitForDecision();
    await surface.stop();
  }
});
