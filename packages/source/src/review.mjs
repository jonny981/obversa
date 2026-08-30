import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeDiff, listTrackedFiles, rangeEnd, readNewFileText, repositoryRoot } from "./git.mjs";
import { parseUnifiedDiff } from "./diff.mjs";
import { ASSETS_DIR, buildIndexHtml } from "./page.mjs";
import { createHighlightRegistry, registryToCss } from "./highlight.mjs";
import { highlightModel } from "./highlight-model.mjs";
import { boundedReader, contextModel } from "./context-model.mjs";
import { navModel } from "./nav-model.mjs";
import { isGateBinding, isSurfaceRequest, normalizeResult } from "./contract.mjs";

// The most diff a review takes, supplied or computed: the git lane's own
// output bound (computeDiff's maxBuffer), so a supplied diff is held to
// what git could have returned.
export const MAX_DIFF_BYTES = 64 * 1024 * 1024;

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
// callback that gate expects its result at. reviewDiff validates the pair
// and carries it in the request; it does not send anything to the
// callback. The result comes back to the caller through the launcher's
// framed handoff only, and delivery to the gate is the gate's own work.
// The pair is enforced by the contract's isGateBinding — a gate needs a
// present id, address, and token; direct use has none of the three — and a
// wrong shape fails before a surface opens.
function normalizeGate(gate) {
  if (gate === undefined || gate === null) return { gateId: null, callback: { address: null, token: null } };
  if (typeof gate !== "object") throw new TypeError("gate must be an object with gateId and callback");
  // Each field is read exactly once, so a getter cannot assemble an address
  // and a token that never existed together as one callback value.
  const { gateId, callback: rawCallback } = gate;
  const callback = rawCallback && typeof rawCallback === "object"
    ? (({ address, token }) => ({ address, token }))(rawCallback)
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
 * token; the contract treats that shape as valid. The subject is the reviewed
 * ref (the working tree, the index, or the ref range) plus the URL the page
 * fetches the diff from; the transport is the browser pane the host opens.
 * The result copies surfaceId and gateId back, which is how a consumer routes
 * it.
 */
export function buildSurfaceRequest(/** @type {{ model?: any, meta?: any, gate?: any, binding?: any }} */ { model, meta, gate, binding } = {}) {
  // reviewDiff hands over the binding it already read once; a direct caller
  // passes the gate option and it is read here, once.
  const { gateId, callback } = binding ?? normalizeGate(gate);
  const ref = meta?.mode === "range" ? String(meta.range) : String(meta?.mode ?? "worktree");
  return {
    surfaceId: randomUUID(),
    gateId,
    callback,
    kind: { family: "output", renderer: "review" },
    subject: { ref, fetch: "/api/model" },
    anchors: outputAnchors(model),
    transport: "browser",
  };
}

// The decision a session that ends without the browser's completion carries.
function decisionFor(status) {
  // An error ending is an error, not a review outcome: no SurfaceResult
  // says "cancelled" for it. The launcher keeps a null payload for the
  // status it reports, and the caller sees status "error" with no result.
  if (status === "error") throw new Error("the surface session ended in error; there is no review outcome");
  return status === "timed_out" ? "timed-out" : "cancelled";
}

// Highlight a diff model into a fresh registry: the tokens ride the
// authenticated model response, and the browser paints class spans, so
// nothing highlights (or executes) client-side.
async function highlighted(diffText) {
  const model = parseUnifiedDiff(diffText);
  const registry = createHighlightRegistry();
  await highlightModel(model, registry);
  return { model, registry };
}

// A diff handed in by the caller: reviewed exactly as given, with no
// context bands, no go-to-source, and no file tree beyond the diff, since
// those read the repository and a read now need not be the state the diff
// came from. Nothing here touches the repository — not even to find it.
async function captureSupplied({ diffText, mode, range }) {
  const resolved = { diffText, mode, range: mode === "range" ? range : null };
  return { resolved, allFiles: [], ...(await highlighted(diffText)) };
}

// One pass over the repository: the diff, then the context bands and
// go-to-source hits read beside it — one bounded reader serves both, so a
// file is read once and the review-wide byte bound is one bound across the
// two passes — then the tracked-file list (from the range's end commit for a
// range review, else the index). Every byte the repository answered with is
// folded into one fingerprint: the diff text, each file read's path, mode and
// text, and the file list. `git` is the port for the diff and the list;
// `readFile` is the port for the file reads.
async function captureOnce({ mode, range, cwd, git, readFile }) {
  const resolved = await git.computeDiff({ mode, range, cwd });
  const { model, registry } = await highlighted(resolved.diffText);
  const reads = [];
  const read = boundedReader({
    read: async (args) => {
      const text = await readFile(args);
      reads.push([args.path, args.mode, text]);
      return text;
    },
  });
  await contextModel(model, { mode: resolved.mode, cwd, registry, read });
  await navModel(model, { mode: resolved.mode, cwd, read });
  const ref = resolved.mode === "range" ? await git.rangeEnd({ cwd, range: resolved.range }) : undefined;
  const allFiles = await git.listTrackedFiles({ cwd, ref });
  const fingerprint = JSON.stringify([resolved.diffText, allFiles, reads]);
  return { resolved, model, registry, allFiles, fingerprint };
}

// One review from one repository state, as far as reads without a lock can
// tell: the whole capture is taken twice and accepted only when both passes
// answered identically — every diff line, every file read, the file list. A
// repository that moved under either pass shows up as a mismatch (a change
// made after the first diff and undone before the second one included, since
// the reads of the two passes then differ), so the capture is retried from
// the top, and refused when the repository will not hold still. What this
// cannot see is a change made and undone the same way inside both passes;
// binding each read to the blob the diff names would close that and is not
// done here.
const CAPTURE_ATTEMPTS = 3;
async function capture({ mode, range, cwd, git, readFile = readNewFileText }) {
  for (let attempt = 1; ; attempt += 1) {
    const first = await captureOnce({ mode, range, cwd, git, readFile });
    const second = await captureOnce({ mode, range, cwd, git, readFile });
    if (second.fingerprint === first.fingerprint) {
      const { resolved, model, registry, allFiles } = second;
      return { resolved, model, registry, allFiles };
    }
    if (attempt >= CAPTURE_ATTEMPTS) {
      throw new Error("The repository changed while the review was being captured; retry when it is quiet");
    }
  }
}

// The repository reads a review makes, as one replaceable port (the tests
// hand in spies).
const gitPort = { repositoryRoot, computeDiff, listTrackedFiles, rangeEnd };

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
 * with contract anchors, meta): the reviewer's on completion, or one with a
 * "cancelled" / "timed-out" decision and no annotations when the session
 * ended otherwise; null only if the session never produced a terminal
 * record. `annotations` is `result.annotations` or []; `terminal` is the
 * runtime's framed terminal record.
 *
 * @param {{
 *   mode?: "worktree" | "staged" | "range",
 *   range?: string,
 *   cwd?: string,
 *   diffText?: string,
 *   app?: string,
 *   launchSurface?: Function,
 *   clientKitSource?: string,
 *   open?: boolean,
 *   ready?: Function,
 *   gate?: { gateId?: unknown, callback?: { address?: unknown, token?: unknown } } | null,
 *   git?: { repositoryRoot: Function, computeDiff: Function, listTrackedFiles: Function },
 * }} [options]
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
  git = gitPort,
} = {}) {
  if (typeof launchSurface !== "function") {
    throw new TypeError("reviewDiff needs a launchSurface port");
  }
  if (typeof clientKitSource !== "string" || clientKitSource.length === 0) {
    throw new TypeError("reviewDiff needs the surface client-kit source");
  }
  const gateBinding = normalizeGate(gate); // fail on a bad gate option before anything opens; read once
  // The mode and its range are checked before anything is read or reviewed,
  // a supplied diff included: an unknown mode, or range mode with no range,
  // would otherwise reach the page's completion payload as a value the
  // surfacer's data contract refuses, after a page had opened.
  if (!["worktree", "staged", "range"].includes(mode)) throw new TypeError(`reviewDiff mode must be worktree, staged, or range; got ${String(mode)}`);
  if (mode === "range" && (typeof range !== "string" || range.trim().length === 0)) throw new TypeError("reviewDiff in range mode needs a ref range");
  // A supplied diff is text, and no larger than the git lane would return:
  // anything else (null, a Buffer, an object) is a caller error, not an
  // empty review, and an unbounded one is not split, highlighted, or
  // anchored.
  if (diffText !== undefined) {
    if (typeof diffText !== "string") throw new TypeError("diffText must be a string");
    if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) throw new RangeError(`diffText is larger than ${MAX_DIFF_BYTES} bytes`);
  }

  // The command may run from any directory inside the repository. Git prints
  // diff paths relative to the repository root, so every read that resolves a
  // diff path works from the root, not from `cwd`.
  // A diff handed in is reviewed as it is: nothing is read from the
  // repository for it — not even its root — because a read now may not be
  // the state that diff was taken from. A diff computed here is captured
  // together with the file content and the tracked-file list beside it,
  // from one repository state (see capture).
  const { resolved, model, registry, allFiles } = diffText !== undefined
    ? await captureSupplied({ diffText, mode, range })
    : await capture({ mode, range, cwd: (await git.repositoryRoot({ cwd })) ?? cwd, git });
  const highlightCss = registryToCss(registry);
  const meta = {
    mode: resolved.mode,
    range: resolved.range,
    label: buildLabel({ mode: resolved.mode, range: resolved.range }),
    fileCount: model.files.length,
    // The tracked files of the reviewed state, for the tree's "All files" view.
    allFiles,
  };
  const request = buildSurfaceRequest({ model, meta, binding: gateBinding });
  // The request this review opens is held to the contract it will check
  // results against, before any page opens: a request the guard would
  // refuse cannot be the one a reviewer answers.
  if (!isSurfaceRequest(request)) throw new TypeError(`reviewDiff built a request its own contract refuses (ref ${JSON.stringify(request.subject.ref)})`);

  const directory = await mkdtemp(path.join(os.tmpdir(), "obversa-review-"));
  try {
    await writeFile(path.join(directory, "index.html"), buildIndexHtml(), "utf8");
    await copyFile(path.join(ASSETS_DIR, "app.js"), path.join(directory, "app.js"));
    await copyFile(path.join(ASSETS_DIR, "app.css"), path.join(directory, "app.css"));
    await copyFile(path.join(ASSETS_DIR, "nav-segments.mjs"), path.join(directory, "nav-segments.mjs"));
    await copyFile(path.join(ASSETS_DIR, "file-tree.mjs"), path.join(directory, "file-tree.mjs"));
    await copyFile(path.join(ASSETS_DIR, "icons.mjs"), path.join(directory, "icons.mjs"));
    await writeFile(path.join(directory, "surface-client.mjs"), clientKitSource, "utf8");

    const api = {
      // The diff model is fetched here, behind the bearer token, rather than
      // embedded in the static shell (static files are served before the auth
      // check, so an embedded diff would be readable by any local process that
      // found the port). It goes out verbatim: the server redacts every other
      // /api body, which would corrupt code under review. The highlight rules
      // ride with it for the same reason: they are built from the tokens this
      // review contains, so as a static file they would change with the
      // content under review and tell a pre-auth reader something about it.
      "GET /api/model": async () => ({ body: { model, meta, highlightCss }, verbatim: true }),
      // The browser returns contract-shaped annotations and a decision; the
      // contract validates every anchor against the request (membership), bounds
      // bodies and counts, and shapes the SurfaceResult. It completes verbatim so
      // code quoted in a comment survives the transport's redaction.
      "POST /api/submit": async ({ body, session }) => {
        const result = normalizeResult({ annotations: body?.annotations, decision: body?.decision, meta }, request);
        // A submission whose decision and annotations disagree — or that
        // names an ending only the runtime may — is refused, and the session
        // stays open for a submission that agrees.
        if (result === null) {
          return { status: 400, body: { error: "A review is approved with no annotations, or requests changes with at least one" } };
        }
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
        "/surface-client.mjs": ["surface-client.mjs", "text/javascript; charset=utf-8"],
      },
    };

    // A session that ends without the browser's completion — cancelled, timed
    // out, interrupted — still frames a SurfaceResult carrying the surface and
    // gate ids and a "cancelled" / "timed-out" decision, so a gate can route
    // the outcome.
    // The outcome carries identity fields (a gate id can look like a token to
    // the redactor), so it opts in to verbatim like the completed result.
    const terminalPayload = (status) => normalizeResult({ decision: decisionFor(status), annotations: [], meta }, request, { terminal: true });
    const outcome = await launchSurface({ app, assets, api, open, ready, terminalPayload, terminalPayloadVerbatim: true });
    const terminal = outcome?.result ?? outcome;
    const status = terminal?.status ?? "unknown";
    // The framed payload is the SurfaceResult itself, whatever the status.
    const result = terminal?.payload ?? null;
    return { status, result, annotations: result?.annotations ?? [], meta, terminal };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
