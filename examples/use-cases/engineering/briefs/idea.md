Ledgerline, an invoicing app for freelancers, wants invoices to be paid by
bank transfer with automatic matching: when money lands in the business
account, the matching invoice is marked paid without anyone doing it by
hand.

What exists: invoices with a number, an amount and a due date in Postgres;
a nightly job; no bank connection. Constraints: one engineer for four
weeks; the bank feed arrives as a CSV export a user uploads, not an API,
for the first version; a wrong match is worse than no match.

The spike must prove the matching rule on real-shaped data before anyone
builds the upload. Write the spike as a Node program with no dependencies
that reads a small CSV of transactions and a list of open invoices, both
written into the program, and prints which transaction matches which
invoice and why, exiting 1 when any transaction matches two invoices.
