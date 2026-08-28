import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { frameName, frameResult, terminalResult } from "./handoff.mjs";
import { safeText, sanitizeValue } from "./sanitize.mjs";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
// The largest delay Node's setTimeout honours; a larger one is clamped to 1 ms.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Start one secure local surface session.
 *
 * The server binds one loopback port, guards every API request with a
 * bearer token carried in the page URL fragment, and runs until exactly one
 * terminal decision settles: the app completes it, the user cancels it, a
 * timeout or lease expiry closes it, or the caller interrupts it. The
 * decision is one opaque result; the server never interprets the payload.
 *
 * Built-in endpoints: POST /api/heartbeat, /api/cancel, /api/ack. The app
 * supplies its own endpoints through `api` and its static shell through
 * `assets`. App handlers receive ({ body, session }) and either return
 * { status, body } or call session.complete(payload). A handler that returns
 * { verbatim: true } sends its body byte-exact, skipping the secret redaction
 * that every other response passes through — the read-side mirror of
 * session.complete's verbatim option, for content the caller must not corrupt
 * (a diff under review). The body still travels behind the bearer token.
 */
export async function startSurface({
  app,
  assets,
  api = {},
  terminalPayload,
  terminalPayloadVerbatim = false,
  sessionTimeoutMs = 14_400_000,
  leaseTimeoutMs = 300_000,
  ackTimeoutMs = 30_000,
} = {}) {
  if (!app) throw new TypeError("An app name is required");
  // The app name is read exactly once, here, and every result and frame uses
  // that one string: an object whose string value is empty, or would change
  // after start, must not pass now and fail at the end, after the browser had
  // been told the session completed. The frame marker is proved on it too.
  const appName = String(app);
  frameName(appName);
  // A timer that setTimeout refuses would throw inside the claim, after the
  // state had changed, and one above 2^31 - 1 milliseconds is clamped to 1 ms
  // and fires at once; refuse both here instead.
  for (const [name, value] of Object.entries({ sessionTimeoutMs, leaseTimeoutMs, ackTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
      throw new TypeError(`${name} must be a positive integer of milliseconds up to ${MAX_TIMER_MS}`);
    }
  }
  if (terminalPayload !== undefined && typeof terminalPayload !== "function") {
    throw new TypeError("terminalPayload must be a function of the terminal status");
  }
  // The payload for a session that ends without the browser's completion —
  // cancelled, timed out, interrupted. An app supplies it so a consumer can
  // still route the outcome (for a review: the surface and gate ids and a
  // "cancelled" decision). It goes through the normal redaction unless the
  // app opts in to verbatim, as it must when the payload carries identity
  // fields that redaction would rewrite (a gate id that looks like a token).
  const outcomePayload = (status) => {
    if (!terminalPayload) return null;
    try {
      const payload = terminalPayload(status);
      // An outcome the frame cannot carry whole (a BigInt, a cycle, a
      // function, a symbol, an undefined value, a non-finite number, a Map or
      // Set) is no outcome: the ending must still reach the caller, with a
      // null payload. What is kept is the plain-data snapshot of one
      // serialisation, not the live object, so a value that would serialise
      // differently later cannot change the frame the caller is waiting for.
      return payload === undefined || payload === null ? null : losslessSnapshot(payload);
    } catch {
      return null;
    }
  };
  const endingFor = (status, detail) => ({ detail, payload: outcomePayload(status), verbatim: terminalPayloadVerbatim === true });
  if (!assets?.directory || !assets?.files || Object.keys(assets.files).length === 0) {
    throw new TypeError("A static shell is required: an assets directory and a route map");
  }
  const staticFiles = new Map(Object.entries(assets.files));
  for (const [route, [fileName]] of staticFiles) {
    if (typeof fileName !== "string" || fileName.includes("/") || fileName.includes("\\") || fileName.startsWith(".")) {
      throw new TypeError(`Static file names must be plain names inside the assets directory: ${route}`);
    }
    // Static files are served before the bearer check, so nothing under /api/
    // may ever be static: the promise that every API request needs the token
    // must not depend on how an app fills its route map.
    if (route === "/api" || route.startsWith("/api/")) {
      throw new TypeError(`Static routes must not live under /api/: ${route}`);
    }
  }

  let terminalState = "pending";
  let terminalClaim = null;
  let decisionSettled = false;
  let completionReserved = false;
  let port;
  let sessionTimeout;
  let leaseTimeout;
  let ackTimeout;
  let resolveDecision;
  const activeOperations = new Set();
  const token = randomBytes(32).toString("base64url");
  const decision = new Promise((resolve) => { resolveDecision = resolve; });

  const session = {
    get state() { return terminalState; },
    complete(payload, { verbatim = false } = {}) {
      if (terminalState !== "pending" || completionReserved) {
        throw httpError("This session already has a terminal decision", 409);
      }
      completionReserved = true;
      try {
        // A claim is a promise to frame this result on stdout. The app's data
        // is serialised exactly once, here, and what is claimed is the plain
        // snapshot of that serialisation. A payload JSON cannot carry (a
        // BigInt, a cycle) or would carry with loss (a function, a symbol, an
        // undefined value, a non-finite number, a Map or Set) is refused and
        // the session stays open, so the browser is never told a session
        // completed that the caller will never receive; and a payload whose
        // toJSON or getter would answer differently on a later serialisation
        // cannot change the frame, because nothing serialises it again.
        let snapshot;
        try {
          snapshot = losslessSnapshot(payload);
        } catch (error) {
          throw httpError(`The completion payload cannot be framed: ${error?.message ?? error}`, 500);
        }
        const result = terminalResult(appName, "completed", { payload: snapshot, verbatim });
        // The exact frame is proved now, not when the launcher writes it, and
        // the handler's copy is made now too: nothing that can fail runs
        // after the claim, so a failure here leaves the session unclaimed and
        // open rather than claimed with no operation id to acknowledge.
        let copy;
        try {
          frameResult(result);
          copy = structuredClone(result);
        } catch (error) {
          throw httpError(`The completion cannot be framed: ${error?.message ?? error}`, 500);
        }
        if (!claimTerminal("completed", result)) {
          throw httpError("This session already has a terminal decision", 409);
        }
        // The claim owns its data. A handler gets the copy, so nothing it does
        // to what it got back can change the frame the caller receives.
        return copy;
      } finally {
        completionReserved = false;
      }
    },
    async run(operation) {
      if (terminalState !== "pending") {
        throw httpError("This session is closed", 409);
      }
      const controller = new AbortController();
      activeOperations.add(controller);
      try {
        return await operation(controller.signal);
      } finally {
        activeOperations.delete(controller);
      }
    },
  };

  const server = http.createServer(async (request, response) => {
    try {
      const expectedHost = `127.0.0.1:${port}`;
      if (request.headers.host !== expectedHost) {
        sendJson(response, 421, { error: "Invalid host" });
        return;
      }
      const requestUrl = new URL(request.url || "/", `http://${expectedHost}`);
      const isApi = requestUrl.pathname.startsWith("/api/");
      // The /api/ prefix is decided first: an API path never resolves to a
      // static file, whatever the route map says (the map is also refused any
      // /api/ key at startup).
      const staticFile = isApi ? undefined : staticFiles.get(requestUrl.pathname);
      if (request.method === "GET" && staticFile) {
        await sendStatic(response, assets.directory, staticFile);
        return;
      }
      if (!isApi) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      if (!authorized(request, token)) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (request.method !== "GET" && request.headers.origin !== `http://${expectedHost}`) {
        sendJson(response, 403, { error: "Invalid origin" });
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/heartbeat") {
        requireOpenSession();
        assertExactKeys(await readJson(request), []);
        requireOpenSession();
        renewLease();
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/cancel") {
        assertExactKeys(await readJson(request), []);
        const result = terminalResult(appName, "cancelled", endingFor("cancelled","The user cancelled the surface"));
        if (!claimTerminal("cancelled", result)) {
          sendJson(response, 409, { error: "This session already has a terminal decision" });
          return;
        }
        sendJson(response, 200, { ok: true, status: terminalState, operationId: result.operationId });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/ack") {
        const body = await readJson(request);
        assertExactKeys(body, ["operationId"]);
        if (!terminalClaim || body.operationId !== terminalClaim.operationId) {
          sendJson(response, 409, { error: "No matching terminal decision is awaiting acknowledgement" });
          return;
        }
        response.once("finish", finalizeClaim);
        sendJson(response, 200, { ok: true, status: terminalState });
        return;
      }

      const handler = api[`${request.method} ${requestUrl.pathname}`];
      if (!handler) {
        sendJson(response, 404, { error: "Not found" });
        return;
      }
      requireOpenSession();
      renewLease();
      const body = request.method === "GET" ? null : await readJson(request);
      // The check above ran when the headers arrived; the body can take
      // longer, and the session can close while it is still on the wire. Check
      // again before any app code runs, and snapshot the claim only then, so a
      // closure during the read is refused rather than compared against itself.
      requireOpenSession();
      const claimBefore = terminalClaim;
      // Two authenticated handlers can race to complete. Only the request
      // whose own complete() won may report success; the loser's 409 must
      // reach its client, or two clients report success while only one
      // result was framed. So this request's completion is tracked here, not
      // inferred from "a completion happened during the handler".
      let completedHere = false;
      const scoped = Object.create(session, {
        complete: {
          value: (payload, options) => {
            const result = session.complete(payload, options);
            completedHere = true;
            return result;
          },
        },
      });
      let outcome;
      try {
        outcome = await handler({ body, session: scoped });
      } catch (error) {
        // A handler that completed the session and then threw must not
        // contradict the caller: the completion stands and the browser
        // gets it, with the operationId it needs to acknowledge.
        if (completedHere && terminalClaim && terminalClaim.status === "completed") {
          sendJson(response, 200, { ok: true, operationId: terminalClaim.operationId });
          return;
        }
        throw error;
      }
      if (response.headersSent || response.destroyed) return;
      // A terminal decision that arrived DURING the handler but was not this
      // request's own completion — a timeout, or another request's completion
      // that this handler stood by or swallowed the 409 of — must not look
      // like success, and its operationId must never reach this client.
      if (terminalClaim && terminalClaim !== claimBefore && !completedHere) {
        sendJson(response, 409, { error: terminalClaim.status === "completed" ? "This session already has a terminal decision" : "This session is closed" });
        return;
      }
      if (completedHere) {
        // Once this request has claimed the session, its response is the
        // fixed acknowledgement and nothing else: a body the handler returned
        // after completing is ordinary app output that could fail to
        // serialise, and nothing fallible may run after the claim, or the
        // browser is left with a completed session it cannot acknowledge.
        sendJson(response, 200, { ok: true, operationId: terminalClaim.operationId });
        return;
      }
      const verbatim = outcome?.verbatim === true;
      sendJson(response, outcome?.status ?? 200, outcome?.body ?? { ok: true }, { verbatim });
    } catch (error) {
      sendJson(response, error?.statusCode || (error?.code === "BODY_TOO_LARGE" ? 413 : 400), {
        error: safeText(error?.message || "Request failed", 300),
      });
    }
  });

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  sessionTimeout = setTimeout(() => {
    const result = terminalResult(appName, "timed_out", endingFor("timed_out","The surface session timed out"));
    if (claimTerminal("timed_out", result, { awaitAcknowledgement: false })) finalizeClaim();
  }, sessionTimeoutMs);
  sessionTimeout.unref?.();
  renewLease();

  function claimTerminal(status, result, { awaitAcknowledgement = true } = {}) {
    if (terminalState !== "pending") return false;
    terminalState = status;
    terminalClaim = result;
    clearTimeout(sessionTimeout);
    clearTimeout(leaseTimeout);
    for (const controller of activeOperations) controller.abort();
    if (awaitAcknowledgement) {
      ackTimeout = setTimeout(finalizeClaim, ackTimeoutMs);
      ackTimeout.unref?.();
    }
    return true;
  }

  function renewLease() {
    clearTimeout(leaseTimeout);
    if (terminalState !== "pending") return;
    leaseTimeout = setTimeout(() => {
      const result = terminalResult(appName, "timed_out", endingFor("timed_out","The surface disconnected"));
      if (claimTerminal("timed_out", result, { awaitAcknowledgement: false })) finalizeClaim();
    }, leaseTimeoutMs);
    leaseTimeout.unref?.();
  }

  function finalizeClaim() {
    if (!terminalClaim || decisionSettled) return false;
    decisionSettled = true;
    clearTimeout(ackTimeout);
    resolveDecision(terminalClaim);
    return true;
  }

  function requireOpenSession() {
    if (terminalState !== "pending") throw httpError("This session is closed", 409);
  }

  return {
    origin,
    url: `${origin}/#${token}`,
    port,
    waitForDecision: () => decision,
    interrupt(signal = "signal") {
      if (terminalState !== "pending") return finalizeClaim();
      const result = terminalResult(appName, "interrupted", endingFor("interrupted",`Interrupted by ${signal}`));
      if (!claimTerminal("interrupted", result, { awaitAcknowledgement: false })) return false;
      return finalizeClaim();
    },
    async stop() {
      if (terminalState === "pending") {
        const result = terminalResult(appName, "interrupted", endingFor("interrupted","The caller stopped the session"));
        if (claimTerminal("interrupted", result, { awaitAcknowledgement: false })) finalizeClaim();
      } else {
        finalizeClaim();
      }
      clearTimeout(sessionTimeout);
      clearTimeout(leaseTimeout);
      clearTimeout(ackTimeout);
      for (const controller of activeOperations) controller.abort();
      if (!server.listening) return;
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    },
  };
}

export function assertExactKeys(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be a JSON object");
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = allowedKeys.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError("Request body does not match the expected schema");
  }
}

