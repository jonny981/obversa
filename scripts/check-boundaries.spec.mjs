import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";
import { validRange } from "semver";

import { dependencyTarget, extractObversaImports, internalDependencies, isProjectConfig, isVersionRange, manifestImportTargets, manifestPathTargets, moduleSpecifiers, parserExtensions, projectConfig, refusal, scansImports, sourceExtensions, textExtensions, tsconfigDependencies, walkTree } from "./check-boundaries.mjs";

// A filesystem for the compiler made of a path -> text map, rooted at /repo.
// The compiler's own directory matcher walks it, so `include` globs, package
// `imports` / `exports` lookups, and `extends` probes behave as on disk.
function fakeHost(files) {
  const dirOf = (p) => p.replace(/\/$/, "") + "/";
  const entries = (p) => {
    const dir = dirOf(p);
    const own = [], directories = new Set();
    for (const key of Object.keys(files)) {
      if (!key.startsWith(dir)) continue;
      const rest = key.slice(dir.length);
      if (rest.includes("/")) directories.add(rest.split("/")[0]);
      else own.push(rest);
    }
    return { files: own, directories: [...directories] };
  };
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (p) => p in files,
    readFile: (p) => files[p],
    directoryExists: (p) => Object.keys(files).some((key) => key.startsWith(dirOf(p))),
    realpath: (p) => p,
    getCurrentDirectory: () => "/repo",
    getDirectories: (p) => entries(p).directories,
    readDirectory: (rootDir, extensions, excludes, includes, depth) =>
      ts.matchFiles(rootDir, extensions, excludes, includes, true, "/repo", depth, entries, (p) => p),
  };
}
const tree = (extra = {}) => ({
  "/repo/packages/source/src/a.ts": "",
  "/repo/packages/surfacer/src/index.ts": "",
  "/repo/packages/memory/src/index.ts": "",
  "/repo/tsconfig.base.json": '{ "compilerOptions": { "types": ["node"] } }',
  ...extra,
});
const SOURCE = "/repo/packages/source/tsconfig.json";
const deps = (text, extra, file = SOURCE) => tsconfigDependencies(text, { file, root: "/repo", host: fakeHost(tree(extra)) });
const refused = (list) => list.filter((d) => d.startsWith("@obversa/<"));

test("a package.json imports alias, a workspace devDependency, and an alias that installs a sibling under another name are arrows the rules must allow", () => {
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
  assert.deepEqual(internalDependencies({ devDependencies: { "@obversa/surfacer": "workspace:^", vitest: "1" } }, "devDependencies"), ["@obversa/surfacer"]);
  assert.deepEqual(internalDependencies({}, "devDependencies"), []);
  // The value installs the sibling whatever the key says: `import "hidden"`
  // then loads @obversa/surfacer, so the alias is the arrow.
  assert.deepEqual(
    internalDependencies({ dependencies: { hidden: "npm:@obversa/surfacer@0.1.0", other: "workspace:@obversa/memory@*", "@obversa/lines": "workspace:^", ext: "npm:lodash@4", plain: "^1.0.0" } }, "dependencies"),
    ["@obversa/lines", "@obversa/memory", "@obversa/surfacer"],
    "npm: and workspace: aliases by value, keys by name, externals ignored",
  );
  assert.deepEqual(internalDependencies({ peerDependencies: { mem: "npm:@obversa/memory" } }, "peerDependencies"), ["@obversa/memory"], "a peer alias counts too");
  // pnpm links a relative workspace spec to the package at that path.
  assert.deepEqual(internalDependencies({ dependencies: { hidden: "workspace:../surfacer" } }, "dependencies", at), ["@obversa/surfacer"], "a relative workspace alias is placed by its directory");
  assert.deepEqual(internalDependencies({ dependencies: { self: "workspace:./" } }, "dependencies", at), ["@obversa/source"], "the owner's own directory names the owner");
  assert.deepEqual(internalDependencies({ dependencies: { odd: "workspace:../../hosts/cmux" } }, "dependencies", at), [refusal("dependencies odd links ../../hosts/cmux, which is not a workspace package the scan can place")]);
  assert.deepEqual(internalDependencies({ dependencies: { hidden: "workspace:../surfacer" } }, "dependencies"), [refusal("dependencies hidden links ../surfacer, which is not a workspace package the scan can place")], "without a location a path alias is refused");
  assert.deepEqual(internalDependencies({ dependencies: { "@obversa/memory": "workspace:^" } }, "dependencies", at), ["@obversa/memory"], "a version range is not a path");
});

