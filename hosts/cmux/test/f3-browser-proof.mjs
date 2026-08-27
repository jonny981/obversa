// Browser proof of the review surface under the runtime's exact security
// headers and auth model. A local server mirrors the surfacer contract on the
// parts that matter — the Content-Security-Policy header (asserted below to be
// the very string in packages/surfacer/src/server.mjs, so drift fails this
// test), a bearer-gated verbatim GET /api/model, a static shell with no diff
// — and serves the real assets and the real client kit. Headless Chrome loads
// the session URL; a probe registered before app.js counts CSP violations and
// inline styles, waits for the render, exercises the tree, the context bands,
// and go-to-source, and posts the results back.
//
// The go-to-source check clicks an identifier in the SECOND file, whose line
// numbers overlap the first file's, and requires the flashed definition row to
// be in the same file section: the regression test for the document-wide
// lookup that once jumped between files.
//
// Skips when Google Chrome is not installed; the runtime proof
// (f3-review-proof.mjs) still covers the server side without a browser.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseUnifiedDiff } from "../../../packages/source/src/diff.mjs";
import { computeDiff, listTrackedFiles } from "../../../packages/source/src/git.mjs";
import { createHighlightRegistry, registryToCss } from "../../../packages/source/src/highlight.mjs";
import { highlightModel } from "../../../packages/source/src/highlight-model.mjs";
import { contextModel } from "../../../packages/source/src/context-model.mjs";
import { navModel } from "../../../packages/source/src/nav-model.mjs";
import { buildIndexHtml, ASSETS_DIR } from "../../../packages/source/src/page.mjs";

const CHROME_CANDIDATES = [
  process.env.OBVERSA_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));

const SURFACER_SERVER = new URL("../../../packages/surfacer/src/server.mjs", import.meta.url);
const CLIENT_KIT = new URL("../../../packages/surfacer/src/client.mjs", import.meta.url);
// The runtime's headers, verbatim. The CSP is asserted against server.mjs.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const HEADERS = {
  "Content-Security-Policy": CSP,
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

