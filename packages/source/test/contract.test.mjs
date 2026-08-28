import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anchorKey,
  buildAnchorSet,
  validateAnnotation,
  normalizeResult,
  isSurfaceRequest,
  FAMILIES,
  DECISIONS,
  MAX_ANNOTATIONS,
  MAX_BODY,
  MAX_THREAD,
} from "../src/contract.mjs";

const outputAnchor = (line, side = "new") => ({ target: "src/app.js", side, position: line });

function makeRequest(anchors) {
  return {
    surfaceId: "s1",
    gateId: "g1",
    callback: { address: "cb://x", token: "t" },
    kind: { family: "output", renderer: "diff" },
    subject: { ref: "worktree", fetch: "/api/model" },
    anchors,
    transport: "terminal",
  };
}

test("anchorKey is stable and distinct across target, side and position", () => {
  assert.equal(anchorKey(outputAnchor(12)), anchorKey({ ...outputAnchor(12) }));
  assert.notEqual(anchorKey(outputAnchor(12, "new")), anchorKey(outputAnchor(12, "old")));
  assert.notEqual(anchorKey(outputAnchor(12)), anchorKey(outputAnchor(13)));
  assert.notEqual(anchorKey({ target: "a", position: 1 }), anchorKey({ target: "b", position: 1 }));
});

test("anchorKey handles a non-scalar position and rejects invalid anchors", () => {
  const region = { target: "shot.png", position: { x: 1, y: 2 } };
  assert.equal(anchorKey(region), anchorKey({ target: "shot.png", position: { x: 1, y: 2 } }));
  assert.equal(anchorKey(null), null);
  assert.equal(anchorKey({ target: 5, position: 1 }), null);
  assert.equal(anchorKey({ target: "a" }), null);
});

test("buildAnchorSet collects valid keys and skips invalid ones", () => {
  const set = buildAnchorSet([outputAnchor(1), outputAnchor(2), { bad: true }, null]);
  assert.equal(set.size, 2);
  assert.ok(set.has(anchorKey(outputAnchor(1))));
});

test("validateAnnotation accepts an in-set anchor, trims the body, defaults the author", () => {
  const set = buildAnchorSet([outputAnchor(12)]);
  const clean = validateAnnotation({ anchor: outputAnchor(12), body: "  looks off  " }, set);
  assert.equal(clean.body, "looks off");
  assert.deepEqual(clean.author, { kind: "human", id: "reviewer" });
  assert.deepEqual(clean.anchor, { target: "src/app.js", position: 12, side: "new" });
  assert.equal(clean.createdAt, null);
});

test("validateAnnotation rejects an anchor that was never shown (anti-forgery)", () => {
  const set = buildAnchorSet([outputAnchor(12)]);
  assert.equal(validateAnnotation({ anchor: outputAnchor(999), body: "x" }, set), null);
});

test("validateAnnotation rejects an empty or whitespace body", () => {
  const set = buildAnchorSet([outputAnchor(12)]);
  assert.equal(validateAnnotation({ anchor: outputAnchor(12), body: "   " }, set), null);
  assert.equal(validateAnnotation({ anchor: outputAnchor(12), body: 5 }, set), null);
});

test("validateAnnotation caps the body length", () => {
  const set = buildAnchorSet([outputAnchor(12)]);
  const clean = validateAnnotation({ anchor: outputAnchor(12), body: "x".repeat(MAX_BODY + 50) }, set);
  assert.equal(clean.body.length, MAX_BODY);
});

test("validateAnnotation preserves a valid author and createdAt", () => {
  const set = buildAnchorSet([outputAnchor(12)]);
  const clean = validateAnnotation(
    { anchor: outputAnchor(12), body: "x", author: { kind: "agent", id: "grok" }, createdAt: "2026-08-26T18:00Z" },
    set,
  );
  assert.deepEqual(clean.author, { kind: "agent", id: "grok" });
  assert.equal(clean.createdAt, "2026-08-26T18:00Z");
});

test("validateAnnotation falls back to the default author on an invalid kind", () => {
  const set = buildAnchorSet([outputAnchor(12)]);
  const clean = validateAnnotation({ anchor: outputAnchor(12), body: "x", author: { kind: "robot", id: "z" } }, set);
  assert.deepEqual(clean.author, { kind: "human", id: "reviewer" });
});

