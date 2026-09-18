import assert from "node:assert/strict";
import test from "node:test";

import { defineBudgetChain } from "../../../test-support/budget-chain.mjs";

test("span derives a containing lifetime from its named phases", () => {
  const chain = defineBudgetChain("review-cli", 10_000, {
    setup: 1_000,
    phases: [["page URL", 2_000], ["model fetch", 3_000], ["child close", 1_000]],
    cleanup: 1_000,
  });

  assert.equal(chain.span("child process", ["page URL", "model fetch", "child close"]), 6_000);
  assert.equal(chain.totalMs, 8_000);
});

test("a ceiling is sized by its own wait, not by what the other phases might take", async () => {
  // Phase allowances are worst cases that do not happen together: a run that
  // spends a minute waiting for a browser target does not also spend a minute
  // posting the page. Requiring the allowances to sum inside the test budget
  // squeezed every ceiling until an ordinary slow moment tripped one, which
  // cost a gate round. A single phase may not reach the test budget; the sum
  // may exceed it.
  const chain = defineBudgetChain("generous", 10_000, {
    setup: 6_000,
    phases: [["first wait", 9_000], ["second wait", 9_000]],
    cleanup: 6_000,
  });

  assert.equal(chain.allowance("first wait"), 9_000);
  assert.equal(chain.totalMs, 30_000);
  assert.throws(
    () => defineBudgetChain("too wide", 10_000, {
      setup: 1_000,
      phases: [["one wait", 10_000]],
      cleanup: 1_000,
    }),
    /one wait/,
    "a single phase that reaches the test budget is still refused",
  );
});

test("a condition that arrives late still passes, and one that never arrives fails by name", async () => {
  const chain = defineBudgetChain("condition", 10_000, {
    setup: 100,
    phases: [["slow condition", 400]],
    cleanup: 100,
  });

  // Later than a tight ceiling would have allowed, well inside a ceiling sized
  // for the wait itself.
  const value = await chain.run("slow condition", async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return "arrived";
  });
  assert.equal(value, "arrived");

  await assert.rejects(
    chain.run("slow condition", () => new Promise(() => {})),
    /condition phase slow condition exceeded 400ms/,
    "a condition that never arrives fails at the ceiling naming the phase",
  );
});
