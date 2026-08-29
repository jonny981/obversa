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
  // An accessor is no location on either side: it could answer one position
  // to the check and another to whoever reads the result. A request anchor
  // and an annotation's anchor are both read from their own data
  // descriptors, so the accessor is refused and never invoked.
  let anchorReads = 0;
  const shifting = { target: "a", get position() { anchorReads += 1; return anchorReads < 3 ? 1 : 999; } };
  assert.equal(buildAnchorSet([shifting]).size, 0, "an accessor anchor offers no location");
  assert.equal(validateAnnotation({ anchor: shifting, body: "x" }, buildAnchorSet([{ target: "a", position: 1 }])), null, "an accessor anchor matches no location");
  assert.equal(anchorReads, 0, "the accessor was never invoked, on either side");
  const kept = validateAnnotation({ anchor: { target: "a", position: 1 }, body: "x" }, buildAnchorSet([{ target: "a", position: 1 }]));
  assert.equal(kept.anchor.position, 1);
  // Hidden, inherited, or extra fields on an annotation's anchor are refused
  // before anything is read from them.
  const hidden = { target: "a", position: 1 };
  Object.defineProperty(hidden, "side", { value: "new", enumerable: false });
  assert.equal(validateAnnotation({ anchor: hidden, body: "x" }, buildAnchorSet([{ target: "a", position: 1 }])), null, "a hidden field");
  assert.equal(validateAnnotation({ anchor: Object.assign(Object.create({ side: "new" }), { target: "a", position: 1 }), body: "x" }, buildAnchorSet([{ target: "a", position: 1 }])), null, "an inherited field on a foreign prototype");
  assert.equal(validateAnnotation({ anchor: { target: "a", position: 1, extra: 1 }, body: "x" }, buildAnchorSet([{ target: "a", position: 1 }])), null, "an extra field");
  // The returned annotation owns its location: mutating what the browser
  // sent afterwards moves nothing.
  const sent = { anchor: { target: "shot", position: { x: 1, y: 2 } }, body: "x" };
  const owned = validateAnnotation(sent, buildAnchorSet([{ target: "shot", position: { x: 1, y: 2 } }]));
  sent.anchor.position.x = 999;
  sent.anchor.target = "elsewhere";
  assert.deepEqual(owned.anchor, { target: "shot", position: { x: 1, y: 2 } });
  assert.notEqual(owned.anchor.position, sent.anchor.position, "a copy, not the sent reference");
  // A Proxy cannot be made stable by reading it once — it may answer the
  // serialiser differently from the check — so it is no location at all.
  let proxyReads = 0;
  const proxied = new Proxy({ x: 1 }, { get(t, k, r) { if (k === "x") return ++proxyReads === 1 ? 1 : 999; return Reflect.get(t, k, r); } });
  assert.equal(validateAnnotation({ anchor: { target: "shot", position: proxied }, body: "x" }, buildAnchorSet([{ target: "shot", position: { x: 1 } }])), null, "a proxied position is no location");
  assert.equal(anchorKey({ target: "shot", position: new Proxy({ x: 1 }, {}) }), null, "even a transparent proxy");
  assert.equal(anchorKey({ target: "shot", position: { x: 1, p: new Proxy({ y: 2 }, {}) } }), null, "a proxy nested");
  assert.equal(anchorKey({ target: "shot", position: new Proxy([1], {}) }), null, "a proxied array");
  // The contract is observable own data. Hidden internal state is not data:
  // it is neither carried nor promised, so an object with its prototype
  // removed is exactly its own enumerable data properties, and two such
  // objects with the same observable data are the same location.
  const u1 = Object.setPrototypeOf(Object.assign(new URL("https://a.example/one"), { visible: 1 }), null);
  const u2 = Object.setPrototypeOf(Object.assign(new URL("https://b.example/two"), { visible: 1 }), null);
  assert.equal(anchorKey({ target: "x", position: u1 }), anchorKey({ target: "x", position: { visible: 1 } }), "a URL with its prototype removed is its observable data");
  assert.equal(anchorKey({ target: "x", position: u1 }), anchorKey({ target: "x", position: u2 }), "the same observable data is the same location, whatever is hidden");
  assert.equal(anchorKey({ target: "shot", position: Object.setPrototypeOf(new Map([["k", 1]]), null) }), null, "a Map with its prototype removed has no observable data: an empty location");
  assert.equal(anchorKey({ target: "shot", position: { x: 1, m: Object.setPrototypeOf(new Set([1]), null) } }), anchorKey({ target: "shot", position: { x: 1, m: {} } }), "nested, its observable data is {}");
  assert.equal(anchorKey({ target: "shot", position: Object.setPrototypeOf(new Date(0), null) }), null, "a Date with its prototype removed: empty");
  assert.equal(anchorKey({ target: "shot", position: Object.setPrototypeOf(new Uint8Array(2), null) }), anchorKey({ target: "shot", position: { 0: 0, 1: 0 } }), "a typed array with its prototype removed is its indexed data");
  // A proxied anchor list offers nothing and is no request.
  assert.equal(buildAnchorSet(new Proxy([outputAnchor(1)], {})).size, 0);
  assert.equal(isSurfaceRequest({ ...request, anchors: new Proxy([outputAnchor(1)], {}) }), false);
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
  // A transparent Proxy answers this read like a plain object and may answer
  // the next one differently: refused at the request, its kind, its subject,
  // its callback, and its payload, as the module's head states. The base
  // here is a sound request, so each refusal is the Proxy's alone.
  const sound = { ...request, anchors: [outputAnchor(1)] };
  assert.equal(isSurfaceRequest(sound), true, "the base is a request");
  assert.equal(isSurfaceRequest(new Proxy({ ...sound }, {})), false, "a transparent proxy request");
  assert.equal(isSurfaceRequest({ ...sound, kind: new Proxy({ ...sound.kind }, {}) }), false, "a transparent proxy kind");
  assert.equal(isSurfaceRequest({ ...sound, subject: new Proxy({ ...sound.subject }, {}) }), false, "a transparent proxy subject");
  assert.equal(isSurfaceRequest({ ...sound, callback: new Proxy({ ...sound.callback }, {}) }), false, "a transparent proxy callback");
  assert.equal(isGateBinding("gate-1", new Proxy({ address: "https://gate.example/cb", token: "t" }, {})), false, "a transparent proxy binding");
  assert.equal(isSurfaceRequest({ ...sound, subject: { ref: "r", payload: { files: [] } } }), true, "a plain payload is a request");
  assert.equal(isSurfaceRequest({ ...sound, subject: { ref: "r", payload: new Proxy({ files: [] }, {}) } }), false, "a transparent proxy payload");
  // A payload is content a transport can carry: an object or a string.
  assert.equal(isSurfaceRequest({ ...sound, subject: { ref: "r", payload: "diff --git a/x b/x" } }), true, "a string payload");
  for (const payload of [() => {}, Symbol("p"), 1n, 42, true, null]) {
    assert.equal(isSurfaceRequest({ ...sound, subject: { ref: "r", payload } }), false, `a ${typeof payload} payload is not content`);
  }
  assert.equal(isSurfaceRequest({ get surfaceId() { throw new Error("boom"); } }), false, "a throwing root getter");
  assert.equal(isSurfaceRequest({ ...request, anchors: [outputAnchor(1)], get transport() { throw new Error("boom"); } }), false, "a throwing getter deeper in");
  assert.equal(buildAnchorSet([{ target: "a", position: cyclic }, { target: "a", position: 1 }]).size, 1);
  assert.equal(validateAnnotation({ anchor: { target: "a", position: cyclic }, body: "x" }, buildAnchorSet([outputAnchor(1)])), null);
});

