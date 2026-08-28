import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";

import { extractObversaImports, internalDevDependencies, manifestImportTargets, moduleSpecifiers, parserExtensions, scansImports, scansTsconfig, sourceExtensions, textExtensions, tsconfigDependencies, walkTree } from "./check-boundaries.mjs";

test("a package.json imports alias, through conditions and arrays, and a workspace devDependency are arrows the rules must allow", () => {
  const at = { file: "/repo/packages/source/package.json", root: "/repo" };
  assert.deepEqual(manifestImportTargets({ imports: { "#surface": "@obversa/surfacer" } }, at), ["@obversa/surfacer"], "an alias to a sibling by name");
  assert.deepEqual(
    manifestImportTargets({ imports: { "#kit": { node: "@obversa/surfacer/client", default: "./src/local.mjs" }, "#mem/*": ["../memory/src/*", "./fallback.mjs"] } }, at),
    ["@obversa/surfacer", "@obversa/memory"],
    "every string leaf: a conditional object, an array, a subpath, a relative path into a sibling",
  );
  assert.deepEqual(manifestImportTargets({ imports: { "#local": "./src/x.mjs", "#dep": "some-external" } }, at), [], "own paths and external packages are not crossings");
  assert.deepEqual(manifestImportTargets({}, at), []);
  assert.deepEqual(manifestImportTargets({ imports: { "#self": "@obversa/source" } }, at), ["@obversa/source"], "a self-alias is reported by name; the scan allows the owner's own name for imports");
  assert.deepEqual(internalDevDependencies({ devDependencies: { "@obversa/surfacer": "workspace:^", vitest: "1" } }), ["@obversa/surfacer"]);
  assert.deepEqual(internalDevDependencies({}), []);
});

test("a tsconfig inherits its dependencies through extends, at any depth, with a cycle guard; an unreadable base fails closed", () => {
  const root = "/repo";
  const file = "/repo/packages/source/tsconfig.json";
  const texts = {
    "/repo/packages/source/base.json": '{ "extends": "./deeper.json", "compilerOptions": { "jsxImportSource": "@obversa/surfacer" } }',
    "/repo/packages/source/deeper.json": '{ "extends": "./tsconfig.json", "compilerOptions": { "paths": { "#m/*": ["../memory/src/*"] } } }',
  };
  const read = (absolute) => texts[absolute] ?? null;
  assert.deepEqual(
    tsconfigDependencies('{ "extends": "./base.json" }', { file, root, read }),
    ["@obversa/surfacer", "@obversa/memory"],
    "a same-package base carries the dependency, and its own base too; the cycle back to tsconfig.json stops",
  );
  assert.deepEqual(tsconfigDependencies('{ "extends": "./missing.json" }', { file, root, read }), ["@obversa/<unreadable-extends>"], "an unreadable base is reported, not skipped");
  assert.deepEqual(tsconfigDependencies('{ "extends": "@tsconfig/node22/tsconfig.json" }', { file, root, read }), [], "an external base is not a crossing and is not read");
  assert.deepEqual(tsconfigDependencies('{ "extends": "/repo/packages/source/base.json" }', { file, root, read }), ["@obversa/surfacer", "@obversa/memory"], "an absolute parent is inherited too");
  assert.deepEqual(tsconfigDependencies('{ "extends": "./base" }', { file, root, read }), ["@obversa/surfacer", "@obversa/memory"], "an extensionless parent is probed with .json, as the compiler does");
  // Every tsconfig under a package, however nested, carries dependency fields.
  assert.equal(scansTsconfig("packages/source/tsconfig.json"), true);
  assert.equal(scansTsconfig("packages/source/config/tsconfig.build.json"), true, "a nested tsconfig");
  assert.equal(scansTsconfig("packages/source/src/tsconfig.notes.md"), false);
  assert.equal(scansTsconfig("hosts/cmux/tsconfig.json"), false, "only packages carry boundary rules");
  // The remaining resolver fields.
  const at = { file, root, read };
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "typeRoots": ["./types", "../surfacer/types"] } }', at), ["@obversa/surfacer"], "typeRoots");
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "baseUrl": "../surfacer" } }', at), ["@obversa/surfacer"], "baseUrl");
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "rootDirs": ["./src", "../memory/src"] } }', at), ["@obversa/memory"], "rootDirs");
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "plugins": [{ "name": "@obversa/surfacer" }] } }', at), ["@obversa/surfacer"], "a plugin by name");
  assert.deepEqual(tsconfigDependencies('{ "typeAcquisition": { "include": ["@obversa/memory"] } }', at), ["@obversa/memory"], "typeAcquisition.include");
  // paths targets resolve against baseUrl, as the compiler resolves them; a
  // bare relative target and an absolute one count too.
  const viaBaseUrl = '{ "compilerOptions": { "baseUrl": "../..", "paths": { "#surf/*": ["packages/surfacer/src/*"] } } }';
  assert.deepEqual(tsconfigDependencies(viaBaseUrl, at), ["@obversa/surfacer"], "a paths target relative to baseUrl");
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "baseUrl": "/repo/packages/surfacer" } }', at), ["@obversa/surfacer"], "an absolute baseUrl");
  assert.deepEqual(tsconfigDependencies('{ "files": ["/repo/packages/memory/src/index.ts"] }', at), ["@obversa/memory"], "an absolute file");
  assert.deepEqual(tsconfigDependencies('{ "include": ["src/**/*"], "compilerOptions": { "baseUrl": ".", "paths": { "#local/*": ["src/*"] } } }', at), [], "bare own paths are not crossings");
  // The premise: the compiler resolves that alias into the sibling package.
  const host = { fileExists: (p) => p === "/repo/packages/surfacer/src/index.ts", readFile: () => "", directoryExists: () => true, getCurrentDirectory: () => "/repo", getDirectories: () => [], realpath: (p) => p };
  const resolved = ts.resolveModuleName("#surf/index", "/repo/packages/source/src/a.ts", { baseUrl: "/repo", paths: { "#surf/*": ["packages/surfacer/src/*"] }, moduleResolution: ts.ModuleResolutionKind.Bundler }, host).resolvedModule;
  assert.equal(resolved?.resolvedFileName, "/repo/packages/surfacer/src/index.ts", "TypeScript resolves the alias into the sibling package");
});

