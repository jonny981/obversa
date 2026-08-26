import path from "node:path";
import { fileURLToPath } from "node:url";

// The browser assets (app.js, app.css) are static files served verbatim. Only
// index.html is generated per review, because it carries the diff model.
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

// Embed a value inside <script type="application/json"> safely. The block is
// inert data, not executable script, so the session CSP (script-src 'self')
// permits it. The only breakout risk is the literal substring "</script"; we
// escape every '<', '>' and '&' to its \u form, which stays valid JSON and
// decodes back to the original text in the browser. U+2028 and U+2029 are
// escaped too: they are valid in JSON but are line terminators in JavaScript,
// so they must not appear raw where a script could later read them.
export function escapeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

/**
 * Generate the review page shell. It carries the parsed diff model and the
 * review metadata as an inert JSON block; app.js reads that block, renders the
 * diff, and returns the reviewer's annotations. The diff travels in the static
 * shell rather than an /api response on purpose: every /api JSON body is
 * redacted by the surface server, which would corrupt code under review, so the
 * verbatim diff rides the same raw static channel that serves app.js. The
 * bearer token still gates the state-changing annotation submission.
 *
 * Known limitation (tracked for the F3 remainder): static assets are served
 * before the bearer check, so while the session is open a same-user process on
 * the same machine can read the diff over the loopback port. On the single-user
 * local-dev target this adds nothing — such a process could run `git diff`
 * itself — but on a shared host it is a local read channel. The clean fix keeps
 * the diff behind the token, which needs a surfacer capability (an opt-in
 * verbatim /api response, mirroring session.complete's verbatim option, so the
 * diff can be fetched authenticated without redaction); that is deliberately
 * out of this F2-completing slice and not rushed into the hardened runtime.
 */
export function buildIndexHtml({ model, meta }) {
  const payload = escapeJsonForHtml({ model, meta });
  const title = escapeHtml(`Review: ${meta?.label ?? "changes"}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<script type="application/json" id="review-data">${payload}</script>
<main id="app" aria-busy="true">Loading review…</main>
<script type="module" src="/app.js"></script>
</body>
</html>
`;
}
