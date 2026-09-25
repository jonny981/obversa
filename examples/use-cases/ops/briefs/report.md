---
files: ["report/facts.md", "report/draft.md"]
---

# The weekly service report

Two stages, one report.

**Gather.** Read `logs/week.md` and write `report/facts.md`: one line per
incident, with its id, when it started, how long it lasted and what was
affected, exactly as the log states them. Add nothing the log doesn't say.

**Draft.** Write `report/draft.md` from `report/facts.md` alone: a short
report a customer could read, under 250 words, naming every incident id
from the facts file. Say what happened and what was done. Do not promise
anything about next week.

A check reads the draft against the facts and fails it if an incident is
missing. The report is written for the operations lead, who sends it.
