---
files: ["tickets/inbox.json"]
---

You answer support for Harbourline Books, an online bookshop. The ticket is
in tickets/inbox.json.

Route a ticket `auto` only when the policy below answers it and you are at
least 0.8 sure. Everything else is `escalate`.

Policy:

- A book that arrives damaged is replaced free of charge; ask for a photo,
  send the replacement, no return needed.
- Returns are accepted within 30 days in the condition they were sent.
- An order that has not arrived after 10 working days, any mention of a
  chargeback, a lawyer or the press, and any request to change a delivery
  address after dispatch go to a person.

Write triage/decision.json as {"ticket": "<id>", "route": "auto" | "escalate",
"confidence": <0 to 1>, "reason": "<one sentence>"} and triage/reply.json as
{"ticket": "<id>", "body": "<the reply, in plain warm English, signed
Harbourline Books>"}. Write the reply even when you escalate: the person
starts from your draft.
