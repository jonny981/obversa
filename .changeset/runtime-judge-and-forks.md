---
"@obversa/runtime": patch
---

The judge now decides each review finding (act or skip, with a reason): the builder gets only the findings worth acting on, skipped findings and their reasons reach the next round's reviewers, and a round where every finding is skipped ships. A chosen `continue` runs another round within the cap, and the judge's event records the route and the rule behind it. A person's answer to a product decision goes to the builder as the next round. A run deletes the branches of forks that ended without landing, recording any commits it threw away, keeps the fork of an interrupted attempt, a winner that could not merge, and a step that threw, and logs a cleanup that fails.
