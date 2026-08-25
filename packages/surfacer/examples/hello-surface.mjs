// Runnable example: node examples/hello-surface.mjs
// Opens a one-question surface and prints the framed result on stdout.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { runSurface } from "../src/launcher.mjs";

const directory = mkdtempSync(path.join(os.tmpdir(), "hello-surface-"));
// The session CSP is script-src 'self' with no inline allowance, so the
// page logic ships as its own file.
writeFileSync(path.join(directory, "index.html"), `<!doctype html>
<title>Hello surface</title>
<h1>Answer the one question</h1>
<button id="yes">Yes</button><button id="no">No</button>
<script type="module" src="/app.js"></script>`);
writeFileSync(path.join(directory, "app.js"), `
const token = location.hash.slice(1); history.replaceState(null, "", location.pathname);
const api = (p, b) => fetch(p, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
document.getElementById("yes").onclick = async () => { const r = await api("/api/answer", { value: true }); await api("/api/ack", { operationId: r.operationId }); document.body.textContent = "Done."; };
document.getElementById("no").onclick = async () => { const r = await api("/api/cancel", {}); await api("/api/ack", { operationId: r.operationId }); document.body.textContent = "Done."; };
`);

let result;
try {
  ({ result } = await runSurface({
  app: "hello-surface",
  assets: { directory, files: {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  } },
  api: {
    "POST /api/answer": async ({ body, session }) => {
      session.complete({ value: body.value === true });
      return null;
    },
  },
    leaseTimeoutMs: 120_000,
  }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
process.exit(result.status === "completed" ? 0 : 1);
