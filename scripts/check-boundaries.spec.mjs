import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { extractObversaImports, moduleSpecifiers } from "./check-boundaries.mjs";

test("the import scan sees every form a module can use to name an @obversa package", () => {
  const source = `
    import { a } from "@obversa/memory";
    import "@obversa/lines/testing";
    export { b } from '@obversa/memory-git';
    export * from "@obversa/memory-simple";
    const dyn = await import("@obversa/surfacer/client");
    const cjs = require('@obversa/source');
    const lazy = () => import(
      "@obversa/lines"
    );
    // not imports: a string that merely mentions a package name
    const note = "see @obversa/memory for the contract";
  `;
  assert.deepEqual(extractObversaImports(source, { file: "/repo/x.mjs", root: "/repo" }), [
    "@obversa/memory",
    "@obversa/lines",
    "@obversa/memory-git",
    "@obversa/memory-simple",
    "@obversa/surfacer",
    "@obversa/source",
    "@obversa/lines",
  ]);
});

test("TypeScript forms: type-only imports and import-equals count as dependencies", () => {
  const source = `
    import type { Memory } from "@obversa/memory";
    import kit = require("@obversa/lines/testing");
    export type { X } from "@obversa/memory-git";
  `;
  assert.deepEqual(extractObversaImports(source, { file: "/repo/packages/lines/src/a.ts", root: "/repo" }), [
    "@obversa/memory",
    "@obversa/lines",
    "@obversa/memory-git",
  ]);
});

test("a subpath import resolves to its package name; a relative import inside the same package is ignored", () => {
  const file = "/repo/packages/source/src/review.mjs";
  assert.deepEqual(extractObversaImports(`import x from "@obversa/memory/testing";`, { file, root: "/repo" }), ["@obversa/memory"]);
  assert.deepEqual(extractObversaImports(`import x from "../src/git.mjs"; require("./local.cjs");`, { file, root: "/repo" }), []);
});

test("a relative import that lands in another package names that package", () => {
  const file = "/repo/packages/source/src/review.mjs";
  const source = `
    import { runSurface } from "../../surfacer/src/index.mjs";
    const kit = require("../../surfacer/src/client.mjs");
    const lazy = () => import("../../memory/dist/index.js");
    import ok from "../test/helper.mjs";
  `;
  assert.deepEqual(extractObversaImports(source, { file, root: "/repo" }), ["@obversa/surfacer", "@obversa/surfacer", "@obversa/memory"]);
});

test("a comment between the keyword and the specifier does not hide an import", () => {
  const source = `
    const a = import/*boundary*/("@obversa/surfacer");
    const b = require /* why */ ( '@obversa/memory' );
    import /* c */ "@obversa/lines";
    // import "@obversa/not-really" — a commented-out import is not an import
    /* import "@obversa/nor-this" */
    const url = "http://example.test/not-an-import"; // trailing comments stay harmless
  `;
  assert.deepEqual(extractObversaImports(source), ["@obversa/surfacer", "@obversa/memory", "@obversa/lines"]);
});

test("comment markers inside strings, templates, and regex literals cannot hide a later import", () => {
  const cases = [
    `const marker = "plain//text"; import("@obversa/surfacer");`,
    `const left = "/*"; import("@obversa/surfacer"); const right = "*/";`,
    `const re = /\\/\\//; import("@obversa/surfacer");`,
    `const re2 = /\\/\\*/; import("@obversa/surfacer"); const re3 = /\\*\\//;`,
    "const tpl = `a // b /* c`; import(\"@obversa/surfacer\"); const tpl2 = `*/`;",
    `const s = 'it\\'s // not a comment'; import("@obversa/surfacer");`,
  ];
  for (const source of cases) {
    assert.deepEqual(extractObversaImports(source, { file: "/repo/packages/source/src/x.mjs", root: "/repo" }), ["@obversa/surfacer"], source);
  }
});

test("a computed specifier is reported as a sentinel, never silently dropped", () => {
  const source = `
    const name = "surfacer";
    const a = import("@obversa/" + name);
    const b = require(\`@obversa/\${name}\`);
    import c from "@obversa/memory";
  `;
  assert.deepEqual(extractObversaImports(source), ["@obversa/<computed>", "@obversa/<computed>", "@obversa/memory"]);
  assert.deepEqual(moduleSpecifiers(`import("x" + y); require("z");`, "a.mjs"), [null, "z"]);
});

test("the live tree passes the boundary check", () => {
  const script = fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /Boundary check passed for \d+ packages/);
});
