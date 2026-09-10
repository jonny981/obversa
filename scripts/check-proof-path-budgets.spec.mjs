import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("verify:f15 runs the proof-path spec before the checker", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(scripts["verify:f15"], /pnpm test:proof-path-budgets && pnpm check:proof-path-budgets/);
});

test("reports response body reads outside a budget-chain phase", () => {
  const source = `
    async function readBody(response) {
      await response.json();
      await response.text();
      await response.arrayBuffer();
      await response.body.getReader().read();
    }

    test("unbounded body", async () => {
      await readBody(response);
    });
  `;

  const violations = findProofPathViolations(source, "fixture.mjs");
  assert.ok(violations.filter(({ kind }) => kind === "await").length >= 4);
});

test("reports synchronous process calls without a chain-derived timeout", () => {
  const source = `
    const session = {
      run(callback) { return callback(); },
      span() { return 10; },
    };

    test("unbounded process", async () => {
      await session.run(async () => { await fetch("https://example.test"); });
      spawnSync(process.execPath, []);
      execFileSync("git", ["status"]);
    });
  `;

  const violations = findProofPathViolations(source, "fixture.mjs");
  assert.equal(violations.filter(({ kind }) => kind === "spawn-timeout").length, 2);
});

test("only a budget-chain receiver creates a guarded phase or derived span", () => {
  const source = `
    const chain = defineBudgetChain("fixture", 100, {
      setup: 10,
      phases: [["work", 20]],
      cleanup: 10,
    });
    const session = {
      run(callback) { return callback(); },
      span() { return 10; },
    };
    const timeout = session.span("child", ["work"]);

    test("collisions are not guards", async () => {
      await session.run(async () => { await fetch("https://example.test"); });
      spawnSync(process.execPath, [], { timeout });
    });
  `;

  const violations = findProofPathViolations(source, "fixture.mjs");
  assert.ok(violations.some(({ kind }) => kind === "await"), "session.run does not guard the callback");
  assert.ok(violations.some(({ kind }) => kind === "spawn-timeout"), "session.span does not derive a child timeout");
});

function violationText(violations, kind) {
  return violations.find((violation) => violation.kind === kind)?.message ?? "";
}