test("validateAnnotation reads every raw field once: a stateful getter cannot put a non-string into the clean shape", () => {
  const set = buildAnchorSet([outputAnchor(1)]);
  // Each getter answers a string to the first read and an object to the next.
  const flip = (first, then) => { let reads = 0; return () => (++reads === 1 ? first : then); };
  const bodyReads = flip("looks off", { not: "a string" });
  const createdReads = flip("2026-08-28T09:00:00Z", { not: "a timestamp" });
  const entryBodyReads = flip("reply", { not: "a string" });
  const entry = { author: { kind: "human", id: "r" }, get body() { return entryBodyReads(); } };
  const threadReads = flip([entry], "not an array");
  const raw = {
    anchor: outputAnchor(1),
    get body() { return bodyReads(); },
    get createdAt() { return createdReads(); },
    get thread() { return threadReads(); },
  };
  const clean = validateAnnotation(raw, set);
  assert.equal(typeof clean.body, "string");
  assert.equal(clean.body, "looks off");
  assert.equal(typeof clean.createdAt, "string");
  assert.equal(clean.createdAt, "2026-08-28T09:00:00Z");
  assert.equal(clean.thread.length, 1);
  assert.equal(typeof clean.thread[0].body, "string");
  assert.equal(clean.thread[0].body, "reply");
  // A field that answers a non-string on its one read is simply invalid.
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), get body() { return { not: "a string" }; } }, set), null);
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", createdAt: Number.NaN }, set).createdAt, null, "a non-finite number is no timestamp");
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", createdAt: Number.POSITIVE_INFINITY }, set).createdAt, null);
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", createdAt: Number.NEGATIVE_INFINITY }, set).createdAt, null);
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", createdAt: 1756371600000 }, set).createdAt, 1756371600000, "a finite number is kept");
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", thread: [{ author: { kind: "human", id: "r" }, get body() { return { not: "a string" }; } }] }, set).thread, undefined);
  // The author is read once too.
  const kindReads = flip("agent", "robot");
  const withAuthor = validateAnnotation({ anchor: outputAnchor(1), body: "x", author: { get kind() { return kindReads(); }, id: "grok" } }, set);
  assert.deepEqual(withAuthor.author, { kind: "agent", id: "grok" });
});

