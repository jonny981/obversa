---
"@obversa/engine-claude-agent-sdk": patch
---

A usage, billing or rate limit the SDK reports through its structured `rate_limit_info` field now marks the reset it carries as proven. A run's availability store only remembers a billing or quota failure whose reset is proven: one a structured field stated, never one parsed out of error text.
