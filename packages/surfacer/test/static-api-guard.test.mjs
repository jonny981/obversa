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