test("arrays are read by own index: an inherited iterator or an own method cannot split what the key, the set, and the guard see", () => {
  // An array whose prototype chain supplies its own iterator: for..of would
  // see 999, the own indexed items say 1.
  const withIterator = (real, yielded) => {
    const proto = Object.create(Array.prototype);
    proto[Symbol.iterator] = function* iterate() { yield* yielded; };
    Object.setPrototypeOf(real, proto);
    return real;
  };
  const one = withIterator([1], [999]);
  assert.equal(anchorKey({ target: "a", position: one }), anchorKey({ target: "a", position: [1] }), "keyed by own items");
  assert.notEqual(anchorKey({ target: "a", position: one }), anchorKey({ target: "a", position: [999] }));
  const anchors = withIterator([{ target: "a", position: 1 }], [{ target: "a", position: 999 }]);
  const request = { ...makeRequest([]), anchors };
  assert.equal(isSurfaceRequest(request), true, "a valid request by its own items");
  const set = buildAnchorSet(anchors);
  assert.equal(set.size, 1);
  assert.ok(set.has(anchorKey({ target: "a", position: 1 })), "the set holds the own item");
  assert.equal(validateAnnotation({ anchor: { target: "a", position: 999 }, body: "x" }, set), null, "the iterated item was never offered");
  assert.ok(validateAnnotation({ anchor: { target: "a", position: 1 }, body: "x" }, set));
  assert.equal(normalizeResult({ decision: "changes-requested", annotations: withIterator([{ anchor: { target: "a", position: 1 }, body: "own" }], [{ anchor: { target: "a", position: 1 }, body: "iterated" }]) }, request).annotations[0].body, "own");
  const thread = withIterator([{ author: { kind: "human", id: "r" }, body: "own" }], [{ author: { kind: "human", id: "r" }, body: "iterated" }]);
  assert.equal(validateAnnotation({ anchor: { target: "a", position: 1 }, body: "x", thread }, set).thread[0].body, "own");
  // Guard false positives through Array.prototype.every: a hole, an own every.
  assert.equal(isSurfaceRequest({ ...makeRequest([]), anchors: new Array(1) }), false, "a hole is not an anchor");
  assert.equal(isSurfaceRequest({ ...makeRequest([]), anchors: Object.assign([null], { every: () => true }) }), false, "an own every is not consulted");
  assert.equal(buildAnchorSet(new Array(1)).size, 0);
  assert.equal(buildAnchorSet(Object.assign([outputAnchor(1)], { length: 2 })).size, 0, "a length past the own items is a hole");
  // Request fields are read once: a getter cannot satisfy three checks with three shapes.
  let kindReads = 0;
  const shiftingKind = { ...makeRequest([outputAnchor(1)]), get kind() { kindReads += 1; return kindReads === 1 ? {} : kindReads === 2 ? { family: "output" } : { renderer: "diff" }; } };
  assert.equal(isSurfaceRequest(shiftingKind), false);
  let anchorsReads = 0;
  const shiftingAnchors = { ...makeRequest([]), get anchors() { anchorsReads += 1; return anchorsReads === 1 ? [null] : []; } };
  assert.equal(isSurfaceRequest(shiftingAnchors), false);
  assert.equal(anchorsReads, 1, "anchors read once");
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
  // A hostile thread is an absent thread; the annotation it hangs off still stands.
  assert.equal(validateAnnotation({ anchor: outputAnchor(1), body: "x", thread: hostileArray }, buildAnchorSet([outputAnchor(1)])).thread, undefined);
  const base = makeRequest([outputAnchor(1)]);
  assert.equal(isSurfaceRequest({ ...base, callback: hostile() }), false);
  assert.equal(isSurfaceRequest({ ...base, anchors: hostileArray }), false);
  assert.equal(isSurfaceRequest({ ...base, get deadline() { throw new Error("boom"); } }), false);
  assert.equal(isSurfaceRequest({ ...base, kind: hostile() }), false);
  assert.equal(isSurfaceRequest({ ...base, subject: hostile() }), false);
  // The normaliser is total too: a field that throws when read is absent, and
  // a payload with no readable decision is no result — null, not a throw.
  assert.equal(normalizeResult(hostile(), base), null);
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

test("normalizeResult refuses an unknown, missing, or runtime-only decision from a submission, never coercing it", () => {
  const request = makeRequest([outputAnchor(1)]);
  assert.equal(normalizeResult({ decision: "yolo", annotations: [] }, request), null);
  assert.equal(normalizeResult({ annotations: [] }, request), null);
  assert.equal(normalizeResult({ decision: "cancelled", annotations: [] }, request), null, "a browser cannot submit the runtime's endings");
  assert.equal(normalizeResult({ decision: "timed-out", annotations: [] }, request), null);
  assert.equal(normalizeResult({ decision: "approved", annotations: [] }, request).decision, "approved");
  // The runtime's own endings carry no annotations and nothing else.
  assert.equal(normalizeResult({ decision: "cancelled", annotations: [] }, request, { terminal: true }).decision, "cancelled");
  assert.equal(normalizeResult({ decision: "timed-out", annotations: [] }, request, { terminal: true }).decision, "timed-out");
  assert.equal(normalizeResult({ decision: "approved", annotations: [] }, request, { terminal: true }), null, "a terminal ending is never an approval");
  assert.equal(normalizeResult({ decision: "cancelled", annotations: [{ anchor: outputAnchor(1), body: "x" }] }, request, { terminal: true }), null, "nor does it carry annotations");
});

test("normalizeResult caps the annotation count", () => {
  const anchors = Array.from({ length: MAX_ANNOTATIONS + 20 }, (_, i) => outputAnchor(i + 1));
  const request = makeRequest(anchors);
  const annotations = anchors.map((a) => ({ anchor: a, body: "x" }));
  const result = normalizeResult({ decision: "changes-requested", annotations }, request);
  assert.equal(result.annotations.length, MAX_ANNOTATIONS);
});

test("normalizeResult carries meta when present and never a raw edits field", () => {
  const request = makeRequest([outputAnchor(1)]);
  const result = normalizeResult(
    { decision: "approved", annotations: [], edits: [{ path: "a" }], meta: { n: 1 } },
    request,
  );
  assert.equal("edits" in result, false, "there is no edit path in this surface, so nothing unchecked is carried");
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
  assert.equal(isSurfaceRequest({ ...makeRequest([]), subject: { ref: "worktree", payload: { files: [] }, fetch: "/api/model" } }), false, "a subject names one content source, not both");
  // A present but unusable fetch beside a payload is still two fields, not one.
  for (const fetch of ["", "   ", null, 42]) {
    assert.equal(isSurfaceRequest({ ...makeRequest([]), subject: { ref: "worktree", payload: { files: [] }, fetch } }), false, `payload plus fetch ${JSON.stringify(fetch)}`);
    assert.equal(isSurfaceRequest({ ...makeRequest([]), subject: { ref: "worktree", fetch } }), false, `fetch ${JSON.stringify(fetch)} alone is not a URL`);
  }
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
  // A deadline is optional; when present it is an RFC 3339 date-time with
  // seconds, an optional fraction of up to nine digits, and Z or a numeric
  // offset; no leap second.
  assert.equal(isSurfaceRequest({ ...ok, deadline: null }), true);
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00Z" }), true);
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00.250+01:00" }), true, "a zone offset and fraction");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00.123456789Z" }), true, "a nine-digit fraction");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00.1234567890Z" }), false, "a ten-digit fraction");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00Z" }), false, "seconds are required");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-06-30T23:59:60Z" }), false, "no leap second");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00-00:00" }), false, "-00:00 means the offset is unknown, not one instant");
  assert.equal(isSurfaceRequest({ ...ok, deadline: "2026-08-28T09:00:00+00:00" }), true, "+00:00 is UTC");
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

