---
"@obversa/runtime": patch
---

A review panel can merge its reviews into one list before anyone acts on them. Set `synthesise` on a `workflow()` stage with several reviewers, a `panel:` stage, or `reviewPanel()`. Findings that name the same problem become one finding with the strongest severity, crediting every reviewer who raised it. Each reviewer then votes once on the others' findings: agree, disagree, or a better fix. A finding is dropped when the reviewers who disagree outnumber those who raised it, agreed, or offered a better fix; a better fix most voters back replaces the original; a tie stays marked disputed for the judge. A passing reviewer's findings are kept. The record shows who raised each finding, who agreed, and what was dropped and why.
