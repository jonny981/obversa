---
name: review-diff
description: Open the current git diff for inline review in a local surface and return the annotations. Use when a person should review a change before it proceeds.
---

## Launch

Run from the repository under review and keep the command running until the
reviewer submits, cancels, or the session ends:

    npx -y @obversa/source@0 <selected args>

Pick the arguments from what was asked for: no mode flag reviews the working
tree; `--staged` only when the staged changes were requested; `--range A..B`
for a ref range. `--cwd <dir>` runs against another repository directory;
`--no-open` prints the URL on stderr instead of placing the surface.

## Handle the result

Read only the JSON between `<<<REVIEW_RESULT_V1>>>` and
`<<<END_REVIEW_RESULT_V1>>>` on stdout.

- `completed`: `payload.decision` is `approved` (no annotations) or
  `changes-requested` (one or more). Apply each annotation at its anchor
  (`target`, `side`, `position`).
- `cancelled`, `timed_out`, `interrupted`, `error`: make no change and report
  the status and `detail`.
- No frame at all (the command exited before printing one, for example because
  the package could not be fetched or resolved): treat it as `error`. Report
  the last lines of stderr, make no change, and do not retry with a different
  version.
- `surface.package` and `surface.version` name the package and the resolved
  version that ran. Report them with the outcome.