test("an anchor is plain data: an accessor, a proxy, a hidden or extra property, a symbol key, or a class instance is no location", () => {
  // A getter could answer one position to the guard that validated the
  // request and another to the set the result is checked against.
  let calls = 0;
  const getter = { target: "src/app.js", side: "new" };
  Object.defineProperty(getter, "position", { get: () => (calls += 1), enumerable: true });
  assert.equal(anchorKey(getter), null, "an accessor position");
  assert.equal(isSurfaceRequest(makeRequest([getter])), false, "a request offering it is refused");
  assert.equal(anchorKey(new Proxy(outputAnchor(1), {})), null, "a proxy");
  const hidden = outputAnchor(1);
  Object.defineProperty(hidden, "position", { value: 1, enumerable: false });
  assert.equal(anchorKey(hidden), null, "a non-enumerable field");
  assert.equal(anchorKey({ ...outputAnchor(1), extra: true }), null, "a property no location has");
  assert.equal(anchorKey({ ...outputAnchor(1), [Symbol("s")]: 1 }), null, "a symbol key");
  class Anchor { constructor() { Object.assign(this, outputAnchor(1)); } }
  assert.equal(anchorKey(new Anchor()), null, "a class instance");
  assert.equal(anchorKey(Object.assign(Object.create(null), outputAnchor(1))), anchorKey(outputAnchor(1)), "a null-prototype object is its own data");
  assert.equal(anchorKey({ target: "src/app.js", position: 1 }), anchorKey({ position: 1, target: "src/app.js" }), "field order is not identity");
});

