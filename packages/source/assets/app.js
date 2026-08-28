// The review page. It fetches the diff model from the session API with the
// bearer token, renders it, lets the reviewer attach comments to individual
// lines, and returns those annotations through the surface client kit. It is
// served under script-src 'self'; there is no inline script and no innerHTML of
// diff content, so arbitrary code inside a diff line can never execute or
// break out.
import { createSurfaceClient } from "./surface-client.mjs";
import { overlaySegments } from "./nav-segments.mjs";
import { buildFileTree, countFiles } from "./file-tree.mjs";
import { iconFor } from "./icons.mjs";

const root = document.getElementById("app");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Build the highlighted <code> for one diff line from its server-side tokens,
// with clickable identifiers overlaid from the line's go-to-source hits. Every
// value still goes in through textContent, so nothing in a diff line can execute
// or break out. Falls back to plain text when a line carries no tokens.
// `scope` is the file section the line belongs to: a definition is looked up
// inside it, never across files that happen to share a line number.
function codeEl(line, scope) {
  const code = el("code", "code");
  const tokens = line.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    code.textContent = line.text;
    return code;
  }
  for (const seg of overlaySegments(tokens, line.hits)) {
    if (seg.hit) {
      const navCls = seg.hit.action === "jump" ? "nav nav-jump" : "nav nav-indicate";
      const span = el("span", seg.cls ? `${seg.cls} ${navCls}` : navCls, seg.text);
      span.setAttribute("role", "link");
      span.tabIndex = 0;
      span.title = seg.hit.action === "jump"
        ? `Go to definition of ${seg.hit.name} (line ${seg.hit.def.line})`
        : `${seg.hit.name} is defined at line ${seg.hit.def.line}, not shown here`;
      const activate = () => activateNav(seg.hit, scope);
      span.addEventListener("click", activate);
      span.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
      });
      code.append(span);
    } else if (seg.cls) {
      code.append(el("span", seg.cls, seg.text));
    } else {
      code.append(document.createTextNode(seg.text));
    }
  }
  return code;
}

// Jump to (and briefly flash) the row that defines the clicked identifier, when
// that definition line is shown in the diff. An "indicate" hit has no on-screen
// target; its title tooltip already names the definition line. The lookup is
// scoped to the identifier's own file section: line numbers repeat across files.
function activateNav(hit, scope) {
  if (hit.action !== "jump" || !hit.def || !scope) return;
  const row = scope.querySelector(`.row[data-new-line="${hit.def.line}"]`);
  if (!row) return;
  row.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the flash animation
  row.classList.add("flash");
}

function reduceMotion() {
  return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// The files navigator: a collapsible directory tree built from the diff model,
// with a Changes view and an All-files view. The caller supplies `onOpen(path)`;
// the review page scrolls that file's diff section into view.
function renderFileTree(model, meta, onOpen) {
  const nav = el("nav", "filetree");
  nav.setAttribute("aria-label", "Files");
  const tabs = el("div", "tree-tabs");
  const changesTab = el("button", "tree-tab");
  changesTab.type = "button";
  changesTab.append(document.createTextNode("Changes "), el("span", "tab-count", String(model.files.length)));
  const allTab = el("button", "tree-tab");
  allTab.type = "button";
  const hasAll = Array.isArray(meta.allFiles) && meta.allFiles.length > model.files.length;
  allTab.append(document.createTextNode("All files "), el("span", "tab-count", String(hasAll ? meta.allFiles.length : model.files.length)));
  const content = el("div", "tree-content");

  const changesTree = () => renderTreeNodes(buildFileTree(model.files), onOpen);
  const allTree = () => {
    const changed = new Map(model.files.map((f) => [f.path, f]));
    const all = (meta.allFiles || []).map((p) => changed.get(p) || { path: p, status: "unchanged" });
    return renderTreeNodes(buildFileTree(all), onOpen);
  };
  const show = (which) => {
    changesTab.classList.toggle("active", which === "changes");
    allTab.classList.toggle("active", which === "all");
    content.replaceChildren(which === "changes" ? changesTree() : allTree());
  };
  changesTab.addEventListener("click", () => show("changes"));
  allTab.addEventListener("click", () => show("all"));

  tabs.append(changesTab);
  if (hasAll) tabs.append(allTab);
  nav.append(tabs, content);
  show("changes");
  return nav;
}

function renderTreeNodes(node, onOpen) {
  const list = el("ul", "tree-list");
  for (const dir of node.dirs) {
    const item = el("li", "tree-dir");
    const toggle = el("button", "tree-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "true");
    toggle.append(el("span", "tree-caret", "▾"), iconEl(null, "folder"), el("span", "tree-name", dir.name), el("span", "tree-count", String(countFiles(dir))));
    const children = renderTreeNodes(dir, onOpen);
    toggle.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      toggle.firstChild.textContent = open ? "▸" : "▾";
      children.hidden = open;
    });
    item.append(toggle, children);
    list.append(item);
  }
  for (const file of node.files) {
    const item = el("li", "tree-file");
    const changed = file.status !== "unchanged";
    const btn = el("button", `tree-file-btn status-${file.status}${changed ? "" : " unchanged"}`);
    btn.type = "button";
    btn.title = changed ? `${file.path} — ${file.status}` : file.path;
    btn.append(iconEl(file.path), el("span", "tree-name", file.name));
    if (changed) btn.append(fileStatEl(file), el("span", "tree-status", statusMark(file.status)));
    btn.addEventListener("click", () => onOpen(file.path));
    item.append(btn);
    list.append(item);
  }
  return list;
}

