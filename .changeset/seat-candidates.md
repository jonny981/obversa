---
"@obversa/api": minor
"@obversa/runtime": minor
"@obversa/builtin-workflows": minor
---

One seat can name its candidate models in order. Where a `dag()` node's `agent`, a `pipeline()` stage's `agent` or a seat in `review({ reviewers })` took a `TeamSeat`, it also takes `{ seat, candidates }`: the seat that runs first and the ordered alternatives behind it, each a full seat with its own engine, identity and tools. A call that fails on billing or quota runs the next candidate in the same step, and each attempt uses the candidate's own tool policy. A rate limit follows the step's `fallbackOn` policy, so it also moves to the next candidate when that policy allows it, as the default does. Any other failure ends the step exactly as before, and `agentJob`'s own `fallback` and `fallbackOn` are unchanged. When no candidate can run, the step ends on a `QUOTA` error that carries the earliest known reset, so the run's `onLimit` policy waits for that reset or pauses, as it does for a single model. An empty `candidates` list is refused, and a seat with none behaves exactly as before.

The run records each move as a `seat:route` event: the requested identity, the selected candidate, the failure kind and the reset when one is known. What actually answered stays on `engine:usage` as before, and the recorded-model checks keep reading it.

A run may carry an `AvailabilityStore` (`run({ availability })`; `fileAvailabilityStore(path)` is the plain-file default). When a billing or quota failure reports a proven reset, one a header or structured field stated rather than text parsed out of the error, the store remembers `(adapter, provider, model) -> until`, and a later run skips that candidate without a call and records the skip. A candidate with no proven reset is never written, a corrupt store file reads as empty with a warning, and a run with no candidate seats never touches the store.

The distinct-family rule now reads every candidate a seat can resolve to: inside a review, no reviewer may reach the model family of another reviewer, the node's `agent` or its `fixer` over any combination of candidates, or the graph is refused before any model runs.

In `@obversa/builtin-workflows`, a reviewer in `thresholdPanel` and `featureDelivery` is a `ReviewerSeat`, so it takes `{ seat, candidates }` the same way, and each workflow's distinct-family check reads every candidate a seat can resolve to.
