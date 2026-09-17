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
