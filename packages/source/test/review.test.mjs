import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { normalizeAnnotations, reviewDiff } from "../src/review.mjs";
import { parseUnifiedDiff } from "../src/diff.mjs";

const DIFF = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

const CLIENT_KIT = "export function createSurfaceClient(){return{};}\n";

test("reviewDiff needs both injected dependencies", async () => {
  await assert.rejects(() => reviewDiff({ diffText: DIFF, clientKitSource: CLIENT_KIT }), /launchSurface/);
  await assert.rejects(() => reviewDiff({ diffText: DIFF, launchSurface: () => {} }), /client-kit/);
});

test("reviewDiff builds the surface, returns validated annotations, and cleans up", async () => {
  let capturedDir;
  let capturedVerbatim;
  const submitted = [
    { path: "a.txt", side: "new", line: 2, body: "token=abc123 keep this verbatim" }, // valid
    { path: "a.txt", side: "old", line: 2, body: "comment on the removed line" }, // valid
    { path: "nope.txt", side: "new", line: 1, body: "wrong file" }, // dropped
    { path: "a.txt", side: "middle", line: 1, body: "bad side" }, // dropped
    { path: "a.txt", side: "new", line: 99, body: "line not in diff" }, // dropped
    { path: "a.txt", side: "new", line: 1, body: "   " }, // dropped (empty)
  ];

  const launchSurface = async ({ app, assets, api, open }) => {
    assert.equal(app, "review");
    assert.equal(open, false);
    capturedDir = assets.directory;
    // The static shell and reused client kit are all present and named plainly.
    assert.deepEqual(Object.keys(assets.files).sort(), ["/", "/app.css", "/app.js", "/file-tree.mjs", "/highlight.css", "/icons.mjs", "/nav-segments.mjs", "/surface-client.mjs"]);
    const html = readFileSync(path.join(assets.directory, "index.html"), "utf8");
    // The diff never rides the pre-auth static shell; it is served verbatim
    // from the authenticated model endpoint.
    assert.doesNotMatch(html, /TWO/);
    const modelResponse = await api["GET /api/model"]({ body: null, session: {} });
    assert.equal(modelResponse.verbatim, true, "the diff must not pass through redaction");
    assert.equal(modelResponse.body.model.files[0].path, "a.txt");
    assert.equal(modelResponse.body.meta.label, "working tree");
    assert.equal(readFileSync(path.join(assets.directory, "surface-client.mjs"), "utf8"), CLIENT_KIT);
    assert.ok(existsSync(path.join(assets.directory, "app.js")));

    // Simulate the browser returning annotations.
    let payload;
    const session = {
      complete(value, options) { payload = value; capturedVerbatim = options?.verbatim; },
    };
    const result = await api["POST /api/submit"]({ body: { annotations: submitted }, session });
    assert.equal(result, null);
    return { result: { status: "completed", payload } };
  };

  const outcome = await reviewDiff({
    diffText: DIFF,
    app: "review",
    launchSurface,
    clientKitSource: CLIENT_KIT,
    open: false,
  });

  assert.equal(outcome.status, "completed");
  assert.equal(capturedVerbatim, true, "annotations must complete verbatim so quoted code survives");
  assert.equal(outcome.annotations.length, 2);
  assert.deepEqual(outcome.annotations[0], { path: "a.txt", side: "new", line: 2, body: "token=abc123 keep this verbatim" });
  assert.equal(outcome.meta.label, "working tree");
  assert.equal(outcome.meta.fileCount, 1);
  // The temp asset directory is removed after the session.
  assert.ok(capturedDir && !existsSync(capturedDir), "the temp directory must be cleaned up");
});

test("reviewDiff forwards a ready callback to the surface port", async () => {
  let received;
  const marker = () => {};
  const launchSurface = async ({ ready }) => { received = ready; return { result: { status: "cancelled" } }; };
  await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false, ready: marker });
  assert.equal(received, marker);
});

test("a cancelled surface returns no annotations", async () => {
  const launchSurface = async () => ({ result: { status: "cancelled" } });
  const outcome = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false });
  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(outcome.annotations, []);
});

test("normalizeAnnotations enforces anchors, bodies, and a count cap", () => {
  const model = parseUnifiedDiff(DIFF);
  assert.deepEqual(normalizeAnnotations("not an array", model), []);
  assert.equal(normalizeAnnotations([{ path: "a.txt", side: "new", line: 2, body: "x".repeat(9000) }], model)[0].body.length, 4000);
  const many = Array.from({ length: 600 }, () => ({ path: "a.txt", side: "new", line: 1, body: "ok" }));
  assert.equal(normalizeAnnotations(many, model).length, 500);
});
