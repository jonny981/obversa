// Build a directory tree from the review's changed files, for the file
// navigator sidebar. Pure and DOM-free (app.js renders it; a node test checks
// it), and serialisable — nodes use arrays, not Maps. A single chain of
// one-child directories is collapsed into one row ("src/auth"), the way an IDE
// shows it, so deep paths don't waste horizontal space.

// Added/deleted line counts for one file, for the tree's +/- badge.
export function fileStats(file) {
  let added = 0;
  let deleted = 0;
  for (const hunk of file?.hunks ?? []) {
    for (const line of hunk?.lines ?? []) {
      if (line.type === "add") added += 1;
      else if (line.type === "del") deleted += 1;
    }
  }
  return { added, deleted };
}

function insert(root, file) {
  const parts = (file.path || "").split("/").filter(Boolean);
  const name = parts.pop() ?? file.path ?? "";
  let node = root;
  for (const part of parts) {
    let dir = node.dirs.find((d) => d.name === part);
    if (!dir) { dir = { name: part, dirs: [], files: [] }; node.dirs.push(dir); }
    node = dir;
  }
  const { added, deleted } = fileStats(file);
  node.files.push({ name, path: file.path, status: file.status ?? "modified", binary: Boolean(file.binary), added, deleted });
}

function sortNode(node) {
  node.dirs.sort((a, b) => a.name.localeCompare(b.name));
  node.files.sort((a, b) => a.name.localeCompare(b.name));
  for (const dir of node.dirs) sortNode(dir);
}

// Collapse a directory that holds exactly one subdirectory and no files into a
// single "a/b" row, recursively — the common deep-path case.
function collapse(node) {
  for (const dir of node.dirs) collapse(dir);
  const merged = [];
  for (const dir of node.dirs) {
    let current = dir;
    while (current.files.length === 0 && current.dirs.length === 1) {
      const only = current.dirs[0];
      current = { name: `${current.name}/${only.name}`, dirs: only.dirs, files: only.files };
    }
    merged.push(current);
  }
  node.dirs = merged;
}

export function buildFileTree(files) {
  const root = { name: "", dirs: [], files: [] };
  for (const file of Array.isArray(files) ? files : []) insert(root, file);
  sortNode(root);
  collapse(root);
  return root;
}

// Total number of files in a subtree — handy for a directory's count badge.
export function countFiles(node) {
  let total = node.files.length;
  for (const dir of node.dirs) total += countFiles(dir);
  return total;
}