test("a package tsconfig names a dependency through every field that can reach a sibling: jsxImportSource, types, paths, references, extends, include, files", () => {
  // The repository's shared base is inherited by every package; here it is
  // what the real one is, a types list with no package in it.
  const read = (absolute) => (absolute === "/repo/tsconfig.base.json" ? '{ "compilerOptions": { "types": ["node"] } }' : null);
  const at = { file: "/repo/packages/source/tsconfig.json", root: "/repo", read };
  assert.deepEqual(tsconfigDependencies('{\n  // comments and trailing commas are fine\n  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "@obversa/surfacer", },\n}\n', at), ["@obversa/surfacer"]);
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "jsx": "react-jsx" } }', at), []);
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "types": ["node", "@obversa/surfacer"] } }', at), ["@obversa/surfacer"], "types");
  assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "paths": { "#kit/*": ["../surfacer/src/*"] } } }', at), ["@obversa/surfacer"], "a paths alias into a sibling");
  assert.deepEqual(tsconfigDependencies('{ "references": [{ "path": "../memory" }] }', at), ["@obversa/memory"], "a project reference");
  assert.deepEqual(tsconfigDependencies('{ "extends": "../surfacer/tsconfig.json" }', at), ["@obversa/surfacer"], "extends");
  assert.deepEqual(tsconfigDependencies('{ "include": ["src/**/*", "../surfacer/src/**/*"] }', at), ["@obversa/surfacer"], "include with a glob into a sibling");
  assert.deepEqual(tsconfigDependencies('{ "files": ["../memory/src/index.ts"] }', at), ["@obversa/memory"], "files");
  assert.deepEqual(tsconfigDependencies('{ "extends": "../../tsconfig.base.json", "include": ["src"], "compilerOptions": { "paths": { "#local/*": ["./src/*"] } } }', at), [], "the repository base, own sources, and own aliases are not crossings");
  // The premise: with that option and no pragma, the compiler emits the import.
  const emitted = ts.transpileModule("export const view = <Panel />;", { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "@obversa/surfacer", module: ts.ModuleKind.ESNext }, fileName: "view.jsx" }).outputText;
  assert.match(emitted, /@obversa\/surfacer\/jsx-runtime/);
});

test("dependencies TypeScript keeps outside the node tree are found: jsxImportSource, triple-slash references, amd-dependency, module augmentation", () => {
  const root = "/repo";
  const under = (name) => ({ file: `/repo/packages/source/src/${name}`, root });
  const jsx = '/** @jsxImportSource @obversa/surfacer */\nexport const el = <div />;\n';
  assert.deepEqual(extractObversaImports(jsx, under("view.jsx")), ["@obversa/surfacer"], "the jsxImportSource pragma");
  // The premise: the compiler really emits an import from that source.
  const emitted = ts.transpileModule(jsx, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext }, fileName: "view.jsx" }).outputText;
  assert.match(emitted, /@obversa\/surfacer\/jsx-runtime/, "TypeScript emits an import of <source>/jsx-runtime for the pragma");
  assert.deepEqual(extractObversaImports('/// <reference path="../../surfacer/src/index.d.ts" />\nexport {};\n', under("types.mts")), ["@obversa/surfacer"], "a reference path into a sibling package");
  assert.deepEqual(extractObversaImports('/// <reference types="@obversa/surfacer" />\nexport {};\n', under("types.ts")), ["@obversa/surfacer"], "a reference types directive");
  assert.deepEqual(extractObversaImports('/// <amd-dependency path="@obversa/surfacer" />\nexport {};\n', under("legacy.cts")), ["@obversa/surfacer"], "an amd-dependency");
  assert.deepEqual(extractObversaImports('declare module "@obversa/surfacer" { export const extra: number; }\n', under("augment.ts")), ["@obversa/surfacer"], "an external module augmentation");
  assert.deepEqual(extractObversaImports('/// <reference path="./local.d.ts" />\ndeclare module "./local" {}\n', under("same.ts")), [], "references inside the same package are not crossings");
});

