# @obversa/surfacer

Surfacer runs one secure local surface session: a small user interface for
one decision. It owns the loopback server, the session lifecycle, and the
handoff of exactly one opaque result. It owns no callback state, no
routing, and no run records.

Extracted from the skills-manager donor. Nothing of that product's
inventory, graph, or editing behaviour survives here.

## What the package gives

- `startSurface({ app, assets, api, ... })` — one loopback server on an
  ephemeral 127.0.0.1 port. The page URL carries a fragment token. Every
  API request must send it as a bearer token, checked in constant time.
  Requests with a wrong Host or Origin are refused. JSON bodies are
  bounded at 4 MiB. Responses carry strict security headers, and all
  values pass secret redaction.
- Payloads pass secret redaction by default. `session.complete(payload,
  { verbatim: true })` is the explicit opt-in for content that must
  survive byte-exact — review annotations quoting code, for example —
  and the caller owns what it carries.
- One terminal decision per session: the app completes it, the user
  cancels it, the lease or session times out, or the caller interrupts.
  `waitForDecision()` resolves with one result and the browser
  acknowledges it, with a timeout when the acknowledgement never comes.
- `frameResult` / `parseFramedResult` — the framed stdout handoff with
  app-named frames, so one caller can demultiplex surfaces.
- `createPrivateTransfer` — private temporary files (0700 directory,
  0600 files) with SHA-256 hashes in the manifest.
- `@obversa/surfacer/client` — the no-framework browser kit: token
  handling, authenticated fetch, heartbeat, submit and cancel with
  acknowledgement.
- `openSurfaceUrl` — host placement: the cmux adapter through the F0
  glue script first (`$OBVERSA_SURFACE_BIN` or `obversa-surface` on
  PATH), the platform browser second, a printed URL last. Diagnostics
  stay on stderr; stdout belongs to the framed result.

## Test

```sh
node --test test/*.test.mjs
```

The suite runs real HTTP sessions against the loopback server. No UI
opens and nothing external is called.

## Rules

- No dependency on Lines, Obversa records, or one required host.
- Short surface sessions only; no long-lived viewer lifecycle.
- A surface returns one opaque result. The caller interprets it.
