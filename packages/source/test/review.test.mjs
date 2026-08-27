import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildSurfaceRequest, outputAnchors, reviewDiff } from "../src/review.mjs";
import { isSurfaceRequest, MAX_ANNOTATIONS, MAX_BODY } from "../src/contract.mjs";
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

test("reviewDiff builds the surface, returns a validated SurfaceResult, and cleans up", async () => {
  let capturedDir;
  let capturedVerbatim;
  const at = (side, position) => ({ target: "a.txt", side, position });
  const submitted = [
    { anchor: at("new", 2), body: "token=abc123 keep this verbatim", createdAt: "2026-08-28T00:00:00Z" }, // valid
    { anchor: at("old", 2), body: "comment on the removed line" }, // valid
    { anchor: { target: "nope.txt", side: "new", position: 1 }, body: "wrong file" }, // dropped
    { anchor: at("middle", 1), body: "bad side" }, // dropped
    { anchor: at("new", 99), body: "line not in diff" }, // dropped
    { anchor: at("new", 1), body: "   " }, // dropped (empty)
    { path: "a.txt", side: "new", line: 1, body: "old flat shape, no anchor" }, // dropped
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

    // Simulate the browser returning contract-shaped annotations and a decision.
    let payload;
    const session = {
      complete(value, options) { payload = value; capturedVerbatim = options?.verbatim; },
    };
    const result = await api["POST /api/submit"]({ body: { decision: "changes-requested", annotations: submitted }, session });
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
  assert.equal(capturedVerbatim, true, "the result must complete verbatim so quoted code survives");
  // The payload is the SurfaceResult: routed by surfaceId/gateId, carrying the
  // decision and only the annotations that pin to an offered anchor.
  const { result } = outcome;
  assert.equal(typeof result.surfaceId, "string");
  assert.equal(result.gateId, null);
  assert.equal(result.decision, "changes-requested");
  assert.equal(result.annotations.length, 2);
  assert.deepEqual(result.annotations[0], {
    anchor: { target: "a.txt", position: 2, side: "new" },
    body: "token=abc123 keep this verbatim",
    author: { kind: "human", id: "reviewer" },
    createdAt: "2026-08-28T00:00:00Z",
  });
  assert.deepEqual(result.annotations[1].anchor, { target: "a.txt", position: 2, side: "old" });
  assert.equal(outcome.annotations, result.annotations);
  assert.equal(result.meta.label, "working tree");
  assert.equal(outcome.meta.fileCount, 1);
  // The temp asset directory is removed after the session.
  assert.ok(capturedDir && !existsSync(capturedDir), "the temp directory must be cleaned up");
});

test("an unknown decision never becomes an approval", async () => {
  const launchSurface = async ({ api }) => {
    let payload;
    await api["POST /api/submit"]({ body: { decision: "lgtm", annotations: [] }, session: { complete(value) { payload = value; } } });
    return { result: { status: "completed", payload } };
  };
  const outcome = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false });
  assert.equal(outcome.result.decision, "cancelled");
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

test("outputAnchors offers every visible line and side; the request is contract-shaped", () => {
  const model = parseUnifiedDiff(DIFF);
  const anchors = outputAnchors(model);
  // " one" (old 1 / new 1), "-two" (old 2), "+TWO" (new 2), " three" (old 3 / new 3).
  assert.deepEqual(anchors, [
    { target: "a.txt", side: "old", position: 1 },
    { target: "a.txt", side: "new", position: 1 },
    { target: "a.txt", side: "old", position: 2 },
    { target: "a.txt", side: "new", position: 2 },
    { target: "a.txt", side: "old", position: 3 },
    { target: "a.txt", side: "new", position: 3 },
  ]);
  // The direct request, exactly as the live review builds it, is valid by the
  // contract's own validator: no gate means gateId null and a null callback.
  const request = buildSurfaceRequest({ model, label: "working tree" });
  assert.equal(request.kind.family, "output");
  assert.equal(request.subject, "working tree");
  assert.equal(request.anchors.length, 6);
  assert.equal(request.gateId, null);
  assert.deepEqual(request.callback, { address: null, token: null });
  assert.equal(isSurfaceRequest(request), true);
  // A gate-launched request carries the gate's id and callback.
  const gated = buildSurfaceRequest({ model, label: "working tree", gate: { gateId: "gate-1", callback: { address: "http://127.0.0.1:9/cb", token: "t" } } });
  assert.equal(gated.gateId, "gate-1");
  assert.deepEqual(gated.callback, { address: "http://127.0.0.1:9/cb", token: "t" });
  assert.equal(isSurfaceRequest(gated), true);
  // A malformed gate option fails before a surface opens.
  assert.throws(() => buildSurfaceRequest({ model, label: "x", gate: { gateId: "" } }), /gateId must be a non-empty string/);
  assert.throws(() => buildSurfaceRequest({ model, label: "x", gate: { gateId: "g" } }), /callback must be an object/);
});

test("a gate's id flows through reviewDiff onto the result", async () => {
  const launchSurface = async ({ api }) => {
    let payload;
    await api["POST /api/submit"]({ body: { decision: "approved", annotations: [] }, session: { complete(value) { payload = value; } } });
    return { result: { status: "completed", payload } };
  };
  const gate = { gateId: "gate-42", callback: { address: "http://127.0.0.1:9/cb", token: "secret" } };
  const outcome = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false, gate });
  assert.equal(outcome.result.gateId, "gate-42");
  assert.equal(outcome.result.decision, "approved");
  // The direct path carries no gate.
  const direct = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false });
  assert.equal(direct.result.gateId, null);
  // A bad gate option is refused before anything opens.
  await assert.rejects(() => reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false, gate: { gateId: 7 } }), /gateId must be a non-empty string/);
});

test("the submit handler bounds bodies and counts through the contract", async () => {
  const launchSurface = async ({ api }) => {
    let payload;
    const session = { complete(value) { payload = value; } };
    const many = Array.from({ length: MAX_ANNOTATIONS + 100 }, () => ({ anchor: { target: "a.txt", side: "new", position: 1 }, body: "x".repeat(MAX_BODY + 5000) }));
    await api["POST /api/submit"]({ body: { decision: "changes-requested", annotations: many }, session });
    return { result: { status: "completed", payload } };
  };
  const outcome = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false });
  assert.equal(outcome.result.annotations.length, MAX_ANNOTATIONS);
  assert.equal(outcome.result.annotations[0].body.length, MAX_BODY);
});
