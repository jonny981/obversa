# @obversa/notify-webhook

`@obversa/notify-webhook` tells somebody what a run is doing. It turns the
run's own events into one message each and posts them to a URL you supply.

The body carries a `text` field, which is the field a Slack, Discord or Teams
incoming webhook renders, so those three need no code of their own. Everything
else in the body is structured, for a relay that wants the parts.

## Install

```bash
pnpm add @obversa/notify-webhook
```

## Requirements

- Node.js 22.12 or later

## Build from the workspace

From the workspace root, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @obversa/notify-webhook build
```

## Usage

The notifier is an `onEvent` consumer. Hand its `onEvent` to `run`, and await
`done()` afterwards so the last message is not lost when the process exits.

```ts
import { webhookNotifier } from '@obversa/notify-webhook';
import { run } from '@obversa/runtime';

const notifier = webhookNotifier({
  url: process.env.OBVERSA_WEBHOOK_URL ?? '',
  onError: (error) => { console.error(error.message); },
});

const result = await run(job, { onEvent: notifier.onEvent });
await notifier.done();
```

The URL is yours and it is read at run time. Nothing in this package, its
tests or its documentation contains one.

## What it sends

Six moments, one message each.

| Moment | The run event behind it | What the message carries |
| --- | --- | --- |
| `run-started` | `dag:start`, `loop:start` or `workflow:start` | What started |
| `stage-finished` | `dag:node` reaching `done`, at any depth | The stage and how it ended |
| `sent-back` | `dag:kickback`, or a `loop:review` that did not pass | The reason the reviewer gave, and in a graph which stage it went back to |
| `paused` | A stage whose outcome is `paused`, or an ending event with one | The question being asked, and the run's page |
| `finished` | An ending event whose outcome is `pass` | That it finished; the run's summary is a field on the body, not in the text |
| `failed` | An ending event with any other outcome | Why it ended that way |

Two of them carry the information rather than a pointer to it. The paused
message names the run's page, so the person can answer from the message. The
sent-back message carries what the reviewer said, so the news is the reason
and not just the fact. It is posted for both shapes a review takes: a graph
names the stage the work went back to, and a loop sends it back to its own
body, so it names no stage.

The paused message asks the person's own question, which a person gate carries
as its own field on the outcome. Any other pause says what it is waiting for in
its summary, and that is used as it stands.

A stage that is waiting for a person has not finished, so it is reported as
paused rather than as a stage finishing. That matters where the run stays up
for the answer instead of ending: the run reports no outcome while it waits, so
the stage is the only thing that says the wait is happening at all. Where the
run does end on the wait, the stage message and the run's own outcome are the
same news, and only the first is sent. A run with two gates is told about
both.

A run is announced once and ends once, and its own news comes from one place:
the first graph or loop the run reports, which owns it. That container's own
ending is the run's ending, at whatever depth it sits. The depth is read from
the run rather than assumed, because depth is a property of what wraps the job
and the caller decides that - a workflow's `post.always` wraps the whole graph
in a loop, which moves every one of that graph's events one level deeper
without making the run any different. A run that reports no container at all is
a single job, and that job's end is the run's end, because nothing else would
report it.

News from inside the run is not filtered by depth. A stage finishing and a
review failing a step are reported wherever they happen, including in a
graph that something else is wrapping. Everything else a run emits, including
every engine token, is ignored.

## What it does not send

A failure is reported from the event that ends the run, never from the `error`
event. A loop can emit `error` in one iteration and pass in the next, so
notifying on it would announce a failure for a run that went on to succeed.
The ending event carries the same text in its summary.

A resumed run sends nothing of its own, because nothing in a run says it
resumed: the caller passed `resume: true` and already knows.

## Failure

A notification that cannot be delivered never fails the run. A refused or
unreachable endpoint reaches `onError` and the run carries on. Messages are
posted in the order the run made them, so one slow post delays the rest rather
than letting them overtake it.

## Example

[`examples/notify-webhook.ts`](../../examples/notify-webhook.ts) runs a small
graph offline whose review fails the draft once, and prints what a channel
would have shown:

```bash
pnpm example:notify-webhook
```

## Licence

MIT
