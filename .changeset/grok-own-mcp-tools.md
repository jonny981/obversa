---
"@obversa/engine-grok-cli": patch
---

A Grok step answers when one of your own MCP servers connects before Grok starts its reply. Grok lists that server's tools in its start message even though the plugin keeps them from the model. The engine leaves a listed server's tools out of its tool check, so such a run answers instead of failing with `Grok returned an invalid JSON stream`. Write steps hit this most often.
