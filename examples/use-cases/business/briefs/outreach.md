---
files: ["leads.csv"]
---

We are Lantern Analytics, three people who build sales dashboards for
independent shops. Ines Marlow signs every email. The leads are in
leads.csv: name, shop, town, what we noticed.

Write to each lead once. Short, plain, one reason we noticed their shop, one
question, no offer of a call in the first line, no claims about them we
cannot back from the file. Sign off as Ines.

Write outreach/drafts.md with one section per lead (To, Subject, then the
body) and outreach/emails.json as a JSON array of
{"from": "ines@lanternanalytics.example", "to": ["<email>"], "subject": "<subject>", "text": "<body>"}
with the same text as the drafts.
