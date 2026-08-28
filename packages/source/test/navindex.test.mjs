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

test("a named function expression's name is visible only inside itself", () => {
  const code = "const f = function inner() { return inner; };\ninner;\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 1, 36).def, { line: 1, col: 19 }, "the body sees the name");
  assert.equal(at(occurrences, 2, 0).def, null, "the outer use does not");
});

test("expressions inside patterns are indexed: parameter defaults, computed keys, binding defaults, catch and loop patterns", () => {
  const code = "const base = 1;\nfunction f(arg = base) {}\nconst { [base]: value = base } = {};\ntry {} catch ({ message = base }) {}\nfor (const [item = base] of []) {}\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  const def = { line: 1, col: 6 };
  assert.deepEqual(at(occurrences, 2, 17).def, def, "a parameter default");
  assert.deepEqual(at(occurrences, 3, 9).def, def, "a computed destructuring key");
  assert.deepEqual(at(occurrences, 3, 24).def, def, "a binding default");
  assert.deepEqual(at(occurrences, 4, 26).def, def, "a catch pattern default");
  assert.deepEqual(at(occurrences, 5, 19).def, def, "a loop pattern default");
  // A parameter default sees an earlier parameter.
  const params = navIndex({ code: "function g(a, b = a) {}\n", lang: "javascript" }).occurrences;
  assert.deepEqual(at(params, 1, 18).def, { line: 1, col: 11 });
});

test("an import binds for the whole module, whatever line it sits on", () => {
  const code = "foo();\nimport { foo } from \"./dep.js\";\nfoo();\nbar();\nimport bar from \"./b.js\";\nns.x;\nimport * as ns from \"./n.js\";\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 1, 0).def, { line: 2, col: 9 }, "a named import used above it");
  assert.deepEqual(at(occurrences, 3, 0).def, { line: 2, col: 9 });
  assert.deepEqual(at(occurrences, 4, 0).def, { line: 5, col: 7 }, "a default import used above it");
  assert.deepEqual(at(occurrences, 6, 0).def, { line: 7, col: 12 }, "a namespace import used above it");
  assert.equal(occurrences.filter((o) => o.name === "foo" && o.isDef).length, 1, "one definition occurrence");
});

test("a class member exists whatever its position: a method may call one declared below it", () => {
  const code = "class C {\n  first() { return this.second(); }\n  second() { return 2; }\n  static third = this.fourth;\n  static fourth = 4;\n}\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 2, 24).def, { line: 3, col: 2 }, "this.second() before second is declared");
  assert.deepEqual(at(occurrences, 4, 22).def, { line: 5, col: 9 }, "a static field read before it is declared");
  assert.equal(occurrences.filter((o) => o.name === "second" && o.isDef).length, 1, "one definition occurrence");
  assert.equal(occurrences.filter((o) => o.name === "fourth" && o.isDef).length, 1);
});

test("only this.member links to a class member; another receiver, or this inside a nested function, stays unresolved", () => {
  const code = "class C {\n  method() {}\n  run(other) { return other.method(); }\n  go() { return this.method(); }\n}\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.equal(at(occurrences, 3, 28).def, null, "other.method is not C.method");
  assert.deepEqual(at(occurrences, 4, 21).def, { line: 2, col: 2 }, "this.method is");
  const nested = "class D {\n  m() {}\n  n() {\n    function f() { return this.m(); }\n    return () => this.m();\n  }\n}\n";
  const inner = navIndex({ code: nested, lang: "javascript" }).occurrences;
  assert.equal(at(inner, 4, 31).def, null, "a nested function rebinds this");
  assert.deepEqual(at(inner, 5, 22).def, { line: 2, col: 2 }, "an arrow keeps it");
});

test("class members resolve by context: static or instance, unique only, super and computed keys never", () => {
  const code = [
    "class A {",
    "  static foo() {}",
    "  foo() {}",
    "  bar() { return this.foo(); }",
    "  static baz() { return this.foo(); }",
    "  get pair() { return 1; }",
    "  set pair(v) {}",
    "  use() { return this.pair; }",
    "  sup() { return super.foo(); }",
    "  nest() { class B { inner() {} go() { return this.inner(); } } return this.inner; }",
    "  field = this.foo;",
    "  static sfield = this.foo;",
    "}",
    "",
  ].join("\n");
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 4, 22).def, { line: 3, col: 2 }, "instance this.foo is the instance member");
  assert.deepEqual(at(occurrences, 5, 29).def, { line: 2, col: 9 }, "static this.foo is the static member");
  assert.equal(at(occurrences, 8, 22).def, null, "a getter/setter pair is ambiguous");
  assert.equal(at(occurrences, 9, 23).def, null, "super.foo is the parent's");
  assert.deepEqual(at(occurrences, 10, 51).def, { line: 10, col: 21 }, "a nested class's this is its own");
  assert.equal(at(occurrences, 10, 76).def, null, "the outer class has no inner");
  assert.deepEqual(at(occurrences, 11, 15).def, { line: 3, col: 2 }, "an instance field initialiser sees the instance");
  assert.deepEqual(at(occurrences, 12, 23).def, { line: 2, col: 9 }, "a static field initialiser sees the class");
  // A computed key evaluates outside the class: at the top level, this is unknown.
  const computed = navIndex({ code: "class G {\n  [this.foo]() {}\n}\n", lang: "javascript" }).occurrences;
  assert.equal(at(computed, 2, 8).def, null, "a computed key evaluates outside the class");
});