test("validateAnnotation keeps a bounded, cleaned thread", () => {
  const set = buildAnchorSet([outputAnchor(12)]);
  const thread = Array.from({ length: MAX_THREAD + 10 }, (_, i) => ({
    author: { kind: "human", id: "r" },
    body: `c${i}`,
  }));
  thread.push({ author: { kind: "human", id: "r" }, body: "   " }); // dropped: empty
  const clean = validateAnnotation({ anchor: outputAnchor(12), body: "x", thread }, set);
  assert.equal(clean.thread.length, MAX_THREAD);
});

test("normalizeResult validates every annotation against the request anchors", () => {
  const request = makeRequest([outputAnchor(1), outputAnchor(2)]);
  const result = normalizeResult(
    {
      decision: "changes-requested",
      annotations: [
        { anchor: outputAnchor(1), body: "real" },
        { anchor: outputAnchor(99), body: "fabricated" },
      ],
    },
    request,
  );
  assert.equal(result.decision, "changes-requested");
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].body, "real");
  assert.equal(result.surfaceId, "s1");
  assert.equal(result.gateId, "g1");
});

test("normalizeResult treats an unknown or missing decision as cancelled, never approved", () => {
  const request = makeRequest([outputAnchor(1)]);
  assert.equal(normalizeResult({ decision: "yolo", annotations: [] }, request).decision, "cancelled");
  assert.equal(normalizeResult({ annotations: [] }, request).decision, "cancelled");
  assert.equal(normalizeResult({ decision: "approved", annotations: [] }, request).decision, "approved");
});

test("normalizeResult caps the annotation count", () => {
  const anchors = Array.from({ length: MAX_ANNOTATIONS + 20 }, (_, i) => outputAnchor(i + 1));
  const request = makeRequest(anchors);
  const annotations = anchors.map((a) => ({ anchor: a, body: "x" }));
  const result = normalizeResult({ decision: "approved", annotations }, request);
  assert.equal(result.annotations.length, MAX_ANNOTATIONS);
});

test("normalizeResult carries edits and meta when present", () => {
  const request = makeRequest([outputAnchor(1)]);
  const result = normalizeResult(
    { decision: "approved", annotations: [], edits: [{ path: "a" }], meta: { n: 1 } },
    request,
  );
  assert.deepEqual(result.edits, [{ path: "a" }]);
  assert.deepEqual(result.meta, { n: 1 });
});

test("isSurfaceRequest guards the shape", () => {
  assert.equal(isSurfaceRequest(makeRequest([outputAnchor(1)])), true);
  // The gate and its callback are a pair. Direct: gateId null AND a null
  // address and token. Gated: a present id, address, and token. Mixed or
  // partial states are invalid.
  const live = { address: "http://127.0.0.1:9/cb", token: "t" };
  const none = { address: null, token: null };
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: null, callback: none }), true);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: "gate-1", callback: live }), true);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: "gate-1", callback: none }), false, "an id with no callback");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: null, callback: live }), false, "a callback with no id");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: "gate-1", callback: { address: live.address, token: null } }), false, "a partial callback");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: "gate-1", callback: { address: 8080, token: "t" } }), false, "a non-string address");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: "gate-1", callback: {} }), false, "an empty callback");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: 5, callback: live }), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), gateId: "", callback: live }), false);
  assert.equal(isSurfaceRequest(null), false);
  // Every field a host needs to render must be present: a non-empty surface
  // id, the renderer, a subject with a ref and a payload or fetch URL, and a
  // known transport (or a named third-party tool).
  assert.equal(isSurfaceRequest({ ...makeRequest([]), surfaceId: "" }), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), kind: { family: "output" } }), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), subject: { ref: "worktree" } }), false, "a subject needs a payload or a fetch URL");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), subject: { fetch: "/api/model" } }), false, "a subject needs a ref");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), subject: { ref: "worktree", payload: { files: [] } } }), true);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), transport: "local" }), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), transport: "browser" }), true);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), transport: "third-party:linear" }), true);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), transport: "third-party:" }), false);
  const noSubject = makeRequest([]);
  delete noSubject.subject;
  assert.equal(isSurfaceRequest(noSubject), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), kind: { family: "bogus" } }), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), surfaceId: 5 }), false);
  const noAnchors = makeRequest([]);
  delete noAnchors.anchors;
  assert.equal(isSurfaceRequest(noAnchors), false);
});

test("FAMILIES and DECISIONS are the contract's closed vocabularies", () => {
  assert.deepEqual([...FAMILIES], ["intent", "output", "outcome"]);
  assert.deepEqual([...DECISIONS], ["approved", "changes-requested", "cancelled", "timed-out"]);
});
