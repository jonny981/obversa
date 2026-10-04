---
"@obversa/engine-grok-cli": patch
---

`grok(model, { executable })` makes a Grok seat for a workflow role in one line, as `claude(model)` does for Claude. It returns the engine and its identity, reads with `read_file`, `grep` and `list_dir` unless you pass `tools`, and takes `version` and `effort`. A Grok tool named as a permission rule is read as the rule for that tool, such as `read_file` as `Read`, so a seat's tools work as its rules in a workflow.
