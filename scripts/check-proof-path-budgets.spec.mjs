import assert from "node:assert/strict";
import test from "node:test";

import { findProofPathViolations } from "./check-proof-path-budgets.mjs";

test("reports waits and timers outside a budget chain", () => {
  const source = `
    import { spawnSync } from "node:child_process";

    async function readLater() {
      return await fetch("https://example.test");
    }

    test("unbounded", async () => {
      await readLater();
      for await (const item of stream) consume(item);
      setTimeout(() => {}, 10);
      setTimeout(() => child.kill("SIGKILL"), 10);
      AbortSignal.timeout(10);
      spawnSync(process.execPath, [], { timeout: 10 });
    });
  `;

  const violations = findProofPathViolations(source, "fixture.mjs");

  assert.ok(violations.some(({ kind }) => kind === "await"), "bare await is reported");
  assert.ok(violations.some(({ kind }) => kind === "for-await"), "for-await is reported");
  assert.ok(violations.some(({ kind }) => kind === "timer"), "raw timers are reported");
  assert.ok(violations.some(({ kind }) => kind === "kill-timer"), "kill timers are reported");
  assert.ok(violations.some(({ kind }) => kind === "spawn-timeout"), "spawn timeouts are reported");
});

test("accepts waits in a chain phase, helper calls from that phase, and span-derived child timeouts", () => {
  const source = `
    import { spawnSync } from "node:child_process";

    const chain = defineBudgetChain("fixture", 100, {
      setup: 10,
      phases: [["work", 20]],
      cleanup: 10,
    });
    const childTimeout = chain.span("child", ["work"]);

    async function readLater() {
      return await fetch("https://example.test");
    }

    test("bounded", async () => {
      await chain.run("work", async () => {
        await readLater();
        for await (const item of stream) consume(item);
        setTimeout(() => {}, 10);
        AbortSignal.timeout(10);
      });
      spawnSync(process.execPath, [], { timeout: childTimeout });
      setTimeout(() => child.kill("SIGKILL"), childTimeout);
    });
  `;

  assert.deepEqual(findProofPathViolations(source, "fixture.mjs"), []);
});

test("does not treat an in-memory promise as external progress", () => {
  const source = `
    test("already settled", async () => {
      await Promise.resolve("value");
    });
  `;

  assert.deepEqual(findProofPathViolations(source, "fixture.mjs"), []);
});

test("reports a helper wait when the helper is called outside a chain phase", () => {
  const source = `
    async function readLater() {
      return await fetch("https://example.test");
    }

    test("unbounded helper", async () => {
      await readLater();
    });
  `;

  const violations = findProofPathViolations(source, "fixture.mjs");
  assert.ok(violations.some(({ kind }) => kind === "await" && /readLater/.test(violationText(violations, kind))));
});

function violationText(violations, kind) {
  return violations.find((violation) => violation.kind === kind)?.message ?? "";
}
