# CHANGELOG.md, Unreleased (lead's words, byte for byte). Released text from the 1.0.0 heading down is untouched.

## Under "### Added", after the `maxKickbacks` item

- **Engine checks before graph work:** A plan may carry a preflight policy,
  one entry per lane with `live: 'required' | 'skip'` and
  `unsupportedStatic: 'block' | 'allow'`. Before the first dispatch the
  executor asks each engine to `admit` the seat with real node
  configuration and, where required, makes one tool-free live call per
  eligible seat, one at a time, stopping at the first that answers. A
  failed check pauses the run with `PREFLIGHT_PAUSED` before any work;
  `resume({ preflightEventId })` and `resumeSupervisedRun` with
  `preflightEventId` reopen that exact pause, repeat the static checks and
  reuse live receipts that still apply. `readRunPreflight` reads the record.
- `Engine.admit` on the engine contract: an engine reports the identity it
  will run under, and refuses when it would now run as something else.
  `AgentRequest.purpose: 'preflight'` marks a live check.

## New "### Changed" items, under the existing "### Changed" heading

- A failed engine check or call retires what the failure proves: bad
  credentials retire the selected adapter and provider; a missing model,
  exhausted credit or an exhausted quota retire the provider and model; a
  missing command-line tool or an invalid configuration retire the
  adapter; a rate limit or a transport error retire nothing. The reported
  effective identity is evidence in the record and never widens the scope.
  An old auth record with no provider recovers one from its lane, and an
  ambiguous recovery refuses before work with `ENGINE_IDENTITY_UNRESOLVED`.
- Usage that was not reported is unknown, not zero; usage from checks is
  recorded separately from usage from nodes. Preflight checks before a
  worker launches spend no run budget; checks inside a worker do.
- Environment variable names passed to a supervised run are validated and
  their values captured before any asynchronous work; no value reaches run
  storage.

## Under "### Fixed"

- A result whose assistant text is not a string is rejected by the shared
  engine validator, in complete results and in incomplete evidence alike;
  an empty string is still valid text.
