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

/** One opaque result for the caller. `completed` carries the payload; every
 *  other status carries a short redacted detail instead. */
export function terminalResult(app, status, { payload = null, detail = null, operationId = randomUUID() } = {}) {
  if (!TERMINAL_STATUSES.includes(status)) {
    throw new TypeError(`Unsupported terminal status: ${status}`);
  }
  return {
    schemaVersion: 1,
    app: String(app),
    status,
    operationId,
    createdAt: new Date().toISOString(),
    payload: status === "completed" ? sanitizeValue(payload) : null,
    detail: detail ? redactText(String(detail)).slice(0, 500) : null,
  };
}

/** Frame a result for stdout. The frame is app-named, so one caller can
 *  demultiplex results from different surfaces. */
export function frameResult(result) {
  const name = frameName(result.app);
  return [
    `<<<${name}_RESULT_V1>>>`,
    JSON.stringify(sanitizeValue(result)),
    `<<<END_${name}_RESULT_V1>>>`,
    "",
  ].join("\n");
}

/** Pull one framed result out of caller-captured stdout. Returns null when
 *  no complete frame for the app is present. */
export function parseFramedResult(text, app) {
  const name = frameName(app);
  const pattern = new RegExp(`<<<${name}_RESULT_V1>>>\\n([\\s\\S]*?)\\n<<<END_${name}_RESULT_V1>>>`);
  const match = pattern.exec(String(text));
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export { TERMINAL_STATUSES };