function statusMark(status) {
  return { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C" }[status] || "M";
}

function fileStatEl(file) {
  const stat = el("span", "tree-stat");
  if (file.added) stat.append(el("span", "stat-add", `+${file.added}`));
  if (file.deleted) stat.append(el("span", "stat-del", `−${file.deleted}`));
  return stat;
}

// Render a trusted, static file-type icon. The SVG comes from our fixed icon map
// (icons.mjs), never from user content, so setting innerHTML here is safe: the
// icons carry no script and no external references (asserted in icons.test).
function iconEl(path, kind) {
  const span = el("span", "tree-icon");
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconFor(path, kind);
  return span;
}

function anchorFor(line) {
  // A del line lives on the old side; an add or context line on the new side.
  if (line.type === "del") return { side: "old", line: line.oldNumber };
  return { side: "new", line: line.newNumber };
}

function statusLabel(status) {
  return { added: "added", deleted: "deleted", modified: "modified", renamed: "renamed", copied: "copied" }[status] || status;
}

// The file path as a breadcrumb: dimmed directory segments, the filename bold.
function renderPath(path) {
  const wrap = el("span", "path");
  const parts = String(path).split("/");
  parts.forEach((part, i) => {
    if (i > 0) wrap.append(el("span", "path-sep", "/"));
    wrap.append(el("span", i === parts.length - 1 ? "path-file" : "path-dir", part));
  });
  return wrap;
}

// A collapsible "N unmodified lines" band. It expands into the surrounding
// full-file context (highlighted, read-only); collapsed by default so the view
// is the diff. Rows are built lazily on first expand.
function renderContextBand(contextLines) {
  const band = el("div", "context-band");
  const toggle = el("button", "context-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  const n = contextLines.length;
  toggle.append(el("span", "context-caret", "▸"), el("span", "context-label", `${n} unmodified line${n === 1 ? "" : "s"}`));
  const rows = el("div", "context-rows");
  rows.hidden = true;
  let built = false;
  toggle.addEventListener("click", () => {
    if (!built) {
      for (const line of contextLines) rows.append(contextRow(line));
      built = true;
    }
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!open));
    toggle.firstChild.textContent = open ? "▸" : "▾";
    rows.hidden = open;
  });
  band.append(toggle, rows);
  return band;
}

function contextRow(line) {
  const row = el("div", "row row-context");
  row.dataset.newLine = String(line.line);
  const code = el("code", "code");
  const tokens = line.tokens;
  if (Array.isArray(tokens) && tokens.length > 0) {
    for (const token of tokens) {
      if (token && token.cls) code.append(el("span", token.cls, token.text));
      else code.append(document.createTextNode(token ? token.text : ""));
    }
  } else {
    code.textContent = line.text;
  }
  row.append(
    el("span", "gutter old", ""),
    el("span", "gutter new", String(line.line)),
    el("span", "sign", " "),
    code,
  );
  return row;
}

