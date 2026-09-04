import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";
import { validRange } from "semver";

import { dependencyTarget, internalDependencies, isHostScript, isPinnedWorkspaceFile, isProjectConfig, isTestPath, isVersionRange, manifestImportTargets, manifestPathTargets, moduleSpecifiers, parserExtensions, PINNED_WORKSPACE_FILE, projectConfig, refusal, scansImports, sourceExtensions, textExtensions, tsconfigDependencies, walkTree } from "./check-boundaries.mjs";

// No test in this file writes to the shared worktree: its status and every
// tracked file's content relative to HEAD are captured before the first test
// and must be identical after the last. A dirty tree is fine; a changed one
// is a test that wrote where it must not.
const worktree = new URL("..", import.meta.url).pathname;
const worktreeState = () => execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" }) + execFileSync("git", ["diff", "HEAD", "--no-color", "--no-ext-diff"], { cwd: worktree, encoding: "utf8" });
let worktreeBefore;
before(() => { worktreeBefore = worktreeState(); });
after(() => { assert.equal(worktreeState(), worktreeBefore, "the shared worktree is exactly as it was before this file's tests"); });

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
    manifestImportTargets({ imports: { "#kit": { node: "@obversa/surfacer/client", default: "./src/local.mjs" }, "#mem": ["../memory/src/index.ts", "./fallback.mjs"] } }, at),
    ["@obversa/surfacer", "@obversa/memory"],
    "every string leaf: a conditional object, an array, a subpath, a relative path into a sibling (a pattern leaf is refused outright; see the vm-alias test)",
  );
  assert.deepEqual(manifestImportTargets({ imports: { "#local": "./src/x.mjs", "#dep": "some-external" } }, at), [], "own paths and external packages are not crossings");
  const builtinAlias = (leaf) => refusal(`package imports alias the ${leaf} builtin, which the source rules refuse in every form`);
  assert.deepEqual(manifestImportTargets({ imports: { "#module": "module" } }, at), [builtinAlias("module")], "an alias of the module builtin hides its loaders");
  assert.deepEqual(manifestImportTargets({ imports: { "#m": { node: "node:module", default: ["node:module", "./x.mjs"] } } }, at), [builtinAlias("node:module"), builtinAlias("node:module")], "through conditions and arrays");
  assert.deepEqual(manifestImportTargets({}, at), []);
  assert.deepEqual(manifestImportTargets({ imports: { "#self": "@obversa/source" } }, at), ["@obversa/source"], "a self-alias is reported by name; the scan allows the owner's own name for imports");
  assert.deepEqual(internalDependencies({ devDependencies: { "@obversa/surfacer": "workspace:^", vitest: "1" } }, "devDependencies"), ["@obversa/surfacer"]);
  assert.deepEqual(internalDependencies({}, "devDependencies"), []);
  // The value installs the sibling whatever the key says: `import "hidden"`
  // then loads @obversa/surfacer, so the alias is the arrow.
  assert.deepEqual(
    internalDependencies({ dependencies: { hidden: "npm:@obversa/surfacer@0.1.0", other: "workspace:@obversa/memory@*", "@obversa/runtime": "workspace:^", ext: "npm:lodash@4", plain: "^1.0.0" } }, "dependencies"),
    ["@obversa/memory", "@obversa/runtime", "@obversa/surfacer"],
    "npm: and workspace: aliases by value, keys by name, externals ignored",
  );
  assert.deepEqual(internalDependencies({ peerDependencies: { mem: "npm:@obversa/memory@^0.1.0" } }, "peerDependencies"), ["@obversa/memory"], "a peer alias counts too");
  assert.deepEqual(internalDependencies({ peerDependencies: { mem: "npm:@obversa/memory" } }, "peerDependencies"), [refusal("peerDependencies mem is npm:@obversa/memory, whose selector is not a version range")], "an alias without a selector is a tag");
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
  // x-ranges as semver 7.7.2 reads them in loose mode (a number after an x
  // is allowed there; 7.8.5 refuses it — which is why the exact bundled
  // version is pinned).
  for (const range of ["1", "1.2", "1.x", "1.X", "1.*", "1.2.x", "1.x.x", "x", "X", "x.x.x", "*.*", "1.x.3", "x.1", "1.*.3", "x.1.2"]) assert.equal(isVersionRange(range), true, `${range} is an x-range`);
  // What pnpm treats as a tag: validRange(..., { loose: true }) is null.
  const tags = ["1.2-foo", "1.x-foo", "1.2.3.4", "9007199254740992.0.0", `1.2.3-${"a".repeat(300)}`, "0+a", "latest", "1.0.0-foo_bar", "1.0.0+a_b", "../surfacer", "github:obversa/surfacer", "obversa/surfacer", "git+ssh://git@github.com/o/s.git", "https://example.test/s.tgz", "file:../surfacer", "link:../surfacer", "catalog:"];
  for (const other of tags) assert.equal(isVersionRange(other), false, `${other} is a tag to pnpm`);
  assert.equal(isVersionRange(""), false, "an empty selector is nothing to pnpm, though validRange reads it as *");
  // The premise, on the pinned semver 7.7.2 that pnpm 10.15.1 bundles:
  // every answer above is validRange's own.
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
  assert.deepEqual(dependencyTarget("hidden", "workspace:@obversa/surfacer@^", at), { name: "@obversa/surfacer" });
  assert.deepEqual(dependencyTarget("hidden", "workspace:@obversa/surfacer@>=0.1.0", at), { name: "@obversa/surfacer" });
  // An internal alias needs a real selector too: a tag or none installs
  // whatever the tag points at.
  assert.deepEqual(dependencyTarget("hidden", "npm:@obversa/memory@latest", at), { refused: "hidden is npm:@obversa/memory@latest, whose selector is not a version range" });
  assert.deepEqual(dependencyTarget("hidden", "npm:@obversa/memory", at), { refused: "hidden is npm:@obversa/memory, whose selector is not a version range" });
  assert.deepEqual(dependencyTarget("hidden", "workspace:@obversa/memory@latest", at), { refused: "hidden is workspace:@obversa/memory@latest, whose selector is not a version range" });
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

