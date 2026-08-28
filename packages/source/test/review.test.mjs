import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeDiff } from "../src/git.mjs";
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
    // Every static file is the same for every review: the highlight rules,
    // which depend on the review's tokens, are not among them.
    assert.deepEqual(Object.keys(assets.files).sort(), ["/", "/app.css", "/app.js", "/file-tree.mjs", "/icons.mjs", "/nav-segments.mjs", "/surface-client.mjs"]);
    assert.ok(!existsSync(path.join(assets.directory, "highlight.css")), "no highlight.css on disk in the served directory");
    const html = readFileSync(path.join(assets.directory, "index.html"), "utf8");
    // The diff never rides the pre-auth static shell; it is served verbatim
    // from the authenticated model endpoint.
    assert.doesNotMatch(html, /TWO/);
    const modelResponse = await api["GET /api/model"]({ body: null, session: {} });
    assert.equal(modelResponse.verbatim, true, "the diff must not pass through redaction");
    assert.equal(modelResponse.body.model.files[0].path, "a.txt");
    assert.equal(modelResponse.body.meta.label, "working tree");
    assert.match(modelResponse.body.highlightCss, /^\/\* shiki /, "the highlight rules ride the authenticated model");
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

test("an unknown, contradictory, or runtime-only decision is refused by the submit route, never coerced, and the session stays open", async () => {
  const launchSurface = async ({ api }) => {
    let completed = false;
    const session = { complete() { completed = true; } };
    for (const body of [
      { decision: "lgtm", annotations: [] },
      { decision: "cancelled", annotations: [] },
      { decision: "timed-out", annotations: [] },
      { decision: "changes-requested", annotations: [] },
      { decision: "approved", annotations: [{ anchor: { target: "a.txt", side: "new", position: 1 }, body: "fix" }] },
    ]) {
      const answer = await api["POST /api/submit"]({ body, session });
      assert.equal(answer?.status, 400, JSON.stringify(body));
    }
    assert.equal(completed, false, "no refused submission completes the session");
    return { result: { status: "cancelled" } };
  };
  const outcome = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false });
  assert.equal(outcome.status, "cancelled");
  assert.deepEqual(outcome.annotations, []);
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

test("the static shell names nothing under review; the ref is behind the token", async () => {
  // Static files are served before the bearer check. The ref under review is
  // part of the token-gated subject, so it must not ride the shell's title.
  let html;
  let modelResponse;
  const launchSurface = async ({ assets, api }) => {
    html = readFileSync(path.join(assets.directory, "index.html"), "utf8");
    modelResponse = await api["GET /api/model"]({ body: null, session: {} });
    return { result: { status: "cancelled" } };
  };
  await reviewDiff({ diffText: DIFF, mode: "range", range: "customer-secret..HEAD", launchSurface, clientKitSource: CLIENT_KIT, open: false });
  assert.doesNotMatch(html, /customer-secret/, "the shell must not name the ref");
  assert.match(html, /<title>Review<\/title>/);
  assert.equal(modelResponse.body.meta.label, "range customer-secret..HEAD", "the label rides the authenticated model");
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
  // contract's own validator: no gate means gateId null and a null callback;
  // the subject is the reviewed ref plus the URL the page fetches the diff
  // from; the transport is the browser pane.
  const meta = { mode: "worktree", range: null, label: "working tree" };
  const request = buildSurfaceRequest({ model, meta });
  assert.deepEqual(request.kind, { family: "output", renderer: "review" });
  assert.deepEqual(request.subject, { ref: "worktree", fetch: "/api/model" });
  assert.equal(request.transport, "browser");
  assert.equal(request.anchors.length, 6);
  assert.equal(request.gateId, null);
  assert.deepEqual(request.callback, { address: null, token: null });
  assert.equal(isSurfaceRequest(request), true);
  assert.deepEqual(buildSurfaceRequest({ model, meta: { mode: "range", range: "main..HEAD", label: "range main..HEAD" } }).subject, { ref: "main..HEAD", fetch: "/api/model" });
  // A gate-launched request carries the gate's id and callback.
  const gated = buildSurfaceRequest({ model, meta, gate: { gateId: "gate-1", callback: { address: "http://127.0.0.1:9/cb", token: "t" } } });
  assert.equal(gated.gateId, "gate-1");
  assert.deepEqual(gated.callback, { address: "http://127.0.0.1:9/cb", token: "t" });
  assert.equal(isSurfaceRequest(gated), true);
  // A malformed gate option fails before a surface opens: the id and the
  // callback come as a pair, all present and non-empty strings.
  const bad = (gate) => assert.throws(() => buildSurfaceRequest({ model, meta, gate }), TypeError);
  bad({ gateId: "" });
  bad({ gateId: "g" });
  bad({ gateId: "g", callback: {} });
  bad({ gateId: "g", callback: { address: "http://127.0.0.1:9/cb" } });
  bad({ gateId: "g", callback: { address: 8080, token: "t" } });
  bad({ gateId: "g", callback: { address: "http://127.0.0.1:9/cb", token: { v: 1 } } });
  bad({ gateId: null, callback: { address: "http://127.0.0.1:9/cb", token: "t" } });
  bad({ gateId: "   ", callback: { address: "http://127.0.0.1:9/cb", token: "t" } });
  bad({ gateId: "g", callback: { address: " ", token: "t" } });
  bad("gate-1");
});

