# @obversa/engine-jev-api

`@obversa/engine-jev-api` runs one isolated Obversa engine attempt as a single
Jev decision call over the TypeSafe API.

## Requirements

- Node.js 22.12 or later
- A TypeSafe API endpoint and bearer credential

## Use

```ts
import { JevApiEngine } from '@obversa/engine-jev-api';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  throw new Error('TYPESAFE_API_KEY is not set');
}

const engine = new JevApiEngine({
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  apiKey,
  adapterVersion: '0.1.0',
});
```

A request's `prompt` is a JSON document carrying the recorded state to judge
and the questions to answer:

```json
{
  "state": { "verdict": "...", "proofLog": "..." },
  "questions": {
    "send_back": {
      "type": "noul",
      "instructions": "Should this work go back for more iteration?",
      "criteria": {
        "true": "A finding describes incorrect behaviour a user would see",
        "false": "The findings are cosmetic or advisory only"
      }
    },
    "which_stage": {
      "type": "choice",
      "instructions": "Which stage should the work return to?",
      "criteria": {
        "implement": "The defect is in the code itself",
        "test": "The code is right but the tests do not prove it",
        "none": "Nothing needs to go back"
      }
    },
    "readiness": {
      "type": "score",
      "instructions": "How ready is this work to ship?",
      "criteria": ["Unsafe to ship", "Needs another round", "Ships clean"]
    }
  }
}
```

`choice` criteria map each option to its description, `score` criteria are
the array of labels the score indexes, and `noul` criteria describe what true
and false mean.

The adapter validates the document shape — that it parses to an object, that
`questions` is a non-empty object, and that every question names one of the
three types — before any network call. A missing or `null` `state` is sent
as an empty object; `questions` is required. It does not inspect `criteria`;
criteria are forwarded to the provider unchanged. Malformed input fails as
`invalid-config`. A successful call returns one `structured` result
part whose `value` is the provider's `answers` object itself — a binding's
`parseResult` reads `part.value.send_back` directly rather than unwrapping a
second layer.

The adapter does not validate the answer objects; it returns them unchanged.
The shapes below are what the provider has been observed to return, not
types the adapter checks:

- `noul` answers have been observed carrying `noul`, the probability that
  the proposition is true — with no separate `confidence` field.
- `choice` answers have been observed carrying `choice` plus `confidence`
  (and may carry `probabilities`).
- `score` answers have been observed carrying `score` plus `confidence`
  (and may carry `probabilities`/`legend`).

Low-confidence `choice`/`score` answers and mid-range `noul` probabilities all
complete normally — confidence thresholds and routing are the caller's policy,
not the adapter's.

An unreachable endpoint fails the attempt. The adapter never invents an
answer and never retries on its own.

The bearer key comes from adapter configuration at construction; a
`request.env` field is refused. The provider's response — including error
bodies — is recorded in the result and in error details, so anything the
provider returns can reach the run record.

`timeoutMs`, plus `timeoutGraceMs` when set, bounds the whole call —
connection and response body read. Exceeding the deadline fails as
`timeout`; a caller abort fails as `aborted`. `maxOutputBytes`, when
supplied on the request, caps the response body the adapter reads; it
applies only when set and is not a general memory bound.

Requests that carry `system`/`systemMode`, `env`, `maxTokens`, a
`workspaceMode` other than `none`, or a non-empty `tools` list are refused as
`invalid-config` before any network call.

## Live probe

`scripts/probe.mjs` is a live experiment against the real endpoint — the only
file in this package that may touch it. It is not packed; it runs from a
source checkout after `pnpm build`. It asks the three sanitized review
questions and prints what the provider answers. It reads `TYPESAFE_API_KEY`
from the environment at run time and exits nonzero if any case fails:

```bash
node plugins/engine-jev-api/scripts/probe.mjs
```

## Identity

- adapter: `jev-api`
- provider: `typesafe`
- model family: derived from the wire model through the shared `modelIdentity`
  helper (the default model `jev-latest` reports family `jev`). When the
  response echoes no model — or one that is not readable — the recorded
  effective model and model family are `null`; the answers are still
  returned.
