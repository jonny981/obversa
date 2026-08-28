// The surface contract: one request shape and one result shape that stay
// identical across every renderer family (Intent, Output, Outcome) and every
// transport (terminal, browser, remote, webhook, third-party). That invariant
// is what lets one agent consume any human review the same way, and it is the
// spine of an internal note
//
// This module is family-agnostic and depends on nothing but Node's own
// Proxy check (node:util types.isProxy). It owns the shapes and
// the one security-critical rule: an annotation may only pin to a location the
// request actually offered (buildAnchorSet + validateAnnotation). Every
// exported guard and normaliser is total: handed a throwing getter or proxy,
// it answers "invalid" (false, null, or an empty set) and never throws. A family
// renderer supplies the concrete anchors — for Output, every real diff line —
// and the core here enforces membership, so a tampered client cannot invent a
// location that was never shown. When a second family lands, this module lifts
// into a shared package unchanged.
//
// Shapes (see an internal note):
//   SurfaceRequest { surfaceId, gateId, callback{address,token},
//                    kind{family,renderer}, subject{ref, payload | fetch},
//                    anchors[], transport, deadline? }
//   transport is one of TRANSPORTS or `third-party:<tool>`.
//   A surface opened directly (a person running the command, no Callback Gate)
//   has gateId null and a callback whose address and token are null; a
//   gate-launched surface carries the gate's id and callback. Both are valid.
//   Anchor         { target, side?, position }   side is absent (undefined or
//                  null) or old | new
//   Annotation     { anchor, body, author{kind,id}, createdAt, thread? }
//   SurfaceResult  { surfaceId, gateId, decision, annotations[], edits?, meta? }
//   deadline, when present, is an RFC 3339 date-time with seconds, an
//   optional fraction of up to nine digits, and Z or a numeric offset (no
//   leap second, no -00:00).

import { types } from "node:util";

export const FAMILIES = Object.freeze(["intent", "output", "outcome"]);
// Transport hints (an internal note): the named hosts, or a third-party tool as
// `third-party:<tool>`.
export const TRANSPORTS = Object.freeze(["terminal", "browser", "remote", "webhook"]);
const THIRD_PARTY = /^third-party:[A-Za-z0-9._-]+$/;
export function isTransport(value) {
  return typeof value === "string" && (TRANSPORTS.includes(value) || THIRD_PARTY.test(value));
}
export const DECISIONS = Object.freeze([
  "approved",
  "changes-requested",
  "cancelled",
  "timed-out",
]);
export const AUTHOR_KINDS = Object.freeze(["human", "agent"]);
// The sides of an Output anchor (an internal note): the old or the new text.
export const SIDES = Object.freeze(["old", "new"]);
// The fields a location has, and the only own properties an anchor may carry.
const ANCHOR_FIELDS = Object.freeze(["target", "side", "position"]);
// A deadline names one instant every host reads the same way. The accepted
// form is exactly: an RFC 3339 date-time with seconds, an optional fraction
// of up to nine digits, and Z or a numeric offset — no leap second (:60),
// which Date.parse cannot place, and no -00:00, which RFC 3339 reserves for
// "offset unknown". The shape is checked and then every
// calendar component, because Date.parse would quietly roll 2026-02-30
// forward to March 2 and call it valid.
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
function isIsoInstant(text) {
  const match = typeof text === "string" ? ISO_TIMESTAMP.exec(text) : null;
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHours = "0", offsetMinutes = "0"] = match;
  const y = Number(year);
  const m = Number(month);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12) return false;
  if (Number(day) < 1 || Number(day) > daysInMonth[m - 1]) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (Number(offsetHours) > 23 || Number(offsetMinutes) > 59) return false;
  // RFC 3339 gives -00:00 the meaning "the local offset is unknown", which
  // is not one instant; Date.parse would quietly read it as UTC.
  if (text.endsWith("-00:00")) return false;
  return Number.isFinite(Date.parse(text));
}

// The data contract. A location is its OBSERVABLE OWN DATA: its own
// enumerable string-keyed data properties and its indexed items, read exactly
// once, recursively. (The runtime's payload rule in @obversa/surfacer is the
// looser cousin: the values one JSON serialisation reads, getters and toJSON
// included; a location needs a stable key, so it takes data properties
// only.) Hidden internal state —
// a Map's entries, a URL's address, a WeakRef's target — is not data: it is
// neither carried nor promised, and no finite list of brand checks could
// promise otherwise. Two values with the same observable data are the same
// location. What is refused is what would make the observable data itself
// unstable or lossy: a Proxy (Node can tell, and it may answer a later read
// differently), an object whose prototype is not Object's or none (its
// meaning is not in its own data), an own toJSON, an accessor, a symbol key,
// a non-enumerable property, a hole or extra property in an array, and any
// value JSON cannot write back exactly.