// The highlight rules arrive with the authenticated model, not as a pre-auth
// static file: what the shell serves before the token is checked must not
// vary with the content under review. A constructed stylesheet is CSSOM, which
// style-src does not govern, so the CSP stays 'self' with no inline style.
function applyHighlightCss(css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(typeof css === "string" ? css : "");
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

async function main() {
  let client;
  try {
    client = createSurfaceClient();
  } catch (error) {
    root.replaceChildren(el("p", "notice error", error.message));
    root.setAttribute("aria-busy", "false");
    return;
  }

  // The diff rides the authenticated API, not the static shell.
  let model;
  let meta;
  let highlightCss;
  try {
    ({ model, meta, highlightCss } = await client.api("/api/model"));
    // A browser without constructable stylesheets cannot paint the review;
    // say so rather than sit on "Loading review…" forever.
    applyHighlightCss(highlightCss);
  } catch (error) {
    const notice = el("p", "notice error", `Could not load the review: ${error.message}`);
    root.replaceChildren(notice);
    root.setAttribute("aria-busy", "false");
    // Nothing can be returned from here, so end the session. The heartbeat
    // stops first — a cancel that hangs must not keep renewing the lease —
    // then the cancel gives the caller a cancelled result; the client can
    // still send and acknowledge it after dispose. If the cancel request
    // fails, the page cannot know whether the server applied it before the
    // response was lost, so it says only what it can verify: the heartbeat
    // has stopped and the session will lapse.
    client.dispose();
    try {
      await client.cancel();
      notice.textContent = `Could not load the review: ${error.message}. The session has been cancelled.`;
    } catch {
      notice.textContent = `Could not load the review: ${error.message}. Cancellation could not be confirmed; the heartbeat has stopped and the session will lapse.`;
    }
    return;
  }

  const annotations = [];
  let annotationSeq = 0;
  let settled = false;

  // Header with the review label and the return/cancel controls.
  const header = el("header", "review-header");
  const heading = el("h1", null, `Review: ${meta.label}`);
  // The static shell names nothing under review; the title arrives with the
  // authenticated model.
  document.title = `Review: ${meta.label}`;
  const summary = el("p", "summary", `${meta.fileCount} file${meta.fileCount === 1 ? "" : "s"} changed`);
  const actions = el("div", "actions");
  const returnButton = el("button", "primary");
  returnButton.type = "button";
  const cancelButton = el("button", "secondary", "Cancel");
  cancelButton.type = "button";
  actions.append(returnButton, cancelButton);
  header.append(heading, summary, actions);

  const status = el("p", "notice");
  status.setAttribute("role", "status");
  status.hidden = true;

  // The button names the decision the return will carry: annotations mean
  // "changes requested"; none means "approved".
  function updateCount() {
    returnButton.textContent = annotations.length
      ? `Return ${annotations.length} annotation${annotations.length === 1 ? "" : "s"} (request changes)`
      : "Approve with no annotations";
  }
  updateCount();

  const body = el("div", "files");
  const fileSections = new Map();
  if (model.files.length === 0) {
    body.append(el("p", "notice", "No changes to review."));
  }

  for (const file of model.files) {
    const section = el("section", "file");
    section.dataset.path = file.path;
    fileSections.set(file.path, section);
    const head = el("div", "file-head");
    head.append(el("span", `badge badge-${file.status}`, statusLabel(file.status)), renderPath(file.path));
    const hasContext = file.hunks.some((h) => h.contextBefore && h.contextBefore.length) || (file.contextAfter && file.contextAfter.length);
    if (hasContext) {
      const expandAll = el("button", "file-expand small");
      expandAll.type = "button";
      expandAll.textContent = "Expand full file";
      expandAll.addEventListener("click", () => {
        const toggles = [...section.querySelectorAll(".context-toggle")];
        const expand = toggles.some((t) => t.getAttribute("aria-expanded") !== "true");
        for (const t of toggles) if ((t.getAttribute("aria-expanded") === "true") !== expand) t.click();
        expandAll.textContent = expand ? "Collapse to diff" : "Expand full file";
      });
      head.append(expandAll);
    }
    section.append(head);

    if (file.binary) {
      section.append(el("p", "binary", "Binary file — no line content to review."));
      body.append(section);
      continue;
    }
    if (file.hunks.length === 0) {
      section.append(el("p", "binary", "No line changes."));
      body.append(section);
      continue;
    }

    const table = el("div", "hunks");
    for (const hunk of file.hunks) {
      // The collapsible "N unmodified lines" band is the separator between hunks
      // and expands into full-file context. Without full-file context the plain
      // @@ header stands in; adjacent hunks (an empty gap) get no separator.
      if (hunk.contextBefore === undefined) {
        table.append(el("div", "hunk-head", hunk.header
          ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`
          : `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
      } else if (hunk.contextBefore.length) {
        table.append(renderContextBand(hunk.contextBefore));
      }

      for (const line of hunk.lines) {
        const anchor = anchorFor(line);
        const row = el("div", `row row-${line.type}`);
        if (line.newNumber != null) row.dataset.newLine = String(line.newNumber);
        row.append(
          el("span", "gutter old", line.oldNumber == null ? "" : String(line.oldNumber)),
          el("span", "gutter new", line.newNumber == null ? "" : String(line.newNumber)),
          el("span", "sign", line.type === "add" ? "+" : line.type === "del" ? "-" : " "),
          codeEl(line, section),
        );
        const addButton = el("button", "add-comment", "+");
        addButton.type = "button";
        addButton.setAttribute(
          "aria-label",
          `Add a comment on the ${anchor.side} side at line ${anchor.line} of ${file.path}`,
        );
        row.append(addButton);

        const thread = el("div", "thread");
        addButton.addEventListener("click", () => openEditor(thread, file.path, anchor));

        table.append(row, thread);
      }
    }
    if (file.contextAfter && file.contextAfter.length) table.append(renderContextBand(file.contextAfter));
    section.append(table);
    body.append(section);
  }

  function openEditor(thread, filePath, anchor) {
    if (thread.querySelector(".editor")) return; // one editor at a time per line
    const editor = el("div", "editor");
    const textarea = el("textarea");
    textarea.setAttribute("aria-label", "Comment text");
    textarea.rows = 3;
    const save = el("button", "primary small", "Save comment");
    save.type = "button";
    const discard = el("button", "secondary small", "Discard");
    discard.type = "button";
    const controls = el("div", "editor-actions");
    controls.append(save, discard);
    editor.append(textarea, controls);
    thread.prepend(editor);
    textarea.focus();

    discard.addEventListener("click", () => editor.remove());
    save.addEventListener("click", () => {
      const text = textarea.value.trim();
      if (!text) {
        textarea.focus();
        return;
      }
      const entry = { key: ++annotationSeq, path: filePath, side: anchor.side, line: anchor.line, body: text };
      annotations.push(entry);
      renderComment(thread, entry);
      editor.remove();
      updateCount();
    });
  }

  function renderComment(thread, entry) {
    const comment = el("div", "comment");
    comment.append(el("p", "comment-body", entry.body));
    const remove = el("button", "link", "Remove");
    remove.type = "button";
    remove.addEventListener("click", () => {
      const index = annotations.indexOf(entry);
      if (index >= 0) annotations.splice(index, 1);
      comment.remove();
      updateCount();
    });
    comment.append(remove);
    thread.append(comment);
  }

  function show(message, isError) {
    status.hidden = false;
    status.textContent = message;
    status.classList.toggle("error", Boolean(isError));
  }

  function finish(message) {
    settled = true;
    root.replaceChildren(el("p", "notice done", message));
    root.setAttribute("aria-busy", "false");
  }

  returnButton.addEventListener("click", async () => {
    if (settled) return;
    returnButton.disabled = true;
    cancelButton.disabled = true;
    try {
      // The surface contract: each annotation pins to an anchor the server
      // offered (a diff line and side); the decision follows from whether there
      // are any.
      const payload = {
        decision: annotations.length ? "changes-requested" : "approved",
        annotations: annotations.map(({ path, side, line, body }) => ({
          anchor: { target: path, side, position: line },
          body,
          createdAt: new Date().toISOString(),
        })),
      };
      await client.submit("/api/submit", payload);
      const n = payload.annotations.length;
      finish(n ? `Returned ${n} annotation${n === 1 ? "" : "s"}. You can close this tab.` : "Approved with no annotations. You can close this tab.");
    } catch (error) {
      returnButton.disabled = false;
      cancelButton.disabled = false;
      show(`Could not return annotations: ${error.message}`, true);
    }
  });

  cancelButton.addEventListener("click", async () => {
    if (settled) return;
    returnButton.disabled = true;
    cancelButton.disabled = true;
    try {
      await client.cancel();
      finish("Review cancelled. You can close this tab.");
    } catch (error) {
      returnButton.disabled = false;
      cancelButton.disabled = false;
      show(`Could not cancel: ${error.message}`, true);
    }
  });

  const layout = el("div", "layout");
  if (model.files.length > 0) {
    layout.append(renderFileTree(model, meta, (path) => {
      const section = fileSections.get(path);
      if (section) section.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
    }));
  }
  layout.append(body);
  root.replaceChildren(header, status, layout);
  root.setAttribute("aria-busy", "false");
}

main();
