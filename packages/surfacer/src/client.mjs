/**
 * Browser client kit, no framework. The app bundles or serves this module
 * and calls createSurfaceClient() once at startup. The kit reads the
 * session token from the URL fragment, removes it from the address bar,
 * sends the heartbeat that keeps the lease alive, and wraps every API call
 * with the bearer token. submit() and cancel() acknowledge the terminal
 * decision so the server can hand the result to its caller.
 */
export function createSurfaceClient({ heartbeatMs = 15_000 } = {}) {
  const token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  if (!token) throw new Error("This surface needs its session link, not a bare URL");

  async function api(endpoint, body) {
    // Resolve against our origin and require it stays here. URL parsing
    // strips tabs and newlines, so string-prefix checks are not enough:
    // "/\t/evil/x" resolves off-origin. Compare resolved origins instead.
    let resolved;
    try {
      resolved = new URL(endpoint, location.origin);
    } catch {
      throw new Error("Surface API endpoint is not a valid path");
    }
    if (resolved.origin !== location.origin) {
      throw new Error("Surface API endpoints must stay on the session origin");
    }
    const response = await fetch(endpoint, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  const heartbeat = setInterval(() => api("/api/heartbeat", {}).catch(() => null), heartbeatMs);

  async function acknowledge(operationId) {
    if (operationId) await api("/api/ack", { operationId }).catch(() => null);
    clearInterval(heartbeat);
  }

  return {
    api,
    async submit(endpoint, body) {
      try {
        const result = await api(endpoint, body);
        await acknowledge(result.operationId);
        return result;
      } catch (error) {
        clearInterval(heartbeat);
        throw error;
      }
    },
    async cancel() {
      try {
        const result = await api("/api/cancel", {});
        await acknowledge(result.operationId);
        return result;
      } catch (error) {
        clearInterval(heartbeat);
        throw error;
      }
    },
    dispose() {
      clearInterval(heartbeat);
    },
  };
}
