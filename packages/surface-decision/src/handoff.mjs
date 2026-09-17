import { randomUUID } from "node:crypto";
import { types } from "node:util";

import { redactText, sanitizeValue } from "./sanitize.mjs";

/**
 * JSON text for plain data, written by a walk that never consults toJSON:
 * own enumerable string-keyed data properties of an Object-or-null-prototype
 * object, the indexed items of an array with nothing else on it, strings,
 * finite numbers other than negative zero, booleans, and null. A primitive
 * is serialised as itself (JSON.stringify looks up toJSON on objects only).
 * Anything JSON could not carry whole — a cycle, a BigInt, a function, a
 * symbol, an undefined value, a non-finite number, a Map, a Date, a class
 * instance, a Proxy, an accessor, a symbol key, a non-enumerable property, an
 * array with holes or extras — throws, naming where. A toJSON on any
 * prototype, Object's included, changes nothing: this is what makes the
 * frame the same text whatever app code installs before or after the claim.
 */
export function dataJson(value, where = "the payload", seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`JSON cannot carry a non-finite number at ${where}`);
    if (Object.is(value, -0)) throw new TypeError(`JSON cannot carry negative zero at ${where}`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`JSON cannot carry ${value === undefined ? "an undefined value" : typeof value === "bigint" ? "a BigInt" : `a ${typeof value}`} at ${where}`);
  if (types.isProxy(value)) throw new TypeError(`JSON cannot carry a Proxy at ${where}`);
  if (seen.has(value)) throw new TypeError(`JSON cannot carry a cycle at ${where}`);
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`JSON cannot carry a symbol-keyed property at ${where}`);
  const own = (key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) throw new TypeError(`JSON cannot carry an accessor at ${where === "the payload" ? `"${key}"` : `${where}.${key}`}`);
    return descriptor.value;
  };
  let text;
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw new TypeError(`JSON cannot carry an array with extra properties or holes at ${where}`);
    const names = Object.getOwnPropertyNames(value).filter((name) => name !== "length");
    if (names.length !== keys.length) throw new TypeError(`JSON cannot carry a non-enumerable property at ${where}`);
    text = `[${keys.map((key) => dataJson(own(key), `${where}[${key}]`, seen)).join(",")}]`;
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError(`JSON cannot carry ${Object.prototype.toString.call(value)} at ${where}`);
    const keys = Object.keys(value);
    if (Object.getOwnPropertyNames(value).length !== keys.length) throw new TypeError(`JSON cannot carry a non-enumerable property at ${where}`);
    text = `{${keys.map((key) => `${JSON.stringify(key)}:${dataJson(own(key), `"${key}"`, seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return text;
}

const TERMINAL_STATUSES = Object.freeze([
  "completed",
  "cancelled",
  "timed_out",
  "interrupted",
  "error",
]);

/** The frame marker name for an app: upper case, punctuation collapsed to
 *  `_`. Throws on an empty name, so a session can refuse it at start rather
 *  than fail to frame its result at the end. */
export function frameName(app) {
  const cleaned = String(app).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!cleaned) throw new TypeError("An app name is required");
  return cleaned;
}

/** One opaque result for the caller. `completed` carries the app's result;
 *  every other status carries the outcome payload the app supplied for it, or
 *  null, plus a short redacted detail. `surface` is the identity of the
 *  package that answered — { package, version }, read from that package's own
 *  manifest — and rides every status, so a consumer can always say which
 *  package and version produced the frame. */
export function terminalResult(app, status, { payload = null, detail = null, operationId = randomUUID(), verbatim = false, surface = null } = {}) {
  if (!TERMINAL_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported terminal status: ${status}`);
  }
  let identity = null;
  if (surface !== null && surface !== undefined) {
    const name = surface.package;
    const version = surface.version;
    if (typeof name !== "string" || name.length === 0 || typeof version !== "string" || version.length === 0) {
      throw new TypeError("surface identity must be { package, version }, both non-empty strings");
    }
    identity = { package: name, version };
  }
  return {
    schemaVersion: 1,
    app: String(app),
    surface: identity,
    status,
    operationId,
    createdAt: new Date().toISOString(),
    // A completed session carries the app's result; another terminal status
    // carries whatever the app supplied for it (an outcome a consumer can
    // route), or null. Verbatim skips redaction only when the app asked.
    payload: payload === null || payload === undefined ? null : (verbatim === true ? payload : sanitizeValue(payload)),
    detail: detail ? redactText(String(detail)).slice(0, 500) : null,
  };
}

/** Frame a result for stdout. The frame is app-named, so one caller can
 *  demultiplex results from different surfaces. */
export function frameResult(result) {
  const name = frameName(result.app);
  // The payload was already sanitized (or deliberately marked verbatim) at
  // terminalResult time; re-sanitizing here would mangle verbatim payloads.
  // The envelope is written by the data walker, never by JSON.stringify: a
  // toJSON installed on Object.prototype would otherwise replace the whole
  // envelope with whatever it returned.
  return [
    `<<<${name}_RESULT_V1>>>`,
    dataJson(result, "the result"),
    `<<<END_${name}_RESULT_V1>>>`,
    "",
  ].join("\n");
}

/** Pull one framed result out of caller-captured stdout. Returns null when
 *  no complete frame for the app is present. */
export function parseFramedResult(text, app) {
  // The app name is read once and used for both the marker and the match.
  const appName = String(app);
  const name = frameName(appName);
  const pattern = new RegExp(`<<<${name}_RESULT_V1>>>\\n([\\s\\S]*?)\\n<<<END_${name}_RESULT_V1>>>`, "g");
  // Frame names collapse punctuation, so distinct app names can share a
  // frame name. Scan every frame and return the first whose embedded app
  // field matches exactly — a colliding earlier frame must not hide a
  // valid later one.
  for (const match of String(text).matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.app === appName) return parsed;
    } catch { /* not this frame */ }
  }
  return null;
}

export { TERMINAL_STATUSES };
