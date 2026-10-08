---
"@obversa/notify-webhook": patch
---

The package's README and documentation describe posting a run's progress to a team's channel, and name only the channels whose incoming webhooks show the message as it is: Slack and Mattermost. Discord shows it on its webhook URL with `/slack` at the end. Microsoft Teams shows it through a workflow from Teams' Workflows app that posts the body's `text`, and Google Chat through a relay that posts the `text` to the space's incoming webhook.
