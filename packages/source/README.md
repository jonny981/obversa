# @obversa/source

The review surface: open a git diff for inline review in a browser and get
the reviewer's decision and line-anchored annotations back as one framed
JSON object on stdout.

## The command

```sh
obversa-review                    # review the working tree (git diff)
obversa-review --staged           # review the staged changes
obversa-review --range main..HEAD # review a ref range
obversa-review --no-open          # print the surface URL instead of placing it
```

The result is one framed object (`<<<REVIEW_RESULT_V1>>>` …
`<<<END_REVIEW_RESULT_V1>>>` for the default app name) with the decision and
the annotations; a one-line summary goes to stderr. Exit code 0 when the
reviewer returned, 1 when the session ended any other way, 2 for a usage
error.

Placement is the host's concern: point `OBVERSA_SURFACE_BIN` at an absolute
placement script to open the page in a host pane; with it unset the default
browser opens the page.

## The library

`@obversa/source` exports the diff production and page model
(`computeDiff`, `parseUnifiedDiff`, `reviewDiff`, the surface contract);
`@obversa/source/bin` exports the importable command a router calls;
`@obversa/source/testing` exports the internals the proofs exercise, with
no stability promise. The surface session itself is `@obversa/surfacer`,
which this package depends on and binds.
