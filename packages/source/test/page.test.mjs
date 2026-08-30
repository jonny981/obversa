import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ASSETS_DIR, buildIndexHtml } from "../src/page.mjs";

test("the shell links the static assets and carries nothing about the review", () => {
  const html = buildIndexHtml();
  // The shell is served before the bearer check, so it names neither the diff
  // nor the ref under review; the title is a constant and the label arrives
  // with the authenticated model.
  assert.match(html, /<title>Review<\/title>/);
  assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
  // The highlight rules are built from the review's own tokens, so they ride
  // the authenticated model, never a pre-auth static file.
  assert.doesNotMatch(html, /highlight\.css/);
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  // The only script tag is the app module; the model is fetched behind the
  // bearer token, never embedded where a pre-auth static read could see it.
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.doesNotMatch(html, /review-data/);
  // The shell is the same for every review: nothing a caller passes reaches it.
  assert.equal(/** @type {any} */ (buildIndexHtml)({ meta: { label: "customer-secret..HEAD" } }), html);
});

test("ASSETS_DIR holds the served browser files", () => {
  assert.ok(existsSync(path.join(ASSETS_DIR, "app.js")));
  assert.ok(existsSync(path.join(ASSETS_DIR, "app.css")));
});
