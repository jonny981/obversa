---
"@obversa/runtime": patch
---

The run page answers a judge's product decision, not only approvals. A judge's product decision gets a box for your written decision and a Send button, so you answer it without posting JSON by hand. Any other question shows a labelled field for each field its answer needs. A question that accepts more than one shape of answer lets you pick the shape first. Approvals keep their Yes and No buttons and the note. `/state` sends each waiting question's `responseSchema`, and what you type stays in the form while the page polls and while other questions arrive or are answered. When the run refuses an answer, the reason stays on the page until you send again.
