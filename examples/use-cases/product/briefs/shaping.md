---
files: ["pitches/r-1.md", "pitches/r-2.md"]
---

# Shape the requests into pitches

Read each raw request in `requests/` and write it as a pitch to
`pitches/<request id>.md`. A pitch has five parts, each under its own
heading, in this order:

1. **Problem.** The situation someone is in, in their words, and why it
   matters now.
2. **Appetite.** How much of the team's time this is worth, as a fixed
   amount. Copy the `appetite` value from the request's front matter into
   a line `Appetite: <value>`; the value is the request's, not yours.
3. **Solution.** The rough shape of what we would build, in a paragraph,
   with no interface detail.
4. **Rabbit holes.** The parts that could eat the appetite, named so the
   team avoids them.
5. **No-gos.** What this pitch does not include, so nobody builds it.

The reviewer checks that every pitch has all five parts and that the
appetite is the request's. A pitch missing a part goes back to you.
