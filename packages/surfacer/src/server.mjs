import { randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";

import { terminalResult } from "./handoff.mjs";
import { safeText, sanitizeValue } from "./sanitize.mjs";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

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
 * { status, body } or call session.complete(payload).
 */
export async function startSurface({
  app,
  assets,
  api = {},
  sessionTimeoutMs = 14_400_000,
  leaseTimeoutMs = 300_000,
  ackTimeoutMs = 30_000,
} = {}) {
  if (!app) throw new TypeError("An app name is required");
  if (!assets?.directory || !assets?.files || Object.keys(assets.files).length === 0) {
    throw new TypeError("A static shell is required: an assets directory and a route map");
  }
  const staticFiles = new Map(Object.entries(assets.files));

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
        const result = terminalResult(app, "completed", { payload, verbatim });
        if (!claimTerminal("completed", result)) {
          throw httpError("This session already has a terminal decision", 409);
        }
        return result;
      } finally {
        completionReserved = false;
      }
    },
    async run(operation) {
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
      const staticFile = staticFiles.get(requestUrl.pathname);
      if (request.method === "GET" && staticFile) {
        await sendStatic(response, assets.directory, staticFile);
        return;
      }
      if (!requestUrl.pathname.startsWith("/api/")) {
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
        renewLease();
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/cancel") {
        assertExactKeys(await readJson(request), []);
        const result = terminalResult(app, "cancelled", { detail: "The user cancelled the surface" });
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
      const claimBefore = terminalClaim;
      const outcome = await handler({ body, session });
      if (response.headersSent || response.destroyed) return;
      // A terminal decision that arrived DURING the handler but was not this
      // handler's own completion (a lease or session timeout) must not look
      // like success — and its operationId must never reach this client.
      if (terminalClaim && terminalClaim !== claimBefore && terminalClaim.status !== "completed") {
        sendJson(response, 409, { error: "This session is closed" });
        return;
      }
      if (terminalClaim && outcome?.body && typeof outcome.body === "object" && !Array.isArray(outcome.body)) {
        sendJson(response, outcome.status ?? 200, { ...outcome.body, operationId: terminalClaim.operationId });
        return;
      }
      sendJson(response, outcome?.status ?? 200, outcome?.body ?? { ok: true });
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
    const result = terminalResult(app, "timed_out", { detail: "The surface session timed out" });
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
      const result = terminalResult(app, "timed_out", { detail: "The surface disconnected" });
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
      const result = terminalResult(app, "interrupted", { detail: `Interrupted by ${signal}` });
      if (!claimTerminal("interrupted", result, { awaitAcknowledgement: false })) return false;
      return finalizeClaim();
    },
    async stop() {
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

function sendJson(response, status, body) {
  if (response.headersSent || response.destroyed) return;
  const content = Buffer.from(JSON.stringify(sanitizeValue(body)));
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
