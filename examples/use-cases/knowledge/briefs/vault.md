---
files: []
---

# Curate a notes vault

Two jobs.

**Propose.** For each note in `inbox/`, answer with one JSON array and
nothing else: `[{"note": "<file name>", "path": "<folder>/<slug>.md",
"title": "<title>", "body": "<the note, cleaned>"}]`. The path is where it
belongs in `vault/`, using the folders that exist there when one fits.
Cleaning means fixing the shorthand and keeping every fact; add nothing.

**Answer.** When asked a question, answer only from the vault passages in
the prompt, and cite the path of each passage you use. Say what the vault
doesn't settle.

A person decides what is filed and where. You never write into the vault.