// The key separator. A scalar key component must never contain it, or two
// distinct anchors could share a key (a target ending in the separator plus a
// side, against a bare target plus a position starting with it).
const NUL = String.fromCharCode(0);
const hasNul = (text) => text.includes(NUL);

// The own indexed items of an array, read once each by index — never through
// an iterator or a method the array could override or inherit, which could
// yield one list to the key and another to the membership set — or null when
// the length is not a safe count or any index is a hole or not an own data
// property.
function ownItems(value) {
  if (types.isProxy(value)) return null;
  const { length } = value;
  if (!Number.isSafeInteger(length) || length < 0) return null;
  const items = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    items.push(descriptor.value);
  }
  return items;
}

// Canonical JSON text for an object or array location, or null; never throws.
// Object keys are sorted at every level, so the same coordinates match after
// crossing a transport that reorders them; array order is part of the
// location. Null for anything JSON could not carry whole — a cycle, a BigInt,
// a function, a symbol, an undefined value, a non-finite number, a Map or Set
// — and for any value with its own toJSON, whose text would depend on the
// serialiser rather than on the location. JSON escapes a NUL inside a string,
// so the text never contains the separator.
function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  // JSON writes negative zero as 0, so it is not carried whole.
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? JSON.stringify(value) : null;
  if (typeof value !== "object") return null;
  // A Proxy may answer a later read differently, and an object whose
  // prototype is not Object's (or none) carries meaning outside its own data
  // — a RegExp, an Error, a Map, a class instance. Neither is a location. An
  // object with its prototype removed is exactly its observable own data;
  // whatever state it hides is not data (see the data contract above).
  if (types.isProxy(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return null;
  // A value with its own toJSON means something other than its properties.
  if (Object.prototype.hasOwnProperty.call(value, "toJSON")) return null;
  // JSON skips a symbol-keyed property without a trace, enumerable or not; a
  // location with one would be keyed as something smaller than it is.
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  // Every own string-keyed property is read exactly once, as a descriptor: an
  // accessor is no data (it could answer differently each time), and a
  // non-enumerable property is skipped by JSON (an array's own length aside).
  const keys = Object.keys(value);
  const descriptors = keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)]);
  if (descriptors.some(([, descriptor]) => !descriptor || !("value" in descriptor))) return null;
  const owned = Object.getOwnPropertyNames(value).filter((name) => !(Array.isArray(value) && name === "length")).length;
  if (owned !== keys.length) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  const parts = [];
  if (Array.isArray(value)) {
    // An array is its indexed items and nothing else: an extra property or a
    // hole is something JSON would drop or fill, so two arrays that differ
    // there would share a key.
    const items = ownItems(value);
    if (items === null || keys.length !== items.length || keys.some((key, index) => key !== String(index))) {
      seen.delete(value);
      return null;
    }
    for (const item of items) {
      const text = canonicalJson(item, seen);
      if (text === null) {
        seen.delete(value);
        return null;
      }
      parts.push(text);
    }
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  // Sorted keys, values taken from the descriptors already read: one read.
  descriptors.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, descriptor] of descriptors) {
    const text = canonicalJson(descriptor.value, seen);
    if (text === null) {
      seen.delete(value);
      return null;
    }
    parts.push(`${JSON.stringify(key)}:${text}`);
  }
  seen.delete(value);
  return `{${parts.join(",")}}`;
}

// Bounds. A result may be handed back verbatim (so quoted code survives the
// transport's redaction), which means these caps live here, in the contract,
// not in any one transport.
export const MAX_ANNOTATIONS = 500;
export const MAX_BODY = 4000;
export const MAX_THREAD = 100;

/**
 * A stable string key for an anchor, used for set membership. It covers the
 * polymorphic position — a line number for Output, coordinates for a screenshot
 * region, a node id for a diagram — by serialising a non-scalar position. The
 * NUL separator cannot occur in a path or an id, so two distinct anchors never
 * collide on their key. Returns null for a structurally invalid anchor and
 * never throws, whatever it is handed: the target must be a visible string,
 * the side (when given) old or new, and the position a location the frame can
 * carry whole — a finite number, a visible string, or a non-empty object or
 * array that JSON carries without loss, in canonical key order (see
 * canonicalJson). A cycle, a BigInt, a boolean, an empty value, or a nested
 * value JSON would drop is no location. No scalar component may contain the
 * separator, and the position is tagged by type, so a number, the string of
 * that number, an object, and the JSON text of that object are four
 * different locations: an annotation can only match the location that was
 * offered, exactly as it was offered. A throwing getter or proxy is no
 * location either: the guards built on this are booleans and never throw.
 */
