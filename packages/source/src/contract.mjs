// The surface contract: one request shape and one result shape that stay
// identical across every renderer family (Intent, Output, Outcome) and every
// transport (terminal, browser, remote, webhook, third-party). That invariant
// is what lets one agent consume any human review the same way, and it is the
// spine of an internal note
//
// This module is family-agnostic and dependency-free. It owns the shapes and
// the one security-critical rule: an annotation may only pin to a location the
// request actually offered (buildAnchorSet + validateAnnotation). A family
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
//   Anchor         { target, side?, position }
//   Annotation     { anchor, body, author{kind,id}, createdAt, thread? }
//   SurfaceResult  { surfaceId, gateId, decision, annotations[], edits?, meta? }

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
 * collide on their key. Returns null for a structurally invalid anchor.
 */
export function anchorKey(anchor) {
  if (!anchor || typeof anchor !== "object") return null;
  const { target, side, position } = anchor;
  if (typeof target !== "string") return null;
  if (position === undefined || position === null) return null;
  const pos = typeof position === "object" ? JSON.stringify(position) : String(position);
  return `${target}\u0000${side ?? ""}\u0000${pos}`;
}

/**
 * Build the set of anchor keys a request offered. An annotation whose anchor is
 * not in this set is rejected downstream: the reviewer could not have seen that
 * location, so intent pinned there is fabricated.
 */
export function buildAnchorSet(anchors) {
  const set = new Set();
  if (!Array.isArray(anchors)) return set;
  for (const anchor of anchors) {
    const key = anchorKey(anchor);
    if (key !== null) set.add(key);
  }
  return set;
}

// Keep only the contract fields of an anchor, in a stable order. Runs after the
// anchor has already passed the membership check.
function normalizeAnchor(anchor) {
  const clean = { target: anchor.target, position: anchor.position };
  if (anchor.side !== undefined) clean.side = anchor.side;
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
  const author = normalizeAuthor(entry.author);
  if (!author) return null;
  if (typeof entry.body !== "string") return null;
  const body = entry.body.trim();
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
  if (!raw || typeof raw !== "object") return null;
  const key = anchorKey(raw.anchor);
  if (key === null || !anchorSet.has(key)) return null;
  if (typeof raw.body !== "string") return null;
  const body = raw.body.trim();
  if (!body) return null;

  const annotation = {
    anchor: normalizeAnchor(raw.anchor),
    body: body.slice(0, MAX_BODY),
    author: normalizeAuthor(raw.author) ?? { kind: "human", id: "reviewer" },
    createdAt:
      typeof raw.createdAt === "string" || typeof raw.createdAt === "number"
        ? raw.createdAt
        : null,
  };

  if (Array.isArray(raw.thread) && raw.thread.length > 0) {
    const thread = [];
    for (const entry of raw.thread) {
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
 * request. Every annotation is validated against the request's anchors; the
 * decision must be one of DECISIONS (an unknown or missing decision is treated
 * as "cancelled", never as an approval); surfaceId and gateId are copied from
 * the request so the callback routes the result to the exact gate instance.
 */
export function normalizeResult(raw, request) {
  const anchorSet = buildAnchorSet(request?.anchors);
  const annotations = [];
  const rawAnnotations = Array.isArray(raw?.annotations) ? raw.annotations : [];
  for (const item of rawAnnotations) {
    if (annotations.length >= MAX_ANNOTATIONS) break;
    const clean = validateAnnotation(item, anchorSet);
    if (clean) annotations.push(clean);
  }
  const result = {
    surfaceId: request?.surfaceId ?? null,
    gateId: request?.gateId ?? null,
    decision: DECISIONS.includes(raw?.decision) ? raw.decision : "cancelled",
    annotations,
  };
  if (raw?.edits !== undefined) result.edits = raw.edits;
  if (raw?.meta !== undefined) result.meta = raw.meta;
  return result;
}

/**
 * A light structural guard for a SurfaceRequest. Not a full schema validator —
 * it catches the shape errors that would otherwise fail deep inside a renderer,
 * where the cause is harder to see.
 */
// A non-empty string, the only acceptable form for an id, an address, or a
// token that is present.
function isPresent(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * The gate and its callback come as a pair, because the callback is what
 * authenticates the result and binds it to one gate instance. Either the
 * request was opened directly — gateId null, callback address and token null
 * — or by a gate — a present gateId, address, and token. Mixed states (an id
 * with no callback, a callback with no id, a partial callback) are invalid.
 */
export function isGateBinding(gateId, callback) {
  if (!callback || typeof callback !== "object") return false;
  const { address, token } = callback;
  if (gateId === null) return address === null && token === null;
  return isPresent(gateId) && isPresent(address) && isPresent(token);
}

export function isSurfaceRequest(value) {
  if (!value || typeof value !== "object") return false;
  if (!isPresent(value.surfaceId)) return false;
  if (!isGateBinding(value.gateId, value.callback)) return false;
  if (!value.kind || !FAMILIES.includes(value.kind.family) || !isPresent(value.kind.renderer)) return false;
  // The subject is a ref plus either an inline payload or a fetch URL; a host
  // cannot render a request that names neither.
  const subject = value.subject;
  if (!subject || typeof subject !== "object" || !isPresent(subject.ref)) return false;
  if (subject.payload === undefined && !isPresent(subject.fetch)) return false;
  if (!isTransport(value.transport)) return false;
  if (!Array.isArray(value.anchors)) return false;
  return true;
}