test("a dependency value is a registry range, a registry alias, a workspace package, or refused", () => {
  const at = { file: "/repo/packages/source/package.json", root: "/repo" };
  for (const range of ["1.2.3", "^1.2.3", "~0.1.0", ">=0.1.0 <0.2.0", ">= 1.0.0", ">= 0.1.0 < 0.2.0", "1.x", "*", "1.2.3 - 2.0.0", "^1.0.0 || ^2.0.0", "4.4.3", "0.3.241", "1.0.0-beta.1", "1.0.0-rc-1+build.7"]) assert.equal(isVersionRange(range), true, range);
  // node-semver's grammar, as pnpm reads it: an identifier is [0-9A-Za-z-];
  // anything it returns null for falls through to a tag.
  for (const range of ["1", "1.2", "1.x", "1.X", "1.*", "1.2.x", "1.x.x", "x", "X", "x.x.x", "*.*"]) assert.equal(isVersionRange(range), true, `${range} is an x-range`);
  // What pnpm treats as a tag: validRange(..., { loose: true }) is null.
  const tags = ["1.x.3", "x.1", "1.*.3", "1.2-foo", "1.x-foo", "x.1.2", "1.2.3.4", "9007199254740992.0.0", `1.2.3-${"a".repeat(300)}`, "latest", "1.0.0-foo_bar", "1.0.0+a_b", "../surfacer", "github:obversa/surfacer", "obversa/surfacer", "git+ssh://git@github.com/o/s.git", "https://example.test/s.tgz", "file:../surfacer", "link:../surfacer", "catalog:"];
  for (const other of tags) assert.equal(isVersionRange(other), false, `${other} is a tag to pnpm`);
  assert.equal(isVersionRange(""), false, "an empty selector is nothing to pnpm, though validRange reads it as *");
  // The premise, on the pinned semver pnpm bundles: every answer above is
  // validRange's own.
  for (const value of [...tags, "1.2.3", "^1.2.3", ">= 1.0.0", "1.x", "*", "1.2.3 - 2.0.0", "^1.0.0 || ^2.0.0"]) {
    assert.equal(isVersionRange(value), validRange(value, { loose: true }) !== null, `${value}: the guard answers as validRange does`);
  }
  assert.equal(validRange("", { loose: true }), "*", "validRange alone would accept an empty selector");
  assert.deepEqual(dependencyTarget("zod", "^4.4.3", at), { external: true });
  assert.deepEqual(dependencyTarget("lod", "npm:lodash@^4", at), { external: true }, "an alias of a registry package");
  assert.deepEqual(dependencyTarget("lod", "npm:lodash", at), { refused: "lod is npm:lodash, which is not a registry version the scan can read" }, "an alias without a version installs latest, a tag");
  assert.deepEqual(dependencyTarget("x", "1.0.0-foo_bar", at), { refused: "x is 1.0.0-foo_bar, which is not a registry version the scan can read" });
  assert.deepEqual(dependencyTarget("@obversa/memory", "workspace:^", at), { name: "@obversa/memory" });
  assert.deepEqual(dependencyTarget("@obversa/memory", ">=0.1.0 <0.2.0", at), { name: "@obversa/memory" }, "a peer by range");
  assert.deepEqual(dependencyTarget("hidden", "npm:@obversa/surfacer@0.1.0", at), { name: "@obversa/surfacer" });
  assert.deepEqual(dependencyTarget("hidden", "workspace:../surfacer", at), { name: "@obversa/surfacer" });
  assert.deepEqual(dependencyTarget("hidden", "../surfacer", at), { refused: "hidden is ../surfacer, which is not a registry version the scan can read" }, "a bare path is a local install");
  assert.deepEqual(dependencyTarget("hidden", "github:obversa/surfacer", at), { refused: "hidden is github:obversa/surfacer, which is not a registry version the scan can read" });
  assert.deepEqual(dependencyTarget("hidden", "obversa/surfacer", at), { refused: "hidden is obversa/surfacer, which is not a registry version the scan can read" }, "a bare owner/repo is a Git spec");
  assert.deepEqual(dependencyTarget("hidden", "git+ssh://git@github.com/o/s.git", at), { refused: "hidden is git+ssh://git@github.com/o/s.git, which is not a registry version the scan can read" });
  assert.deepEqual(dependencyTarget("hidden", "link:packages/surfacer", at), { refused: "hidden is link:packages/surfacer, which is not a registry version the scan can read" });
  assert.deepEqual(dependencyTarget("hidden", "catalog:", at), { refused: "hidden is catalog:, which is not a registry version the scan can read" });
  assert.deepEqual(dependencyTarget("hidden", "latest", at), { refused: "hidden is latest, which is not a registry version the scan can read" }, "a tag is not a version");
  assert.deepEqual(dependencyTarget("@obversa/memory", "link:../memory", at), { refused: "@obversa/memory is link:../memory, which is not a workspace range the scan can read" });
});

