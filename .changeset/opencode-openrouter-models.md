---
"@obversa/api": patch
"@obversa/engine-opencode-cli": patch
---

Accept OpenRouter model names through the OpenCode engine, such as `openrouter/anthropic/claude-sonnet-4.5`. Record `openrouter` as the provider and derive the family from the final model name, so a Claude model remains in the Claude family across providers. Refuse OpenRouter routers such as `openrouter/openrouter/auto`, which cannot declare a fixed family.
