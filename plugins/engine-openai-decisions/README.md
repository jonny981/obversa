# @obversa/engine-openai-decisions

`@obversa/engine-openai-decisions` runs one isolated Obversa engine attempt as
a single call to OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions):
typed answers about some evidence, the probability that a condition is true,
one choice from a fixed set, or a score against ordered levels.

It takes the questions of `@obversa/engine-jev-api`'s prompt document
(`noul`, `choice` and `score`), so the runtime's `judge` runs on it unchanged.

## Requirements

- Node.js 22.12 or later
- An OpenAI API key with access to the Decisions API

## Use

```ts
import { openaiDecisions } from '@obversa/engine-openai-decisions';

// Reads OPENAI_API_KEY. The model defaults to gpt-6-luna.
const decider = openaiDecisions();
```

Pass the seat wherever a Jev seat goes, for example `judge(decider)` in a
stage's `refine`.

A request's `prompt` is a JSON document carrying the evidence and the
questions, keyed by name:

```json
{
  "state": { "findings": ["..."], "rounds": 2 },
  "questions": {
    "holds": {
      "type": "noul",
      "instructions": "Does the draft hold as it stands?",
      "criteria": { "true": "Only nits remain", "false": "A block remains" }
    },
    "stop_reason": {
      "type": "choice",
      "instructions": "Why stop, if at all?",
      "criteria": { "holds": "It holds", "continue": "Another round is worth it" }
    },
    "readiness": {
      "type": "score",
      "instructions": "How ready is this to ship?",
      "criteria": ["Unsafe to ship", "Needs another round", "Ships clean"]
    }
  }
}
```

The adapter sends `state` as the evidence (a string as it is, anything else
as indented JSON) and each question in the API's own shape: a `noul` as a
`predicate`, with its true and false criteria added to the instructions; a
`choice` with each criterion as a value and its description; a `score` with
its criteria as ordered levels, each a label or a `{label, description}`
object. A `choice` needs at least two choices and a `score` at least two
levels.

The result is one `structured` part: the answers, keyed by question name,
with the fields the API returned. A predicate's `probability` is also given
as `noul`, the field a Jev answer carries. A score is the probability-weighted
average of the level indices, which start at 0. A question the API refused
comes back as `{ "type": "refusal" }`. A response that leaves a question
unanswered, or answers one nobody asked, fails the attempt.

`openaiDecisions()` returns the answers as assistant text, the JSON of the
answers object, so a job reads them as it reads any seat's reply.

## Cost

The Decisions API bills input tokens only. A response that reports no output
count is read as zero output tokens. The runtime's shipped price table keys
prices by model, and `gpt-6-luna` costs more on other OpenAI endpoints, so
the table has no entry for it. Price a run's decision calls with the
`prices` run option:

```ts
const prices = { 'gpt-6-luna': { inputPerMTokUsd: 0.1, outputPerMTokUsd: 0 } };
```

Then pass it as `run(team, { prices })`.

## Failures

- An HTTP 400 fails as `invalid-config`, 401 and 403 as `auth`, 402 as
  `billing`, 429 as `rate-limit` with its `Retry-After`, and 5xx as
  `transient`.
- An unreachable endpoint fails the attempt. The adapter never invents an
  answer and never retries on its own.
- `timeoutMs`, plus `timeoutGraceMs` when set, bounds the whole call.
  `maxOutputBytes`, when set, caps the response body the adapter reads.
- A request with a system prompt, `env`, `maxTokens`, a `jsonSchema` result,
  a workspace mode other than `none`, tools or `effort` is refused as
  `invalid-config` before any call. The key comes from adapter configuration, never from `request.env`.

## Identity

- adapter: `openai-decisions`
- provider: `openai`
- model family: read from the model name through the shared `modelIdentity`
  helper, so `gpt-6-luna` reports family `gpt`. When the response echoes no
  model, the recorded effective model and family are `null`.

## Limits

- The Decisions API is in public beta. `gpt-6-luna` is the only model it
  serves.
- Images are not sent: the adapter sends the evidence as text.
- A preflight live check can't run on this engine. The check sends a
  plain-text turn with `maxTokens`, which the engine refuses. Set
  `live: 'skip'` for its lane in a run's preflight policy.
