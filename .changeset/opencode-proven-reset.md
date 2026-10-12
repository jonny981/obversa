---
"@obversa/engine-opencode-cli": patch
---

A limit the provider reports through its own response fields — a `retry-after` or rate-limit-reset header — now marks the reset it carries as proven. A run's availability store only remembers a billing or quota failure whose reset is proven: one a header or structured field stated, never one parsed out of error text.