test("string-keyed members count, a dynamic computed key fails its side closed, and a computed duplicate is ambiguous", () => {
  const ambiguous = navIndex({ code: 'class C { foo() {} ["foo"]() {} call() { return this.foo(); } }\n', lang: "javascript" }).occurrences;
  assert.equal(at(ambiguous, 1, 53).def, null, "a later computed foo replaces the first at run time: ambiguous");
  const literal = navIndex({ code: 'class D { ["bar"]() {} call() { return this.bar(); } }\n', lang: "javascript" }).occurrences;
  assert.deepEqual(at(literal, 1, 44).def, { line: 1, col: 11 }, "a bracketed string key is a known member");
  const quoted = navIndex({ code: 'class F { "q"() {} go() { return this.q(); } }\n', lang: "javascript" }).occurrences;
  assert.deepEqual(at(quoted, 1, 38).def, { line: 1, col: 10 }, "a quoted key is a known member");
  // A numeric key, plain or in brackets, names only its own number: it cannot
  // replace a dot name, so it neither collides nor closes the side.
  const numeric = navIndex({ code: "class B { foo() {} [1]() {} go() { return this.foo(); } }\n", lang: "javascript" }).occurrences;
  assert.deepEqual(at(numeric, 1, 47).def, { line: 1, col: 10 }, "a computed numeric key leaves the side open");
  const bigint = navIndex({ code: "class H { foo() {} [1n]() {} 2() {} go() { return this.foo(); } }\n", lang: "javascript" }).occurrences;
  assert.deepEqual(at(bigint, 1, 55).def, { line: 1, col: 10 }, "a bigint or plain numeric key too");
  // A boolean or null literal in brackets defines a dot-reachable name.
  const bool = navIndex({ code: "class I { true() {} [true]() {} go() { return this.true(); } }\n", lang: "javascript" }).occurrences;
  assert.equal(at(bool, 1, 51).def, null, "[true] replaces the plain true at run time: ambiguous");
  const nul = navIndex({ code: "class J { [null]() {} go() { return this.null(); } }\n", lang: "javascript" }).occurrences;
  assert.deepEqual(at(nul, 1, 41).def, { line: 1, col: 11 }, "[null] alone is the member this.null reaches");
  const dynamic = navIndex({ code: "class E { [key]() {} x() {} go() { return this.x(); } static s() {} static gs() { return this.s(); } }\n", lang: "javascript" }).occurrences;
  assert.equal(at(dynamic, 1, 47).def, null, "a dynamic computed key on the instance side: no instance name is known unique");
  assert.deepEqual(at(dynamic, 1, 94).def, { line: 1, col: 61 }, "the static side is untouched");
});

test("a re-export from another module names nothing local, and export { foo } is one use", () => {
  const code = "const foo = 1;\nexport { foo as bar } from \"./dep.js\";\nexport { foo };\nexport * from \"./all.js\";\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.equal(at(occurrences, 2, 9), undefined, "the re-exported name is not the local foo");
  const uses = occurrences.filter((o) => o.name === "foo" && !o.isDef);
  assert.equal(uses.length, 1, "export { foo } is exactly one use");
  assert.deepEqual(uses[0].def, { line: 1, col: 6 });
  assert.deepEqual([uses[0].line, uses[0].col], [3, 9]);
});

test("a class's heritage is a use: extends Base is indexed in the right scope", () => {
  const code = "class Base {}\nclass Child extends Base {}\nconst E = class Inner extends Base {};\n";
  const { occurrences } = navIndex({ code, lang: "javascript" });
  assert.deepEqual(at(occurrences, 2, 20).def, { line: 1, col: 6 }, "a declaration's heritage");
  assert.deepEqual(at(occurrences, 3, 30).def, { line: 1, col: 6 }, "a named expression's heritage");
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
