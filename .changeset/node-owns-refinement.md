---
"@obversa/runtime": minor
"@obversa/builtin-workflows": minor
---

A `dag()` node now owns its refinement: `agent` names the seat that does the work, `writes` scopes what it may write, and `refine: review({ ... })` holds its checks, goal check, reviewers, judge or round limit, and optional fixer in one field. `pipeline()` stages take the same fields. `review()` exports the value, `isReview()` recognises it.

Removed, with no alias: the graph-level `maxKickbacks` map and the `KickbackBudget` type. A node that may receive work again declares `refine`, whose `rounds` or `judge` governs its own reviews and the send-backs it receives. `acceptsKickbackTo` is replaced by `sendsBackTo` on the sending node. A graph that still uses either name fails at compile with a message naming the new field.

In `@obversa/builtin-workflows` the `maxKickbacks` config field is renamed `refine` (`RefineBudget`), and a number now counts per send-back target: `refine: 2` lets each target take two send-backs, where `maxKickbacks: 2` allowed two for the whole graph. A map gives each target its own rounds or judge, and a target absent from a map refuses send-backs.

Three smaller behaviour changes ride with it. A `workflow()` writer stage that answers in prose is asked once more instead of failing, the same second ask a reviewer gets: one more model call instead of a spurious failure. A `workflow()` stage a panel reviews whose declared write stays missing now sends the work back on a check budget of 3 instead of spending a refinement: `refine: N` can run up to N+1+3 builds on that stage, where before it stopped at N+1. And a reviewer whose engine throws, or refuses to start on an `invalid-config` failure, now pauses every review panel as an operational error, where before it counted as a rejection.

`loop()` is unchanged: it keeps its own `max` and `review` options and does not take `review()`.
