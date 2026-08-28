import { randomUUID } from "node:crypto";

import { redactText, sanitizeValue } from "./sanitize.mjs";

const TERMINAL_STATUSES = Object.freeze([
  "completed",
  "cancelled",
  "timed_out",
  "interrupted",
  "error",
]);

function frameName(app) {
  const cleaned = String(app).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  if (!cleaned) throw new TypeError("An app name is required");
  return cleaned;
}

/** One opaque result for the caller. `completed` carries the app's result;
 *  every other status carries the outcome payload the app supplied for it, or
 *  null, plus a short redacted detail. */
export function terminalResult(app, status, { payload = null, detail = null, operationId = randomUUID(), verbatim = false } = {}) {
  if (!TERMINAL_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported terminal status: ${status}`);
  }
  return {
    schemaVersion: 1,
    app: String(app),
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
  return [
    `<<<${name}_RESULT_V1>>>`,
    JSON.stringify(result),
    `<<<END_${name}_RESULT_V1>>>`,
    "",
  ].join("\n");
}

/** Pull one framed result out of caller-captured stdout. Returns null when
 *  no complete frame for the app is present. */
export function parseFramedResult(text, app) {
  const name = frameName(app);
  const pattern = new RegExp(`<<<${name}_RESULT_V1>>>\\n([\\s\\S]*?)\\n<<<END_${name}_RESULT_V1>>>`, "g");
  // Frame names collapse punctuation, so distinct app names can share a
  // frame name. Scan every frame and return the first whose embedded app
  // field matches exactly — a colliding earlier frame must not hide a
  // valid later one.
  for (const match of String(text).matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.app === String(app)) return parsed;
    } catch { /* not this frame */ }
  }
  return null;
}

export { TERMINAL_STATUSES };
