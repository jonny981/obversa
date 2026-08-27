import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeDiff, listTrackedFiles, repositoryRoot } from "./git.mjs";
import { parseUnifiedDiff } from "./diff.mjs";
import { ASSETS_DIR, buildIndexHtml } from "./page.mjs";
import { createHighlightRegistry, registryToCss } from "./highlight.mjs";
import { highlightModel } from "./highlight-model.mjs";
import { contextModel } from "./context-model.mjs";
import { navModel } from "./nav-model.mjs";
import { isGateBinding, normalizeResult } from "./contract.mjs";

// Human-readable name for what is under review.
function buildLabel({ mode, range }) {
  if (mode === "staged") return "staged changes";
  if (mode === "range") return `range ${range}`;
  return "working tree";
}

/**
 * The anchors an Output surface offers: one per diff line and side that the
 * reviewer can actually see. A deleted line anchors on the old side, an added
 * line on the new side, and an unchanged line on both. The contract's
 * membership rule (validateAnnotation) then rejects any annotation pinned to a
 * location outside this set, so a tampered browser cannot invent one.
 */
export function outputAnchors(model) {
  const anchors = [];
  for (const file of model.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.oldNumber != null) anchors.push({ target: file.path, side: "old", position: line.oldNumber });
        if (line.newNumber != null) anchors.push({ target: file.path, side: "new", position: line.newNumber });
      }
    }
  }
  return anchors;
}

// The `gate` option a Callback Gate passes to reviewDiff: its id and the
// callback the result should reach. The pair is enforced by the contract's
// isGateBinding — a gate needs a present id, address, and token; direct use
// has none of the three — and a wrong shape fails before a surface opens.
function normalizeGate(gate) {
  if (gate === undefined || gate === null) return { gateId: null, callback: { address: null, token: null } };
  if (typeof gate !== "object") throw new TypeError("gate must be an object with gateId and callback");
  const gateId = gate.gateId;
  const callback = gate.callback && typeof gate.callback === "object"
    ? { address: gate.callback.address, token: gate.callback.token }
    : null;
  if (gateId === null || gateId === undefined) {
    throw new TypeError("gate.gateId must be a non-empty string (omit the gate option for direct use)");
  }
  if (!isGateBinding(gateId, callback)) {
    throw new TypeError("gate needs a non-empty string gateId and a callback with a non-empty string address and token");
  }
  return { gateId, callback };
}

/**
 * The SurfaceRequest for one review (an internal note). `gate` is the option a
 * Callback Gate passes through reviewDiff — its id and callback — and is the
 * only route by which a gate reaches the request. Direct use from the command
 * line passes none, so gateId is null and the callback has null address and
 * token; the contract treats that shape as valid. The result copies surfaceId
 * and gateId back, which is how a consumer routes it.
 */
export function buildSurfaceRequest({ model, label, gate } = {}) {
  const { gateId, callback } = normalizeGate(gate);
  return {
    surfaceId: randomUUID(),
    gateId,
    callback,
    kind: { family: "output", renderer: "review" },
    subject: label,
    anchors: outputAnchors(model),
    transport: "local",
  };
}

/**
 * Open a git diff for inline review and return the reviewer's annotations.
 *
 * `reviewDiff` owns diff production and the review UI but not the surface
 * runtime: the caller injects a `launchSurface` port (the same shape as
 * @obversa/surfacer's runSurface) and the surface client-kit source. This keeps
 * @obversa/source free of any sibling-package dependency; the composition root
 * binds Surfacer.
 *
 * Options:
 * - mode: "worktree" | "staged" | "range" (default "worktree")
 * - range: the ref range, required in range mode
 * - cwd: the repository directory (default process.cwd())
 * - diffText: supply the unified diff directly and skip git (for tests/callers)
 * - app: the surface app name (default "review")
 * - launchSurface: required port; called with { app, assets, api, open, ready }
 * - clientKitSource: required; the surface client-kit module served to the page
 * - open: place the surface in a host pane (default true)
 * - ready: forwarded to launchSurface once the session is reachable
 * - gate: { gateId, callback: { address, token } } when a Callback Gate opens
 *   the review; omitted for direct use. The gateId is copied onto the result.
 *
 * Resolves to { status, result, annotations, meta, terminal }: `result` is the
 * SurfaceResult (an internal note — surfaceId, gateId, decision, annotations
 * with contract anchors, meta) when the reviewer returned, else null;
 * `annotations` is `result.annotations` or []; `terminal` is the runtime's
 * framed terminal record.
 */