test("a session path is one leading slash with no whitespace of any kind: protocol-relative paths and Unicode spaces are refused", () => {
  const withFetch = (fetch) => isSurfaceRequest({ ...makeRequest([]), subject: { ref: "worktree", fetch } });
  assert.equal(withFetch("/api/model"), true);
  // Protocol-relative: names a host, even one whose origin matches the base.
  assert.equal(withFetch("//127.0.0.1/x"), false);
  assert.equal(withFetch("//127.0.0.1:80/x"), false);
  assert.equal(withFetch("//evil.invalid/x"), false);
  // Whitespace the ASCII check missed: no-break space, em space, ideographic space.
  assert.equal(withFetch("/api/ model"), false);
  assert.equal(withFetch("/api/ model"), false);
  assert.equal(withFetch("/api/　model"), false);
  assert.equal(withFetch("/api/model "), false);
  assert.equal(withFetch("/api/\tmodel"), false);
});

test("a subject's fetch is a URL the host can fetch: absolute http(s) or a path on the session origin", () => {
  const withFetch = (fetch) => isSurfaceRequest({ ...makeRequest([outputAnchor(1)]), subject: { ref: "worktree", fetch } });
  for (const ok of ["/api/model", "/api/model?x=1", "http://127.0.0.1:8080/api/model", "https://example.test/review"]) assert.equal(withFetch(ok), true, ok);
  for (const bad of ["http://[", "%", "not a URL", "", " ", "//evil.test/x", "/\\evil.test/x", "/\\\\evil.test", "/api\nevil.test", "/api\tmodel", "/\u0000", "ftp://x/y", "javascript:alert(1)", "api/model", "data:text/plain,x"]) assert.equal(withFetch(bad), false, JSON.stringify(bad));
  // The premise: the URL parser reads a backslash as a slash and drops a
  // newline, so those forms would otherwise leave the session origin.
  assert.equal(new URL("/\\evil.test/x", "http://127.0.0.1").origin, "http://evil.test");
});

test("a decision agrees with its annotations or there is no result: approved with none, changes-requested with at least one", () => {
  const request = makeRequest([outputAnchor(3)]);
  assert.equal(normalizeResult({ decision: "approved", annotations: [{ anchor: outputAnchor(3), body: "fix this" }] }, request), null, "an approval beside review work is refused, not coerced");
  assert.equal(normalizeResult({ decision: "approved", annotations: [] }, request).decision, "approved");
  // An annotation the request never offered is dropped; the approval then
  // stands on what is valid, which is nothing.
  const forged = normalizeResult({ decision: "approved", annotations: [{ anchor: outputAnchor(99), body: "not shown" }] }, request);
  assert.equal(forged.decision, "approved");
  assert.equal(forged.annotations.length, 0);
  // A request for changes names at least one: none sent, or every one
  // forged, is refused.
  assert.equal(normalizeResult({ decision: "changes-requested", annotations: [] }, request), null);
  assert.equal(normalizeResult({ decision: "changes-requested", annotations: [{ anchor: outputAnchor(99), body: "forged" }] }, request), null, "every annotation forged");
  const real = normalizeResult({ decision: "changes-requested", annotations: [{ anchor: outputAnchor(3), body: "real" }] }, request);
  assert.equal(real.decision, "changes-requested");
  assert.equal(real.annotations.length, 1);
});
