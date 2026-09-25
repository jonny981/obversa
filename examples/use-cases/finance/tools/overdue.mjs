#!/usr/bin/env node
// Read the ledger and write the overdue invoices, with days overdue, to
// chase/overdue.json. Stands in for the export a real ledger would give.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const ledger = JSON.parse(readFileSync('ledger/invoices.json', 'utf8'));
const asOf = Date.parse(ledger.asOf);
const day = 24 * 60 * 60 * 1000;
const overdue = ledger.invoices
  .filter((invoice) => !invoice.paid && Date.parse(invoice.due) < asOf)
  .map((invoice) => ({ ...invoice, currency: ledger.currency, daysOverdue: Math.floor((asOf - Date.parse(invoice.due)) / day) }));
mkdirSync('chase', { recursive: true });
writeFileSync('chase/overdue.json', `${JSON.stringify(overdue, null, 2)}\n`);
console.log(`${overdue.length} of ${ledger.invoices.length} invoices overdue as of ${ledger.asOf}`);
