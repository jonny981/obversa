import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeDiff } from "./git.mjs";
import { parseUnifiedDiff } from "./diff.mjs";
import { ASSETS_DIR, buildIndexHtml } from "./page.mjs";

const MAX_ANNOTATIONS = 500;
const MAX_BODY = 4000;

// Human-readable name for what is under review.
function buildLabel({ mode, range }) {
  if (mode === "staged") return "staged changes";
  if (mode === "range") return `range ${range}`;
  return "working tree";
}

// Index the line numbers that actually appear in the diff, per file and side.
// An annotation may only anchor to a line the reviewer could really see, so a
// tampered browser cannot attach a comment to a fabricated location.
function buildAnchorIndex(model) {
  const index = new Map();
  for (const file of model.files) {
    const sides = { old: new Set(), new: new Set() };
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.oldNumber != null) sides.old.add(line.oldNumber);
        if (line.newNumber != null) sides.new.add(line.newNumber);
      }
    }
    index.set(file.path, sides);
  }
  return index;
}

// Validate and bound the annotations a browser returns. session.complete runs
// verbatim so code quoted in a comment survives, which means this function owns
// the bounds: it drops anything that is not anchored to a real diff line, caps
// the body length, and caps the total count.
export function normalizeAnnotations(raw, model) {
  if (!Array.isArray(raw)) return [];
  const index = buildAnchorIndex(model);
  const clean = [];
  for (const item of raw) {
    if (clean.length >= MAX_ANNOTATIONS) break;
    if (!item || typeof item !== "object") continue;
    const { path: filePath, side, line, body } = item;
    if (typeof filePath !== "string" || !index.has(filePath)) continue;
    if (side !== "old" && side !== "new") continue;
    if (!Number.isInteger(line) || line < 1) continue;
    if (!index.get(filePath)[side].has(line)) continue;
    if (typeof body !== "string") continue;
    const trimmed = body.trim();
    if (!trimmed) continue;
    clean.push({ path: filePath, side, line, body: trimmed.slice(0, MAX_BODY) });
  }
  return clean;
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
 * - app: the surface app name (default "pierre-review")
 * - launchSurface: required port; called with { app, assets, api, open, ready }
 * - clientKitSource: required; the surface client-kit module served to the page
 * - open: place the surface in a host pane (default true)
 * - ready: forwarded to launchSurface once the session is reachable
 */
export async function reviewDiff({
  mode = "worktree",
  range,
  cwd = process.cwd(),
  diffText,
  app = "pierre-review",
  launchSurface,
  clientKitSource,
  open = true,
  ready,
} = {}) {
  if (typeof launchSurface !== "function") {
    throw new TypeError("reviewDiff needs a launchSurface port");
  }
  if (typeof clientKitSource !== "string" || clientKitSource.length === 0) {
    throw new TypeError("reviewDiff needs the surface client-kit source");
  }

  const resolved = diffText !== undefined
    ? { diffText, mode, range: mode === "range" ? range : null }
    : await computeDiff({ mode, range, cwd });
  const model = parseUnifiedDiff(resolved.diffText);
  const meta = {
    mode: resolved.mode,
    range: resolved.range,
    label: buildLabel({ mode: resolved.mode, range: resolved.range }),
    fileCount: model.files.length,
  };

  const directory = await mkdtemp(path.join(os.tmpdir(), "pierre-review-"));
  try {
    await writeFile(path.join(directory, "index.html"), buildIndexHtml({ model, meta }), "utf8");
    await copyFile(path.join(ASSETS_DIR, "app.js"), path.join(directory, "app.js"));
    await copyFile(path.join(ASSETS_DIR, "app.css"), path.join(directory, "app.css"));
    await writeFile(path.join(directory, "surface-client.mjs"), clientKitSource, "utf8");

    const api = {
      "POST /api/submit": async ({ body, session }) => {
        const annotations = normalizeAnnotations(body?.annotations, model);
        session.complete({ annotations, meta }, { verbatim: true });
        return null;
      },
    };
    const assets = {
      directory,
      files: {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/app.css": ["app.css", "text/css; charset=utf-8"],
        "/surface-client.mjs": ["surface-client.mjs", "text/javascript; charset=utf-8"],
      },
    };

    const outcome = await launchSurface({ app, assets, api, open, ready });
    const result = outcome?.result ?? outcome;
    const annotations = result?.status === "completed" ? result.payload?.annotations ?? [] : [];
    return { status: result?.status ?? "unknown", annotations, meta, result };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
