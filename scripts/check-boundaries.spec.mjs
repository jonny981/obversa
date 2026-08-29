import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "@typescript/typescript6";
import { validRange } from "semver";

import { dependencyTarget, extractObversaImports, hostEdgeFailures, hostImportFindings, internalDependencies, isHostScript, isHostTestFile, isPinnedWorkspaceFile, isProjectConfig, isTestPath, isVersionRange, manifestImportTargets, manifestPathTargets, moduleSpecifiers, parserExtensions, PINNED_WORKSPACE_FILE, projectConfig, refusal, scansImports, sourceExtensions, textExtensions, tsconfigDependencies, walkTree } from "./check-boundaries.mjs";

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
    internalDependencies({ dependencies: { hidden: "npm:@obversa/surfacer@0.1.0", other: "workspace:@obversa/memory@*", "@obversa/lines": "workspace:^", ext: "npm:lodash@4", plain: "^1.0.0" } }, "dependencies"),
    ["@obversa/lines", "@obversa/memory", "@obversa/surfacer"],
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
    // The import that names the link looks local, but the file the loader
    // opens is the sibling package's: the scan judges the crossing by real
    // path, refuses the link as another spelling, and the walk fails closed
    // on the link itself as well.
    const found = extractObversaImports('import "./bridge.mjs";', { file: path.join(dir, "packages/source/src/real.mjs"), root: dir });
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0], /\.\/bridge\.mjs names packages\/surfacer\/src\/index\.mjs by another spelling/);
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
  assert.deepEqual(moduleSpecifiers('module[key]("x"); require[key]("y"); import.meta[key]("w"); module.other("z");', "a.cjs"), [null, null, null, null], "a computed member may be the loader, and an unlisted member of module reaches one: both unreadable");
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
    'export { registerHooks } from "node:module";',
    'export * from "node:module";',
    'export * as m from "module";',
    'import Module = require("node:module");',
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
    'Reflect.get(process, "getBuiltinModule")("node:module").register("./hook.mjs", import.meta.url);',
    'process["get" + "BuiltinModule"]("node:module");',
    'process[k];',
    'globalThis[k];',
    'Reflect.get(globalThis, "process");',
    'const p = process;',
    'const g = globalThis;',
    'globalThis.process[k];',
    'f(globalThis);',
    'process.binding("fs");',
    'process.dlopen(m, "x.node");',
    'process.mainModule;',
    // A member outside a root's list hands the root back or reaches past it,
    // and so does a listed chaining method whose result is kept.
    'const p = process.valueOf(); p["get" + "BuiltinModule"]("node:module");',
    'process.on("SIGINT", f)["get" + "BuiltinModule"]("node:module");',
    'const p = process.once("exit", f);',
    'f(process.off("exit", g));',
    // .constructor.constructor is Function on any object.
    'process.stdout.constructor.constructor("return process")();',
    '({}).constructor.constructor("return process")();',
    'const C = x.constructor;',
    'Reflect.get(x, "constructor");',
    'Reflect.apply(f, null, []);',
    'process.constructor;',
    'process.__proto__;',
    'globalThis.valueOf();',
    'globalThis.eval("1");',
    'import.meta.valueOf;',
    'module.valueOf();',
    // Text run as code, and the vm builtin.
    'eval("process.getBuiltinModule");',
    'new Function("return process")();',
    'Function("x")();',
    'const e = eval;',
    'import vm from "node:vm";',
    'import { runInThisContext } from "vm";',
    'const vm = await import("node:vm");',
    'require("vm");',
    // Node's CommonJS wrapper passes require and module as its arguments.
    'const loaded = arguments[1]("../../surfacer/src/sanitize.mjs");',
    'arguments[2].require("x");',
    'const [, load] = arguments;',
    'const a = arguments;',
    'f(arguments);',
    'const load = (() => arguments[1])();',
    // module.constructor is the Module class: its hooks and loaders take
    // no Module argument, so the class itself is the route.
    'module.constructor.registerHooks({ resolve });',
    'module.constructor._load("../../surfacer/src/sanitize.mjs", undefined, false);',
    'module.constructor;',
    'module.children;',
    'module.parent;',
    'module.paths;',
    'Module.registerHooks({ resolve });',
    'anything._load("x");',
    'anything._resolveFilename("x");',
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
    'module.exports = 1;', 'module.id;', 'module.filename;', 'module.path;', 'module.loaded;', 'import.meta.url;', 'import.meta.dirname;',
    'function f() { return arguments[0]; }', 'const o = { m() { return arguments.length; } };', 'class A { constructor() { this.n = arguments.length; } }',
    'process.env.HOME; process.cwd(); process.exit(1); process.stdout.write("x"); process.argv.slice(2); process.platform === "darwin";',
    'process.on("SIGINT", handler); process.off("SIGINT", handler);', 'const name = value.constructor?.name; const n2 = value.constructor.name;',
    'globalThis.fetch; globalThis.process.env.X; typeof globalThis.WebSocket;', 'process === globalThis.process;',
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

