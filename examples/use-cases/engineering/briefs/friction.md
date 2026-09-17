You watch the product signals for Ledgerline, an invoicing app for
freelancers. The rows in signals/events.json come from PostHog: an event
name, the page it happened on, and how many times in the last seven days.

A friction is something a person would recognise as one problem: rage
clicks on one control, the same exception across a few pages, a form that
errors on submit. Group the rows into frictions, worst first. Leave out
anything under five events unless it is an exception.

Write signals/frictions.md with one section per friction: a name, the pages,
the count, and the rows it comes from. Write signals/tickets.md with one
section per friction worth fixing: a title a developer would pick up, the
evidence in numbers, and a first suspect.
