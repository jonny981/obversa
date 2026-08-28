import path from "node:path";
import { fileURLToPath } from "node:url";

// The browser assets (app.js, app.css, and the modules they import) are static
// files served verbatim, and index.html is the same for every review: it
// carries nothing about the review — not the diff, not the ref under review.
// Static files are served before the auth check, so anything embedded in the
// shell would be readable by any local process that found the loopback port;
// the page fetches the diff model and its label from GET /api/model behind the
// bearer token, and that authenticated, verbatim response keeps the subject
// under review behind the session token.
export const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

/**
 * Generate the review page shell. It links the static assets and nothing
 * else; app.js fetches the diff model and metadata from the session API once
 * it has the token, sets the title, renders the diff, and returns the
 * reviewer's annotations.
 */
export function buildIndexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review</title>
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
