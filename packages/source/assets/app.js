// The Pierre review page. It reads the diff model embedded in the shell,
// renders it, lets the reviewer attach comments to individual lines, and
// returns those annotations through the surface client kit. It is served under
// script-src 'self'; there is no inline script and no innerHTML, so arbitrary
// code inside a diff line can never execute or break out.
import { createSurfaceClient } from "./surface-client.mjs";

const root = document.getElementById("app");

function readReviewData() {
  const node = document.getElementById("review-data");
  if (!node) throw new Error("The review data block is missing");
  return JSON.parse(node.textContent);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function anchorFor(line) {
  // A del line lives on the old side; an add or context line on the new side.
  if (line.type === "del") return { side: "old", line: line.oldNumber };
  return { side: "new", line: line.newNumber };
}

function statusLabel(status) {
  return { added: "added", deleted: "deleted", modified: "modified", renamed: "renamed", copied: "copied" }[status] || status;
}

function main() {
  const { model, meta } = readReviewData();
  const annotations = [];
  let annotationSeq = 0;
  let settled = false;

  let client;
  try {
    client = createSurfaceClient();
  } catch (error) {
    root.replaceChildren(el("p", "notice error", error.message));
    root.setAttribute("aria-busy", "false");
    return;
  }

  // Header with the review label and the return/cancel controls.
  const header = el("header", "review-header");
  const heading = el("h1", null, `Review: ${meta.label}`);
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

  function updateCount() {
    returnButton.textContent = annotations.length
      ? `Return ${annotations.length} annotation${annotations.length === 1 ? "" : "s"}`
      : "Return with no annotations";
  }
  updateCount();

  const body = el("div", "files");
  if (model.files.length === 0) {
    body.append(el("p", "notice", "No changes to review."));
  }

  for (const file of model.files) {
    const section = el("section", "file");
    const head = el("div", "file-head");
    head.append(el("span", `badge badge-${file.status}`, statusLabel(file.status)), el("span", "path", file.path));
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
      const hunkHead = el("div", "hunk-head", hunk.header
        ? `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`
        : `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      table.append(hunkHead);

      for (const line of hunk.lines) {
        const anchor = anchorFor(line);
        const row = el("div", `row row-${line.type}`);
        row.append(
          el("span", "gutter old", line.oldNumber == null ? "" : String(line.oldNumber)),
          el("span", "gutter new", line.newNumber == null ? "" : String(line.newNumber)),
          el("span", "sign", line.type === "add" ? "+" : line.type === "del" ? "-" : " "),
          el("code", "code", line.text),
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
      const payload = annotations.map(({ path, side, line, body }) => ({ path, side, line, body }));
      await client.submit("/api/submit", { annotations: payload });
      finish(`Returned ${payload.length} annotation${payload.length === 1 ? "" : "s"}. You can close this tab.`);
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

  root.replaceChildren(header, status, body);
  root.setAttribute("aria-busy", "false");
}

main();