export function anchorKey(anchor) {
  try {
    return keyOf(anchor);
  } catch {
    return null;
  }
}

// The key, and — when `owned` is given — the owned copy of the position made
// from the very same canonical text, so every property is read exactly once:
// a value that would answer differently on a second read (a non-throwing
// proxy, an accessor) has no second read to answer.
// An anchor's three fields, read from its own data descriptors, or null. The
// anchor is plain data under the same rule as its position: not a Proxy, no
// prototype but Object's or none, no symbol-keyed or hidden property, and
// only the three fields a location has, each an enumerable data property. An
// accessor could answer one position to the check and another to whoever
// reads the result — on a request offered to the guard, or on an annotation
// the browser sent — so it is no location, and is never invoked.
function plainAnchor(anchor) {
  if (!anchor || typeof anchor !== "object" || types.isProxy(anchor)) return null;
  const proto = Object.getPrototypeOf(anchor);
  if (proto !== Object.prototype && proto !== null) return null;
  if (Object.getOwnPropertySymbols(anchor).length > 0) return null;
  const names = Object.getOwnPropertyNames(anchor);
  if (names.some((name) => !ANCHOR_FIELDS.includes(name))) return null;
  const read = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(anchor, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    read[name] = descriptor.value;
  }
  return { target: read.target, side: read.side, position: read.position };
}

function keyOf(anchor, owned) {
  const plain = plainAnchor(anchor);
  if (plain === null) return null;
  const { target, side, position } = plain;
  if (!isPresent(target) || hasNul(target)) return null;
  if (side !== undefined && side !== null && !SIDES.includes(side)) return null;
  let pos;
  if (typeof position === "number") {
    if (!Number.isFinite(position) || Object.is(position, -0)) return null;
    pos = `n:${position}`;
    if (owned) owned.position = position;
  } else if (typeof position === "string") {
    if (!isPresent(position) || hasNul(position)) return null;
    pos = `s:${position}`;
    if (owned) owned.position = position;
  } else if (position && typeof position === "object") {
    const text = canonicalJson(position);
    if (text === null || text === "{}" || text === "[]") return null;
    pos = `j:${text}`;
    if (owned) owned.position = JSON.parse(text);
  } else {
    return null;
  }
  return `${target}\u0000${side ?? ""}\u0000${pos}`;
}

/**
 * Build the set of anchor keys a request offered. An annotation whose anchor is
 * not in this set is rejected downstream: the reviewer could not have seen that
 * location, so intent pinned there is fabricated.
 */
export function buildAnchorSet(anchors) {
  const set = new Set();
  try {
    if (!Array.isArray(anchors)) return set;
    // By own index, never through an iterator the list could override.
    const items = ownItems(anchors);
    if (items === null) return set;
    for (const anchor of items) {
      const key = anchorKey(anchor);
      if (key !== null) set.add(key);
    }
    return set;
  } catch {
    // A list that throws while being read offered nothing.
    return new Set();
  }
}

// Keep only the contract fields of an anchor, in a stable order. Runs after the
// anchor has already passed the membership check. A null side is no side: it
// keys as omitted, so it is normalised as omitted too.
function normalizeAnchor(anchor) {
  const clean = { target: anchor.target, position: anchor.position };
  if (anchor.side !== undefined && anchor.side !== null) clean.side = anchor.side;
  return clean;
}

// Validate one author descriptor -> { kind, id } or null.
function normalizeAuthor(author) {
  if (!author || typeof author !== "object") return null;
  const { kind, id } = author;
  if (!AUTHOR_KINDS.includes(kind)) return null;
  if (typeof id !== "string" || id.trim() === "") return null;
  return { kind, id: id.trim().slice(0, 200) };
}

// Validate one thread entry -> { author, body } or null.
function normalizeThreadEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  // Each field is read exactly once; the checks and the result use the locals.
  const { author: rawAuthor, body: rawBody } = entry;
  const author = normalizeAuthor(rawAuthor);
  if (!author) return null;
  if (typeof rawBody !== "string") return null;
  const body = rawBody.trim();
  if (!body) return null;
  return { author, body: body.slice(0, MAX_BODY) };
}

/**
 * Validate and normalise one annotation against the request's anchor set.
 * Returns a clean Annotation or null. The anchor must be a location the request
 * offered; the body must be non-empty; author, createdAt and thread are shaped
 * and bounded. A missing author defaults to an anonymous human reviewer, which
 * matches how a plain review UI submits. This is the single membership gate
 * every family reuses.
 */
