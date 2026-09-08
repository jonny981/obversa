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
// The go-to-source check clicks `sign` in the SECOND file, whose definition is
// on line 3, while the FIRST file's hunk also shows a line 3; it requires the
// flashed definition row to be in the second file's section. A document-wide
// line lookup finds the first file's row 3 first, so this fails for the bug it
// locks down (that mutation was run to confirm it). The test also asserts its
// own premise: line 3 is present in both sections.
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

import { ASSETS_DIR, buildIndexHtml, computeDiff, parseUnifiedDiff } from "@obversa/source";
import {
  contextModel,
  createHighlightRegistry,
  highlightModel,
  listTrackedFiles,
  navModel,
  registryToCss,
} from "@obversa/source/testing";

const CHROME_CANDIDATES = [
  process.env.OBVERSA_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const BROWSER_TEST_TIMEOUT_MS = 120_000;
const BROWSER_RESULTS_TIMEOUT_MS = 60_000;
const BROWSER_ACK_TIMEOUT_MS = 10_000;
const BROWSER_RENDER_TIMEOUT_MS = 30_000;
const DEVTOOLS_PORT_TIMEOUT_MS = 10_000;
const DEVTOOLS_TARGET_TIMEOUT_MS = 10_000;
const DEVTOOLS_FETCH_TIMEOUT_MS = 5_000;
const BROWSER_SETUP_ALLOWANCE_MS = 14_000;
const BROWSER_CLEANUP_ALLOWANCE_MS = 15_000;

const BROWSER_TEST_CHAINS = {
  render: [
    ["setup", BROWSER_SETUP_ALLOWANCE_MS],
    ["page post", BROWSER_RESULTS_TIMEOUT_MS],
    ["DevTools port", DEVTOOLS_PORT_TIMEOUT_MS],
    ["DevTools target", DEVTOOLS_TARGET_TIMEOUT_MS],
    ["acknowledgement", BROWSER_ACK_TIMEOUT_MS],
    ["cleanup", BROWSER_CLEANUP_ALLOWANCE_MS],
  ],
  cancel: [
    ["setup", BROWSER_SETUP_ALLOWANCE_MS],
    ["acknowledgement", BROWSER_ACK_TIMEOUT_MS],
    ["cleanup", BROWSER_CLEANUP_ALLOWANCE_MS],
  ],
};

assert.ok(BROWSER_RENDER_TIMEOUT_MS < BROWSER_RESULTS_TIMEOUT_MS, "the in-page probe must finish before the page-post guard");
for (const [name, chain] of Object.entries(BROWSER_TEST_CHAINS)) {
  const total = chain.reduce((sum, [, allowance]) => sum + Number(allowance), 0);
  assert.ok(total < BROWSER_TEST_TIMEOUT_MS, `${name} browser budget chain exceeds its test budget: ${total}ms >= ${BROWSER_TEST_TIMEOUT_MS}ms`);
}

const SURFACER_SERVER = new URL("../../surfacer/src/server.mjs", import.meta.url);
const CLIENT_KIT = new URL("../../surfacer/src/client.mjs", import.meta.url);
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
// The first file changes on line 3, so its hunk shows lines 1–6: line 3 is
// visible in both sections. A second change deep in the file keeps a
// collapsible context band between the hunks.
const SERVER_OLD = Array.from({ length: 30 }, (_, i) => `export const line${i} = ${i};`).join("\n") + "\n";
const SERVER_NEW = SERVER_OLD
  .replace("export const line2 = 2;", "export const line2 = 20;")
  .replace("export const line15 = 15;", "export const line15 = 150; // token=ghp_ABC123verbatimSECRET");

const PROBE = `(() => {
  const violations = [];
  document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective + " " + (e.blockedURI || "")));
  const deadline = Date.now() + ${BROWSER_RENDER_TIMEOUT_MS};
  const tick = () => {
    const app = document.getElementById("app");
    const rendered = app && app.getAttribute("aria-busy") === "false" && document.querySelector(".row");
    if (!rendered && Date.now() < deadline) return setTimeout(tick, 100);
    const sections = document.querySelectorAll(".file");
    const jumps = document.querySelectorAll(".nav-jump");
    let flashed = false, clicked = null, sameFile = false, defLine = null, premise = false;
    // Click a use of sign (defined on line 3) in the second file.
    const j = sections[1] && [...sections[1].querySelectorAll(".nav-jump")].find((s) => s.textContent === "sign");
    if (j) {
      const m = /line (\\d+)/.exec(j.title || ""); defLine = m ? Number(m[1]) : null;
      premise = !!sections[0].querySelector('.row[data-new-line="' + defLine + '"]') && !!sections[1].querySelector('.row[data-new-line="' + defLine + '"]');
      clicked = j.textContent; j.click();
      const flashedRow = document.querySelector(".row.flash");
      flashed = !!flashedRow;
      sameFile = !!flashedRow && flashedRow.closest(".file") === sections[1];
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
      // The highlight rules came with the model and were applied as a
      // constructed stylesheet; a token must paint in a colour of its own.
      tokenPainted: (() => {
        const span = document.querySelector("code.code span[class^='tok-']");
        if (!span) return false;
        const own = getComputedStyle(span).color;
        return !!own && own !== getComputedStyle(span.parentElement).color;
      })(),
      sections: sections.length, jumps: jumps.length, clicked, defLine, premise, flashed, sameFile,
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

// Chrome's helper processes can outlive a killed browser for a moment and
// keep writing into the profile; removing it is best effort, retried, and a
// leftover temporary directory is not a failed proof.
async function removeProfile(profile) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

// A DevTools session on the review page, so the proof can press real keys:
// a Tab dispatched through the browser's input pipeline moves focus by the
// document's tab order, and an Enter activates whatever holds focus the way
// the browser activates it — a native button opens the editor, a div with a
// click handler does not. Chrome writes its debugging port to the profile
// once it listens.
async function devtools(profile, origin) {
  const portFile = path.join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (!existsSync(portFile)) {
    if (Date.now() - started > DEVTOOLS_PORT_TIMEOUT_MS) throw new Error("Chrome did not open a DevTools port");
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`browser DevTools port wait: ${Date.now() - started}ms`);
  const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
  let page;
  const targetDeadline = Date.now() + DEVTOOLS_TARGET_TIMEOUT_MS;
  while (!page && Date.now() < targetDeadline) {
    let targets;
    const fetchStarted = Date.now();
    try {
      targets = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(DEVTOOLS_FETCH_TIMEOUT_MS) })).json());
    } catch {
      if (Date.now() >= targetDeadline) break;
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    page = targets.find((t) => t.type === "page" && t.url.startsWith(origin));
    if (page) console.log(`browser DevTools target fetch: ${Date.now() - fetchStarted}ms`);
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw new Error("the review page is not a DevTools target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = message.id && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (exceptionDetails) throw new Error(`${exceptionDetails.text}: ${exceptionDetails.exception?.description ?? ""}`);
    return result.value;
  };
  // A key press as the browser sees one: the down event carries the
  // character for keys that produce one (Enter), so the page receives the
  // keypress a native control activates on.
  const press = async (key, keyCode, text) => {
    const base = { key, code: key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  return {
    send,
    evaluate,
    tab: () => press("Tab", 9),
    enter: () => press("Enter", 13, "\r"),
    type: (text) => send("Input.insertText", { text }),
    close: () => ws.close(),
  };
}

// The keyboard route to a comment, pressed for real: Tab from the document
// until an add-comment button holds focus (it must be painted then), Enter
// to open the editor (the textarea takes focus), Tab to Discard and Enter
// (the editor closes, focus returns to the button that opened it), Enter
// again, text, Tab to Save and Enter (the comment renders, focus returns to
// that button). Every state is read from the live document.
async function keyboardRoute(dt) {
  await dt.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const active = (expression) => dt.evaluate(`(() => { const a = document.activeElement; ${expression} })()`);
  let tabs = 0;
  let reached = null;
  while (tabs < 400 && !reached) {
    await dt.tab();
    tabs += 1;
    // The opener's row names the line it annotates and the thread the
    // comment must land in (the element after the row); its label names
    // the side, the line, and the file.
    reached = await active(`if (!a || !a.classList.contains("add-comment")) return null; const s = getComputedStyle(a); window.__opener = a; window.__thread = a.closest(".row").nextElementSibling; return { visible: s.visibility !== "hidden" && s.opacity === "1", label: a.getAttribute("aria-label"), rowLine: a.closest(".row").dataset.newLine, threadIsNext: window.__thread.classList.contains("thread") };`);
  }
  if (!reached) return { tabs, reached: false };
  await dt.enter();
  const opened = await active(`const t = window.__thread.querySelector('textarea[aria-label="Comment text"]'); return { editorOpened: !!t, editorFocused: !!t && a === t };`);
  await dt.tab(); // Save
  await dt.tab(); // Discard
  const discardTarget = await active(`return a && a.textContent;`);
  await dt.enter();
  const discarded = await active(`return { discardClosed: !document.querySelector(".editor"), discardReturned: a === window.__opener };`);
  await dt.enter(); // the opener holds focus again: reopen
  await dt.type("Looks wrong");
  await dt.tab(); // Save
  const saveTarget = await active(`return a && a.textContent;`);
  await dt.enter();
  // The one comment in the document is in the opener's own thread.
  const firstSave = await active(`const all = document.querySelectorAll(".comment-body"); const c = window.__thread.querySelector(".comment-body"); return { saved: c && c.textContent, commentsInDocument: all.length, saveClosed: !document.querySelector(".editor"), saveReturned: a === window.__opener };`);
  // Remove the comment from the keyboard: Tab from the opener reaches the
  // comment's Remove button (the thread follows the row), Enter removes it,
  // and focus returns to the opener rather than being dropped.
  await dt.tab();
  const removeTarget = await active(`return a && a.textContent;`);
  await dt.enter();
  const removed = await active(`return { removed: !window.__thread.querySelector(".comment"), removeReturned: a === window.__opener };`);
  // Put the comment back the same way, so the return below carries one.
  await dt.enter();
  await dt.type("Looks wrong");
  await dt.tab(); // Save
  await dt.enter();
  const saved = await active(`const all = document.querySelectorAll(".comment-body"); const c = window.__thread.querySelector(".comment-body"); return { saved: c && c.textContent, commentsInDocument: all.length, saveClosed: !document.querySelector(".editor"), saveReturned: a === window.__opener };`);
  // Return the review: what the page sends is what the reviewer gets.
  const returned = await dt.evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /^Return 1 annotation/.test(x.textContent)); if (!b) return null; b.click(); return b.textContent; })()`);
  return { tabs, reached: true, ...reached, ...opened, discardTarget, ...discarded, saveTarget, firstSaveReturned: firstSave.saveReturned, removeTarget, ...removed, ...saved, returned };
}