test("host JavaScript is import-scanned: public package names pass, a path into packages/ or a loader hatch is refused", () => {
  assert.equal(isHostScript("hosts/cmux/lib/review-args.mjs", "export const x = 1;"), true);
  assert.equal(isHostScript("hosts/cmux/bin/obversa-review", "#!/usr/bin/env node\nimport x from 'y';"), true, "an extensionless node command");
  assert.equal(isHostScript("hosts/cmux/bin/obversa-surface", "#!/usr/bin/env bash\necho"), false, "a bash script is not JavaScript");
  assert.equal(isHostScript("packages/source/src/a.mjs", ""), false, "packages are scanned by the package rules");
  const file = "/repo/hosts/cmux/bin/obversa-review";
  assert.deepEqual(hostImportFindings('import { runSurface } from "@obversa/surfacer"; import { reviewDiff } from "@obversa/source"; const kit = import.meta.resolve("@obversa/surfacer/client"); import { HELP } from "../lib/review-args.mjs";', { file, root: "/repo", dependencies: HOST_DEPENDENCIES }), [], "public names and the host's own files");
  for (const text of [
    'import { reviewDiff } from "../../../packages/source/src/review.mjs";',
    'const kit = import.meta.resolve("../../../packages/surfacer/src/client.mjs");',
    'const { runSurface } = await import("/repo/packages/surfacer/src/index.mjs");',
  ]) {
    const found = hostImportFindings(text, { file, root: "/repo" });
    assert.ok(found.some((entry) => /by path/.test(entry)), text);
  }
  // Package indirection: a `#alias` (the manifest's imports map) and the
  // host's own name (its exports map) are refused outright in shipped code.
  assert.ok(hostImportFindings('import { e } from "#escape";', { file, root: "/repo" }).some((entry) => /package-imports alias/.test(entry)));
  assert.ok(hostImportFindings('import { e } from "@obversa/cmux-host/escape";', { file, root: "/repo", selfName: "@obversa/cmux-host" }).some((entry) => /imports itself by package name/.test(entry)));
  assert.ok(hostImportFindings('import { e } from "@obversa/cmux-host";', { file, root: "/repo", selfName: "@obversa/cmux-host" }).some((entry) => /imports itself by package name/.test(entry)));
  assert.deepEqual(hostImportFindings('import { e } from "@obversa/cmux-host-other";', { file, root: "/repo", selfName: "@obversa/cmux-host", dependencies: new Map([["@obversa/cmux-host-other", null]]) }), [], "a different, declared package name is a public name");
  assert.ok(hostImportFindings('const m = process.getBuiltinModule("node:module");', { file, root: "/repo" }).length > 0, "loader hatches are refused in a host too");
  assert.ok(hostImportFindings('const name = "@obversa/" + pick; import(name);', { file, root: "/repo" }).some((entry) => /computed module reference/.test(entry)));
  // Shipped host code may not reach a test path (exempt from the hatch rules)
  // or a local module without a source extension (never scanned).
  assert.ok(hostImportFindings('import { probe } from "../test/escape.mjs";', { file, root: "/repo" }).some((entry) => /imports a test path/.test(entry)));
  assert.ok(hostImportFindings('import { probe } from "../lib/escape.test.mjs";', { file, root: "/repo" }).some((entry) => /imports a test path/.test(entry)));
  assert.ok(hostImportFindings('import { helper } from "../lib/helper";', { file, root: "/repo" }).some((entry) => /the scan would not read/.test(entry)));
  assert.ok(hostImportFindings('const h = await import("../bin/other-command");', { file, root: "/repo" }).some((entry) => /the scan would not read/.test(entry)));
  assert.deepEqual(hostImportFindings('import { helper } from "../lib/helper.mjs";', { file, root: "/repo" }), [], "a local module with a source extension inside the host root is scanned on its own");
  // Every resolved shipped edge is recorded, so the walk can prove its
  // target was actually import-scanned; a shape that passes the early checks
  // (a dist file under the host root) is still only an edge until then.
  const edges = [];
  hostImportFindings('import { helper } from "../lib/helper.mjs"; import { built } from "../dist/escape.mjs";', { file, root: "/repo", edges });
  assert.deepEqual(edges.map((edge) => edge.target), ["hosts/cmux/lib/helper.mjs", "hosts/cmux/dist/escape.mjs"]);
  assert.deepEqual([], (() => { const e = []; hostImportFindings('import "@obversa/source";', { file, root: "/repo", edges: e }); return e; })(), "a public name is not a local edge");
  // A suffix proves nothing: the target must sit inside the importing
  // file's own hosts/<name>/ root, or it is a file the walk never scans.
  for (const text of [
    'import { e } from "../../../escape.mjs";',
    'import { e } from "../../../scripts/release.mjs";',
    'import { e } from "../../other-host/lib/helper.mjs";',
    'import { e } from "/repo/escape.mjs";',
  ]) {
    assert.ok(hostImportFindings(text, { file, root: "/repo" }).some((entry) => /outside its own host root/.test(entry)), text);
  }
  // A host proof may reach a package's internals by path until F2b gives it a
  // public testing subpath; it is still refused a computed or schemed specifier.
  const proof = "/repo/hosts/cmux/test/f3-browser-proof.mjs";
  assert.deepEqual(hostImportFindings('import { highlightModel } from "../../../packages/source/src/highlight-model.mjs";', { file: proof, root: "/repo" }), []);
  assert.ok(hostImportFindings('import(pick);', { file: proof, root: "/repo" }).length > 0);
});

test("a recorded host edge passes only when its target is in the set the walk import-scanned", () => {
  const scanned = new Set(["hosts/cmux/bin/obversa-review", "hosts/cmux/lib/review-args.mjs"]);
  const edge = (specifier, target) => ({ from: "hosts/cmux/bin/obversa-review", specifier, target });
  assert.deepEqual(hostEdgeFailures([edge("../lib/review-args.mjs", "hosts/cmux/lib/review-args.mjs")], scanned), []);
  for (const [specifier, target] of [["../dist/escape.mjs", "hosts/cmux/dist/escape.mjs"], ["../lib/missing.mjs", "hosts/cmux/lib/missing.mjs"], ["../../../escape.mjs", "escape.mjs"]]) {
    const failures = hostEdgeFailures([edge(specifier, target)], scanned);
    assert.equal(failures.length, 1, specifier);
    assert.match(failures[0], /did not import-scan/);
  }
});