export async function reviewDiff({
  mode = "worktree",
  range,
  cwd = process.cwd(),
  diffText,
  app = "review",
  launchSurface,
  clientKitSource,
  open = true,
  ready,
  gate,
} = {}) {
  if (typeof launchSurface !== "function") {
    throw new TypeError("reviewDiff needs a launchSurface port");
  }
  if (typeof clientKitSource !== "string" || clientKitSource.length === 0) {
    throw new TypeError("reviewDiff needs the surface client-kit source");
  }
  normalizeGate(gate); // fail on a bad gate option before anything opens

  // The command may run from any directory inside the repository. Git prints
  // diff paths relative to the repository root, so every read that resolves a
  // diff path works from the root, not from `cwd`.
  const root = (await repositoryRoot({ cwd })) ?? cwd;
  const resolved = diffText !== undefined
    ? { diffText, mode, range: mode === "range" ? range : null }
    : await computeDiff({ mode, range, cwd: root });
  const model = parseUnifiedDiff(resolved.diffText);
  // Highlight the diff and the expandable full-file context into one shared
  // stylesheet, and attach go-to-source hits. Tokens and context ride the
  // authenticated model response; the browser paints class spans, so nothing
  // highlights (or executes) client-side.
  const registry = createHighlightRegistry();
  await highlightModel(model, registry);
  await contextModel(model, { mode: resolved.mode, cwd: root, registry });
  await navModel(model, { mode: resolved.mode, cwd: root });
  const highlightCss = registryToCss(registry);
  const meta = {
    mode: resolved.mode,
    range: resolved.range,
    label: buildLabel({ mode: resolved.mode, range: resolved.range }),
    fileCount: model.files.length,
    // The repo's tracked files, for the tree's "All files" view.
    allFiles: await listTrackedFiles({ cwd: root }),
  };
  const request = buildSurfaceRequest({ model, label: meta.label, gate });

  const directory = await mkdtemp(path.join(os.tmpdir(), "obversa-review-"));
  try {
    await writeFile(path.join(directory, "index.html"), buildIndexHtml({ meta }), "utf8");
    await copyFile(path.join(ASSETS_DIR, "app.js"), path.join(directory, "app.js"));
    await copyFile(path.join(ASSETS_DIR, "app.css"), path.join(directory, "app.css"));
    await copyFile(path.join(ASSETS_DIR, "nav-segments.mjs"), path.join(directory, "nav-segments.mjs"));
    await copyFile(path.join(ASSETS_DIR, "file-tree.mjs"), path.join(directory, "file-tree.mjs"));
    await copyFile(path.join(ASSETS_DIR, "icons.mjs"), path.join(directory, "icons.mjs"));
    await writeFile(path.join(directory, "highlight.css"), highlightCss, "utf8");
    await writeFile(path.join(directory, "surface-client.mjs"), clientKitSource, "utf8");

    const api = {
      // The diff model is fetched here, behind the bearer token, rather than
      // embedded in the static shell (static files are served before the auth
      // check, so an embedded diff would be readable by any local process that
      // found the port). It goes out verbatim: the server redacts every other
      // /api body, which would corrupt code under review.
      "GET /api/model": async () => ({ body: { model, meta }, verbatim: true }),
      // The browser returns contract-shaped annotations and a decision; the
      // contract validates every anchor against the request (membership), bounds
      // bodies and counts, and shapes the SurfaceResult. It completes verbatim so
      // code quoted in a comment survives the transport's redaction.
      "POST /api/submit": async ({ body, session }) => {
        const result = normalizeResult({ annotations: body?.annotations, decision: body?.decision, meta }, request);
        session.complete(result, { verbatim: true });
        return null;
      },
    };
    const assets = {
      directory,
      files: {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/app.css": ["app.css", "text/css; charset=utf-8"],
        "/nav-segments.mjs": ["nav-segments.mjs", "text/javascript; charset=utf-8"],
        "/file-tree.mjs": ["file-tree.mjs", "text/javascript; charset=utf-8"],
        "/icons.mjs": ["icons.mjs", "text/javascript; charset=utf-8"],
        "/highlight.css": ["highlight.css", "text/css; charset=utf-8"],
        "/surface-client.mjs": ["surface-client.mjs", "text/javascript; charset=utf-8"],
      },
    };

    const outcome = await launchSurface({ app, assets, api, open, ready });
    const terminal = outcome?.result ?? outcome;
    const status = terminal?.status ?? "unknown";
    // On completion the framed payload is the SurfaceResult itself.
    const result = status === "completed" ? terminal.payload ?? null : null;
    return { status, result, annotations: result?.annotations ?? [], meta, terminal };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
