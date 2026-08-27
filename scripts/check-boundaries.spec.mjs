import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { extractObversaImports } from "./check-boundaries.mjs";

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
  assert.deepEqual(extractObversaImports(source), [
    "@obversa/memory",
    "@obversa/lines",
    "@obversa/memory-git",
    "@obversa/memory-simple",
    "@obversa/surfacer",
    "@obversa/source",
    "@obversa/lines",
  ]);
});

test("a subpath import resolves to its package name; a relative import inside the same package is ignored", () => {
  assert.deepEqual(extractObversaImports(`import x from "@obversa/memory/testing";`), ["@obversa/memory"]);
  const file = "/repo/packages/source/src/review.mjs";
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
    const url = "http://example.test/not-an-import"; // trailing comments stay harmless
  `;
  assert.deepEqual(extractObversaImports(source), ["@obversa/surfacer", "@obversa/memory", "@obversa/lines"]);
});

test("the live tree passes the boundary check", () => {
  const script = fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /Boundary check passed for \d+ packages/);
});