// What hosts/cmux/package.json declares, as the guard hands it over.
const HOST_DEPENDENCIES = new Map([["@obversa/surfacer", new Set([".", "./client"])], ["@obversa/source", new Set(["."])]]);

test("a shipped host bare specifier is a node: builtin or a declared dependency, and a subpath only one the dependency exports", () => {
  const file = "/repo/hosts/cmux/bin/obversa-review";
  const dependencies = new Map([...HOST_DEPENDENCIES, ["semver", null]]);
  const findings = (text) => hostImportFindings(text, { file, root: "/repo", dependencies });
  assert.deepEqual(findings('import { readFile } from "node:fs/promises"; import semver from "semver"; import { runSurface } from "@obversa/surfacer"; const kit = import.meta.resolve("@obversa/surfacer/client");'), []);
  assert.ok(findings('import { e } from "payload/dist/escape.mjs";').some((entry) => /which its manifest does not declare/.test(entry)));
  assert.ok(findings('import { e } from "payload";').some((entry) => /which its manifest does not declare/.test(entry)));
  assert.ok(findings('import { e } from "obversa/escape";').some((entry) => /which its manifest does not declare/.test(entry)), "the root's name is not a dependency");
  assert.ok(findings('import { e } from "@obversa/source/dist/escape.mjs";').some((entry) => /a subpath its dependency's exports map does not list/.test(entry)));
  assert.ok(findings('import { e } from "semver/internal/re.js";').some((entry) => /a subpath its dependency's exports map does not list/.test(entry)), "a registry dependency exports no subpath the scan knows");
  assert.ok(findings('import { readFile } from "fs/promises";').some((entry) => /without its node: prefix/.test(entry)));
  assert.ok(findings('import { x } from "node:nonesuch";').some((entry) => /not a Node builtin/.test(entry)));
  assert.equal(hostImportFindings('import { e } from "payload/dist/escape.mjs";', { file, root: "/repo" }).length, 1, "nothing declared is the default");
  assert.deepEqual(hostImportFindings('import { e } from "payload/dist/escape.mjs";', { file: "/repo/hosts/cmux/test/x.test.mjs", root: "/repo" }), [], "a test file is not shipped");
});

test("a relative import is placed by its real path, and a spelling other than the disk's own is refused", (t) => {
  const tree = realpathSync(mkdtempSync(path.join(os.tmpdir(), "boundaries-case-")));
  try {
    mkdirSync(path.join(tree, "packages", "surfacer", "src"), { recursive: true });
    mkdirSync(path.join(tree, "packages", "source", "src"), { recursive: true });
    writeFileSync(path.join(tree, "packages", "surfacer", "src", "index.mjs"), "export const x = 1;\n");
    const file = path.join(tree, "packages", "source", "src", "a.mjs");
    writeFileSync(file, "");
    const found = (text) => extractObversaImports(text, { file, root: tree });
    assert.deepEqual(found('import { x } from "../../surfacer/src/index.mjs";'), ["@obversa/surfacer"], "the honest spelling is the crossing it is");
    assert.deepEqual(found('import { x } from "../../surfacer/src/missing.mjs";'), ["@obversa/surfacer"], "a missing target keeps its spelling and its crossing");
    // A root and a file handed over through a symlinked spelling still place
    // the crossing: the check reads real paths on both sides.
    const linkedTree = path.join(os.tmpdir(), path.basename(tree) + "-link");
    symlinkSync(tree, linkedTree);
    try {
      assert.deepEqual(extractObversaImports('import { x } from "../../surfacer/src/index.mjs";', { file: path.join(linkedTree, "packages", "source", "src", "a.mjs"), root: linkedTree }), ["@obversa/surfacer"]);
      // Every placement path reads the root the same way: an alias the
      // compiler resolves, a manifest entry field, and a tsconfig files
      // entry each place the same crossing under the real root and the
      // linked one.
      writeFileSync(path.join(tree, "packages", "surfacer", "src", "index.ts"), "export const x = 1;\n");
      for (const root of [tree, linkedTree]) {
        const source = path.join(root, "packages", "source");
        assert.deepEqual(
          extractObversaImports('import x from "#surf/index";', { file: path.join(source, "src", "a.ts"), root, configs: [{ baseUrl: root, paths: { "#surf/*": ["packages/surfacer/src/*"] } }] }),
          ["@obversa/surfacer"],
          `an alias under ${root === tree ? "the real" : "the linked"} root`,
        );
        assert.deepEqual(manifestPathTargets({ main: "../surfacer/src/index.ts" }, { file: path.join(source, "package.json"), root }), ["@obversa/surfacer"], `a manifest entry under ${root === tree ? "the real" : "the linked"} root`);
        assert.deepEqual(tsconfigDependencies('{ "files": ["../../packages/surfacer/src/index.ts"] }', { file: path.join(source, "tsconfig.json"), root }), ["@obversa/surfacer"], `a tsconfig files entry under ${root === tree ? "the real" : "the linked"} root`);
        assert.deepEqual(manifestPathTargets({ main: "../../" }, { file: path.join(source, "package.json"), root }), [refusal("main reaches ., which holds every package")], `a value that reaches every package under ${root === tree ? "the real" : "the linked"} root`);
        // A path whose tail does not exist yet — generated output, several
        // segments deep — still places under the sibling it names. The
        // manifest case is the one that exercises the walk up to the deepest
        // existing ancestor; the import's own directory is read by real path
        // before its target is, so it places either way.
        assert.deepEqual(manifestPathTargets({ main: "../surfacer/generated/nested/entry.mjs" }, { file: path.join(source, "package.json"), root }), ["@obversa/surfacer"], `a missing nested path under ${root === tree ? "the real" : "the linked"} root`);
        assert.deepEqual(extractObversaImports('import { x } from "../../surfacer/generated/nested/entry.mjs";', { file: path.join(source, "src", "a.mjs"), root }), ["@obversa/surfacer"], `a missing nested import under ${root === tree ? "the real" : "the linked"} root`);
      }
    } finally {
      rmSync(linkedTree);
    }
    // A symlink is another spelling too.
    symlinkSync(path.join("..", "..", "surfacer", "src", "index.mjs"), path.join(tree, "packages", "source", "src", "link.mjs"));
    assert.ok(found('import { x } from "./link.mjs";').some((entry) => /by another spelling/.test(entry)));
    if (!existsSync(path.join(tree, "PACKAGES", "SURFACER", "src", "index.mjs"))) {
      t.diagnostic("case-sensitive disk: another case opens nothing, so there is nothing to refuse");
      return;
    }
    const other = found('import { x } from "../../SURFACER/src/index.mjs";');
    assert.ok(other.some((entry) => /by another spelling/.test(entry)), JSON.stringify(other));
    assert.ok(found('import { x } from "../../../PACKAGES/surfacer/src/index.mjs";').some((entry) => /by another spelling/.test(entry)));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("createRequire is a loader only from this file's own URL; any other base moves every later resolution unseen", () => {
  const file = "/repo/packages/source/src/a.mjs";
  const found = (text) => extractObversaImports(`import { createRequire } from "node:module"; ${text}`, { file, root: "/repo" });
  assert.deepEqual(found('const require = createRequire(import.meta.url); const x = require.resolve("./x.mjs");'), [], "the documented form");
  for (const base of ['new URL("../../surfacer/package.json", import.meta.url)', '"/repo/packages/surfacer/package.json"', 'import.meta.resolve("@obversa/surfacer")', 'someUrl']) {
    assert.ok(found(`const require = createRequire(${base}); const x = require.resolve("./src/index.mjs");`).length > 0, base);
  }
});

test("shipped source may not import into build output: dist is never read by the scan", () => {
  const tree = realpathSync(mkdtempSync(path.join(os.tmpdir(), "boundaries-dist-")));
  try {
    mkdirSync(path.join(tree, "packages", "source", "src"), { recursive: true });
    mkdirSync(path.join(tree, "packages", "source", "dist"), { recursive: true });
    writeFileSync(path.join(tree, "packages", "source", "dist", "escape.mjs"), 'import "../../surfacer/src/index.mjs";\n');
    const file = path.join(tree, "packages", "source", "src", "a.mjs");
    writeFileSync(file, "");
    const found = extractObversaImports('import { e } from "../dist/escape.mjs";', { file, root: tree });
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.match(found[0], /imports build output under dist, which the scan does not read/);
    assert.deepEqual(extractObversaImports('import { e } from "../dist/escape.mjs";', { file: path.join(tree, "packages", "source", "test", "a.test.mjs"), root: tree }), [], "a test may read its package's build output");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("a package imports nothing from outside packages/: a host, scripts/, or the root is a refused crossing", () => {
  const file = "/repo/packages/source/src/a.mjs";
  for (const specifier of ["../../../hosts/cmux/lib/review-args.mjs", "../../../scripts/release.mjs", "../../../package.json", "/repo/hosts/cmux/lib/review-args.mjs"]) {
    const found = extractObversaImports(`import x from "${specifier}";`, { file, root: "/repo" });
    assert.equal(found.length, 1, specifier);
    assert.match(found[0], /outside packages\/; a package imports nothing from hosts, scripts, or the repository root/, specifier);
  }
  assert.deepEqual(extractObversaImports('import x from "../../surfacer/src/index.mjs";', { file, root: "/repo" }), ["@obversa/surfacer"], "a sibling is still the arrow it is");
});

test("only hosts/<name>/test/ is a host test: a test-shaped name under bin/ or lib/ ships and is held to the shipped rules", () => {
  assert.equal(isHostTestFile("hosts/cmux/test/f3-browser-proof.mjs"), true);
  assert.equal(isHostTestFile("hosts/cmux/test/nested/x.test.mjs"), true);
  for (const path of ["hosts/cmux/bin/x.test.mjs", "hosts/cmux/lib/helper.test.py", "hosts/cmux/bin/test/x", "hosts/cmux/lib/__tests__/y.mjs", "hosts/cmux/tests/z.mjs"]) assert.equal(isHostTestFile(path), false, path);
  const dependencies = new Map([["@obversa/surfacer", new Set(["."])]]);
  assert.ok(hostImportFindings('import { x } from "../../../packages/surfacer/src/index.mjs";', { file: "/repo/hosts/cmux/bin/x.test.mjs", root: "/repo", dependencies }).some((entry) => /by path/.test(entry)), "a test-shaped name under bin/ is shipped");
  assert.deepEqual(hostImportFindings('import { x } from "../../../packages/surfacer/src/index.mjs";', { file: "/repo/hosts/cmux/test/x.test.mjs", root: "/repo", dependencies }), [], "the host's own test/ is the exemption");
});

test("a relative import that names an existing file with no source extension is refused: Node loads it, the scan never reads it", () => {
  const tree = realpathSync(mkdtempSync(path.join(os.tmpdir(), "boundaries-extless-")));
  try {
    mkdirSync(path.join(tree, "packages", "source", "src"), { recursive: true });
    writeFileSync(path.join(tree, "packages", "source", "escape"), 'import "../surfacer/src/index.mjs";\n');
    writeFileSync(path.join(tree, "packages", "source", "data.json"), "{}\n");
    const file = path.join(tree, "packages", "source", "src", "a.mjs");
    writeFileSync(file, "");
    const found = (text) => extractObversaImports(text, { file, root: tree });
    const escaped = found('import { e } from "../escape";');
    assert.equal(escaped.length, 1, JSON.stringify(escaped));
    assert.match(escaped[0], /packages\/source\/escape, a file with no source extension, which the scan never import-scans/);
    assert.deepEqual(found('import data from "../data.json";'), [], "a data file is not a module that imports");
    assert.deepEqual(found('import { x } from "./missing";'), [], "a target that does not exist as spelled is the compiler's to place");
    // Node reads ?query and #fragment as URL syntax and opens the file
    // without them; a resolver would look for the punctuation in a name.
    for (const specifier of ["../escape?x=1", "../escape#part", "../src/b.mjs?cache=1"]) {
      const withUrl = found(`import { e } from "${specifier}";`);
      assert.equal(withUrl.length, 1, specifier);
      assert.match(withUrl[0], /carries a query or fragment; a module is named by its path alone/, specifier);
    }
    assert.ok(hostImportFindings('import { e } from "../lib/review-args.mjs?x";', { file: "/repo/hosts/cmux/bin/obversa-review", root: "/repo" }).some((entry) => /carries a query or fragment/.test(entry)), "a host import likewise");
    // A manifest entry field is the same door: main, module, or an exports
    // leaf naming the extensionless module exposes it to every consumer.
    const manifestAt = { file: path.join(tree, "packages", "source", "package.json"), root: tree };
    mkdirSync(path.join(tree, "packages", "source", "lib"), { recursive: true });
    writeFileSync(path.join(tree, "packages", "source", "index.d.ts"), "export {};\n");
    for (const manifest of [{ main: "./escape" }, { module: "./escape" }, { exports: { ".": "./escape" } }, { exports: { ".": { import: "./src/a.mjs", default: "./escape" } } }]) {
      const placed = manifestPathTargets(manifest, manifestAt);
      assert.equal(placed.length, 1, JSON.stringify(manifest));
      assert.match(placed[0], /names packages\/source\/escape, a file with no source extension, which the scan never import-scans/, JSON.stringify(manifest));
    }
    assert.deepEqual(manifestPathTargets({ main: "./src/a.mjs", types: "./index.d.ts", exports: { ".": "./src/a.mjs", "./data": "./data.json" }, directories: { lib: "./lib" } }, manifestAt), [], "source, types, data, and a directory place as their own");
    // An imports-map alias is the same door again.
    const aliased = manifestImportTargets({ imports: { "#escape": "./escape" } }, manifestAt);
    assert.equal(aliased.length, 1, JSON.stringify(aliased));
    assert.match(aliased[0], /package imports alias \.\/escape, a file with no source extension, which the scan never import-scans/);
    assert.deepEqual(manifestImportTargets({ imports: { "#a": "./src/a.mjs", "#data": "./data.json" } }, manifestAt), [], "a source alias and a data alias place as their own");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

// The live full-check mutants: the real guard, run as a child on a
// disposable copy of the current tree (git's file list, with the root
// node_modules symlinked to the real one),
// with one shipped host import added and the file it names created, must
// fail with the resolved target named. The guard finds its root from its
// own file, so the copied guard checks the copied tree; the shared worktree
// is never written, so a crash, a kill, or a concurrent reader cannot see a
// false tree. The copy is removed in finally.
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
    const command = path.join(root, "hosts", "cmux", "bin", "obversa-review");
    const original = readFileSync(command, "utf8");
    const guard = () => spawnSync(process.execPath, [path.join(root, "scripts", "check-boundaries.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(guard().status, 0, `the copy passes before any mutation:\n${guard().stderr}`);
    const mutants = [
      { name: "a tracked dist file under the host root", file: path.join(root, "hosts", "cmux", "dist", "escape.mjs"), specifier: "../dist/escape.mjs" },
      { name: "a file at the repository root", file: path.join(root, "escape.mjs"), specifier: "../../../escape.mjs" },
      { name: "a file under scripts", file: path.join(root, "scripts", "escape.mjs"), specifier: "../../../scripts/escape.mjs" },
    ];
    for (const mutant of mutants) {
      mkdirSync(path.dirname(mutant.file), { recursive: true });
      writeFileSync(mutant.file, "export const e = eval;\n");
      writeFileSync(command, `${original}\nimport { e } from "${mutant.specifier}";\n`);
      const run = guard();
      assert.notEqual(run.status, 0, `${mutant.name}: the guard must fail`);
      assert.match(run.stderr, /obversa-review: (imports .* a file this scan did not import-scan|a host imports a local module outside its own host root)/, `${mutant.name}:\n${run.stderr}`);
      writeFileSync(command, original);
      rmSync(mutant.file, { force: true });
    }
    writeFileSync(command, `${original}\nimport { e } from "../lib/missing.mjs";\n`);
    const missing = guard();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /hosts\/cmux\/lib\/missing\.mjs, a file this scan did not import-scan/);
    writeFileSync(command, original);
    // Package indirection through the host manifest: an imports alias, a
    // self export, and an aliased dependency are each refused at the
    // manifest, and the alias specifiers are refused in the shipped script.
    const manifestPath = path.join(root, "hosts", "cmux", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const escape = path.join(root, "hosts", "cmux", "dist", "escape.mjs");
    mkdirSync(path.dirname(escape), { recursive: true });
    writeFileSync(escape, "export const e = eval;\n");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, imports: { "#escape": "./dist/escape.mjs" } }));
    writeFileSync(command, `${original}\nimport { e } from "#escape";\n`);
    const aliased = guard();
    assert.notEqual(aliased.status, 0);
    assert.match(aliased.stderr, /hosts\/cmux\/package\.json: a host manifest carries no imports/);
    assert.match(aliased.stderr, /obversa-review: a host imports through a package-imports alias \(#escape\)/);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, exports: { "./escape": "./dist/escape.mjs" } }));
    writeFileSync(command, `${original}\nimport { e } from "@obversa/cmux-host/escape";\n`);
    const selfExport = guard();
    assert.notEqual(selfExport.status, 0);
    assert.match(selfExport.stderr, /hosts\/cmux\/package\.json: a host manifest carries no exports/);
    assert.match(selfExport.stderr, /obversa-review: a host imports itself by package name/);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, escape: "file:./dist" } }));
    writeFileSync(command, original);
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
    assert.match(script.stderr, /hosts\/cmux\/package\.json: script test must be "node --test test\/\*\.test\.mjs"/);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // A nested manifest, under a host or a package, is refused whatever it
    // names itself.
    const nestedHost = path.join(root, "hosts", "cmux", "lib", "package.json");
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
    // Another spelling of a sibling package's path, on a disk that opens it.
    if (existsSync(path.join(root, "PACKAGES", "SURFACER", "src", "index.mjs"))) {
      const probe = path.join(root, "packages", "source", "src", "case-probe.mjs");
      writeFileSync(probe, 'import "../../SURFACER/src/index.mjs";\n');
      const spelled = guard();
      assert.notEqual(spelled.status, 0);
      assert.match(spelled.stderr, /case-probe\.mjs: .*by another spelling/);
      rmSync(probe);
    }
    // A workspace dependency on another host, with no exports map, would let
    // a bare subpath reach that host's unscanned dist.
    mkdirSync(path.join(root, "hosts", "payload", "dist"), { recursive: true });
    writeFileSync(path.join(root, "hosts", "payload", "package.json"), JSON.stringify({ name: "payload", private: true }));
    writeFileSync(path.join(root, "hosts", "payload", "dist", "escape.mjs"), "export const e = eval;\n");
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, payload: "workspace:*" } }));
    writeFileSync(command, `${original}\nimport { e } from "payload/dist/escape.mjs";\n`);
    const payload = guard();
    assert.notEqual(payload.status, 0);
    assert.match(payload.stderr, /hosts\/cmux\/package\.json: dependencies payload is "workspace:\*", a workspace range on something other than a ruled package/);
    assert.match(payload.stderr, /obversa-review: a host imports payload\/dist\/escape\.mjs, which its manifest does not declare/);
    assert.match(payload.stderr, /hosts\/payload: has no host rule/);
    rmSync(path.join(root, "hosts", "payload"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(command, original);
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
    assert.match(rogue.stderr, /hosts\/rogue\/run\.mjs: a host imports obversa\/escape, which its manifest does not declare/);
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
    // A node shebang carrying options loads code before any import: the
    // shebang of a host command is exactly #!/usr/bin/env node.
    for (const shebang of ["#!/usr/bin/env -S node --import=./packages/surfacer/src/index.mjs", "#!/usr/local/bin/node", "#!/usr/bin/env node --experimental-loader=./x.mjs", "#!/usr/bin/env node\r"]) {
      writeFileSync(command, `${shebang}\n${original.split("\n").slice(1).join("\n")}`);
      const bad = guard();
      assert.notEqual(bad.status, 0, shebang);
      assert.match(bad.stderr, /obversa-review: a host command's shebang is exactly #!\/usr\/bin\/env node/, shebang);
    }
    writeFileSync(command, original);
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

test("global is the same guarded root as globalThis: its evaluators and unlisted members are refused", () => {
  const file = "/repo/packages/source/src/a.mjs";
  for (const text of [
    'global.eval("process.getBuiltinModule");',
    'global.Function("return process")();',
    'const p = global.process.binding("fs");',
    'const g = global; g.eval("1");',
    'globalThis.eval("1");',
  ]) {
    assert.ok(extractObversaImports(text, { file, root: "/repo" }).length > 0, text);
  }
  // Listed data members stay usable through either name.
  assert.deepEqual(extractObversaImports('global.setTimeout(() => {}, 1); const e = global.process.env.X; globalThis.console.log(1);', { file, root: "/repo" }), []);
});

test("a package-imports alias of vm is refused, which closes a source import of the alias", () => {
  const file = "/repo/packages/source/package.json";
  for (const target of ["vm", "node:vm", "module", "node:module"]) {
    const found = manifestImportTargets({ imports: { "#x": target } }, { file, root: "/repo" });
    assert.equal(found.length, 1, target);
    assert.match(found[0], /alias the .* builtin/);
  }
  // The source side sees only the alias name; the manifest refusal is what
  // stops it, so the two are proved together: the import names nothing on
  // its own, and the manifest that would give it meaning is refused.
  assert.deepEqual(extractObversaImports('import vm from "#vm";', { file: "/repo/packages/source/src/a.mjs", root: "/repo" }), []);
  assert.equal(manifestImportTargets({ imports: { "#vm": "node:vm" } }, { file, root: "/repo" }).length, 1);
  assert.deepEqual(manifestImportTargets({ imports: { "#h": "./src/helper.mjs" } }, { file, root: "/repo" }), []);
  // An imports pattern substitutes the importer's text: `#escape` through
  // "#*": "./src/*.test.mjs" loads src/escape.test.mjs, and `#escape.test`
  // through "#*": "./src/*.mjs" does the same, with no test text at the
  // shipped edge. The pattern shape is refused whatever its suffix.
  assert.deepEqual(extractObversaImports('import { probe } from "#escape";', { file: "/repo/packages/source/src/a.mjs", root: "/repo" }), [], "the shipped import shows no test text");
  for (const pattern of ["./src/*.test.mjs", "./src/*.mjs", "./*", "./test/*"]) {
    const found = manifestImportTargets({ imports: { "#*": pattern } }, { file, root: "/repo" });
    assert.equal(found.length, 1, pattern);
    assert.match(found[0], /imports pattern .* list the aliases explicitly/, pattern);
  }
});

test("the workspace file pin refuses a missing or an extra glob, not only accepts the exact text", () => {
  assert.equal(isPinnedWorkspaceFile(PINNED_WORKSPACE_FILE), true);
  assert.equal(isPinnedWorkspaceFile("packages:\n  - packages/*\n  - hosts/*\n"), true);
  for (const text of [
    "packages:\n  - packages/*\n",
    "packages:\n  - packages/*\n  - hosts/*\n  - tools/*\n",
    "packages:\n  - hosts/*\n  - packages/*\n",
    "packages:\n  - packages/*\n  - hosts/*",
    "packages:\n  - packages/**\n  - hosts/*\n",
    "",
  ]) {
    assert.equal(isPinnedWorkspaceFile(text), false, JSON.stringify(text));
  }
});

test("a shipped import that an alias resolves to a test file, and an exports pattern that could expose one, are refused", () => {
  // A `paths` alias lands a shipped import on the package's own test file:
  // the compiler's resolution is the edge, refused before the same-package
  // skip.
  const file = "/repo/packages/source/src/a.ts";
  const host = fakeHost(tree({
    "/repo/packages/source/test/review.test.ts": "export const probe = process.getBuiltinModule('node:module');",
    "/repo/packages/source/test/review.test.mjs": "export const probe = process.getBuiltinModule('node:module');",
  }));
  const { options } = projectConfig('{ "compilerOptions": { "allowJs": true, "paths": { "#escape": ["test/review.test.ts"], "#escape-js": ["test/review.test.mjs"] } } }', { file: SOURCE, root: "/repo", host });
  for (const specifier of ["#escape", "#escape-js"]) {
    const found = extractObversaImports(`import { probe } from "${specifier}";`, { file, root: "/repo", configs: [options], host });
    assert.ok(found.some((entry) => /resolves to a test path/.test(entry)), `${specifier}: ${JSON.stringify(found)}`);
  }
  assert.deepEqual(extractObversaImports('import { probe } from "#escape";', { file: "/repo/packages/source/test/other.test.ts", root: "/repo", configs: [options], host }), [], "a test may reach a test");
  // An exports pattern would expose src/escape.test.mjs to any consumer with
  // no shipped source edge at all; the pattern shape is refused.
  const manifestFile = "/repo/packages/source/package.json";
  const withPattern = manifestPathTargets({ exports: { "./*": "./src/*.mjs" } }, { file: manifestFile, root: "/repo", host: fakeHost(tree({ "/repo/packages/source/src/escape.test.mjs": "" })) });
  assert.ok(withPattern.some((entry) => /exports pattern .* list the subpaths explicitly/.test(entry)), JSON.stringify(withPattern));
  assert.deepEqual(manifestPathTargets({ exports: { "./client": "./src/client.mjs" } }, { file: manifestFile, root: "/repo", host: fakeHost(tree({})) }), [], "an explicit subpath is placed as before");
});

test("a shipped entry cannot reach a test file, so the test file's loader-hatch exemption never ships", () => {
  // The probe: a test-named file inside src/ uses a loader hatch to reach a
  // sibling package; the file itself is exempt, and the shipped index imports
  // it by a same-package relative path. The finding lands on the shipped
  // edge, so the hatch has no route into the shipped graph.
  const escape = 'process.getBuiltinModule("node:module").createRequire(import.meta.url)("../../surfacer/src/index.mjs");';
  assert.equal(isTestPath("/repo/packages/source/src/escape.test.mjs"), true);
  assert.deepEqual(extractObversaImports(escape, { file: "/repo/packages/source/src/escape.test.mjs", root: "/repo" }), [], "the test-named file is exempt on its own");
  const shipped = extractObversaImports('import "./escape.test.mjs";', { file: "/repo/packages/source/src/index.mjs", root: "/repo" });
  assert.equal(shipped.length, 1);
  assert.match(shipped[0], /imports a test path/, "the shipped import of the test-named file is the finding");
  // Every static form of the edge: extensionless, a test directory, a
  // sibling package's test file by name, and a dynamic import string.
  for (const [file, text] of [
    ["/repo/packages/source/src/a.ts", 'import x from "./escape.test";'],
    ["/repo/packages/source/src/a.mjs", 'import "../test/helper.mjs";'],
    ["/repo/packages/source/src/a.mjs", 'import "../src/__tests__/c.mjs";'],
    ["/repo/packages/source/src/a.mjs", 'import "@obversa/memory/test/fixture.mjs";'],
    ["/repo/packages/source/src/a.mjs", 'await import("./escape.spec.mjs");'],
  ]) {
    const found = extractObversaImports(text, { file, root: "/repo" });
    assert.ok(found.some((entry) => /test path/.test(entry)), `${file}: ${text}`);
  }
  // A test importing another test is fine; a shipped testing subpath is not a test path.
  assert.deepEqual(extractObversaImports('import "./helper.test.mjs";', { file: "/repo/packages/source/test/a.test.mjs", root: "/repo" }), []);
  assert.deepEqual(extractObversaImports('import "./testing.js";', { file: "/repo/packages/source/src/a.mjs", root: "/repo" }), []);
  // Manifest entries are shipped entries too.
  const file = "/repo/packages/source/package.json";
  assert.ok(manifestPathTargets({ exports: { "./x": "./test/x.test.mjs" } }, { file, root: "/repo", host: fakeHost({}) }).some((entry) => /exports points at a test path/.test(entry)));
  assert.ok(manifestPathTargets({ main: "./src/index.spec.mjs" }, { file, root: "/repo", host: fakeHost({}) }).some((entry) => /main points at a test path/.test(entry)));
  assert.ok(manifestImportTargets({ imports: { "#h": "./test/h.mjs" } }, { file, root: "/repo" }).some((entry) => /alias a test path/.test(entry)));
  assert.deepEqual(manifestPathTargets({ main: "./src/index.mjs" }, { file, root: "/repo", host: fakeHost({}) }), []);
});

test("a test file is held to the arrow rules but not the loader-hatch rules", () => {
  const hatchy = 'Reflect.get(o, "k"); const c = x.constructor.constructor; eval("1"); process[k]; module.constructor; const { getBuiltinModule } = process; import vm from "node:vm";';
  for (const file of ["/repo/packages/source/test/a.test.mjs", "/repo/packages/lines/tests/b.spec.ts", "/repo/packages/x/src/__tests__/c.mjs", "/repo/packages/x/src/d.spec.mjs"]) {
    assert.deepEqual(extractObversaImports(hatchy, { file, root: "/repo" }), [], file);
    assert.deepEqual(extractObversaImports('import "@obversa/surfacer"; require("@obversa/memory");', { file, root: "/repo" }), ["@obversa/surfacer", "@obversa/memory"], `${file} still crosses`);
  }
  assert.ok(extractObversaImports(hatchy, { file: "/repo/packages/source/src/a.mjs", root: "/repo" }).length > 0, "shipped source is held to both");
  assert.equal(isTestPath("packages/source/src/review.mjs"), false);
  assert.equal(isTestPath("packages/source/src/testing.ts"), false, "a testing subpath is shipped source");
});

test("a specifier is read as the loader reads it: percent-encoding decoded, a file URL as its path, other schemes refused", () => {
  const file = "/repo/packages/source/src/review.mjs";
  const at = { file, root: "/repo" };
  assert.deepEqual(extractObversaImports('import "./%2e%2e/%2e%2e/surfacer/src/sanitize.mjs";', at), ["@obversa/surfacer"], "%2e%2e is ..");
  assert.deepEqual(extractObversaImports('import "../../%73urfacer/src/index.mjs";', at), ["@obversa/surfacer"], "an encoded letter");
  assert.deepEqual(extractObversaImports('import "file:///repo/packages/memory/src/index.ts";', at), ["@obversa/memory"], "a file URL");
  assert.deepEqual(extractObversaImports('import "file:///repo/packages/source/src/local.mjs";', at), [], "a file URL inside the package");
  assert.deepEqual(extractObversaImports('import "node:fs"; import "./local.mjs";', at), []);
  assert.deepEqual(extractObversaImports('import "data:text/javascript,export default 1";', at), [refusal("a data: URL specifier loads something the scan cannot place")]);
  assert.deepEqual(extractObversaImports('import "http://example.test/x.mjs";', at), [refusal("a http: URL specifier loads something the scan cannot place")]);
  assert.deepEqual(extractObversaImports('import "./%E0%A4%A";', at), [refusal("a percent-encoded specifier that does not decode: ./%E0%A4%A")]);
  assert.deepEqual(extractObversaImports('import "file://host/x";', at), [refusal("a file URL the loader cannot read: file://host/x")]);
  assert.deepEqual(extractObversaImports('import "/repo/packages/surfacer/src/index.mjs";', at), ["@obversa/surfacer"], "an absolute path");
});

test("a relative import that lands in another package names that package", () => {
  const file = "/repo/packages/source/src/review.mjs";
  const source = `
    import { runSurface } from "../../surfacer/src/index.mjs";
    const kit = require("../../surfacer/src/client.mjs");
    const lazy = () => import("../../memory/dist/index.js");
    import ok from "../lib/helper.mjs";
  `;
  // The same-package import names nothing; a same-package import of a test
  // path is a different case, refused, and covered above. A path into a
  // sibling's dist is build output the scan never reads: refused, not named.
  assert.deepEqual(extractObversaImports(source, { file, root: "/repo" }), ["@obversa/surfacer", "@obversa/surfacer", refusal("../../memory/dist/index.js imports build output under dist, which the scan does not read; import a source file")]);
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
