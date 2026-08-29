# @obversa/surfacer

Surfacer runs one secure local surface session: a small user interface for
one decision. It owns the loopback server, the session lifecycle, and the
handoff of exactly one opaque result. It owns no callback state, no
routing, and no run records.

Extracted from the skills-manager donor. Nothing of that product's
inventory, graph, or editing behaviour survives here.

## What the package gives

- `runSurface({...})` — the one launcher: it starts the session, places
  the page in the selected host, reports the url through `ready`, waits
  for the single decision, frames it on stdout, and shuts down. Signals
  interrupt cleanly. `examples/hello-surface.mjs` runs it end to end.
- `startSurface({ app, assets, api, ... })` — one loopback server on an
  ephemeral 127.0.0.1 port. The page URL carries a fragment token. Every
  API request must send it as a bearer token, checked in constant time.
  Requests with a wrong Host are refused, and state-changing requests
  with a wrong Origin are refused (a GET carries no Origin to check).
  JSON bodies are bounded at 4 MiB. Responses carry strict security headers, and
  response values pass secret redaction by default; a handler that returns
  `{ verbatim: true }` sends its body byte-exact, as `session.complete`
  does with its verbatim option (below).
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
  0600 files) with SHA-256 hashes in the manifest. `removeTransfer`
  removes only directories this module created.
- `@obversa/surfacer/client` — the no-framework browser kit: token
  handling, authenticated fetch, heartbeat, submit and cancel with
  acknowledgement.
- `openSurfaceUrl` — host placement: the command the host injected as
  `$OBVERSA_SURFACE_BIN` first, run only when it is an absolute path
  (it receives a one-time launch URL that redirects to the page — the
  token never enters a process argument — and nothing is looked up on
  PATH; the cmux review command sets it to the glue beside itself), the
  platform browser by its system path second, a printed URL last. Diagnostics
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