export function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function authorized(request, expectedToken) {
  const value = request.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const received = Buffer.from(value.slice(7));
  const expected = Buffer.from(expectedToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// The plain-data snapshot of one JSON serialisation of `value`, or a throw when
// JSON could not carry it whole. JSON.stringify throws on a cycle or a BigInt
// but silently drops a function, a symbol, an undefined value, or a
// symbol-keyed property, turns a non-finite number into null, and turns any
// object that is not a plain object or an array (a Map, a RegExp, an Error, a
// Promise, an ArrayBuffer, a class instance) into {} or a fragment — each a
// payload framed as something other than what the app handed over. The replacer sees every value once, after any toJSON, so the
// check and the snapshot are one pass: a getter or toJSON is consulted exactly
// once, and what it answered is what gets framed. Symbol-keyed and
// non-enumerable properties are skipped before the replacer ever sees them,
// so each object is checked for them directly.
function losslessSnapshot(value) {
  let lost = null;
  const text = JSON.stringify(value, function replacer(key, item) {
    const where = key === "" ? "the payload" : `"${key}"`;
    if (item === undefined || typeof item === "function" || typeof item === "symbol") {
      lost ??= `${item === undefined ? "an undefined value" : `a ${typeof item}`} at ${where}`;
      return undefined;
    }
    if (typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0))) {
      lost ??= `${Object.is(item, -0) ? "negative zero" : "a non-finite number"} at ${where}`;
      return null;
    }
    if (item && typeof item === "object") {
      // Only a plain object or an array survives JSON whole. Anything else —
      // a Map, a Set, a RegExp, an Error, a Promise, an ArrayBuffer, a typed
      // array, a class instance — comes out as {} or a fragment. (A value
      // with its own toJSON was already replaced by what toJSON returned.)
      const proto = Object.getPrototypeOf(item);
      if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) {
        lost ??= `${Object.prototype.toString.call(item)} at ${where}`;
        return undefined;
      }
      // An array is its indexed items and nothing else: JSON drops an extra
      // property and fills a hole with null.
      if (Array.isArray(item)) {
        const keys = Object.keys(item);
        if (keys.length !== item.length || keys.some((key, index) => key !== String(index))) {
          lost ??= `an array with extra properties or holes at ${where}`;
          return undefined;
        }
      }
      if (Object.getOwnPropertySymbols(item).length > 0) {
        lost ??= `a symbol-keyed property at ${where}`;
        return undefined;
      }
      // JSON skips a non-enumerable property too (an array's own length aside).
      const owned = Object.getOwnPropertyNames(item).filter((name) => !(Array.isArray(item) && name === "length")).length;
      if (owned !== Object.keys(item).length) {
        lost ??= `a non-enumerable property at ${where}`;
        return undefined;
      }
    }
    return item;
  });
  if (lost !== null) throw new TypeError(`JSON cannot carry ${lost}`);
  if (text === undefined) throw new TypeError("JSON cannot carry the payload");
  return JSON.parse(text);
}

async function readJson(request) {
  const contentType = request.headers["content-type"] || "";
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  const chunks = [];
  let size = 0;
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    const error = new Error("Request body is too large");
    error.code = "BODY_TOO_LARGE";
    throw error;
  }
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function sendStatic(response, directory, [fileName, contentType]) {
  const content = await fs.readFile(path.join(directory, fileName));
  response.writeHead(200, {
    ...securityHeaders(),
    "Content-Type": contentType,
    "Content-Length": content.length,
  });
  response.end(content);
}

function sendJson(response, status, body, { verbatim = false } = {}) {
  if (response.headersSent || response.destroyed) return;
  const content = Buffer.from(JSON.stringify(verbatim ? body : sanitizeValue(body)));
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": content.length,
  });
  response.end(content);
}

function securityHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