test("the runtime's CSP in this proof is the one surfacer serves", async () => {
  const serverSource = await readFile(SURFACER_SERVER, "utf8");
  assert.ok(serverSource.includes(`"Content-Security-Policy": "${CSP}"`), "surfacer's CSP changed; update this proof to match");
});

test("the review surface renders under the exact CSP with zero violations and file-scoped go-to-source", { skip: CHROME ? false : "Google Chrome is not installed", timeout: BROWSER_TEST_TIMEOUT_MS }, async () => {
  const { model, meta, highlightCss } = await buildModel();
  const token = randomBytes(16).toString("hex");
  const clientKit = await readFile(CLIENT_KIT, "utf8");
  const shell = buildIndexHtml().replace('<script type="module" src="/app.js"></script>', '<script src="/probe.js"></script>\n<script type="module" src="/app.js"></script>');
  const assets = {
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/nav-segments.mjs": ["nav-segments.mjs", "text/javascript; charset=utf-8"],
    "/file-tree.mjs": ["file-tree.mjs", "text/javascript; charset=utf-8"],
    "/icons.mjs": ["icons.mjs", "text/javascript; charset=utf-8"],
  };
  const results = Promise.withResolvers();
  // The review's return, as the surfacer would receive it: the submit body,
  // and the acknowledgement of the operation id the reply carried.
  const submitted = Promise.withResolvers();
  const acked = Promise.withResolvers();
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
    const json = (handler) => { const chunks = []; req.on("data", (d) => chunks.push(d)); req.on("end", () => handler(JSON.parse(Buffer.concat(chunks).toString() || "{}"))); };
    if (url.pathname === "/results" && req.method === "POST") {
      json((body) => { res.writeHead(204); res.end(); results.resolve(body); });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, "application/json", JSON.stringify({ error: "Authentication required" }));
      if (url.pathname === "/api/model" && req.method === "GET") return send(200, "application/json", JSON.stringify({ model, meta, highlightCss }));
      if (url.pathname === "/api/heartbeat") return send(200, "application/json", JSON.stringify({ ok: true }));
      if (url.pathname === "/api/submit" && req.method === "POST") {
        return json((body) => { submitted.resolve(body); send(200, "application/json", JSON.stringify({ ok: true, status: "completed", operationId: "op-submit" })); });
      }
      if (url.pathname === "/api/ack" && req.method === "POST") {
        return json((body) => { acked.resolve(body); send(200, "application/json", JSON.stringify({ ok: true, status: "completed" })); });
      }
      return send(404, "application/json", JSON.stringify({ error: "Not found" }));
    }
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", shell);
    if (url.pathname === "/probe.js") return send(200, "text/javascript; charset=utf-8", PROBE);
    if (url.pathname === "/surface-client.mjs") return send(200, "text/javascript; charset=utf-8", clientKit);
    const asset = assets[url.pathname];
    if (asset) return send(200, asset[1], readFileSync(path.join(ASSETS_DIR, asset[0]), "utf8"));
    send(404, "text/plain", "not found");
  });
  await /** @type {Promise<void>} */ (new Promise((r) => server.listen(0, "127.0.0.1", () => r())));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  const profile = mkdtempSync(path.join(os.tmpdir(), "browser-proof-profile-"));
  let chrome;
  let report;
  let keys;
  try {
    // The static shell carries no diff; the model is gated.
    const shellText = await (await fetch(`${origin}/`)).text();
    assert.doesNotMatch(shellText, /verbatimSECRET|review-data|line15|highlight\.css/);
    assert.equal((await fetch(`${origin}/api/model`)).status, 401);
    // The highlight rules depend on the review's tokens, so no pre-auth route serves them.
    assert.equal((await fetch(`${origin}/highlight.css`)).status, 404);

    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `${origin}/#${token}`], { stdio: "ignore" });
    const resultStarted = Date.now();
    const resultTimeout = setTimeout(() => results.reject(new Error(`the page posted no results within ${BROWSER_RESULTS_TIMEOUT_MS / 1000}s`)), BROWSER_RESULTS_TIMEOUT_MS);
    try {
      report = await results.promise;
      console.log(`browser page-post wait: ${Date.now() - resultStarted}ms`);
    } finally { clearTimeout(resultTimeout); }
    const dt = await devtools(profile, origin);
    try { keys = await keyboardRoute(dt); } finally { dt.close(); }
    const submittedStarted = Date.now();
    const acknowledgementTimeout = setTimeout(() => {
      submitted.reject(new Error("the page never returned the review"));
      acked.reject(new Error("the page never acknowledged the return"));
    }, BROWSER_ACK_TIMEOUT_MS);
    try {
      keys.payload = await submitted.promise;
      console.log(`browser submit acknowledgement: ${Date.now() - submittedStarted}ms`);
      const ackStarted = Date.now();
      keys.ack = await acked.promise;
      console.log(`browser return acknowledgement: ${Date.now() - ackStarted}ms`);
    } finally { clearTimeout(acknowledgementTimeout); }
  } finally {
    chrome?.kill("SIGKILL");
    if (chrome) await new Promise((r) => { chrome.once("exit", r); setTimeout(r, 1500); });
    server.close();
    await removeProfile(profile);
  }

  assert.ok(report.rendered, `did not render: ${report.appText}`);
  assert.deepEqual(report.violations, [], "CSP violations");
  assert.equal(report.inlineStyleAttrs, 0, "inline style attributes");
  assert.equal(report.styleTags, 0, "<style> tags");
  assert.ok(report.tokenSpans > 0, "highlight tokens");
  assert.ok(report.tokenPainted, "the highlight rules from the authenticated model paint the tokens under style-src 'self'");
  assert.equal(report.sections, 2, "two file sections");
  assert.ok(report.jumps > 0, "go-to-source identifiers");
  assert.equal(report.clicked, "sign", "the probe found a use of `sign` in the second file");
  assert.equal(report.defLine, 3, "`sign` is defined on line 3 of the second file");
  assert.ok(report.premise, "line 3 must be visible in BOTH file sections, or this test cannot catch a document-wide lookup");
  assert.ok(report.flashed, `clicking ${report.clicked} did not flash a definition`);
  assert.ok(report.sameFile, `clicking ${report.clicked} flashed a row outside the second file (document-wide lookup)`);
  assert.ok(report.treeFiles > 0, "file tree");
  assert.ok(report.contextBands > 0 && report.bandExpandOk, "context bands expand");
  assert.ok(report.tabs >= 2 && report.allFilesCount > report.treeFiles, "All files tab");
  assert.ok(keys.reached, `Tab never reached an add-comment button in ${keys.tabs} presses`);
  assert.equal(keys.visible, true, "an add-comment button is painted while it holds keyboard focus");
  assert.equal(keys.threadIsNext, true, "the button's row is followed by its thread");
  assert.match(keys.label, /^Add a comment on the new side at line (\d+) of src\//, "the button names its side, line, and file");
  assert.equal(/line (\d+)/.exec(keys.label)[1], keys.rowLine, "and the line it names is the row's own");
  assert.equal(keys.editorOpened, true, "Enter on the focused button opens the comment editor (a div with a click handler would not)");
  assert.equal(keys.editorFocused, true, "and the editor's textarea takes focus");
  assert.equal(keys.discardTarget, "Discard", "Tab reaches Discard from the textarea");
  assert.equal(keys.discardClosed, true, "Enter on Discard closes the editor");
  assert.equal(keys.discardReturned, true, "and focus returns to the button that opened it");
  assert.equal(keys.saveTarget, "Save comment", "Tab reaches Save from the text");
  assert.equal(keys.firstSaveReturned, true, "Enter on Save returns focus to the button that opened the editor");
  assert.equal(keys.removeTarget, "Remove", "Tab from the opener reaches the comment's Remove button");
  assert.equal(keys.removed, true, "Enter on Remove removes the comment");
  assert.equal(keys.removeReturned, true, "and focus returns to the line's add-comment button, not the document");
  assert.equal(keys.saved, "Looks wrong", "Enter on Save renders the comment in the thread of the row that opened it");
  assert.equal(keys.commentsInDocument, 1, "and nowhere else");
  assert.equal(keys.saveClosed, true, "and closes the editor");
  assert.equal(keys.saveReturned, true, "and focus returns to the button that opened it");
  // The returned review names the comment where the reviewer put it: the
  // file and side the button's label names, the line of the row it sits
  // on — not merely where the comment was painted.
  assert.match(keys.returned, /^Return 1 annotation/, "the return button counts the one comment");
  const [, side, line, file] = /^Add a comment on the (\w+) side at line (\d+) of (.+)$/.exec(keys.label);
  assert.equal(keys.payload.decision, "changes-requested");
  assert.equal(keys.payload.annotations.length, 1, "one annotation returned");
  assert.deepEqual(keys.payload.annotations[0].anchor, { target: file, side, position: Number(line) }, "the annotation's anchor is the opener's file, side, and line");
  assert.equal(keys.payload.annotations[0].body, "Looks wrong");
  assert.match(keys.payload.annotations[0].createdAt, /^\d{4}-\d{2}-\d{2}T/, "stamped");
  assert.deepEqual(keys.ack, { operationId: "op-submit" }, "the completion's operation id is acknowledged");
});