test("a symlink under packages/ is reported by the tree walk, never followed as if it were local", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "boundary-walk-"));
  try {
    mkdirSync(path.join(dir, "packages/source/src"), { recursive: true });
    mkdirSync(path.join(dir, "packages/surfacer/src"), { recursive: true });
    writeFileSync(path.join(dir, "packages/surfacer/src/index.mjs"), "export const x = 1;\n");
    writeFileSync(path.join(dir, "packages/source/src/real.mjs"), 'import "./bridge.mjs";\n');
    symlinkSync("../../surfacer/src/index.mjs", path.join(dir, "packages/source/src/bridge.mjs"));
    mkdirSync(path.join(dir, "packages/source/node_modules/dep"), { recursive: true });
    writeFileSync(path.join(dir, "packages/source/node_modules/dep/index.mjs"), "");
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return walkTree(path.join(dir, "packages")).then(({ files, symlinks }) => {
    const rel = (p) => path.relative(dir, p).split(path.sep).join("/");
    assert.deepEqual(files.map(rel).sort(), ["packages/source/src/real.mjs", "packages/surfacer/src/index.mjs"], "regular files only; node_modules ignored");
    assert.deepEqual(symlinks.map(rel), ["packages/source/src/bridge.mjs"], "the symlink is reported, not resolved");
    // The import that names the link looks local to the lexical extractor —
    // which is exactly why the scan must fail closed on the link itself.
    assert.deepEqual(extractObversaImports('import "./bridge.mjs";', { file: path.join(dir, "packages/source/src/real.mjs"), root: dir }), []);
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
});

test("every module form the parser accepts is scanned for imports — .mts, .cts, and .jsx included", () => {
  // A form the parser could read but the scan skipped would let a forbidden
  // sibling import in packages/<name>/src/leak.mts pass the fail-closed check.
  assert.deepEqual([...sourceExtensions].sort(), [...parserExtensions].sort(), "the scan set is exactly the parser map");
  for (const ext of parserExtensions) {
    assert.ok(textExtensions.has(ext), `${ext} is read as text`);
    assert.equal(scansImports(`packages/source/src/leak${ext}`), true, `${ext} under a package is scanned for imports`);
  }
  assert.equal(scansImports("hosts/cmux/bin/tool.mts"), false, "only package files carry boundary rules");
  assert.equal(scansImports("packages/source/README.md"), false);
  assert.deepEqual(
    extractObversaImports('import { x } from "@obversa/surfacer";', { file: "/repo/packages/source/src/leak.mts", root: "/repo" }),
    ["@obversa/surfacer"],
    "the extractor reads a .mts file",
  );
});

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

test("TypeScript forms: type-only imports, import-equals, and type-position import() count as dependencies", () => {
  const source = `
    import type { Memory } from "@obversa/memory";
    import kit = require("@obversa/lines/testing");
    export type { X } from "@obversa/memory-git";
    type S = import("@obversa/surfacer").Surface;
    type T = typeof import("@obversa/source");
    let u: import("@obversa/memory-simple").Store<string>;
  `;
  assert.deepEqual(extractObversaImports(source, { file: "/repo/packages/lines/src/a.ts", root: "/repo" }), [
    "@obversa/memory",
    "@obversa/lines",
    "@obversa/memory-git",
    "@obversa/surfacer",
    "@obversa/source",
    "@obversa/memory-simple",
  ]);
});

test("a JSDoc import type in a JavaScript file counts as a dependency", () => {
  const source = `
    /** @type {import("@obversa/memory").Memory} */
    const memory = make();
    /**
     * @param {import('@obversa/surfacer').Session} session
     * @returns {typeof import("@obversa/lines")}
     */
    function use(session) { return session; }
  `;
  assert.deepEqual(extractObversaImports(source, { file: "/repo/packages/source/src/a.mjs", root: "/repo" }), [
    "@obversa/memory",
    "@obversa/surfacer",
    "@obversa/lines",
  ]);
});

test("the JSDoc @import tag and the import phase forms count as dependencies", () => {
  const source = `
    /** @import { startSurface } from "@obversa/surfacer" */
    /** @import * as mem from '@obversa/memory' */
    const later = import.defer("@obversa/lines");
    const wasm = import.source("@obversa/memory-git");
  `;
  assert.deepEqual(extractObversaImports(source, { file: "/repo/packages/source/src/b.mjs", root: "/repo" }), [
    "@obversa/surfacer",
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