test("path ownership comes from the explicit package map when directory and package names differ", () => {
  const packageNames = new Map([
    ["packages/runtime-folder", "@obversa/runtime-name"],
    ["plugins/provider-folder", "@obversa/provider-name"],
  ]);
  const file = "/repo/packages/runtime-folder/tsconfig.json";
  const host = fakeHost(tree({
    "/repo/packages/runtime-folder/src/index.ts": "",
    "/repo/plugins/provider-folder/src/index.ts": "",
  }));
  const at = { file, root: "/repo", host, packageNames };

  assert.deepEqual(
    dependencyTarget("provider", "workspace:../../plugins/provider-folder", at),
    { name: "@obversa/provider-name" },
    "a workspace path resolves to the manifest identity, not @obversa/provider-folder",
  );
  assert.deepEqual(
    tsconfigDependencies('{ "files": ["../../plugins/provider-folder/src/index.ts"] }', at),
    ["@obversa/provider-name"],
    "a project-config crossing resolves to the manifest identity too",
  );
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

function copyTree(root) {
  const copy = mkdtempSync(path.join(os.tmpdir(), "boundaries-tree-"));
  // The checker's input: every tracked file and every untracked file git
  // does not ignore, as each stands in the working tree (a deleted tracked
  // file is absent; a symlink stays a symlink; the mode is kept). Ignored
  // state — build output, session files — is not copied, so the copy is
  // small, deterministic, and never races whatever writes those.
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const relative of new Set(listed)) {
    const source = path.join(root, relative);
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      continue;
    }
    const target = path.join(copy, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else {
      copyFileSync(source, target);
      chmodSync(target, stat.mode);
    }
  }
  // The guard reads its pinned tools from the root node_modules; a package's
  // own node_modules is never walked and never resolved through.
  symlinkSync(path.join(root, "node_modules"), path.join(copy, "node_modules"));
  return realpathSync(copy);
}

test("the guard, run on a disposable copy of the tree, refuses a shipped host import of a file the walk never scans", { timeout: 300_000 }, () => {
  const real = new URL("..", import.meta.url).pathname;
  const root = copyTree(real);
  try {
    const guard = () => spawnSync(process.execPath, [path.join(root, "scripts", "check-boundaries.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(guard().status, 0, `the copy passes before any mutation:\n${guard().stderr}`);
    // A host carries placement glue only: host JavaScript — an extensionless
    // command with any node shebang, or a source file by extension — is
    // refused on sight, whatever it holds. dependency-cruiser cannot read an
    // extensionless script, so this refusal is the arrow check for hosts.
    const command = path.join(root, "hosts", "cmux", "bin", "probe-review");
    for (const content of [
      "#!/usr/bin/env node\nexport {};\n",
      '#!/usr/bin/env node\nimport { e } from "../../../packages/surfacer/src/index.mjs";\ne;\n',
      "#!/usr/bin/env -S node --import=./packages/surfacer/src/index.mjs\nexport {};\n",
      "#!/usr/local/bin/node\nexport {};\n",
    ]) {
      writeFileSync(command, content);
      const run = guard();
      assert.notEqual(run.status, 0, JSON.stringify(content.split("\n")[0]));
      assert.match(run.stderr, /probe-review: a host carries placement glue only/, JSON.stringify(content.split("\n")[0]));
      rmSync(command);
    }
    const probeSource = path.join(root, "hosts", "cmux", "bin", "probe.mjs");
    writeFileSync(probeSource, "export {};\n");
    const asSource = guard();
    assert.notEqual(asSource.status, 0);
    assert.match(asSource.stderr, /probe\.mjs: a host carries placement glue only/);
    rmSync(probeSource);
    // Package indirection through the host manifest: an imports alias, a
    // self export, and an aliased dependency are each refused at the
    // manifest.
    const manifestPath = path.join(root, "hosts", "cmux", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const escape = path.join(root, "hosts", "cmux", "dist", "escape.mjs");
    mkdirSync(path.dirname(escape), { recursive: true });
    writeFileSync(escape, "export const e = eval;\n");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, imports: { "#escape": "./dist/escape.mjs" } }));
    const aliased = guard();
    assert.notEqual(aliased.status, 0);
    assert.match(aliased.stderr, /hosts\/cmux\/package\.json: a host manifest carries no imports/);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, exports: { "./escape": "./dist/escape.mjs" } }));
    const selfExport = guard();
    assert.notEqual(selfExport.status, 0);
    assert.match(selfExport.stderr, /hosts\/cmux\/package\.json: a host manifest carries no exports/);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, escape: "file:./dist" } }));
    const aliasDep = guard();
    assert.notEqual(aliasDep.status, 0);
    assert.match(aliasDep.stderr, /hosts\/cmux\/package\.json: dependencies escape is "file:\.\/dist"/);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // A symlink under packages/ is a recorded refusal, not a crash: the walk
    // sits outside the check's scope and is handed its failure list.
    const link = path.join(root, "packages", "source", "src", "link.mjs");
    symlinkSync(path.join("..", "..", "surfacer", "src", "host.mjs"), link);
    const linked = guard();
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /packages\/source\/src\/link\.mjs: a symlink is refused wherever the scan walks/);
    assert.doesNotMatch(linked.stderr, /ReferenceError/);
    rmSync(link);
    // A host script is pinned verbatim: one that preloads a package's
    // internals names no import the scan reads.
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, scripts: { test: "node --import ../../packages/surfacer/src/index.mjs --test test/*.test.mjs" } }));
    const script = guard();
    assert.notEqual(script.status, 0);
    assert.match(script.stderr, /hosts\/cmux\/package\.json: script test must be absent/);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // A nested manifest, under a host or a package, is refused whatever it
    // names itself.
    const nestedHost = path.join(root, "hosts", "cmux", "lib", "package.json");
    mkdirSync(path.dirname(nestedHost), { recursive: true });
    writeFileSync(nestedHost, JSON.stringify({ name: "@obversa/source", exports: { "./escape": "./dist/escape.mjs" } }));
    const nestedHostRun = guard();
    assert.notEqual(nestedHostRun.status, 0);
    assert.match(nestedHostRun.stderr, /hosts\/cmux\/lib\/package\.json: a nested manifest makes itself the package scope/);
    rmSync(nestedHost);
    const nestedPackage = path.join(root, "packages", "source", "src", "package.json");
    writeFileSync(nestedPackage, JSON.stringify({ name: "@obversa/surfacer", exports: { "./escape": "./escape.mjs" } }));
    const nestedPackageRun = guard();
    assert.notEqual(nestedPackageRun.status, 0);
    assert.match(nestedPackageRun.stderr, /packages\/source\/src\/package\.json: a nested manifest makes itself the package scope/);
    rmSync(nestedPackage);
    // A workspace dependency on another host, with no exports map, would let
    // a bare subpath reach that host's unscanned dist.
    mkdirSync(path.join(root, "hosts", "payload", "dist"), { recursive: true });
    writeFileSync(path.join(root, "hosts", "payload", "package.json"), JSON.stringify({ name: "payload", private: true }));
    writeFileSync(path.join(root, "hosts", "payload", "dist", "escape.mjs"), "export const e = eval;\n");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, payload: "workspace:*" } }));
    const payload = guard();
    assert.notEqual(payload.status, 0);
    assert.match(payload.stderr, /hosts\/cmux\/package\.json: dependencies payload is "workspace:\*", a workspace range on something other than a ruled package/);
    assert.match(payload.stderr, /hosts\/payload: has no host rule/);
    rmSync(path.join(root, "hosts", "payload"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // A host directory with no manifest takes the root as its package scope;
    // a root exports map would then serve any file under the repository.
    mkdirSync(path.join(root, "hosts", "rogue"));
    writeFileSync(path.join(root, "hosts", "rogue", "run.mjs"), 'import { e } from "obversa/escape";\nconsole.log(e("42"));\n');
    writeFileSync(path.join(root, "scripts", "escape.mjs"), "export const e = eval;\n");
    const rootManifestPath = path.join(root, "package.json");
    const rootManifestText = readFileSync(rootManifestPath, "utf8");
    writeFileSync(rootManifestPath, JSON.stringify({ ...JSON.parse(rootManifestText), exports: { "./escape": "./scripts/escape.mjs" } }));
    const rogue = guard();
    assert.notEqual(rogue.status, 0);
    assert.match(rogue.stderr, /hosts\/rogue\/package\.json: is missing/);
    assert.match(rogue.stderr, /package\.json: exports makes the root importable by name/);
    assert.match(rogue.stderr, /hosts\/rogue\/run\.mjs: a host carries placement glue only/);
    rmSync(path.join(root, "hosts", "rogue"), { recursive: true });
    rmSync(path.join(root, "scripts", "escape.mjs"));
    writeFileSync(rootManifestPath, rootManifestText);
    // Package-manager configuration in a host, and an unreadable host
    // manifest, are refused rather than skipped.
    writeFileSync(path.join(root, "hosts", "cmux", ".npmrc"), "registry=http://127.0.0.1:9/\n");
    const npmrc = guard();
    assert.notEqual(npmrc.status, 0);
    assert.match(npmrc.stderr, /hosts\/cmux\/\.npmrc: rewrites what packages install/);
    rmSync(path.join(root, "hosts", "cmux", ".npmrc"));
    writeFileSync(manifestPath, "\uFEFF{");
    const unreadable = guard();
    assert.notEqual(unreadable.status, 0);
    assert.match(unreadable.stderr, /hosts\/cmux\/package\.json: cannot be read as JSON/);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // A symlink under hosts/ is a shipped entry whose code the scan never
    // read: the link is refused on sight, as one under packages/ is.
    const escapeScript = path.join(root, "scripts", "escape.mjs");
    writeFileSync(escapeScript, '#!/usr/bin/env node\nconsole.log(eval("40 + 2"));\n');
    chmodSync(escapeScript, 0o755);
    const hostLink = path.join(root, "hosts", "cmux", "bin", "obversa-escape");
    symlinkSync(path.join("..", "..", "..", "scripts", "escape.mjs"), hostLink);
    const hostLinked = guard();
    assert.notEqual(hostLinked.status, 0);
    assert.match(hostLinked.stderr, /hosts\/cmux\/bin\/obversa-escape: a symlink is refused wherever the scan walks/);
    rmSync(hostLink);
    rmSync(escapeScript);
    // The main walk skips dist by name; a link kept there, under a host or a
    // package, is met by the per-host and per-package walks and refused.
    writeFileSync(escapeScript, '#!/usr/bin/env node\nconsole.log(eval("40 + 2"));\n');
    mkdirSync(path.join(root, "hosts", "cmux", "dist"), { recursive: true });
    const distLink = path.join(root, "hosts", "cmux", "dist", "obversa-escape");
    symlinkSync(path.join("..", "..", "..", "scripts", "escape.mjs"), distLink);
    const distLinked = guard();
    assert.notEqual(distLinked.status, 0);
    assert.match(distLinked.stderr, /hosts\/cmux\/dist\/obversa-escape: a symlink is refused wherever the scan walks/);
    rmSync(path.join(root, "hosts", "cmux", "dist"), { recursive: true });
    // A host is not built: a regular file kept under a host's dist — a
    // shipped command the main scan never reads — refuses the directory.
    mkdirSync(path.join(root, "hosts", "cmux", "dist"), { recursive: true });
    writeFileSync(path.join(root, "hosts", "cmux", "dist", "obversa-escape"), '#!/usr/bin/env node\nconsole.log(eval("40 + 2"));\n');
    chmodSync(path.join(root, "hosts", "cmux", "dist", "obversa-escape"), 0o755);
    const hostDist = guard();
    assert.notEqual(hostDist.status, 0);
    assert.match(hostDist.stderr, /hosts\/cmux\/dist: a host is not built; a dist directory under a host is a place the scan never reads/);
    rmSync(path.join(root, "hosts", "cmux", "dist"), { recursive: true });
    // The directory is refused by name, whatever it holds: empty, a bare
    // subdirectory, or a file under a node_modules the walk does not enter.
    for (const shape of [[], ["bin"], ["node_modules"]]) {
      const inner = path.join(root, "hosts", "cmux", "dist", ...shape);
      mkdirSync(inner, { recursive: true });
      if (shape[0] === "node_modules") writeFileSync(path.join(inner, "obversa-escape"), '#!/usr/bin/env node\nconsole.log(eval("40 + 2"));\n');
      const shaped = guard();
      assert.notEqual(shaped.status, 0, shape.join("/") || "empty dist");
      assert.match(shaped.stderr, /hosts\/cmux\/dist: a host is not built; a dist directory under a host is a place the scan never reads/, shape.join("/") || "empty dist");
      rmSync(path.join(root, "hosts", "cmux", "dist"), { recursive: true });
    }
    // A node_modules below the host root is not install output.
    mkdirSync(path.join(root, "hosts", "cmux", "lib", "node_modules"), { recursive: true });
    const nestedModules = guard();
    assert.notEqual(nestedModules.status, 0);
    assert.match(nestedModules.stderr, /hosts\/cmux\/lib\/node_modules: a node_modules directory below a host's root is not install output/);
    rmSync(path.join(root, "hosts", "cmux", "lib", "node_modules"), { recursive: true });
    mkdirSync(path.join(root, "packages", "source", "dist"), { recursive: true });
    const packageDistLink = path.join(root, "packages", "source", "dist", "link.mjs");
    symlinkSync(path.join("..", "..", "..", "scripts", "escape.mjs"), packageDistLink);
    const packageDistLinked = guard();
    assert.notEqual(packageDistLinked.status, 0);
    assert.match(packageDistLinked.stderr, /packages\/source\/dist\/link\.mjs: a symlink is refused wherever the scan walks/);
    rmSync(path.join(root, "packages", "source", "dist"), { recursive: true });
    rmSync(escapeScript);
    // A shell host command that names a package path runs it with no import
    // to scan.
    const shellCommand = path.join(root, "hosts", "cmux", "bin", "obversa-surface");
    const shellOriginal = readFileSync(shellCommand, "utf8");
    writeFileSync(shellCommand, `${shellOriginal}\nnode ../../../packages/surfacer/src/index.mjs "$@"\n`);
    const shell = guard();
    assert.notEqual(shell.status, 0);
    assert.match(shell.stderr, /hosts\/cmux\/bin\/obversa-surface: a shell host command names packages\//);
    writeFileSync(shellCommand, shellOriginal);
    // A publishConfig field pnpm promotes at pack time is refused on a
    // public package.
    const memoryManifestPath = path.join(root, "packages", "memory", "package.json");
    const memoryManifestText = readFileSync(memoryManifestPath, "utf8");
    const memoryManifest = JSON.parse(memoryManifestText);
    writeFileSync(memoryManifestPath, JSON.stringify({ ...memoryManifest, publishConfig: { ...memoryManifest.publishConfig, bin: { escape: "./dist/escape.js" } } }));
    const promoted = guard();
    assert.notEqual(promoted.status, 0);
    assert.match(promoted.stderr, /@obversa\/memory: publishConfig\.bin is promoted into the packed manifest by pnpm/);
    writeFileSync(memoryManifestPath, memoryManifestText);
    // A symlink outside packages/ and hosts/ — a release command that lives
    // elsewhere — is refused wherever the walk meets it.
    const releaseScript = path.join(root, "scripts", "release.mjs");
    const releaseText = readFileSync(releaseScript, "utf8");
    rmSync(releaseScript);
    writeFileSync(path.join(root, "scripts", "escape.mjs"), releaseText);
    symlinkSync("escape.mjs", releaseScript);
    const linkedRelease = guard();
    assert.notEqual(linkedRelease.status, 0);
    assert.match(linkedRelease.stderr, /scripts\/release\.mjs: a symlink is refused wherever the scan walks/);
    rmSync(releaseScript);
    rmSync(path.join(root, "scripts", "escape.mjs"));
    writeFileSync(releaseScript, releaseText);
    // A shell host command names its interpreter by absolute path; env
    // would look it up on PATH.
    for (const shebang of ["#!/usr/bin/env bash", "#!/usr/bin/env -S bash -x", "#!/opt/homebrew/bin/bash", "#!/bin/bash\r"]) {
      writeFileSync(shellCommand, `${shebang}\n${shellOriginal.split("\n").slice(1).join("\n")}`);
      const badShell = guard();
      assert.notEqual(badShell.status, 0, shebang);
      assert.match(badShell.stderr, /obversa-surface: a shell host command's shebang is #!\/bin\/bash or #!\/bin\/sh/, shebang);
    }
    writeFileSync(shellCommand, shellOriginal);
    // Text can be assembled; the geometry cannot: a parent segment or an
    // absolute path outside the system directories is refused whatever
    // spells the rest.
    writeFileSync(shellCommand, `${shellOriginal}\nP=pack\nnode "../../../${"$"}{P}ages/surfacer/src/index.mjs" "$URL"\n`);
    const assembled = guard();
    assert.notEqual(assembled.status, 0);
    assert.match(assembled.stderr, /obversa-surface: a shell host command holds a parent-directory segment/);
    writeFileSync(shellCommand, `${shellOriginal}\nnode /Users/someone/obversa/packages/surfacer/src/index.mjs "$URL"\n`);
    const absoluteLiteral = guard();
    assert.notEqual(absoluteLiteral.status, 0);
    assert.match(absoluteLiteral.stderr, /obversa-surface: a shell host command names the absolute path \/Users\/someone\/obversa\/packages\/surfacer\/src\/index\.mjs/);
    writeFileSync(shellCommand, shellOriginal);
    // A shell helper with a shebang anywhere under the host is held to the
    // same rules.
    const helper = path.join(root, "hosts", "cmux", "tools", "helper.sh");
    mkdirSync(path.dirname(helper), { recursive: true });
    writeFileSync(helper, '#!/bin/bash\nnode ../../../packages/surfacer/src/index.mjs\n');
    const helperRun = guard();
    assert.notEqual(helperRun.status, 0);
    assert.match(helperRun.stderr, /hosts\/cmux\/tools\/helper\.sh: a shell host command names packages\//);
    rmSync(path.dirname(helper), { recursive: true });
    // The closure over shell is the pin: any byte changed, however benign,
    // fails until the rule is reviewed; a path rooted in an expansion the
    // text rules cannot place fails the same way.
    writeFileSync(shellCommand, `${shellOriginal}# a note\n`);
    const changedShell = guard();
    assert.notEqual(changedShell.status, 0);
    assert.match(changedShell.stderr, /obversa-surface: content sha256 must be [0-9a-f]{64}; found [0-9a-f]{64}\. Shell host commands are pinned in hostRules/);
    for (const rooted of ['node "${HOME}/x.mjs" "$URL"', 'node "$(pwd)/x.mjs" "$URL"']) {
      writeFileSync(shellCommand, `${shellOriginal}\n${rooted}\n`);
      const rootedRun = guard();
      assert.notEqual(rootedRun.status, 0, rooted);
      assert.match(rootedRun.stderr, /obversa-surface: content sha256 must be/, rooted);
    }
    // And a word assembled across an expansion is refused on its own terms.
    for (const assembled of ['P=pack\nnode "$HOME/x/${P}ages/y.mjs"', 'N=n\n"$N"ode x.mjs', 'A=pack\nB=ages\nnode "$A$B/x.mjs"', 'X=ages\nnode "pack${X}/x.mjs"']) {
      writeFileSync(shellCommand, `${shellOriginal}\n${assembled}\n`);
      const assembledRun = guard();
      assert.notEqual(assembledRun.status, 0, assembled);
      assert.match(assembledRun.stderr, /obversa-surface: a shell host command touches an expansion to a word character or to another expansion/, assembled);
    }
    writeFileSync(shellCommand, shellOriginal);
    // An unpinned shell command under bin/ is refused until reviewed and pinned.
    const unpinned = path.join(root, "hosts", "cmux", "bin", "obversa-new");
    writeFileSync(unpinned, "#!/bin/bash\necho hi\n");
    const unpinnedRun = guard();
    assert.notEqual(unpinnedRun.status, 0);
    assert.match(unpinnedRun.stderr, /hosts\/cmux\/bin\/obversa-new: a shell host command is pinned by content in hostRules; this one is not pinned/);
    rmSync(unpinned);
    // A file under bin/ or lib/ with any extension the scan does not know
    // is read all the same and refused: an extension is not a way past the
    // host checks.
    for (const [name, body] of [["bin/obversa-new.bash", "#!/bin/bash\nnode ../../../packages/surfacer/src/index.mjs\n"], ["lib/helper.py", "#!/usr/bin/env python3\nprint(1)\n"], ["bin/obversa-new.zsh", "echo hi\n"]]) {
      const odd = path.join(root, "hosts", "cmux", ...name.split("/"));
      mkdirSync(path.dirname(odd), { recursive: true });
      writeFileSync(odd, body);
      const oddRun = guard();
      assert.notEqual(oddRun.status, 0, name);
      const escaped = name.replace(/[./]/g, (c) => "\\" + c);
      assert.match(oddRun.stderr, new RegExp(`hosts/cmux/${escaped}: a file under a host's bin/ or lib/ is an extensionless command or JavaScript source`), name);
      if (name.endsWith(".bash")) assert.match(oddRun.stderr, /obversa-new\.bash: a shell host command names packages\//, "the shell checks ran on it too");
      rmSync(odd);
    }
    // A test-shaped name under bin/ or lib/ is not a test: it ships, and it
    // meets the extension rule, the pin, and the path rule like any other.
    for (const [name, body, expect] of [
      ["lib/helper.test.py", "#!/usr/bin/env python3\nprint(1)\n", /lib\/helper\.test\.py: a file under a host's bin\/ or lib\/ is an extensionless command or JavaScript source/],
      ["bin/obversa-new.test.bash", "#!/bin/bash\nnode ../../../packages/surfacer/src/index.mjs\n", /obversa-new\.test\.bash: a shell host command names packages\//],
      ["bin/test/obversa-x", "#!/bin/bash\nnode ../../../packages/surfacer/src/index.mjs\n", /bin\/test\/obversa-x: a shell host command is pinned by content in hostRules; this one is not pinned/],
    ]) {
      const shaped = path.join(root, "hosts", "cmux", ...name.split("/"));
      mkdirSync(path.dirname(shaped), { recursive: true });
      writeFileSync(shaped, body);
      const shapedRun = guard();
      assert.notEqual(shapedRun.status, 0, name);
      assert.match(shapedRun.stderr, expect, name);
      rmSync(shaped);
    }
    rmSync(path.join(root, "hosts", "cmux", "bin", "test"), { recursive: true, force: true });
    rmSync(path.join(root, "hosts", "cmux", "lib"), { recursive: true, force: true });
    // A shebang file directly under hosts/ belongs to no host: a listed
    // refusal, never a crash.
    writeFileSync(path.join(root, "hosts", "run.bash"), "#!/bin/bash\necho hi\n");
    const stray = guard();
    assert.notEqual(stray.status, 0);
    assert.match(stray.stderr, /hosts\/run\.bash: a file directly under hosts\/ belongs to no host/);
    assert.doesNotMatch(stray.stderr, /TypeError|at main/);
    rmSync(path.join(root, "hosts", "run.bash"));
    // Every mutation above was undone: the copy passes again.
    assert.equal(guard().status, 0, "the restored copy passes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the TypeScript hatch scan refuses the loader hatches and exempts test files", () => {
  // A hatch is a null entry among the specifiers; the guard reports any.
  const hatches = (text, file = "packages/runtime/src/a.ts") => moduleSpecifiers(text, file).includes(null);
  for (const text of [
    'eval("1");',
    'new Function("return process")();',
    'process.getBuiltinModule("fs");',
    'global.eval("1");',
    'globalThis.eval("1");',
    'import("./" + name);',
    'const r = require;',
  ]) {
    assert.equal(hatches(text), true, text);
  }
  assert.equal(hatches('globalThis.setTimeout(() => {}, 1); const e = process.env.X;'), false, "listed data members stay usable");
  assert.equal(hatches('const id = record.binding.requestId;'), false, "an ordinary binding property is data");
  assert.equal(hatches('process.binding("fs");'), true, "process.binding is a loader hatch");
  assert.equal(hatches('process["binding"]("fs");'), true, "bracket access to process.binding is a loader hatch");
  assert.equal(hatches('import { x } from "./ok.js";'), false, "a plain import is no hatch");
  assert.equal(hatches('eval("1");', "packages/runtime/tests/a.spec.ts"), false, "a test file is exempt from the hatch rules");
});

test("a TypeScript source with a loader hatch fails the live guard on a disposable copy", { timeout: 300_000 }, () => {
  const real = new URL("..", import.meta.url).pathname;
  const root = copyTree(real);
  try {
    const guard = () => spawnSync(process.execPath, [path.join(root, "scripts", "check-boundaries.mjs")], { cwd: root, encoding: "utf8" });
    const probe = path.join(root, "packages", "runtime", "src", "hatch-probe.ts");
    writeFileSync(probe, 'export const e = eval("1");\n');
    const run = guard();
    assert.notEqual(run.status, 0, "the hatch must fail the guard");
    assert.match(run.stderr, /packages\/runtime\/src\/hatch-probe\.ts: a loader hatch/);
    rmSync(probe);
    assert.equal(guard().status, 0, "the restored copy passes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the workspace file pin keeps packages, plugins, and hosts in the boundary", () => {
  assert.equal(isPinnedWorkspaceFile(PINNED_WORKSPACE_FILE), true);
  assert.equal(isPinnedWorkspaceFile("packages:\n  - packages/*\n  - hosts/*\n  - plugins/*\nnodeLinker: isolated\nhoist: false\npublicHoistPattern: []\n"), true);
  for (const text of [
    "packages:\n  - packages/*\n",
    "packages:\n  - packages/*\n  - hosts/*\nnodeLinker: isolated\nhoist: false\npublicHoistPattern: []\n",
    "packages:\n  - packages/*\n  - hosts/*\n  - tools/*\n",
    "packages:\n  - packages/*\n  - hosts/*\n",
    "packages:\n  - packages/*\n  - hosts/*\nnodeLinker: isolated\nhoist: true\npublicHoistPattern: []\n",
    "packages:\n  - packages/*\n  - hosts/*\nnodeLinker: hoisted\nhoist: false\npublicHoistPattern: []\n",
    "packages:\n  - hosts/*\n  - packages/*\n",
    "packages:\n  - packages/*\n  - hosts/*",
    "packages:\n  - packages/**\n  - hosts/*\n",
    "",
  ]) {
    assert.equal(isPinnedWorkspaceFile(text), false, JSON.stringify(text));
  }
});

test("the loader-hatch scan covers package and plugin TypeScript", () => {
  assert.equal(scansImports("packages/runtime/src/api.ts"), true);
  assert.equal(scansImports("plugins/engine-codex/src/index.ts"), true);
  assert.equal(scansImports("hosts/cmux/src/index.ts"), false);
});

test("the live tree passes the boundary check", () => {
  const script = fileURLToPath(new URL("./check-boundaries.mjs", import.meta.url));
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /Boundary check passed for \d+ packages/);
});