test("a manifest's entry fields are placed by the package their real path lies in", () => {
  const at = { file: "/repo/packages/source/package.json", root: "/repo", host: fakeHost(tree()) };
  assert.deepEqual(manifestPathTargets({ main: "./dist/index.js", types: "./dist/index.d.ts", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" } }, at), [], "own paths");
  assert.deepEqual(manifestPathTargets({ main: "../surfacer/src/index.mjs" }, at), ["@obversa/surfacer"], "main into a sibling");
  assert.deepEqual(manifestPathTargets({ module: "../memory/src/index.ts", browser: { "./x.js": "../surfacer/src/client.mjs", fs: "browserify-fs" } }, at), ["@obversa/memory", "@obversa/surfacer"], "module and a browser map; a bare package name is not a path");
  assert.deepEqual(manifestPathTargets({ types: "../surfacer/types/index.d.ts" }, at), ["@obversa/surfacer"], "types");
  assert.deepEqual(manifestPathTargets({ typings: "../surfacer/types/index.d.ts" }, at), ["@obversa/surfacer"], "typings");
  assert.deepEqual(manifestPathTargets({ typesVersions: { ">=4": { "testing": ["../memory/dist/testing.d.ts"] } } }, at), ["@obversa/memory"], "an exact typesVersions mapping by its path");
  assert.deepEqual(manifestPathTargets({ typesVersions: { "*": { "*": ["types/*"] } } }, at), [refusal("typesVersions uses a wildcard, which substitutes a consumer subpath the scan cannot bound")], "a wildcard mapping lets @obversa/source/../../surfacer/index resolve into the sibling under the compiler");
  assert.deepEqual(manifestPathTargets({ typesVersions: { "*": { "*": ["../memory/dist/*"] } } }, at), [refusal("typesVersions uses a wildcard, which substitutes a consumer subpath the scan cannot bound"), "@obversa/memory"]);
  assert.deepEqual(manifestPathTargets({ exports: { "./deep": "../surfacer/src/index.mjs" } }, at), ["@obversa/surfacer"], "an exports leaf");
  assert.deepEqual(manifestPathTargets({ directories: { lib: "../surfacer/src" } }, at), ["@obversa/surfacer"]);
  assert.deepEqual(manifestPathTargets({ publishConfig: { access: "public", directory: "../surfacer" } }, at), ["@obversa/surfacer"], "publishing another directory");
  assert.deepEqual(manifestPathTargets({ main: "../../" }, at), [refusal("main reaches ., which holds every package")]);
  assert.deepEqual(manifestPathTargets({ main: "@obversa/surfacer/src/index.mjs" }, at), ["@obversa/surfacer"], "by name");
  // `?` and `*` are ordinary characters in an entry path; Node loads the
  // file they name, `..` and all.
  assert.deepEqual(manifestPathTargets({ main: "./x?/../../surfacer/index.cjs" }, at), ["@obversa/surfacer"], "a question mark does not end the path");
  assert.deepEqual(manifestPathTargets({ module: "./x*/../../memory/index.js", types: "./t?/../../surfacer/index.d.ts" }, at), ["@obversa/memory", "@obversa/surfacer"]);
  assert.deepEqual(manifestImportTargets({ imports: { "#x": "./x?/../../surfacer/src/index.mjs" } }, { file: "/repo/packages/source/package.json", root: "/repo" }), ["@obversa/surfacer"], "an imports leaf too");
});

test("a project config is read as the compiler reads it: every extends form, ${configDir}, and the options a base carries", () => {
  const base = '{ "compilerOptions": { "jsxImportSource": "@obversa/surfacer" } }';
  const deeper = '{ "extends": "./deeper.json", "compilerOptions": { "paths": { "#m/*": ["../memory/src/*"] } } }';
  const chain = { "/repo/packages/source/base.json": '{ "extends": "./deeper.json", "compilerOptions": { "jsxImportSource": "@obversa/surfacer" } }', "/repo/packages/source/deeper.json": '{ "compilerOptions": { "paths": { "#m/*": ["../memory/src/*"] } } }' };
  assert.deepEqual(deps('{ "extends": "./base.json" }', chain), ["@obversa/surfacer", "@obversa/memory"], "a same-package base carries the dependency, and its own base too");
  assert.deepEqual(deps('{ "extends": "/repo/packages/source/base.json" }', chain), ["@obversa/surfacer", "@obversa/memory"], "an absolute parent");
  assert.deepEqual(deps('{ "extends": "./base" }', chain), ["@obversa/surfacer", "@obversa/memory"], "an extensionless parent is probed with .json, as the compiler does");
  assert.deepEqual(deps('{ "extends": ["./deeper.json", "./base.json"] }', chain), ["@obversa/surfacer", "@obversa/memory"], "an extends array inherits each base");
  assert.deepEqual(
    deps('{ "extends": "#config" }', { "/repo/packages/source/package.json": '{ "name": "@obversa/source", "imports": { "#config": "./base.json" } }', "/repo/packages/source/base.json": base }),
    ["@obversa/surfacer"],
    "a base named through the manifest's imports map is inherited",
  );
  assert.deepEqual(
    deps('{ "extends": "@obversa/source/config" }', { "/repo/packages/source/package.json": '{ "name": "@obversa/source", "exports": { "./config": "./base.json" } }', "/repo/packages/source/base.json": base }),
    ["@obversa/surfacer"],
    "a base named through the package's own exports is inherited",
  );
  assert.deepEqual(deps('{ "extends": "../surfacer/tsconfig.json" }', { "/repo/packages/surfacer/tsconfig.json": deeper, "/repo/packages/surfacer/deeper.json": "{}" }), ["@obversa/surfacer", "@obversa/surfacer", "@obversa/memory"], "a base in a sibling is a crossing, its own base too, and what it carries is inherited");
  assert.deepEqual(deps('{ "extends": "@tsconfig/node22/tsconfig.json" }', { "/repo/node_modules/@tsconfig/node22/tsconfig.json": "{}" }), [], "an installed external base is not a crossing");
  assert.deepEqual(deps('{ "compilerOptions": { "baseUrl": "${configDir}/../surfacer" } }'), ["@obversa/surfacer"], "${configDir} expands to the config's directory");
  assert.deepEqual(deps('{ "extends": "../../tsconfig.base.json", "include": ["src"], "compilerOptions": { "paths": { "#local/*": ["./src/*"] } } }'), [], "the repository base, own sources, and own aliases are not crossings");
  // Every JSON under a package that the compiler would read as a project.
  assert.equal(isProjectConfig("packages/source/tsconfig.json", "{}"), true);
  assert.equal(isProjectConfig("packages/source/config/tsconfig.build.json", "{}"), true, "a nested tsconfig");
  assert.equal(isProjectConfig("packages/source/jsconfig.json", "{}"), true, "a jsconfig");
  assert.equal(isProjectConfig("packages/source/config/build.json", '{ "compilerOptions": { "paths": {} } }'), true, "any name, by its project fields: tsc -p accepts it");
  assert.equal(isProjectConfig("packages/source/config/build.json", '{ "extends": "./x.json" }'), true);
  assert.equal(isProjectConfig("packages/source/data.json", '{ "a": 1 }'), false, "plain data");
  assert.equal(isProjectConfig("packages/source/list.json", "[1]"), false);
  assert.equal(isProjectConfig("packages/source/package.json", '{ "files": ["dist"] }'), false, "the manifest is read separately");
  assert.equal(isProjectConfig("hosts/cmux/tsconfig.json", "{}"), false, "only packages carry boundary rules");
});

test("every effective option that can reach a sibling is placed by the package it lands in; a value that reaches every package is refused", () => {
  assert.deepEqual(deps('{\n  // comments and trailing commas are fine\n  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "@obversa/surfacer", },\n}\n'), ["@obversa/surfacer"]);
  assert.deepEqual(deps('{ "compilerOptions": { "jsx": "react-jsx" } }'), []);
  assert.deepEqual(deps('{ "compilerOptions": { "types": ["node", "@obversa/surfacer"] } }'), ["@obversa/surfacer"], "types by name");
  assert.deepEqual(deps('{ "compilerOptions": { "typeRoots": ["./types", "../surfacer/types"] } }'), ["@obversa/surfacer"], "typeRoots");
  assert.deepEqual(deps('{ "compilerOptions": { "typeRoots": ["../../hosts/types"], "types": ["../surfacer/types"] } }'), ["@obversa/surfacer"], "a types entry by path");
  assert.deepEqual(deps('{ "compilerOptions": { "baseUrl": "../surfacer" } }'), ["@obversa/surfacer"], "baseUrl");
  assert.deepEqual(deps('{ "compilerOptions": { "baseUrl": "/repo/packages/surfacer" } }'), ["@obversa/surfacer"], "an absolute baseUrl");
  assert.deepEqual(deps('{ "compilerOptions": { "rootDirs": ["./src", "../memory/src"] } }'), ["@obversa/memory"], "rootDirs");
  assert.deepEqual(deps('{ "compilerOptions": { "plugins": [{ "name": "@obversa/surfacer" }] } }'), ["@obversa/surfacer"], "a plugin by name");
  assert.deepEqual(deps('{ "typeAcquisition": { "include": ["@obversa/memory"] } }'), ["@obversa/memory"], "typeAcquisition.include");
  assert.deepEqual(deps('{ "compilerOptions": { "paths": { "#kit/*": ["../surfacer/src/*"] } } }'), ["@obversa/surfacer"], "a paths alias into a sibling");
  assert.deepEqual(deps('{ "references": [{ "path": "../memory" }] }'), ["@obversa/memory"], "a project reference");
  assert.deepEqual(deps('{ "include": ["src/**/*", "../surfacer/src/**/*"] }'), ["@obversa/surfacer", "@obversa/surfacer"], "include with a glob into a sibling: the file it matches, and the directory it walks");
  assert.deepEqual(deps('{ "files": ["../memory/src/index.ts"] }'), ["@obversa/memory"], "files");
  assert.deepEqual(deps('{ "files": ["/repo/packages/memory/src/index.ts"] }'), ["@obversa/memory"], "an absolute file");
  // paths targets substitute against baseUrl when it is set — even one
  // inherited from a base — else against the config that declared them.
  assert.deepEqual(deps('{ "compilerOptions": { "baseUrl": "./src", "paths": { "#surf/*": ["../../surfacer/src/*"] } } }'), ["@obversa/surfacer"], "a paths target relative to an own baseUrl");
  const inherited = deps('{ "extends": "./base.json", "compilerOptions": { "paths": { "#surf/*": ["packages/surfacer/src/*"] } } }', { "/repo/packages/source/base.json": '{ "compilerOptions": { "baseUrl": "../.." } }' });
  assert.deepEqual(inherited, [refusal("baseUrl reaches ., which holds every package"), "@obversa/surfacer"], "the inherited baseUrl at the repository root is refused, and the target it anchors still names the sibling");
  // A wildcard whose literal prefix is packages/ or above ranges over every
  // sibling; so does an include walking above the package.
  assert.deepEqual(deps('{ "compilerOptions": { "paths": { "#pick/*": ["../*/src/index.ts"] } } }'), [refusal("paths target ../*/src/index.ts for #pick/* reaches packages, which holds every package")]);
  assert.deepEqual(deps('{ "compilerOptions": { "rootDirs": ["../.."] } }'), [refusal("rootDirs reaches ., which holds every package")]);
  assert.deepEqual(refused(deps('{ "include": ["../**/*"] }')), [refusal("include reaches packages, which holds every package")]);
  // The premises: the compiler resolves the aliases the way the scan assumes.
  const host = fakeHost(tree());
  const resolved = (name, options) => ts.resolveModuleName(name, "/repo/packages/source/src/a.ts", options, host).resolvedModule?.resolvedFileName;
  assert.equal(resolved("#surf/index", { baseUrl: "/repo", paths: { "#surf/*": ["packages/surfacer/src/*"] } }), "/repo/packages/surfacer/src/index.ts", "a paths target is substituted against baseUrl");
  assert.equal(resolved("#pick/surfacer", { paths: { "#pick/*": ["../*/src/index.ts"] }, pathsBasePath: "/repo/packages/source" }), "/repo/packages/surfacer/src/index.ts", "a wildcard in a directory segment ranges over siblings");
  const emitted = ts.transpileModule("export const view = <Panel />;", { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, jsxImportSource: "@obversa/surfacer", module: ts.ModuleKind.ESNext }, fileName: "view.jsx" }).outputText;
  assert.match(emitted, /@obversa\/surfacer\/jsx-runtime/, "with that option and no pragma, the compiler emits the import");
});

test("a specifier is placed where the compiler resolves it under the package's own config, so an alias cannot walk out of the package unseen", () => {
  const file = "/repo/packages/source/src/a.ts";
  const under = (text, extra) => {
    const host = fakeHost(tree(extra));
    const { options } = projectConfig(text, { file: SOURCE, root: "/repo", host });
    return (source) => extractObversaImports(source, { file, root: "/repo", configs: [options], host });
  };
  const local = under('{ "compilerOptions": { "paths": { "#local/*": ["src/*"] } } }');
  assert.deepEqual(local('import x from "#local/../../surfacer/src/index";'), ["@obversa/surfacer"], "the substitution escapes through the safe prefix; the compiler's answer catches it");
  assert.deepEqual(local('import x from "#local/a";'), [], "an alias that stays home");
  assert.deepEqual(local('import x from "node:fs"; import y from "vitest";'), [], "externals and built-ins");
  const pick = under('{ "compilerOptions": { "paths": { "#pick/*": ["../*/src/index.ts"] } } }');
  assert.deepEqual(pick('import x from "#pick/surfacer";'), ["@obversa/surfacer"], "a wildcard over siblings");
  const viaBaseUrl = under('{ "compilerOptions": { "baseUrl": "../surfacer" } }');
  assert.deepEqual(viaBaseUrl('import x from "src/index";'), ["@obversa/surfacer"], "a bare specifier under a baseUrl in a sibling");
  const config = under('{ "extends": "#config" }', { "/repo/packages/source/package.json": '{ "name": "@obversa/source", "imports": { "#config": "./base.json" } }', "/repo/packages/source/base.json": '{ "compilerOptions": { "paths": { "#m": ["../memory/src/index.ts"] } } }' });
  assert.deepEqual(config('import m from "#m";'), ["@obversa/memory"], "a mapping inherited through the manifest's imports map");
  assert.deepEqual(extractObversaImports('import x from "#local/../../surfacer/src/index";', { file, root: "/repo" }), [], "without a config there is nothing to resolve under (the lexical rules still apply)");
  // The premise: the compiler resolves the escape into the sibling.
  const host = fakeHost(tree());
  const escaped = ts.resolveModuleName("#local/../../surfacer/src/index", file, { paths: { "#local/*": ["src/*"] }, pathsBasePath: "/repo/packages/source" }, host).resolvedModule?.resolvedFileName;
  assert.equal(escaped, "/repo/packages/surfacer/src/index.ts");
});

test("a config the compiler cannot read is refused whole; a project with no inputs is not", () => {
  const only = (list) => (assert.equal(list.length, 1, list.join()), list[0]);
  assert.match(only(deps("{")), /^@obversa\/<the config cannot be read as the compiler reads it: TS1005 /, "malformed JSON");
  assert.match(only(deps('{ "extends": "./missing.json" }')), /TS5083 Cannot read file '\/repo\/packages\/source\/missing\.json'/, "an unreadable base named with its extension");
  assert.match(only(deps('{ "extends": "./missing" }')), /TS6053 File '\.\/missing' not found/, "an unreadable base the compiler probed for");
  const circular = '{ "extends": "./tsconfig.json" }';
  assert.match(only(deps(circular, { [SOURCE]: circular })), /TS18000 Circularity detected/, "a config extending itself (on disk, so the compiler reaches the cycle)");
  assert.match(only(deps('{ "compilerOptions": { "bogus": 1 } }')), /TS5023 Unknown compiler option 'bogus'/, "an option the pinned compiler does not know");
  assert.deepEqual(deps('{ "include": ["nothing/**/*"] }'), [], "no inputs (TS18003) is not a refusal");
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

test("the CommonJS loader and the resolvers name a module too: module.require, require.resolve, import.meta.resolve; a computed member of module or require is refused", () => {
  const source = `
    module.require("../../surfacer/src/index.cjs");
    module["require"]("@obversa/memory");
    require.resolve("@obversa/lines");
    import.meta.resolve("@obversa/memory-git");
    other.require("@obversa/memory-simple");
  `;
  assert.deepEqual(extractObversaImports(source, { file: "/repo/packages/source/src/a.cjs", root: "/repo" }), ["@obversa/surfacer", "@obversa/memory", "@obversa/lines", "@obversa/memory-git", "@obversa/memory-simple"], "a .require call on any object is a load: every Module object carries the loader");
  assert.deepEqual(moduleSpecifiers('module[key]("x"); require[key]("y"); import.meta[key]("w"); module.other("z");', "a.cjs"), [null, null, null], "a computed member may be the loader, so it is unreadable; another member is not a load");
  // A wrapper that changes nothing at runtime does not hide the loader.
  const wrapped = `
    (module.require)("@obversa/surfacer");
    (module).require("@obversa/memory");
    import.meta["resolve"]("@obversa/lines");
    (import.meta.resolve)("@obversa/memory-git");
    (require as any)("@obversa/memory-simple");
    require!("@obversa/source");
    (require satisfies unknown)("@obversa/surfacer");
  `;
  assert.deepEqual(extractObversaImports(wrapped, { file: "/repo/packages/lines/src/w.ts", root: "/repo" }), ["@obversa/surfacer", "@obversa/memory", "@obversa/lines", "@obversa/memory-git", "@obversa/memory-simple", "@obversa/source", "@obversa/surfacer"]);
  // A loader used any other way — bound, applied, passed as a value — goes
  // somewhere the scan cannot follow, so the use itself is refused.
  const computed = refusal("a computed module reference cannot be checked; use a plain string");
  for (const use of [
    'module.require.call(module, "../../surfacer/x.cjs");',
    'require.call(null, "@obversa/surfacer");',
    'require.apply(null, ["@obversa/surfacer"]);',
    'import.meta.resolve.call(import.meta, "@obversa/surfacer");',
    'module.require.bind(module)("../../surfacer/x.cjs");',
    'const r = require; r("@obversa/surfacer");',
    'const r = module.require;',
    'const r = import.meta.resolve;',
    'load(require, "@obversa/surfacer");',
    'const o = { require };',
    'typeof require;',
    'module[k];',
    'require[k];',
    'import.meta[k];',
    'const { require: load } = module; load("../../surfacer/x.cjs");',
    'const { require } = module;',
    'const { resolve } = import.meta;',
    'const m = module;',
    'f(module);',
    'const meta = import.meta;',
    // node:module makes loaders: its factory must be bound as `require`,
    // and the module itself may be imported only by name, unrenamed.
    'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("../../surfacer/x.cjs");',
    'import { createRequire as cr } from "node:module";',
    'import * as mod from "node:module";',
    'import mod from "module";',
    'import { register } from "node:module";',
    'import { createRequire } from "node:module"; let require = createRequire(import.meta.url);',
    'import { createRequire } from "node:module"; const { createRequire: cr } = x;',
    'import { createRequire } from "node:module"; f(createRequire);',
    'const { createRequire } = await import("node:module");',
    'const m = require("module");',
    'mod.createRequire(import.meta.url)("../../surfacer/x.cjs");',
    'import { registerHooks } from "node:module";',
    'import { createRequire, register } from "node:module";',
    'import { findSourceMap } from "node:module";',
    // process.getBuiltinModule hands out node:module and its hooks without
    // an import: every reference to that name is an untracked factory.
    'process.getBuiltinModule("node:module").registerHooks({ resolve });',
    'process["getBuiltinModule"]("node:module");',
    'process.getBuiltinModule.call(process, "node:module");',
    'process.getBuiltinModule.bind(process)("module");',
    'const { getBuiltinModule } = process;',
    'const { getBuiltinModule: g } = process;',
    'globalThis.process.getBuiltinModule("fs");',
    'const p = process; p.getBuiltinModule(name);',
    'const f = process.getBuiltinModule;',
    // Every Module object carries the loader, whatever it is reached as.
    'require.main;',
    'require.cache;',
    'const r = require.main.require;',
    'o.require;',
  ]) {
    const found = extractObversaImports(use, { file: "/repo/packages/source/src/u.cjs", root: "/repo" });
    assert.ok(found.length >= 1 && found.every((entry) => entry === computed), `${use} -> ${JSON.stringify(found)}`);
  }
  // A member that is not a loader is not a use of one; a declaration or a
  // property named require is a name, not a reference.
  for (const fine of [
    'module.exports = 1;', 'module.id;', 'import.meta.url;', 'import.meta.dirname;',
    'const { require: r } = x;', 'o.module;', 'class A { require() {} }', 'const module = 1;', '/** @param {typeof require} r */ function f(r) {}',
    'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); require("./local.cjs");',
    'import { createRequire, builtinModules, isBuiltin } from "node:module"; const require = createRequire(import.meta.url);',
    'import mod from "node:mod"; const require = mod.createRequire(import.meta.url);',
  ]) {
    assert.deepEqual(extractObversaImports(fine, { file: "/repo/packages/source/src/f.mjs", root: "/repo" }), [], fine);
  }
  // A `.require(...)` call on any object loads: the main module, a cache
  // entry, a Module reached however — the load is read, and reaching the
  // Module through `require.main` / `require.cache` is itself refused.
  assert.deepEqual(
    extractObversaImports('require.main.require("@obversa/surfacer"); require.cache[k].require("../../memory/src/index.cjs"); anything.require("@obversa/lines");', { file: "/repo/packages/source/src/m.cjs", root: "/repo" }),
    ["@obversa/surfacer", computed, "@obversa/memory", computed, "@obversa/lines"],
  );
});

test("an input reached through a symlink outside every package is placed where it really is", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "boundary-link-")));
  try {
    mkdirSync(path.join(dir, "packages/source"), { recursive: true });
    mkdirSync(path.join(dir, "packages/surfacer/src"), { recursive: true });
    mkdirSync(path.join(dir, "links"), { recursive: true });
    writeFileSync(path.join(dir, "packages/surfacer/src/index.ts"), "export const x = 1;\n");
    symlinkSync("../packages/surfacer/src/index.ts", path.join(dir, "links/index.ts"));
    symlinkSync("../packages/surfacer/src", path.join(dir, "links/src"));
    const file = path.join(dir, "packages/source/tsconfig.json");
    assert.deepEqual(tsconfigDependencies('{ "files": ["../../links/index.ts"] }', { file, root: dir }), ["@obversa/surfacer"], "a file through a link");
    assert.deepEqual(tsconfigDependencies('{ "include": ["../../links/src"] }', { file, root: dir }), ["@obversa/surfacer", "@obversa/surfacer"], "a directory through a link: the file it holds and the directory itself");
    assert.deepEqual(tsconfigDependencies('{ "compilerOptions": { "rootDirs": ["../../links/src"] } }', { file, root: dir }), ["@obversa/surfacer"], "an option through a link");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a computed specifier is refused, never silently dropped", () => {
  const source = `
    const name = "surfacer";
    const a = import("@obversa/" + name);
    const b = require(\`@obversa/\${name}\`);
    import c from "@obversa/memory";
  `;
  const computed = refusal("a computed module reference cannot be checked; use a plain string");
  assert.deepEqual(extractObversaImports(source), [computed, computed, "@obversa/memory"]);
  assert.deepEqual(moduleSpecifiers(`import("x" + y); require("z");`, "a.mjs"), [null, "z"]);
});

test("the live tree passes the boundary check", () => {
  const script = fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /Boundary check passed for \d+ packages/);
});
