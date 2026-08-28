import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anchorKey,
  buildAnchorSet,
  validateAnnotation,
  normalizeResult,
  isSurfaceRequest,
  isGateBinding,
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

test("anchorKey is total: it never throws, and an anchor that points nowhere is null", () => {
  const cyclic = { self: null };
  cyclic.self = cyclic;
  // Positions the frame cannot carry.
  assert.equal(anchorKey({ target: "a", position: cyclic }), null, "a cyclic position");
  assert.equal(anchorKey({ target: "a", position: 1n }), null, "a BigInt position");
  assert.equal(anchorKey({ target: "a", position: true }), null, "a boolean position");
  assert.equal(anchorKey({ target: "a", position: Number.NaN }), null);
  assert.equal(anchorKey({ target: "a", position: Number.POSITIVE_INFINITY }), null);
  assert.equal(anchorKey({ target: "a", position: () => 1 }), null, "a function position");
  // Empty locations.
  assert.equal(anchorKey({ target: "", position: "" }), null, "an empty target and position");
  assert.equal(anchorKey({ target: "  ", position: 1 }), null, "a whitespace target");
  assert.equal(anchorKey({ target: "a", position: "   " }), null, "a whitespace position");
  assert.equal(anchorKey({ target: "a", position: {} }), null, "an empty object position");
  assert.equal(anchorKey({ target: "a", position: [] }), null, "an empty array position");
  assert.equal(anchorKey({ target: "a", position: 1, side: 7 }), null, "a non-string side");
  // A side, when present, is old or new (an internal note).
  assert.equal(anchorKey({ target: "a", position: 1, side: "" }), null, "an empty side");
  assert.equal(anchorKey({ target: "a", position: 1, side: "   " }), null, "a whitespace side");
  assert.equal(anchorKey({ target: "a", position: 1, side: "middle" }), null, "an unknown side");
  assert.equal(typeof anchorKey({ target: "a", position: 1, side: "old" }), "string");
  assert.equal(typeof anchorKey({ target: "a", position: 1, side: "new" }), "string");
  assert.equal(typeof anchorKey({ target: "a", position: 1, side: null }), "string", "no side");
  // An object position is carried whole or not at all.
  assert.equal(anchorKey({ target: "a", position: { x: 1, fn() {} } }), null, "a nested function");
  assert.equal(anchorKey({ target: "a", position: { x: 1, s: Symbol("s") } }), null, "a nested symbol");
  assert.equal(anchorKey({ target: "a", position: { x: 1, u: undefined } }), null, "a nested undefined");
  assert.equal(anchorKey({ target: "a", position: [1, () => {}] }), null, "a function in an array");
  assert.equal(anchorKey({ target: "a", position: { x: Number.NaN } }), null, "a nested non-finite number");
  assert.equal(anchorKey({ target: "a", position: { m: new Map() } }), null, "a nested Map");
  const whole = anchorKey({ target: "a", position: { x: 1, y: [2, "z"] } });
  assert.equal(typeof whole, "string", "a plain location is keyed");
  assert.equal(whole, anchorKey({ target: "a", position: { x: 1, y: [2, "z"] } }), "keyed whole and stably");
  assert.notEqual(whole, anchorKey({ target: "a", position: { x: 1, y: [2, "q"] } }), "a nested difference is a different location");
  assert.equal(anchorKey({ target: "a", position: new Date(0) }), null, "a value with its own toJSON is not a location");
  // The separator is refused in every scalar component, so a key cannot be
  // forged by moving it into a value.
  const NUL = String.fromCharCode(0);
  assert.equal(anchorKey({ target: `a${NUL}old`, position: "p" }), null, "a NUL in the target");
  assert.equal(anchorKey({ target: "a", side: "old", position: `${NUL}p` }), null, "a NUL in the position");
  assert.equal(anchorKey({ target: "a", position: `p${NUL}` }), null);
  assert.equal(validateAnnotation({ anchor: { target: "a", side: "old", position: `${NUL}p` }, body: "x" }, buildAnchorSet([{ target: `a${NUL}old`, position: "p" }])), null, "the forged pair never meets");
  // The position is tagged by type: an annotation matches only the location
  // that was offered, exactly as it was offered.
  assert.notEqual(anchorKey({ target: "a", position: 1 }), anchorKey({ target: "a", position: "1" }), "a number and its string");
  assert.notEqual(anchorKey({ target: "shot", position: { x: 1 } }), anchorKey({ target: "shot", position: '{"x":1}' }), "an object and its JSON text");
  const offered = buildAnchorSet([{ target: "a", position: 1 }, { target: "shot", position: { x: 1 } }]);
  assert.equal(validateAnnotation({ anchor: { target: "a", position: "1" }, body: "x" }, offered), null, "a string where a number was offered");
  assert.equal(validateAnnotation({ anchor: { target: "shot", position: '{"x":1}' }, body: "x" }, offered), null, "a string where an object was offered");
  assert.ok(validateAnnotation({ anchor: { target: "a", position: 1 }, body: "x" }, offered));
  // The same coordinates match after crossing a transport that reorders keys.
  assert.equal(anchorKey({ target: "shot", position: { x: 1, y: 2 } }), anchorKey({ target: "shot", position: { y: 2, x: 1 } }));
  assert.equal(
    anchorKey({ target: "shot", position: { a: { c: 1, b: [1, { z: 0, y: 1 }] } } }),
    anchorKey({ target: "shot", position: { a: { b: [1, { y: 1, z: 0 }], c: 1 } } }),
    "nested keys are canonical too",
  );
  assert.notEqual(anchorKey({ target: "shot", position: [1, 2] }), anchorKey({ target: "shot", position: [2, 1] }), "array order is part of the location");
  assert.ok(validateAnnotation({ anchor: { target: "shot", position: { y: 2, x: 1 } }, body: "x" }, buildAnchorSet([{ target: "shot", position: { x: 1, y: 2 } }])), "reordered keys still match the offered location");
  // Real locations of every family.
  assert.equal(typeof anchorKey({ target: "src/app.js", side: "new", position: 12 }), "string");
  assert.equal(typeof anchorKey({ target: "diagram", position: "node-3" }), "string");
  assert.equal(typeof anchorKey({ target: "shot.png", position: { x: 0, y: 0 } }), "string");
  assert.equal(typeof anchorKey({ target: "plan.md", position: 0 }), "string", "zero is a coordinate");
  // The boolean guards built on it never throw either.
  const request = {
    surfaceId: "s1", gateId: null, callback: { address: null, token: null },
    kind: { family: "output", renderer: "diff" }, subject: { ref: "worktree", fetch: "/api/model" },
    anchors: [{ target: "a", position: cyclic }], transport: "browser",
  };
  assert.equal(isSurfaceRequest(request), false);
  assert.equal(isSurfaceRequest({ ...request, anchors: [{ target: "", position: "" }] }), false);
  assert.equal(isSurfaceRequest({ ...request, anchors: [{ target: "a", position: 1n }] }), false);
  // A throwing getter or proxy is no location, and the guards stay boolean.
  const throwingPosition = { target: "a", position: { get x() { throw new Error("boom"); } } };
  assert.equal(anchorKey(throwingPosition), null, "a position whose getter throws");
  assert.equal(anchorKey({ get target() { throw new Error("boom"); }, position: 1 }), null, "a target whose getter throws");
  assert.equal(anchorKey(new Proxy({}, { get() { throw new Error("boom"); } })), null, "a proxy that throws");
  assert.equal(isSurfaceRequest({ ...request, anchors: [throwingPosition] }), false);
  assert.equal(validateAnnotation({ anchor: throwingPosition, body: "x" }, buildAnchorSet([outputAnchor(1)])), null);
  assert.equal(anchorKey({ target: "a", position: Object.assign({ x: 1 }, { [Symbol("s")]: 2 }) }), null, "a symbol-keyed property");
  // Only a plain object or an array is a location: JSON erases anything else
  // to {} or a fragment, so two different values would share a key.
  const offeredExotic = { target: "shot", position: { x: 1, exotic: /x/ } };
  assert.equal(anchorKey(offeredExotic), null, "a RegExp inside a position");
  assert.equal(validateAnnotation({ anchor: { target: "shot", position: { x: 1, exotic: /y/ } }, body: "x" }, buildAnchorSet([offeredExotic])), null, "the RegExp forgery never meets");
  assert.equal(isSurfaceRequest({ ...request, anchors: [offeredExotic] }), false);
  class Point { constructor() { this.x = 1; } }
  for (const exotic of [new Error("e"), new WeakMap(), Promise.resolve(1), new ArrayBuffer(4), new Point(), /x/, new Date(0), new Uint8Array(2)]) {
    assert.equal(anchorKey({ target: "shot", position: exotic }), null, `${Object.prototype.toString.call(exotic)} as a position`);
    assert.equal(anchorKey({ target: "shot", position: { x: 1, exotic } }), null, `${Object.prototype.toString.call(exotic)} inside a position`);
  }
  assert.equal(typeof anchorKey({ target: "shot", position: Object.assign(Object.create(null), { x: 1 }) }), "string", "a null-prototype object is plain");
  assert.equal(typeof anchorKey({ target: "shot", position: [{ x: 1 }, [2]] }), "string", "nested plain shapes");
  // An array is its indexed items and nothing else.
  assert.equal(anchorKey({ target: "a", position: Object.assign([1], { extra: 2 }) }), null, "an array with an extra property");
  assert.equal(validateAnnotation({ anchor: { target: "a", position: [1] }, body: "x" }, buildAnchorSet([{ target: "a", position: Object.assign([1], { extra: 2 }) }])), null, "the extra-property forgery never meets");
  assert.equal(anchorKey({ target: "a", position: [1, , 3] }), null, "a hole");
  assert.equal(anchorKey({ target: "a", position: { p: Object.assign([1], { extra: 2 }) } }), null, "an array with an extra property, nested");
  // A location is own data properties only: an accessor could answer
  // differently each time it is read, so the same anchor would not be stable.
  let reads = 0;
  assert.equal(anchorKey({ target: "a", position: { get x() { return ++reads; } } }), null, "an accessor-backed position");
  assert.equal(anchorKey({ target: "a", position: { x: 1, get y() { return 2; } } }), null, "an accessor among data");
  assert.equal(anchorKey({ target: "a", position: { x: 1, deep: { get y() { return 2; } } } }), null, "an accessor nested");
  assert.equal(anchorKey({ target: "a", position: Object.defineProperty([1], "1", { get() { return 2; }, enumerable: true }) }), null, "an accessor index");
  assert.equal(anchorKey({ target: "a", position: { x: 1, get toJSON() { return 5; } } }), null, "an accessor named toJSON");
  assert.equal(anchorKey({ target: "a", position: Object.defineProperty({ x: 1 }, "toJSON", { value: 5 }) }), null, "a non-enumerable own toJSON");
  // JSON writes -0 as 0 and skips a non-enumerable property: neither is carried whole.
  assert.equal(anchorKey({ target: "a", position: -0 }), null, "negative zero");
  assert.equal(anchorKey({ target: "a", position: { x: -0 } }), null, "negative zero nested");
  assert.equal(anchorKey({ target: "a", position: Object.defineProperty({ x: 1 }, "hidden", { value: 2, enumerable: false }) }), null, "a non-enumerable data property");
  assert.equal(typeof anchorKey({ target: "a", position: [1, 2] }), "string", "an array's own length is the one non-enumerable exception");
  // The anchor itself is read once: the location that is checked is the
  // location that is returned, whatever an accessor answers later.
  let anchorReads = 0;
  const shifting = { target: "a", get position() { anchorReads += 1; return anchorReads < 3 ? 1 : 999; } };
  const offeredOnce = buildAnchorSet([shifting]); // read 1 -> 1
  const kept = validateAnnotation({ anchor: shifting, body: "x" }, offeredOnce); // read 2 -> 1, then no re-read
  assert.equal(kept.anchor.position, 1, "the position that passed the check is the position returned");
  assert.equal(anchorReads, 2, "the anchor was read exactly once by the validator");
  // The returned annotation owns its location: mutating what the browser
  // sent afterwards moves nothing.
  const sent = { anchor: { target: "shot", position: { x: 1, y: 2 } }, body: "x" };
  const owned = validateAnnotation(sent, buildAnchorSet([{ target: "shot", position: { x: 1, y: 2 } }]));
  sent.anchor.position.x = 999;
  sent.anchor.target = "elsewhere";
  assert.deepEqual(owned.anchor, { target: "shot", position: { x: 1, y: 2 } });
  assert.notEqual(owned.anchor.position, sent.anchor.position, "a copy, not the sent reference");
  // A symbol key is skipped by JSON whether or not it is enumerable.
  assert.equal(anchorKey({ target: "a", position: Object.defineProperty({ x: 1 }, Symbol("hidden"), { value: 2, enumerable: false }) }), null, "a non-enumerable symbol key");
  let flips = 0;
  const flipping = { target: "a", get position() { flips += 1; return flips < 2 ? 1 : 999; } };
  assert.equal(validateAnnotation({ anchor: flipping, body: "x" }, buildAnchorSet([flipping])), null, "a position that changed before the check is simply not offered");
  // A null side is no side: it keys and normalises as omitted.
  assert.equal(anchorKey({ target: "a", position: 1, side: null }), anchorKey({ target: "a", position: 1 }));
  const nullSide = validateAnnotation({ anchor: { target: "src/app.js", position: 12, side: null }, body: "x" }, buildAnchorSet([{ target: "src/app.js", position: 12 }]));
  assert.deepEqual(nullSide.anchor, { target: "src/app.js", position: 12 });
  // The root guard never throws either.
  assert.equal(isSurfaceRequest(new Proxy({}, { get() { throw new Error("boom"); } })), false, "a proxy request");
  assert.equal(isSurfaceRequest({ get surfaceId() { throw new Error("boom"); } }), false, "a throwing root getter");
  assert.equal(isSurfaceRequest({ ...request, anchors: [outputAnchor(1)], get transport() { throw new Error("boom"); } }), false, "a throwing getter deeper in");
  assert.equal(buildAnchorSet([{ target: "a", position: cyclic }, { target: "a", position: 1 }]).size, 1);
  assert.equal(validateAnnotation({ anchor: { target: "a", position: cyclic }, body: "x" }, buildAnchorSet([outputAnchor(1)])), null);
});