export function validateAnnotation(raw, anchorSet) {
  try {
    return cleanAnnotation(raw, anchorSet);
  } catch {
    return null;
  }
}

// The annotation's anchor as plain data (see plainAnchor): one read of each
// field from its descriptor, so the location that is checked is the location
// that is returned, and an accessor, a proxy, or a hidden or extra field is
// refused rather than read.
function snapshotAnchor(anchor) {
  return plainAnchor(anchor);
}

function cleanAnnotation(raw, anchorSet) {
  if (!raw || typeof raw !== "object") return null;
  // Every raw field is read exactly once, here; the checks below and the
  // annotation returned use these locals only. A getter that answered a
  // string to the type check and an object afterwards would otherwise put a
  // non-string body, timestamp, or thread entry into the "clean" annotation.
  const { anchor: rawAnchor, body: rawBody, author: rawAuthor, createdAt: rawCreatedAt, thread: rawThread } = raw;
  // The anchor is read exactly once. An accessor that answered one location
  // to the membership check and another afterwards would otherwise let the
  // normalised annotation point where the check never looked.
  const anchor = snapshotAnchor(rawAnchor);
  // The key and the owned copy of the position come from one canonicalisation
  // (keyOf reads every property once), so the location that passed the
  // membership check is the location returned, and nothing the sender does to
  // its object afterwards moves the annotation.
  const owned = {};
  const key = keyOf(anchor, owned);
  if (key === null || !anchorSet.has(key)) return null;
  anchor.position = owned.position;
  if (typeof rawBody !== "string") return null;
  const body = rawBody.trim();
  if (!body) return null;

  const annotation = {
    anchor: normalizeAnchor(anchor),
    body: body.slice(0, MAX_BODY),
    author: normalizeAuthor(rawAuthor) ?? { kind: "human", id: "reviewer" },
    createdAt:
      typeof rawCreatedAt === "string" || (typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt))
        ? rawCreatedAt
        : null,
  };

  const entries = Array.isArray(rawThread) ? ownItems(rawThread) : null;
  if (entries !== null) {
    // One read per entry, by own index, in order, bounded.
    const thread = [];
    for (const entry of entries) {
      if (thread.length >= MAX_THREAD) break;
      const clean = normalizeThreadEntry(entry);
      if (clean) thread.push(clean);
    }
    if (thread.length > 0) annotation.thread = thread;
  }
  return annotation;
}

/**
 * Normalise a raw browser/agent result into a clean SurfaceResult bound to the
 * request, or refuse it (null). Every annotation is validated against the
 * request's anchors. The decision must agree with the annotations that
 * survived: "approved" with none, or "changes-requested" with at least one —
 * any other pair, an unknown or missing decision, and a browser naming the
 * runtime's own endings are refused, never coerced. With `terminal` set, the
 * runtime's own ending is normalised instead: "cancelled" or "timed-out",
 * with no annotations. surfaceId and gateId are copied from the request so
 * the callback routes the result to the exact gate instance.
 */
export function normalizeResult(raw, request, { terminal = false } = {}) {
  // Total like every other export: a field that throws when read is absent.
  const read = (get, fallback) => {
    try {
      return get();
    } catch {
      return fallback;
    }
  };
  const anchorSet = buildAnchorSet(read(() => request?.anchors, []));
  const annotations = [];
  const rawAnnotations = read(() => {
    const list = raw?.annotations;
    return Array.isArray(list) ? ownItems(list) ?? [] : [];
  }, []);
  try {
    for (const item of rawAnnotations) {
      if (annotations.length >= MAX_ANNOTATIONS) break;
      const clean = validateAnnotation(item, anchorSet);
      if (clean) annotations.push(clean);
    }
  } catch {
    // A list that throws while being read carries no annotations.
    annotations.length = 0;
  }
  const decision = read(() => raw?.decision, undefined);
  // The decision and the annotations agree, or there is no result: a
  // contradictory submission is refused, never coerced. A reviewer's
  // submission is "approved" with no annotations — an annotation is review
  // work a gate must not proceed past — or "changes-requested" with at least
  // one that survived validation. "cancelled" and "timed-out" belong to the
  // runtime's own ending (`terminal`), always without annotations; a browser
  // cannot submit them.
  const valid = terminal
    ? (decision === "cancelled" || decision === "timed-out") && annotations.length === 0
    : (decision === "approved" && annotations.length === 0) || (decision === "changes-requested" && annotations.length > 0);
  if (!valid) return null;
  const result = {
    surfaceId: read(() => request?.surfaceId ?? null, null),
    gateId: read(() => request?.gateId ?? null, null),
    decision,
    annotations,
  };
  const edits = read(() => raw?.edits, undefined);
  if (edits !== undefined) result.edits = edits;
  const meta = read(() => raw?.meta, undefined);
  if (meta !== undefined) result.meta = meta;
  return result;
}

