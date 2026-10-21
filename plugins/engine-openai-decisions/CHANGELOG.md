# @obversa/engine-openai-decisions

## 0.1.1

### Patch Changes

- Updated dependencies [56a7020]
- Updated dependencies [a6f95ac]
- Updated dependencies [7c0a425]
- Updated dependencies [1d951ce]
  - @obversa/api@0.3.0

## 0.1.0

### Minor Changes

- `openaiDecisions()` puts OpenAI's Decisions API into a workflow as an engine: typed answers about a run's state, a probability, a choice or a score, from `gpt-6-luna`. It takes the same prompt document as the Jev engine, so `judge(openaiDecisions())` works as `judge(jev())` does. The answers come back keyed by question name, a predicate's probability also given as `noul`. The key comes from `OPENAI_API_KEY` or the `apiKey` option.
