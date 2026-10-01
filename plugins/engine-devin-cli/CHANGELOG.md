# @obversa/engine-devin-cli

## 0.1.0

### Minor Changes

- `devin(model?)` is a Devin seat for team workflows. Each attempt runs one fresh `devin -p` process with your own environment, Devin login and Devin settings. A read-only step runs with Devin's `auto` permission mode, and a step that may write runs with `accept-edits`.
