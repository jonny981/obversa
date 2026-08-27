import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ASSETS_DIR, buildIndexHtml } from "../src/page.mjs";

test("the shell links the static assets and carries no diff content", () => {
  const html = buildIndexHtml({ meta: { label: "working tree", fileCount: 0, mode: "worktree", range: null } });
  assert.match(html, /<title>Review: working tree<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
  assert.match(html, /<link rel="stylesheet" href="\/highlight\.css">/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  // The only script tag is the app module; the model is fetched behind the
  // bearer token, never embedded where a pre-auth static read could see it.
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.doesNotMatch(html, /review-data/);
});

test("a hostile review label cannot break out of the title", () => {
  const html = buildIndexHtml({ meta: { label: "</title><script>alert(1)</script>" } });
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;/);
});

test("ASSETS_DIR holds the served browser files", () => {
  assert.ok(existsSync(path.join(ASSETS_DIR, "app.js")));
  assert.ok(existsSync(path.join(ASSETS_DIR, "app.css")));
});
