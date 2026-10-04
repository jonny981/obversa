---
"@obversa/engine-opencode-cli": patch
---

OpenCode's free models, such as `opencode/big-pickle`, run a step. The plugin sets each tool a step doesn't declare to `ask` instead of turning it off, and `opencode run` turns down every `ask`, so the tool still never runs. A step's declared tools also work on every model: OpenCode applied the plugin's catch-all rule after the step's own rules, which blocked even a declared `read`. A call to an undeclared tool that OpenCode turned down does not fail the step; the model is told and carries on.