test("every public guard is total: a throwing proxy is invalid, never an exception", () => {
  const hostile = () => new Proxy({}, { get() { throw new Error("boom"); }, has() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); } });
  const hostileArray = new Proxy([], { get() { throw new Error("boom"); } });
  assert.equal(isGateBinding("g", hostile()), false);
  assert.equal(isGateBinding(null, hostile()), false);
  assert.equal(buildAnchorSet(hostileArray).size, 0);
  assert.equal(buildAnchorSet([outputAnchor(1), hostile()]).size, 1, "a hostile entry is skipped, a real one kept");
  assert.equal(validateAnnotation(hostile(), buildAnchorSet([outputAnchor(1)])), null);
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", get author() { throw new Error("boom"); } }, buildAnchorSet([outputAnchor(1)])), null);
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", thread: hostileArray }, buildAnchorSet([outputAnchor(1)])), null);
  const base = makeRequest([outputAnchor(1)]);
  assert.equal(isSurfaceRequest({ ...base, callback: hostile() }), false);
  assert.equal(isSurfaceRequest({ ...base, anchors: hostileArray }), false);
  assert.equal(isSurfaceRequest({ ...base, get deadline() { throw new Error("boom"); } }), false);
  assert.equal(isSurfaceRequest({ ...base, kind: hostile() }), false);
  assert.equal(isSurfaceRequest({ ...base, subject: hostile() }), false);
  // The normaliser is total too: a field that throws when read is absent.
  assert.deepEqual(normalizeResult(hostile(), base), { surfaceId: "s1", gateId: "g1", decision: "cancelled", annotations: [] });
  assert.deepEqual(normalizeResult({ decision: "approved", annotations: [] }, hostile()), { surfaceId: null, gateId: null, decision: "approved", annotations: [] });
  assert.deepEqual(normalizeResult({ decision: "approved", annotations: hostileArray }, base).annotations, []);
  assert.deepEqual(normalizeResult({ decision: "approved", get meta() { throw new Error("boom"); } }, base), { surfaceId: "s1", gateId: "g1", decision: "approved", annotations: [] });
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
  // Whitespace-only values are absent: they can neither route nor render.
  const ok = makeRequest([]);
  assert.equal(isSurfaceRequest(ok), true);
  assert.equal(isSurfaceRequest({ ...ok, surfaceId: "   " }), false);
  assert.equal(isSurfaceRequest({ ...ok, gateId: " ", callback: live }), false);
  assert.equal(isSurfaceRequest({ ...ok, callback: { address: "  ", token: "t" } }), false);
  assert.equal(isSurfaceRequest({ ...ok, callback: { address: live.address, token: "\t" } }), false);
  assert.equal(isSurfaceRequest({ ...ok, kind: { family: "output", renderer: " " } }), false);
  assert.equal(isSurfaceRequest({ ...ok, subject: { ref: " ", fetch: "/api/model" } }), false);
  assert.equal(isSurfaceRequest({ ...ok, subject: { ref: "worktree", fetch: "   " } }), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), kind: { family: "bogus" } }), false);
  assert.equal(isSurfaceRequest({ ...makeRequest([]), surfaceId: 5 }), false);
  const noAnchors = makeRequest([]);
  delete noAnchors.anchors;
  assert.equal(isSurfaceRequest(noAnchors), false);
  // Every offered anchor must be a real location: a target and a position.
  assert.equal(isSurfaceRequest(makeRequest([null])), false, "a null anchor");
  assert.equal(isSurfaceRequest(makeRequest([{ target: "a" }])), false, "an anchor with no position");
  assert.equal(isSurfaceRequest(makeRequest([{ position: 1 }])), false, "an anchor with no target");
  assert.equal(isSurfaceRequest(makeRequest([outputAnchor(1), "x"])), false, "a non-object among valid anchors");
  assert.equal(isSurfaceRequest(makeRequest([{ target: "shot.png", position: { x: 1, y: 2 } }])), true, "a region anchor");
  // A deadline is optional; when present it is an RFC 3339 date-time with a
  // zone.
  assert.equal(isSurfaceRequest({ ...ok, deadline: null }), true);
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00Z" }), true);
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00.250+01:00" }), true, "a zone offset and fraction");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00Z" }), true, "minutes precision");
  assert.equal(isSurfaceRequest({ ...ok, deadline: { bad: true } }), false, "an object deadline");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "soon" }), false, "an unparseable deadline");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "" }), false, "an empty deadline");
  assert.equal(isSurfaceRequest({ ...ok, deadline: 1756371600000 }), false, "a numeric deadline");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28" }), false, "a bare date has no instant");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00" }), false, "no zone");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "Aug 28 2026 09:00 GMT" }), false, "a loose date Date.parse would accept");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-13-45T00:00:00Z" }), false, "a shaped but impossible date");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-02-30T00:00:00Z" }), false, "a day the month does not have");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2023-02-29T00:00:00Z" }), false, "not a leap year");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2024-02-29T00:00:00Z" }), true, "a leap day");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2000-02-29T00:00:00Z" }), true, "a century leap day");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "1900-02-29T00:00:00Z" }), false, "a century that is not a leap year");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T24:00:00Z" }), false, "hour 24");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:60:00Z" }), false, "minute 60");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:60Z" }), false, "second 60");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00+25:00" }), false, "an impossible offset");
});

test("FAMILIES and DECISIONS are the contract's closed vocabularies", () => {
  assert.deepEqual([...FAMILIES], ["intent", "output", "outcome"]);
  assert.deepEqual([...DECISIONS], ["approved", "changes-requested", "cancelled", "timed-out"]);
});