/**
 * A light structural guard for a SurfaceRequest. Not a full schema validator —
 * it catches the shape errors that would otherwise fail deep inside a renderer,
 * where the cause is harder to see.
 */
// A string with visible content, the only acceptable form for an id, an
// address, a token, a renderer, a ref, or a fetch URL that is present. A
// whitespace-only value could neither route nor render, so it is absent.
// A fetch URL a host can actually fetch: an absolute http or https URL, or a
// path on the session's own origin (`/api/model`). A session path is held to
// the session: no backslash, control, or whitespace character (the URL
// parser reads `\` as `/` and strips a newline, so `/\evil.test` would
// resolve to another host), and once parsed against the session origin it
// must still be on that origin. "not a URL", "%", and "http://[" are strings,
// not URLs.
const SESSION_ORIGIN = "http://127.0.0.1";
function isFetchUrl(value) {
  if (!isPresent(value)) return false;
  if (value.startsWith("/")) {
    if (/[\\\u0000-\u001f\u007f ]/.test(value) || !URL.canParse(value, SESSION_ORIGIN)) return false;
    return new URL(value, SESSION_ORIGIN).origin === SESSION_ORIGIN;
  }
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

function isPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The gate and its callback come as a pair, because the callback is what
 * authenticates the result and binds it to one gate instance. Either the
 * request was opened directly — gateId null, callback address and token null
 * — or by a gate — a present gateId, address, and token. Mixed states (an id
 * with no callback, a callback with no id, a partial callback) are invalid.
 */
export function isGateBinding(gateId, callback) {
  try {
    if (!callback || typeof callback !== "object") return false;
    const { address, token } = callback;
    if (gateId === null) return address === null && token === null;
    return isPresent(gateId) && isPresent(address) && isPresent(token);
  } catch {
    return false;
  }
}

export function isSurfaceRequest(value) {
  // A boolean guard never throws: a throwing getter or proxy anywhere in the
  // request is simply not a request.
  try {
    return checkSurfaceRequest(value);
  } catch {
    return false;
  }
}

function checkSurfaceRequest(value) {
  if (!value || typeof value !== "object") return false;
  // Every field is read exactly once, here, and the checks use the locals: a
  // getter that answered one shape to one check and another to the next
  // would otherwise pass a request no single read of it satisfies.
  const { surfaceId, gateId, callback, kind, subject, anchors, transport, deadline } = value;
  if (!isPresent(surfaceId)) return false;
  if (!isGateBinding(gateId, callback)) return false;
  if (!kind || typeof kind !== "object") return false;
  const { family, renderer } = kind;
  if (!FAMILIES.includes(family) || !isPresent(renderer)) return false;
  // The subject is a ref plus either an inline payload or a fetch URL, one
  // and not both; a host cannot render a request that names neither, and one
  // that names both does not say which content is under review.
  if (!subject || typeof subject !== "object") return false;
  const { ref, payload, fetch } = subject;
  if (!isPresent(ref)) return false;
  // Exactly one of the two fields is present — a subject carrying both would
  // let two renderers choose different reviewed content for the same
  // request, whatever the fetch field holds — and a present fetch must be a
  // usable URL.
  const hasPayload = payload !== undefined;
  const hasFetch = fetch !== undefined;
  if (hasPayload === hasFetch) return false;
  if (hasFetch && !isFetchUrl(fetch)) return false;
  if (!isTransport(transport)) return false;
  // Every offered anchor is a real location — a target and a position — or the
  // membership rule the result is checked against would be built on nothing.
  // The list is read by its own indexed data properties, never through a
  // method or iterator it could override: what this guard sees is exactly
  // what buildAnchorSet will see.
  if (!Array.isArray(anchors)) return false;
  const items = ownItems(anchors);
  if (items === null) return false;
  for (const anchor of items) {
    if (anchorKey(anchor) === null) return false;
  }
  // A deadline is optional; when present it is an RFC 3339 date-time with
  // seconds and a zone (see isIsoInstant), so every host enforces the same
  // instant. A bare date, a loose date, or a number is refused.
  if (deadline !== undefined && deadline !== null && !isIsoInstant(deadline)) return false;
  return true;
}