test("a session that ends without the reviewer returning still yields a routable SurfaceResult", async () => {
  // The runtime hands the app's terminalPayload back as the framed payload
  // for a cancelled or timed-out session; reviewDiff must supply one that
  // keeps the surface and gate ids and states the decision.
  for (const [status, decision] of [["cancelled", "cancelled"], ["timed_out", "timed-out"], ["interrupted", "cancelled"]]) {
    const launchSurface = async ({ terminalPayload }) => ({ result: { status, payload: terminalPayload(status) } });
    const gate = { gateId: "gate-9", callback: { address: "http://127.0.0.1:9/cb", token: "t" } };
    const outcome = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false, gate });
    assert.equal(outcome.status, status);
    assert.equal(typeof outcome.result.surfaceId, "string");
    assert.equal(outcome.result.gateId, "gate-9");
    assert.equal(outcome.result.decision, decision);
    assert.deepEqual(outcome.result.annotations, []);
    assert.equal(outcome.result.meta.label, "working tree");
  }
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
  await assert.rejects(() => reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false, gate: { gateId: 7 } }), /non-empty string gateId/);
  await assert.rejects(() => reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false, gate: { gateId: "g", callback: {} } }), /non-empty string address and token/);
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

test("a supplied diff reads nothing from the repository — not the root, not the diff, not the tracked files — and gets an empty tree list", async () => {
  const calls = [];
  const git = {
    repositoryRoot: async () => { calls.push("repositoryRoot"); return "/nowhere"; },
    computeDiff: async () => { calls.push("computeDiff"); return { diffText: DIFF, mode: "worktree", range: null }; },
    listTrackedFiles: async () => { calls.push("listTrackedFiles"); return ["a.js"]; },
  };
  const launchSurface = async ({ api }) => {
    const { body } = await api["GET /api/model"]();
    return { status: "completed", result: { decision: "approved", annotations: [] }, meta: body.meta };
  };
  const outcome = await reviewDiff({ diffText: DIFF, launchSurface, clientKitSource: CLIENT_KIT, open: false, git });
  assert.deepEqual(calls, [], "no repository read for a supplied diff");
  assert.deepEqual(outcome.meta.allFiles, [], "the tree lists only the diff");
});

test("a computed review takes its tracked-file list inside the capture window, from the range's end for a range", async () => {
  const calls = [];
  const git = {
    repositoryRoot: async () => "/repo",
    computeDiff: async () => { calls.push("computeDiff"); return { diffText: DIFF, mode: "range", range: "a..b" }; },
    listTrackedFiles: async ({ ref }) => { calls.push(`listTrackedFiles:${ref}`); return ["listed.js"]; },
  };
  const launchSurface = async ({ api }) => ({ status: "completed", result: { decision: "approved", annotations: [] }, meta: (await api["GET /api/model"]()).body.meta });
  const outcome = await reviewDiff({ mode: "range", range: "a..b", cwd: "/repo", launchSurface, clientKitSource: CLIENT_KIT, open: false, git });
  assert.deepEqual(calls, ["computeDiff", "listTrackedFiles:b", "computeDiff", "listTrackedFiles:b"], "the list is read inside each of the two passes, at the range's end");
  assert.deepEqual(outcome.meta.allFiles, ["listed.js"]);
});

test("a change made after the first diff and undone before the second is caught by the file reads, and the review carries the settled content", async () => {
  // Codex's probe: the diff is taken at state A, the file changes to B before
  // the context is read, and A is restored before the diff is taken again.
  // The two diffs agree, so a diff-only recheck accepted a review whose
  // context came from B. The whole capture is now taken twice: the first
  // pass read B, the second reads A, the fingerprints differ, and the capture
  // is retried until two passes agree — on A.
  const dir = mkdtempSync(path.join(os.tmpdir(), "source-aba-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const lines = (last) => ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", last].join("\n") + "\n";
  const committed = lines("ten");
  const stateA = committed.replace("two", "TWO");
  const stateB = stateA.replace("ten", "B-MARK");
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(dir, "a.txt"), committed);
    git("add", "a.txt");
    git("commit", "-q", "-m", "base");
    writeFileSync(path.join(dir, "a.txt"), stateA);
    let diffs = 0;
    const port = {
      repositoryRoot: async () => dir,
      computeDiff: async (options) => {
        diffs += 1;
        // The first diff sees A, then the file flips to B for the reads; the
        // second diff sees A again. Later passes see A throughout.
        writeFileSync(path.join(dir, "a.txt"), stateA);
        const result = await computeDiff(options);
        if (diffs === 1) writeFileSync(path.join(dir, "a.txt"), stateB);
        return result;
      },
      listTrackedFiles: async () => ["a.txt"],
    };
    let model;
    const launchSurface = async ({ api }) => {
      model = (await api["GET /api/model"]()).body.model;
      return { status: "completed", result: { decision: "approved", annotations: [] } };
    };
    await reviewDiff({ cwd: dir, launchSurface, clientKitSource: CLIENT_KIT, open: false, git: port });
    const after = model.files[0].contextAfter.map((entry) => entry.text);
    assert.ok(after.includes("ten"), "the context carries the state both passes agreed on");
    assert.ok(!after.includes("B-MARK"), "the context from the undone change never reaches the review");
    assert.equal(diffs, 4, "the first pair of passes disagreed; the second pair agreed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository that keeps changing under the capture is refused after three attempts", async () => {
  let n = 0;
  const git = {
    repositoryRoot: async () => "/repo",
    computeDiff: async () => ({ diffText: `${DIFF}\n// state ${n += 1}\n`, mode: "worktree", range: null }),
    listTrackedFiles: async () => [],
  };
  await assert.rejects(
    () => reviewDiff({ cwd: "/repo", launchSurface: async () => ({ status: "completed" }), clientKitSource: CLIENT_KIT, open: false, git }),
    /changed while the review was being captured/,
  );
  assert.equal(n, 6, "three attempts, two diffs each");
});