// Two files whose line numbers overlap: a new file (every line shown, so
// definitions are in view) and a longer modified file (context bands).
const SESSION = `import { createHmac } from "node:crypto";
const TTL_MS = 30 * 60 * 1000;
function sign(userId, expires, secret) {
  return createHmac("sha256", secret).update(userId + "." + expires).digest("hex");
}
export function issue(userId, secret) {
  const expires = Date.now() + TTL_MS;
  return userId + "." + expires + "." + sign(userId, expires, secret);
}
export function verify(token, secret) {
  const [userId, expires, mac] = token.split(".");
  return mac === sign(userId, expires, secret) ? userId : null;
}
`;
const SERVER_OLD = Array.from({ length: 30 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
const SERVER_NEW = SERVER_OLD.replace("export const line15 = 15;", "export const line15 = 150; // token=ghp_ABC123verbatimSECRET");

const PROBE = `(() => {
  const violations = [];
  document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective + " " + (e.blockedURI || "")));
  const started = Date.now();
  const tick = () => {
    const app = document.getElementById("app");
    const rendered = app && app.getAttribute("aria-busy") === "false" && document.querySelector(".row");
    if (!rendered && Date.now() - started < 8000) return setTimeout(tick, 100);
    const sections = document.querySelectorAll(".file");
    const jumps = document.querySelectorAll(".nav-jump");
    let flashed = false, clicked = null, sameFile = false;
    const j = (sections[1] && sections[1].querySelector(".nav-jump")) || jumps[0];
    if (j) {
      clicked = j.textContent; j.click();
      const flashedRow = document.querySelector(".row.flash");
      flashed = !!flashedRow;
      sameFile = !!flashedRow && flashedRow.closest(".file") === j.closest(".file");
    }
    const bt = document.querySelector(".context-toggle");
    let bandExpandOk = false;
    if (bt) { bt.click(); bandExpandOk = document.querySelectorAll(".context-rows .row-context").length > 0; }
    const tabs = document.querySelectorAll(".tree-tab");
    const treeFiles = document.querySelectorAll(".tree-file-btn").length;
    let allFilesCount = 0;
    if (tabs.length > 1) { tabs[1].click(); allFilesCount = document.querySelectorAll(".tree-file-btn").length; }
    fetch("/results", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      rendered: !!rendered, appText: (app && app.textContent || "").slice(0, 60), violations,
      inlineStyleAttrs: document.querySelectorAll("[style]").length,
      styleTags: document.querySelectorAll("style").length,
      tokenSpans: document.querySelectorAll("code.code span[class^='tok-']").length,
      sections: sections.length, jumps: jumps.length, clicked, flashed, sameFile,
      treeFiles, contextBands: document.querySelectorAll(".context-band").length, bandExpandOk,
      tabs: tabs.length, allFilesCount,
    }) });
  };
  window.addEventListener("load", () => setTimeout(tick, 200));
})();`;

async function buildModel() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "browser-proof-"));
  const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T"); git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(cwd, "src"), { recursive: true });
  writeFileSync(path.join(cwd, "src/server.js"), SERVER_OLD);
  writeFileSync(path.join(cwd, "src/config.js"), "export const PORT = 3000;\n");
  git("add", "."); git("commit", "-q", "-m", "initial");
  writeFileSync(path.join(cwd, "src/server.js"), SERVER_NEW);
  writeFileSync(path.join(cwd, "src/session.js"), SESSION);
  git("add", "-N", "src/session.js");
  try {
    const { diffText } = await computeDiff({ mode: "worktree", cwd });
    const model = parseUnifiedDiff(diffText);
    const registry = createHighlightRegistry();
    await highlightModel(model, registry);
    await contextModel(model, { mode: "worktree", cwd, registry });
    await navModel(model, { mode: "worktree", cwd });
    const meta = { mode: "worktree", range: null, label: "working tree", fileCount: model.files.length, allFiles: await listTrackedFiles({ cwd }) };
    return { model, meta, highlightCss: registryToCss(registry) };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("the runtime's CSP in this proof is the one surfacer serves", async () => {
  const serverSource = await readFile(SURFACER_SERVER, "utf8");
  assert.ok(serverSource.includes(`"Content-Security-Policy": "${CSP}"`), "surfacer's CSP changed; update this proof to match");
});

test("the review surface renders under the exact CSP with zero violations and file-scoped go-to-source", { skip: CHROME ? false : "Google Chrome is not installed", timeout: 60_000 }, async () => {
  const { model, meta, highlightCss } = await buildModel();
  const token = randomBytes(16).toString("hex");
  const clientKit = await readFile(CLIENT_KIT, "utf8");
  const shell = buildIndexHtml({ meta }).replace('<script type="module" src="/app.js"></script>', '<script src="/probe.js"></script>\n<script type="module" src="/app.js"></script>');
  const assets = {
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/nav-segments.mjs": ["nav-segments.mjs", "text/javascript; charset=utf-8"],
    "/file-tree.mjs": ["file-tree.mjs", "text/javascript; charset=utf-8"],
    "/icons.mjs": ["icons.mjs", "text/javascript; charset=utf-8"],
  };
  const results = Promise.withResolvers();
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
    if (url.pathname === "/results" && req.method === "POST") {
      const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => { res.writeHead(204); res.end(); results.resolve(JSON.parse(Buffer.concat(chunks).toString())); });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, "application/json", JSON.stringify({ error: "Authentication required" }));
      if (url.pathname === "/api/model" && req.method === "GET") return send(200, "application/json", JSON.stringify({ model, meta }));
      if (url.pathname === "/api/heartbeat") return send(200, "application/json", JSON.stringify({ ok: true }));
      return send(404, "application/json", JSON.stringify({ error: "Not found" }));
    }
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", shell);
    if (url.pathname === "/probe.js") return send(200, "text/javascript; charset=utf-8", PROBE);
    if (url.pathname === "/surface-client.mjs") return send(200, "text/javascript; charset=utf-8", clientKit);
    if (url.pathname === "/highlight.css") return send(200, "text/css; charset=utf-8", highlightCss);
    const asset = assets[url.pathname];
    if (asset) return send(200, asset[1], readFileSync(path.join(ASSETS_DIR, asset[0]), "utf8"));
    send(404, "text/plain", "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = mkdtempSync(path.join(os.tmpdir(), "browser-proof-profile-"));
  let chrome;
  let report;
  try {
    // The static shell carries no diff; the model is gated.
    const shellText = await (await fetch(`${origin}/`)).text();
    assert.doesNotMatch(shellText, /verbatimSECRET|review-data|line15/);
    assert.equal((await fetch(`${origin}/api/model`)).status, 401);

    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, `${origin}/#${token}`], { stdio: "ignore" });
    const timeout = setTimeout(() => results.reject(new Error("the page posted no results within 30s")), 30_000);
    try { report = await results.promise; } finally { clearTimeout(timeout); }
  } finally {
    chrome?.kill("SIGKILL");
    if (chrome) await new Promise((r) => { chrome.once("exit", r); setTimeout(r, 1500); });
    server.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }

  assert.ok(report.rendered, `did not render: ${report.appText}`);
  assert.deepEqual(report.violations, [], "CSP violations");
  assert.equal(report.inlineStyleAttrs, 0, "inline style attributes");
  assert.equal(report.styleTags, 0, "<style> tags");
  assert.ok(report.tokenSpans > 0, "highlight tokens");
  assert.equal(report.sections, 2, "two file sections");
  assert.ok(report.jumps > 0, "go-to-source identifiers");
  assert.ok(report.flashed, `clicking ${report.clicked} did not flash a definition`);
  assert.ok(report.sameFile, `clicking ${report.clicked} flashed a row in another file`);
  assert.ok(report.treeFiles > 0, "file tree");
  assert.ok(report.contextBands > 0 && report.bandExpandOk, "context bands expand");
  assert.ok(report.tabs >= 2 && report.allFilesCount > report.treeFiles, "All files tab");
});
