// The pass/fail fixture matrix for the dependency-cruiser ruleset
// (an internal note).
//
// One disposable workspace is built with a file per forbidden form — static
// import, re-export, static dynamic import, require, package-import alias,
// deep subpath past an exports map — plus the allowed forms beside them. The
// real root ruleset cruises it, and the spec asserts each forbidden file
// raises the rule that names it while every allowed file raises nothing.
// Every assertion here is a failure assertion: a ruleset edit that stops a
// rule firing fails this spec, not just the live check.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cruiserBin = join(repoRoot, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
const rulesFile = join(repoRoot, ".dependency-cruiser.cjs");

const fixture = mkdtempSync(join(tmpdir(), "obversa-arrows-"));
test.after(() => rmSync(fixture, { recursive: true, force: true }));

function file(path, content) {
  const absolute = join(fixture, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function manifest(path, body) {
  file(join(path, "package.json"), JSON.stringify(body, null, 2) + "\n");
}

// The workspace skeleton. Package directories reuse the real names because
// the arrow-matrix rules are written against them.
manifest(".", { name: "fixture-root", private: true });
manifest("packages/memory", {
  name: "@obversa/memory",
  type: "module",
  exports: { ".": "./src/index.mjs", "./testing": "./src/testing.mjs" },
  devDependencies: { devtool: "1.0.0" },
});
manifest("packages/engine", { name: "@obversa/engine", type: "module", exports: { ".": "./src/index.mjs", "./testing": "./src/testing.mjs" } });
manifest("packages/runtime", {
  name: "@obversa/runtime",
  type: "module",
  exports: { ".": "./src/index.mjs" },
  dependencies: { "@obversa/engine": "workspace:*", "@obversa/memory": "workspace:*" },
});
manifest("packages/source", { name: "@obversa/source", type: "module", exports: { ".": "./src/index.mjs" } });
manifest("packages/surfacer", { name: "@obversa/surfacer", type: "module", exports: { ".": "./src/index.mjs" } });
manifest("plugins/memory-git", {
  name: "@obversa/memory-git",
  type: "module",
  exports: { ".": "./src/index.mjs" },
  dependencies: { "@obversa/memory": "workspace:*", "@obversa/runtime": "workspace:*" },
});
manifest("plugins/memory-simple", {
  name: "@obversa/memory-simple",
  type: "module",
  exports: { ".": "./src/index.mjs" },
  imports: { "#sneak": "../surfacer/src/index.mjs" },
});
for (const name of ["engine-agent-sdk", "engine-anthropic-api", "engine-claude-cli", "engine-codex", "engine-grok-cli", "engine-opencode-cli"]) {
  manifest(`plugins/${name}`, {
    name: `@obversa/${name}`,
    type: "module",
    exports: { ".": "./src/index.mjs" },
    dependencies: { "@obversa/engine": "workspace:*" },
  });
}
manifest("hosts/cmux", {
  name: "@obversa/cmux-host",
  type: "module",
  dependencies: { "@obversa/source": "workspace:*", "@obversa/surfacer": "workspace:*" },
});
for (const name of ["engine", "memory", "runtime", "source", "surfacer"]) {
  mkdirSync(join(fixture, "node_modules", "@obversa"), { recursive: true });
  symlinkSync(join("..", "..", "packages", name), join(fixture, "node_modules", "@obversa", name));
}
manifest("node_modules/left-pad", { name: "left-pad", version: "1.0.0", main: "index.js" });
file("node_modules/left-pad/index.js", "module.exports = (s) => s;\n");
manifest("node_modules/devtool", { name: "devtool", version: "1.0.0", main: "index.js" });
file("node_modules/devtool/index.js", "module.exports = 1;\n");

// Clean targets.
file("packages/memory/src/index.mjs", "export const memory = 1;\n");
file("packages/memory/src/testing.mjs", "export const probe = 1;\n");
file("packages/engine/src/index.mjs", "export const engine = 1;\n");
file("packages/engine/src/testing.mjs", "export const mockEngine = 1;\n");
file("packages/runtime/src/index.mjs", "export const runtime = 1;\n");
file("packages/source/src/index.mjs", "export const source = 1;\n");
file("packages/source/src/private.mjs", "export const priv = 1;\n");
file("packages/surfacer/src/index.mjs", "export const surfacer = 1;\n");
file("plugins/memory-git/src/index.mjs", "export const gitMemory = 1;\n");
file("plugins/memory-simple/src/index.mjs", "export const simple = 1;\n");
for (const name of ["engine-agent-sdk", "engine-anthropic-api", "engine-claude-cli", "engine-codex", "engine-grok-cli", "engine-opencode-cli"]) {
  file(`plugins/${name}/src/index.mjs`, `export const name = ${JSON.stringify(name)};\n`);
}
file("packages/source/src/h.test.mjs", "export const t = 1;\n");
file("packages/source/test/j.test.mjs", "export const t = 1;\n");
file("hosts/cmux/lib/l.mjs", "export const glue = 1;\n");

// The forbidden forms, one file each: [path, content, rule that must fire].
const forbidden = [
  ["packages/surfacer/src/bad-a.mjs", "import '../../memory/src/index.mjs';\n", "no-cross-package-internal-path"],
  ["packages/surfacer/src/bad-a.mjs", null, "surfacer-reaches-no-package"],
  ["packages/source/src/a.mjs", "export * from '../../runtime/src/index.mjs';\n", "source-reaches-surfacer-only"],
  ["packages/memory/src/b.mjs", "export const p = import('../../runtime/src/index.mjs');\n", "memory-reaches-no-package"],
  ["plugins/memory-git/src/c.cjs", "module.exports = require('@obversa/runtime');\n", "memory-plugin-reaches-memory-only"],
  ["packages/runtime/src/d.ts", "import type { X } from '@obversa/source';\nexport const d: X | number = 1;\n", "runtime-reaches-interfaces-only"],
  ["plugins/memory-simple/src/e.mjs", "import '#sneak';\n", "no-unresolvable"],
  ["hosts/cmux/lib/f.mjs", "import '@obversa/source/src/private.mjs';\n", "no-unresolvable"],
  ["packages/source/src/g.mjs", "import './h.test.mjs';\n", "no-test-from-prod"],
  ["packages/surfacer/test/i.test.mjs", "import '../../source/test/j.test.mjs';\n", "no-cross-package-test-import"],
  ["packages/source/src/k.mjs", "import '../../../hosts/cmux/lib/l.mjs';\n", "no-package-to-host"],
  ["hosts/cmux/lib/m.mjs", "import '../../../packages/surfacer/src/index.mjs';\n", "no-host-internal-path"],
  ["hosts/cmux/lib/n.mjs", "import '@obversa/memory';\n", "host-reaches-no-package"],
  ["scripts/o.mjs", "import '../packages/source/src/index.mjs';\n", "no-script-internal-path"],
  ["packages/surfacer/src/p.mjs", "import 'left-pad';\n", "no-undeclared-external"],
  ["packages/memory/src/q.mjs", "import 'devtool';\n", "no-dev-dep-from-prod"],
  ["packages/memory/src/r1.mjs", "import './r2.mjs';\nexport const r1 = 1;\n", "no-circular"],
  ["packages/memory/src/r2.mjs", "import './r1.mjs';\nexport const r2 = 1;\n", null],
  ["packages/source/src/s.mjs", "import './missing.mjs';\n", "no-unresolvable"],
  ["examples/bad7.mjs", "import '@obversa/does-not-resolve';\n", "no-unresolvable-example"],
  ["plugins/memory-simple/src/f2.mjs", "import '@obversa/runtime';\n", "memory-plugin-reaches-memory-only"],
  ["plugins/engine-codex/src/f3.mjs", "import '@obversa/memory';\n", "engine-plugin-reaches-engine-only"],
  ["plugins/engine-agent-sdk/src/f4.mjs", "import '@obversa/runtime';\n", "agent-sdk-plugin-reaches-interfaces-only"],
];
for (const [path, content] of forbidden) if (content !== null) file(path, content);

// The allowed forms: the same arrows done properly raise nothing.
const allowed = [
  ["plugins/memory-git/src/ok1.mjs", "import '@obversa/memory';\n"],
  ["packages/runtime/src/ok9.mjs", "import '@obversa/engine';\nimport '@obversa/memory';\n"],
  ["plugins/engine-codex/src/ok10.mjs", "import '@obversa/engine';\n"],
  ["plugins/engine-agent-sdk/src/ok11.mjs", "import '@obversa/engine';\nimport '@obversa/memory';\n"],
  ["packages/source/src/ok8.mjs", "import '@obversa/surfacer';\n"],
  ["packages/source/test/ok2.test.mjs", "import '../src/index.mjs';\n"],
  ["plugins/memory-git/tests/ok3.test.mjs", "import '@obversa/memory/testing';\n"],
  ["hosts/cmux/test/ok4.test.mjs", "import 'node:test';\n"],
  ["examples/ok5.mjs", "import '@obversa/runtime';\n"],
  ["scripts/ok6.mjs", "import 'node:fs';\n"],
  // The exemption covers exactly the real package names, which resolve at
  // run time relative to the package that runs the example; the fixture
  // root has no symlink for memory-git, so the name is unresolvable here
  // and must still raise nothing.
  ["examples/ok7.mjs", "import '@obversa/memory-git';\n"],
];
for (const [path, content] of allowed) file(path, content);

const run = spawnSync(
  process.execPath,
  [cruiserBin, "--config", rulesFile, "--output-type", "json", "packages", "plugins", "hosts", "scripts", "examples"],
  { cwd: fixture, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const report = JSON.parse(run.stdout);
const violations = report.summary.violations;
const fired = new Set(violations.map((violation) => `${violation.rule.name}|${violation.from}`));

test("every forbidden form raises the rule that names it", () => {
  for (const [path, , rule] of forbidden) {
    if (rule === null) continue;
    assert.ok(fired.has(`${rule}|${path}`), `${rule} must fire for ${path}; fired: ${[...fired].join(", ")}`);
  }
});

test("every allowed form raises nothing", () => {
  const allowedPaths = new Set(allowed.map(([path]) => path));
  const stray = violations.filter((violation) => allowedPaths.has(violation.from));
  assert.deepEqual(stray, [], "allowed files must raise no violation");
});

test("no rule fires outside the forbidden files", () => {
  const forbiddenPaths = new Set(forbidden.map(([path]) => path));
  const stray = violations.filter((violation) => !forbiddenPaths.has(violation.from));
  assert.deepEqual(stray, [], "only the forbidden fixtures may raise violations");
});

test("the live cruise roots cover every workspace package", () => {
  // The check:arrows command lists its roots by hand; a package added to the
  // workspace without a root here would silently escape the cruiser. The
  // list must name a directory inside every package and host that carries
  // source, and the rules file must name every package in its matrix.
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const roots = rootManifest.scripts["check:arrows"].split(" ").filter((part) => /^(packages|plugins|hosts)\//.test(part));
  const members = [
    ...readdirSync(join(repoRoot, "packages"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}`),
    ...readdirSync(join(repoRoot, "plugins"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `plugins/${entry.name}`),
    ...readdirSync(join(repoRoot, "hosts"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `hosts/${entry.name}`),
  ];
  const rules = readFileSync(join(repoRoot, ".dependency-cruiser.cjs"), "utf8");
  for (const member of members) {
    assert.ok(roots.some((root) => root.startsWith(`${member}/`)), `${member} has no cruise root in check:arrows`);
    if (!member.startsWith("hosts/")) {
      const [, name] = member.split("/");
      assert.ok(new RegExp(`\\^(?:packages|plugins)/${name}/|\\^${member}/`).test(rules) || rules.includes(`|${name}|`) || rules.includes(`(${name}|`) || rules.includes(`|${name})`), `${member} is not named by any arrow-matrix rule`);
    }
  }
});

test("the cruise walked the whole fixture", () => {
  assert.ok(report.summary.totalCruised >= 30, `expected at least 30 modules, saw ${report.summary.totalCruised}`);
  assert.ok(report.summary.error >= forbidden.filter(([, , rule]) => rule).length, "every expected error is counted");
});

test("error-severity violations fail the command the proof chain runs", () => {
  // The JSON reporter above always exits 0; the gate runs the default
  // reporter, whose exit code is the error count.
  const gate = spawnSync(process.execPath, [cruiserBin, "--config", rulesFile, "packages", "plugins", "hosts", "scripts", "examples"], {
    cwd: fixture,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.ok(gate.status > 0, `the gate run must exit nonzero on violations; exited ${gate.status}`);
});