test("a page that cannot load its review cancels the session instead of holding the lease", { skip: CHROME ? false : "Google Chrome is not installed", timeout: BROWSER_TEST_TIMEOUT_MS }, async () => {
  // The model endpoint fails. The page must end the session — stop its
  // heartbeat, cancel, then acknowledge — so the caller receives a cancelled
  // result, rather than sit on an error while the heartbeat keeps the lease
  // alive for hours. The kit served here beats every 200 ms and the cancel
  // response is held for a second: a page that cancelled before stopping its
  // heartbeat would send several beats in that window, and the proof demands
  // none after the cancel request (a mutation that drops the dispose fails).
  const token = randomBytes(16).toString("hex");
  const clientKit = (await readFile(CLIENT_KIT, "utf8")).replace("heartbeatMs = 15_000", "heartbeatMs = 200");
  assert.match(clientKit, /heartbeatMs = 200/, "the test-only kit must carry the short heartbeat");
  const shell = buildIndexHtml();
  const assets = {
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/app.css": ["app.css", "text/css; charset=utf-8"],
    "/nav-segments.mjs": ["nav-segments.mjs", "text/javascript; charset=utf-8"],
    "/file-tree.mjs": ["file-tree.mjs", "text/javascript; charset=utf-8"],
    "/icons.mjs": ["icons.mjs", "text/javascript; charset=utf-8"],
  };
  const seen = [];
  let cancelSeen = false;
  let heartbeatsAfterCancel = 0;
  const acked = Promise.withResolvers();
  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, type, body) => { res.writeHead(status, { "content-type": type }); res.end(body); };
    if (url.pathname.startsWith("/api/")) {
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, "application/json", JSON.stringify({ error: "Authentication required" }));
      seen.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/api/model") return send(500, "application/json", JSON.stringify({ error: "the model is unavailable" }));
      if (url.pathname === "/api/cancel") {
        cancelSeen = true;
        setTimeout(() => send(200, "application/json", JSON.stringify({ ok: true, status: "cancelled", operationId: "op-cancel" })), 1000);
        return;
      }
      if (url.pathname === "/api/heartbeat" && cancelSeen) heartbeatsAfterCancel += 1;
      if (url.pathname === "/api/ack") {
        const chunks = []; req.on("data", (d) => chunks.push(d));
        req.on("end", () => { send(200, "application/json", JSON.stringify({ ok: true, status: "cancelled" })); acked.resolve(JSON.parse(Buffer.concat(chunks).toString())); });
        return;
      }
      if (url.pathname === "/api/heartbeat") return send(200, "application/json", JSON.stringify({ ok: true }));
      return send(404, "application/json", JSON.stringify({ error: "Not found" }));
    }
    if (url.pathname === "/") return send(200, "text/html; charset=utf-8", shell);
    if (url.pathname === "/surface-client.mjs") return send(200, "text/javascript; charset=utf-8", clientKit);
    const asset = assets[url.pathname];
    if (asset) return send(200, asset[1], readFileSync(path.join(ASSETS_DIR, asset[0]), "utf8"));
    send(404, "text/plain", "not found");
  });
  await /** @type {Promise<void>} */ (new Promise((r) => server.listen(0, "127.0.0.1", () => r())));
  const origin = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  const profile = mkdtempSync(path.join(os.tmpdir(), "browser-proof-cancel-"));
  let chrome;
  let ack;
  try {
    chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, `${origin}/#${token}`], { stdio: "ignore" });
    const acknowledgementStarted = Date.now();
    const acknowledgementTimeout = setTimeout(() => acked.reject(new Error(`the page never acknowledged a cancel; requests seen: ${seen.join(", ")}`)), BROWSER_ACK_TIMEOUT_MS);
    try {
      ack = await acked.promise;
      console.log(`browser cancel acknowledgement: ${Date.now() - acknowledgementStarted}ms`);
    } finally { clearTimeout(acknowledgementTimeout); }
  } finally {
    chrome?.kill("SIGKILL");
    if (chrome) await new Promise((r) => { chrome.once("exit", r); setTimeout(r, 1500); });
    server.close();
    await removeProfile(profile);
  }
  assert.deepEqual(ack, { operationId: "op-cancel" }, "the cancel's operation id is acknowledged");
  assert.deepEqual(seen.filter((r) => r !== "POST /api/heartbeat"), ["GET /api/model", "POST /api/cancel", "POST /api/ack"], "model failure, then cancel, then ack, in order");
  assert.equal(heartbeatsAfterCancel, 0, "the heartbeat stopped before the cancel was sent, so a slow cancel cannot keep the lease alive");
});
