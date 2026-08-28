import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ACORN_VERSION, navIndex } from "../src/navindex.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function byName(occurrences, name) {
  return occurrences.filter((item) => item.name === name);
}

function at(occurrences, line, col) {
  return occurrences.find((item) => item.line === line && item.col === col);
}

test("pins acorn 8.18.0", () => {
  assert.equal(ACORN_VERSION, "8.18.0");
});

test("module loads without crashing", () => {
  const result = spawnSync(process.execPath, ["-e", "import('../src/navindex.mjs')"], {
    cwd: here,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});

test("return shape is only occurrences", () => {
  const result = navIndex({ code: "const x = 1;", lang: "javascript" });
  assert.deepEqual(Object.keys(result), ["occurrences"]);
});

test("unknown lang returns an empty index", () => {
  assert.deepEqual(navIndex({ code: "function read() {}", lang: "python" }), { occurrences: [] });
});

test("function def and call resolve to the same site", () => {
  const code = "function read(x) {\n  return x;\n}\nread(1);\n";
  const { occurrences } = navIndex({ code, lang: "js" });
  const def = at(occurrences, 1, 9);
  assert.equal(def.name, "read");
  assert.equal(def.kind, "function");
  assert.equal(def.isDef, true);
  assert.deepEqual(def.def, { line: 1, col: 9 });
  const call = at(occurrences, 4, 0);
  assert.equal(call.name, "read");
  assert.equal(call.isDef, false);
  assert.deepEqual(call.def, { line: 1, col: 9 });
  const param = at(occurrences, 1, 14);
  assert.equal(param.name, "x");
  assert.equal(param.kind, "parameter");
  const use = at(occurrences, 2, 9);
  assert.deepEqual(use.def, { line: 1, col: 14 });
});

test("nested same-name functions resolve by scope", () => {
  const code = "function read() { return 1; }\nfunction outer() {\n  function read() { return 2; }\n  return read();\n}\nread();\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  const outerCall = at(occurrences, 4, 9);
  assert.deepEqual(outerCall.def, { line: 3, col: 11 });
  const topCall = at(occurrences, 6, 0);
  assert.deepEqual(topCall.def, { line: 1, col: 9 });
});

test("a block-scoped declaration shadows only inside its block", () => {
  const code = "const value = 1;\n{\n  const value = 2;\n  value;\n}\nvalue;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 4, 2).def, { line: 3, col: 8 }, "inside the block: the inner declaration");
  assert.deepEqual(at(occurrences, 6, 0).def, { line: 1, col: 6 }, "after the block: the outer declaration");
});

test("var hoists out of a block; let and const do not", () => {
  const code = "{\n  var hoisted = 1;\n  let scoped = 2;\n}\nhoisted;\nscoped;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 5, 0).def, { line: 2, col: 6 }, "var is visible after the block");
  assert.equal(at(occurrences, 6, 0).def, null, "let is not");
});

test("a var declared by a for-of, for-in, or for loop is visible after the loop; let is not", () => {
  const code = "for (var x of [1]) {}\nx;\nfor (var y in { a: 1 }) {}\ny;\nfor (var i = 0; i < 1; i += 1) {}\ni;\nfor (const z of [1]) {}\nz;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 2, 0).def, { line: 1, col: 9 }, "for-of var");
  assert.deepEqual(at(occurrences, 4, 0).def, { line: 3, col: 9 }, "for-in var");
  assert.deepEqual(at(occurrences, 6, 0).def, { line: 5, col: 9 }, "for var");
  assert.equal(at(occurrences, 8, 0).def, null, "for-of const stays in the loop");
});

test("a block's let and const bind for the whole block: an early use or a closure belongs to the inner declaration", () => {
  const code = "let x = 0;\n{\n  x;\n  const read = () => x;\n  let x = 1;\n  x;\n}\nx;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 3, 2).def, { line: 5, col: 6 }, "a use before the inner declaration is the inner binding (a TDZ at run time)");
  assert.deepEqual(at(occurrences, 4, 21).def, { line: 5, col: 6 }, "a closure created before the declaration binds to it");
  assert.deepEqual(at(occurrences, 6, 2).def, { line: 5, col: 6 });
  assert.deepEqual(at(occurrences, 8, 0).def, { line: 1, col: 4 }, "after the block: the outer binding");
  // Destructured and switch-wide declarations hoist the same way.
  const more = "let a = 0;\n{\n  a;\n  const { a } = { a: 1 };\n}\nswitch (a) {\n  case 0:\n    a;\n    let a = 2;\n}\n";
  const second = navIndex({ code: more, lang: "javascript" }).occurrences;
  assert.deepEqual(at(second, 3, 2).def, { line: 4, col: 10 }, "a destructured const binds for the whole block");
  assert.deepEqual(at(second, 8, 4).def, { line: 9, col: 8 }, "a switch-wide let binds for every case");
});

test("var binds for the whole function, even before its declaration; a class static block owns its var", () => {
  const code = "function f() {\n  x;\n  if (true) { var x = 1; }\n  return x;\n}\nx;\nclass C {\n  static {\n    var hidden = 1;\n  }\n}\nhidden;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 2, 2).def, { line: 3, col: 18 }, "a use before the var binds to it");
  assert.deepEqual(at(occurrences, 4, 9).def, { line: 3, col: 18 });
  assert.equal(at(occurrences, 6, 0).def, null, "not visible outside the function");
  assert.equal(at(occurrences, 12, 0).def, null, "a static block's var is not visible outside it");
  const inCase = "let x = 0;\nswitch (1) {\n  case 1:\n    x;\n    break;\n  case 2:\n    let x = 2;\n}\n";
  const cases = navIndex({ code: inCase, lang: "javascript" }).occurrences;
  assert.deepEqual(at(cases, 4, 4).def, { line: 7, col: 8 }, "an earlier case sees the switch-wide let");
});

test("a for-of or for-in over an existing variable references it; the loop head is not a new definition", () => {
  const code = "let x;\nfor (x of [1]) { x; }\nx;\nlet y;\nfor (y in { a: 1 }) { y; }\ny;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  const head = at(occurrences, 2, 5);
  assert.equal(head.isDef, false, "the loop head assigns to the existing binding");
  assert.deepEqual(head.def, { line: 1, col: 4 });
  assert.deepEqual(at(occurrences, 2, 17).def, { line: 1, col: 4 }, "the body reads the same binding");
  assert.deepEqual(at(occurrences, 3, 0).def, { line: 1, col: 4 });
  assert.equal(at(occurrences, 5, 5).isDef, false);
  assert.deepEqual(at(occurrences, 5, 5).def, { line: 4, col: 4 });
  assert.deepEqual(at(occurrences, 6, 0).def, { line: 4, col: 4 });
});

test("switch cases share one block scope, separate from the outer one", () => {
  const code = "let n = 1;\nswitch (n) {\n  case 1:\n    let n2 = 2;\n    n2;\n}\nn;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 5, 4).def, { line: 4, col: 8 });
  assert.deepEqual(at(occurrences, 7, 0).def, { line: 1, col: 4 });
});

test("parameter is not visible outside the function", () => {
  const code = "function f(x) { return x; }\nx;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  const inner = at(occurrences, 1, 23);
  assert.deepEqual(inner.def, { line: 1, col: 11 });
  const outer = at(occurrences, 2, 0);
  assert.equal(outer.def, null);
});

test("import alias is the local def", () => {
  const code = 'import { foo as bar } from "m";\nbar;\n';
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.equal(byName(occurrences, "foo").length, 0);
  const def = byName(occurrences, "bar").find((item) => item.kind === "import");
  assert.deepEqual(def.def, { line: 1, col: 16 });
  const use = at(occurrences, 2, 0);
  assert.deepEqual(use.def, { line: 1, col: 16 });
});

test("class method click jumps to the method name", () => {
  const code = "class C {\n  method(x) { return this.method(x); }\n}\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  const def = at(occurrences, 2, 2);
  assert.equal(def.kind, "method");
  const prop = at(occurrences, 2, 26);
  assert.equal(prop.kind, "property");
  assert.deepEqual(prop.def, { line: 2, col: 2 });
});

test("UTF-16 columns for non-ascii names", () => {
  const code = "const café = 1;\ncafé;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  const def = at(occurrences, 1, 6);
  assert.equal(def.name, "café");
  assert.equal(def.endCol, 10);
  const use = at(occurrences, 2, 0);
  assert.deepEqual(use.def, { line: 1, col: 6 });
});

test("lines are 1-indexed", () => {
  const { occurrences } = navIndex({ code: "const x = 1;", lang: "javascript" });
  assert.equal(occurrences[0].line, 1);
});

test("does not instantiate WebAssembly", () => {
  let wasmCalls = 0;
  const instantiate = WebAssembly.instantiate.bind(WebAssembly);
  WebAssembly.instantiate = (...args) => {
    wasmCalls += 1;
    return instantiate(...args);
  };
  try {
    navIndex({ code: "function read() { return 1; }", lang: "javascript" });
    assert.equal(wasmCalls, 0);
  } finally {
    WebAssembly.instantiate = instantiate;
  }
});

test("module is pure JS, not native tree-sitter or wasm", () => {
  const source = readFileSync(join(here, "..", "src", "navindex.mjs"), "utf8");
  assert.match(source, /from "acorn"/);
  assert.doesNotMatch(source, /tree-sitter/);
  assert.doesNotMatch(source, /\.wasm/);
  assert.doesNotMatch(source, /web-tree-sitter/);
});
