import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ASSETS_DIR, buildIndexHtml, escapeJsonForHtml } from "../src/page.mjs";

test("the shell carries the model and links the static assets", () => {
  const html = buildIndexHtml({
    model: { files: [] },
    meta: { label: "working tree", fileCount: 0, mode: "worktree", range: null },
  });
  assert.match(html, /<title>Review: working tree<\/title>/);
  assert.match(html, /id="review-data"/);
  assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
});

test("escapeJsonForHtml neutralises a script breakout and round-trips", () => {
  const value = { code: "</script><img src=x onerror=alert(1)>", amp: "a & b < c > d" };
  const escaped = escapeJsonForHtml(value);
  assert.ok(!escaped.includes("</script"), "must not contain a raw closing script tag");
  assert.ok(!escaped.includes("<"), "must not contain a raw '<'");
  assert.deepEqual(JSON.parse(escaped), value);
});

test("a diff line that looks like a script tag stays inert in the shell", () => {
  const model = { files: [{ path: "x.html", status: "modified", binary: false, hunks: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "", lines: [
      { type: "add", oldNumber: null, newNumber: 1, text: "</script><script>alert(1)</script>" },
    ] },
  ] }] };
  const html = buildIndexHtml({ model, meta: { label: "working tree", fileCount: 1 } });
  // The only real script tags are the data block and the app module.
  const scriptOpens = html.match(/<script/g) || [];
  assert.equal(scriptOpens.length, 2);
});

test("ASSETS_DIR holds the served browser files", () => {
  assert.ok(existsSync(path.join(ASSETS_DIR, "app.js")));
  assert.ok(existsSync(path.join(ASSETS_DIR, "app.css")));
});
