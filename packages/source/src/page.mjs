import path from "node:path";
import { fileURLToPath } from "node:url";

// The browser assets (app.js, app.css, and the modules they import) are static
// files served verbatim. Only index.html is generated per review, and it
// carries nothing but the title: the diff model itself is fetched by the page
// from GET /api/model behind the bearer token. Static files are served before
// the auth check, so a diff embedded in the shell would be readable by any
// local process that found the loopback port; the authenticated, verbatim
// /api response keeps the code under review behind the session token.
export const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

// Escape a string for use as HTML text or an attribute value.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Generate the review page shell. It links the static assets and names the
 * review in its title; app.js fetches the diff model and metadata from the
 * session API once it has the token, then renders the diff and returns the
 * reviewer's annotations.
 */
export function buildIndexHtml({ meta }) {
  const title = escapeHtml(`Review: ${meta?.label ?? "changes"}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="/highlight.css">
</head>
<body>
<main id="app" aria-busy="true">Loading review…</main>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
}
