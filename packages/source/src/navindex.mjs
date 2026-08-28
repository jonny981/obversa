// Server-side go-to-source index for the review surface.
// Parses with acorn (pure JS). The browser receives only the JSON map.
// No native bindings, no WASM, no client-side parse, so script-src 'self' holds.

import { createRequire } from "node:module";
import { Parser } from "acorn";

const require = createRequire(import.meta.url);
export const ACORN_VERSION = require("acorn/package.json").version;

const JS_LANGS = new Set(["javascript", "js", "cjs", "mjs", "jsx"]);
const FUNCTION_VALUES = new Set([
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const PARSE_OPTIONS = {
  ecmaVersion: "latest",
  locations: true,
  ranges: true,
  allowHashBang: true,
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
};

function parse(code) {
  try {
    return Parser.parse(code, { ...PARSE_OPTIONS, sourceType: "module" });
  } catch {
    try {
      return Parser.parse(code, { ...PARSE_OPTIONS, sourceType: "script" });
    } catch {
      return null;
    }
  }
}

// A scope. Function scopes (the program and every function body) are where
// `var` lands; blocks, for statements, switches, and catch clauses hold only their
// lexical declarations, so a `let` or `const` inside a block never shadows the
// outer binding for code after the block.
// `thisClass` is what `this` means here: null when unknown, or the enclosing
// class's member maps plus whether the context is static. A scope inherits
// its parent's unless told otherwise: an arrow inherits, a normal function
// clears it, a class member or static block sets its own class, and a nested
// class therefore replaces the outer one.
function pushScope(parent, { isFunction = false, thisClass } = {}) {
  return {
    parent,
    defs: new Map(),
    isFunction,
    thisClass: thisClass !== undefined ? thisClass : (parent?.thisClass ?? null),
  };
}

function functionScope(scope) {
  let current = scope;
  while (current && !current.isFunction) current = current.parent;
  return current ?? scope;
}

function lookup(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const found = current.defs.get(name);
    if (found) return found;
  }
  return null;
}

// `this.name` resolves only under a known class context, in that class's
// static or instance members as the context says, and only when the name is
// unique there: a duplicate, a getter/setter pair, or a field and a method of
// the same name is ambiguous and fails closed.
function lookupMember(thisClass, name) {
  if (!thisClass) return null;
  const side = thisClass.isStatic ? "static" : "instance";
  // A computed key nobody can read statically may define any name on its
  // side, so no name on that side is known to be unique.
  if (thisClass.members.dynamic[side]) return null;
  const entry = thisClass.members[side].get(name);
  return entry && !entry.ambiguous ? entry : null;
}

function occurrence(id, kind, def) {
  const line = id.loc.start.line;
  const col = id.loc.start.column;
  return {
    line,
    col,
    endCol: id.loc.end.column,
    name: id.name,
    kind,
    isDef: Boolean(def && def.line === line && def.col === col),
    def,
  };
}

function registerDef(scope, id, kind, occurrences, seenDefs) {
  if (!id || id.type !== "Identifier") return scope.defs.get(id?.name);
  if (seenDefs.has(id.start)) return scope.defs.get(id.name);
  seenDefs.add(id.start);
  const def = { line: id.loc.start.line, col: id.loc.start.column };
  const record = { ...def, kind };
  scope.defs.set(id.name, record);
  occurrences.push(occurrence(id, kind, def));
  return record;
}

function registerPattern(node, scope, kind, occurrences, seenDefs) {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      registerDef(scope, node, kind, occurrences, seenDefs);
      return;
    case "ObjectPattern":
      for (const prop of node.properties) {
        if (prop.type === "RestElement") {
          registerPattern(prop.argument, scope, kind, occurrences, seenDefs);
        } else if (prop.type === "Property") {
          registerPattern(prop.value, scope, kind, occurrences, seenDefs);
        }
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements) {
        registerPattern(element, scope, kind, occurrences, seenDefs);
      }
      return;
    case "AssignmentPattern":
      registerPattern(node.left, scope, kind, occurrences, seenDefs);
      return;
    case "RestElement":
      registerPattern(node.argument, scope, kind, occurrences, seenDefs);
  }
}

function unwrapExport(node) {
  if (
    node.type === "ExportNamedDeclaration"
    || node.type === "ExportDefaultDeclaration"
  ) {
    return node.declaration ? [node.declaration] : [];
  }
  return [node];
}

// Register every declaration a scope owns before any of its statements is
// walked. Functions and classes are hoisted, and so — for identity — are
// let and const: a use earlier in the block, or a closure created before the
// declaration, binds to the block's own declaration (a temporal dead zone at
// run time, but the same binding), not to an outer one of the same name.
function hoist(body, scope, occurrences, seenDefs) {
  for (const stmt of body) {
    for (const child of unwrapExport(stmt)) {
      if (child.type === "FunctionDeclaration" && child.id) {
        registerDef(scope, child.id, "function", occurrences, seenDefs);
      }
      if (child.type === "ClassDeclaration" && child.id) {
        registerDef(scope, child.id, "class", occurrences, seenDefs);
      }
      if (child.type === "VariableDeclaration" && child.kind !== "var") {
        for (const decl of child.declarations) {
          const kind = decl.init && FUNCTION_VALUES.has(decl.init.type) ? "function" : "variable";
          registerPattern(decl.id, scope, kind, occurrences, seenDefs);
        }
      }
      // An import is a module binding from instantiation, whatever line it
      // sits on: a use above the import statement still binds to it.
      if (child.type === "ImportDeclaration") {
        registerImports(child, scope, occurrences, seenDefs);
      }
    }
  }
}

function registerImports(node, scope, occurrences, seenDefs) {
  for (const spec of node.specifiers) {
    if (
      spec.type === "ImportSpecifier"
      || spec.type === "ImportDefaultSpecifier"
      || spec.type === "ImportNamespaceSpecifier"
    ) {
      registerDef(scope, spec.local, "import", occurrences, seenDefs);
    }
  }
}

// A class member exists whatever its position in the body: register every
// non-computed method and property key before any member value is walked,
// so a method body may name a member declared below it. Static and instance
// members are kept apart; a second member of the same name in the same map
// (a getter and a setter, a field and a method) makes that name ambiguous.
// The name a member key defines. Any primitive literal, plain or in brackets,
// defines the property named by its String value: a string its text, `true`
// or `null` that word (which `this.true` reaches, since a reserved word is a
// valid identifier name after a dot), a number its canonical form — "1" for
// `[1]`, which no dot name reaches and so collides with nothing, but
// "Infinity" for `[1e999]`, which does collide with a member named Infinity.
// A RegExp literal is an object, not a primitive, and its string form is
// whatever RegExp.prototype.toString says, so it is dynamic (undefined), as
// is any other computed key that is not a fixed literal. A private key is
// not reachable (null).
function memberName(node) {
  const { key } = node;
  if (!key) return null;
  if (key.type === "Literal") {
    if (key.regex) return undefined;
    return String(key.value);
  }
  // A template with no substitutions is a fixed string too; one with
  // substitutions, or an invalid escape (no cooked value), is dynamic.
  if (key.type === "TemplateLiteral" && key.expressions.length === 0) {
    const cooked = key.quasis[0]?.value.cooked;
    return typeof cooked === "string" ? cooked : undefined;
  }
  if (!node.computed) return key.type === "Identifier" ? key.name : null;
  return undefined;
}

function registerMember(node, members, occurrences, seenDefs) {
  const side = node.static ? "static" : "instance";
  const name = memberName(node);
  if (name === undefined) {
    // `[key]() {}` may replace any member on this side at run time.
    members.dynamic[side] = true;
    return;
  }
  if (name === null || seenDefs.has(node.key.start)) return;
  const def = { line: node.key.loc.start.line, col: node.key.loc.start.column };
  seenDefs.add(node.key.start);
  const bucket = members[side];
  const existing = bucket.get(name);
  if (existing) existing.ambiguous = true;
  else bucket.set(name, { ...def, kind: "method", ambiguous: false });
  if (node.key.type === "Identifier") occurrences.push(occurrence(node.key, "method", def));
}

// `var` declarations belong to the whole function: a use earlier in the
// function than the declaration binds to it. Scan the function body for var
// declarations at any depth, stopping at nested functions and classes, which
// own their own.
function hoistVars(node, scope, occurrences, seenDefs) {
  if (!node || typeof node !== "object" || !node.type) return;
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return;
    case "VariableDeclaration":
      if (node.kind === "var") {
        for (const decl of node.declarations) {
          const kind = decl.init && FUNCTION_VALUES.has(decl.init.type) ? "function" : "variable";
          registerPattern(decl.id, scope, kind, occurrences, seenDefs);
        }
      }
      return;
    default:
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) hoistVars(item, scope, occurrences, seenDefs);
        } else if (value && typeof value === "object" && value.type) {
          hoistVars(value, scope, occurrences, seenDefs);
        }
      }
  }
}

function inferKind(node, parent) {
  if (!parent) return "variable";
  if (parent.type === "CallExpression" && parent.callee === node) return "function";
  if (parent.type === "NewExpression" && parent.callee === node) return "class";
  return "variable";
}

function emitRef(id, parent, scope, occurrences, seenDefs) {
  if (seenDefs.has(id.start)) return;
  const found = lookup(scope, id.name);
  occurrences.push(occurrence(
    id,
    found?.kind ?? inferKind(id, parent),
    found ? { line: found.line, col: found.col } : null,
  ));
}

// A property access. Only `this.name` can be linked to a class member — a
// member definition says nothing about an arbitrary receiver's `name`, and
// `super.name` names the parent's — so any other receiver leaves the
// property unresolved.
function emitProperty(id, thisClass, occurrences) {
  const found = lookupMember(thisClass, id.name);
  occurrences.push(occurrence(
    id,
    "property",
    found ? { line: found.line, col: found.col } : null,
  ));
}

function walkFunction(node, scope, occurrences, seenDefs, { namedInner = false, thisClass } = {}) {
  // An arrow keeps the `this` around it; a normal function has its own,
  // unknown here unless it is a class member, whose class the caller names.
  const inner = pushScope(scope, {
    isFunction: true,
    thisClass: node.type === "ArrowFunctionExpression" ? undefined : (thisClass ?? null),
  });
  // A named function expression's name is visible only inside itself.
  if (namedInner && node.id) {
    registerDef(inner, node.id, "function", occurrences, seenDefs);
  }
  // Every parameter binding first, then the expressions inside the
  // parameters (defaults, computed keys), which see every parameter.
  for (const param of node.params ?? []) {
    registerPattern(param, inner, "parameter", occurrences, seenDefs);
  }
  for (const param of node.params ?? []) {
    walkPatternExpressions(param, inner, occurrences, seenDefs);
  }
  hoistVars(node.body, inner, occurrences, seenDefs);
  if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
}

// The expressions a binding pattern contains — a default value, a computed
// key — are uses like any other and must be indexed. Walked after the
// pattern's bindings are registered, in the scope those bindings live in.
function walkPatternExpressions(node, scope, occurrences, seenDefs) {
  if (!node) return;
  switch (node.type) {
    case "ObjectPattern":
      for (const prop of node.properties) {
        if (prop.type === "RestElement") {
          walkPatternExpressions(prop.argument, scope, occurrences, seenDefs);
        } else if (prop.type === "Property") {
          if (prop.computed) walk(prop.key, scope, occurrences, seenDefs, prop);
          walkPatternExpressions(prop.value, scope, occurrences, seenDefs);
        }
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements) {
        walkPatternExpressions(element, scope, occurrences, seenDefs);
      }
      return;
    case "AssignmentPattern":
      walkPatternExpressions(node.left, scope, occurrences, seenDefs);
      walk(node.right, scope, occurrences, seenDefs, node);
      return;
    case "RestElement":
      walkPatternExpressions(node.argument, scope, occurrences, seenDefs);
      return;
    default:
      return;
  }
}

function walk(node, scope, occurrences, seenDefs, parent = null) {
  if (!node || typeof node !== "object" || !node.type) return;

  switch (node.type) {
    case "Program":
      hoistVars(node, scope, occurrences, seenDefs);
      hoist(node.body, scope, occurrences, seenDefs);
      for (const child of node.body) walk(child, scope, occurrences, seenDefs, node);
      return;
    case "StaticBlock": {
      // A class static block owns its `var` like a function does, and its
      // `this` is the class.
      const inner = pushScope(scope, { isFunction: true, thisClass: { members: scope.members, isStatic: true } });
      hoistVars(node, inner, occurrences, seenDefs);
      hoist(node.body, inner, occurrences, seenDefs);
      for (const child of node.body) walk(child, inner, occurrences, seenDefs, node);
      return;
    }
    case "BlockStatement": {
      // A block's own lexical scope: declarations inside it are not visible
      // after it, so a use after the block resolves to the outer binding.
      // (A function body is walked here too, inside the function scope
      // walkFunction pushed; its declarations then sit one level in, which
      // is still invisible from outside the function.)
      const inner = pushScope(scope);
      hoist(node.body, inner, occurrences, seenDefs);
      for (const child of node.body) walk(child, inner, occurrences, seenDefs, node);
      return;
    }
    case "SwitchStatement": {
      // All cases share one block scope.
      const inner = pushScope(scope);
      if (node.discriminant) walk(node.discriminant, scope, occurrences, seenDefs, node);
      hoist(node.cases.flatMap((entry) => entry.consequent), inner, occurrences, seenDefs);
      for (const entry of node.cases) {
        if (entry.test) walk(entry.test, inner, occurrences, seenDefs, entry);
        for (const child of entry.consequent) walk(child, inner, occurrences, seenDefs, entry);
      }
      return;
    }
    case "FunctionDeclaration":
      walkFunction(node, scope, occurrences, seenDefs);
      return;
    case "FunctionExpression":
      walkFunction(node, scope, occurrences, seenDefs, { namedInner: true });
      return;
    case "ArrowFunctionExpression":
      walkFunction(node, scope, occurrences, seenDefs);
      return;
    case "ClassDeclaration":
    case "ClassExpression": {
      // The class scope keeps the surrounding `this` (heritage and computed
      // keys evaluate there); members set their own below.
      const inner = pushScope(scope);
      inner.members = { static: new Map(), instance: new Map(), dynamic: { static: false, instance: false } };
      if (node.type === "ClassExpression" && node.id) {
        registerDef(inner, node.id, "class", occurrences, seenDefs);
      }
      // `extends Base` is a use. A declaration's heritage sees the surrounding
      // scope (where its own hoisted name already is); a named expression's
      // heritage sees its private name too (in a temporal dead zone at run
      // time, but the same binding).
      if (node.superClass) walk(node.superClass, inner, occurrences, seenDefs, node);
      if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
      return;
    }
    case "ClassBody":
      for (const child of node.body) {
        if (child.type === "MethodDefinition" || child.type === "PropertyDefinition") {
          registerMember(child, scope.members, occurrences, seenDefs);
        }
      }
      for (const child of node.body) walk(child, scope, occurrences, seenDefs, node);
      return;
    case "MethodDefinition":
    case "PropertyDefinition": {
      // A computed key evaluates in the surrounding context, not the class's.
      if (node.computed && node.key) walk(node.key, scope, occurrences, seenDefs, node);
      const thisClass = { members: scope.members, isStatic: Boolean(node.static) };
      if (!node.value) return;
      if (node.type === "MethodDefinition") {
        walkFunction(node.value, scope, occurrences, seenDefs, { thisClass });
      } else {
        // A field initialiser runs with `this` as the instance (or the class).
        walk(node.value, pushScope(scope, { thisClass }), occurrences, seenDefs, node);
      }
      return;
    }
    case "VariableDeclaration":
      for (const child of node.declarations) walk(child, scope, occurrences, seenDefs, node);
      return;
    case "VariableDeclarator": {
      const kind = node.init && FUNCTION_VALUES.has(node.init.type) ? "function" : "variable";
      // `var` belongs to the enclosing function scope wherever it is written;
      // `let` and `const` belong to the block they are written in.
      const target = parent?.kind === "var" ? functionScope(scope) : scope;
      registerPattern(node.id, target, kind, occurrences, seenDefs);
      walkPatternExpressions(node.id, scope, occurrences, seenDefs);
      if (node.init) walk(node.init, scope, occurrences, seenDefs, node);
      return;
    }
    case "ImportDeclaration":
      registerImports(node, scope, occurrences, seenDefs); // already registered by hoist; a no-op
      return;
    case "ExportNamedDeclaration":
      if (node.declaration) {
        walk(node.declaration, scope, occurrences, seenDefs, node);
        return;
      }
      // `export { a as b } from "./dep.js"` names another module's bindings;
      // nothing in it is local. `export { foo }` is one use of the local foo —
      // its exported name is the same identifier, not a second use.
      if (node.source) return;
      for (const spec of node.specifiers) {
        if (spec.local?.type === "Identifier") emitRef(spec.local, spec, scope, occurrences, seenDefs);
      }
      return;
    case "ExportAllDeclaration":
      return;
    case "CatchClause": {
      const inner = pushScope(scope);
      registerPattern(node.param, inner, "parameter", occurrences, seenDefs);
      walkPatternExpressions(node.param, inner, occurrences, seenDefs);
      if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const inner = pushScope(scope);
      // The loop's own declarations bind before the right-hand side is
      // evaluated: in `let x = [1]; for (let x of x) {}` the right-hand `x`
      // is the loop's `x` in its temporal dead zone, not the outer one — so
      // the bindings are registered first and the right side walked in the
      // loop scope.
      if (node.left?.type === "VariableDeclaration") {
        // The same rule as any declaration: `var` belongs to the nearest
        // function scope and stays visible after the loop; `let` and `const`
        // belong to the loop.
        const target = node.left.kind === "var" ? functionScope(inner) : inner;
        for (const decl of node.left.declarations) {
          registerPattern(decl.id, target, "variable", occurrences, seenDefs);
        }
        for (const decl of node.left.declarations) {
          walkPatternExpressions(decl.id, inner, occurrences, seenDefs);
        }
      } else {
        // `for (x of …)` assigns to an existing binding: the loop head is a
        // reference to it, not a new definition.
        walk(node.left, inner, occurrences, seenDefs, node);
      }
      if (node.right) walk(node.right, inner, occurrences, seenDefs, node);
      if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
      return;
    }
    case "ForStatement": {
      const inner = pushScope(scope);
      if (node.init) walk(node.init, inner, occurrences, seenDefs, node);
      if (node.test) walk(node.test, inner, occurrences, seenDefs, node);
      if (node.update) walk(node.update, inner, occurrences, seenDefs, node);
      if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
      return;
    }
    case "Identifier":
      emitRef(node, parent, scope, occurrences, seenDefs);
      return;
    case "MemberExpression":
      walk(node.object, scope, occurrences, seenDefs, node);
      if (!node.computed && node.property?.type === "Identifier") {
        emitProperty(node.property, node.object?.type === "ThisExpression" ? scope.thisClass : null, occurrences);
      } else {
        walk(node.property, scope, occurrences, seenDefs, node);
      }
      return;
    case "Property":
      if (node.computed) walk(node.key, scope, occurrences, seenDefs, node);
      else if (node.shorthand && node.value?.type === "Identifier") {
        emitRef(node.value, node, scope, occurrences, seenDefs);
      }
      if (!node.shorthand) walk(node.value, scope, occurrences, seenDefs, node);
      return;
    case "LabeledStatement":
      walk(node.body, scope, occurrences, seenDefs, node);
      return;
    default:
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const item of value) walk(item, scope, occurrences, seenDefs, node);
        } else if (value && typeof value === "object" && value.type) {
          walk(value, scope, occurrences, seenDefs, node);
        }
      }
  }
}

/**
 * @param {{ code: string, lang: string }} input
 * @returns {{ occurrences: Array<{ line: number, col: number, endCol: number, name: string, kind: string, isDef: boolean, def: { line: number, col: number } | null }> }}
 */
export function navIndex({ code, lang }) {
  if (typeof code !== "string") throw new TypeError("code must be a string");
  if (typeof lang !== "string" || lang.length === 0) throw new TypeError("lang must be a non-empty string");
  if (!JS_LANGS.has(lang)) return { occurrences: [] };

  const tree = parse(code);
  if (!tree) return { occurrences: [] };

  const occurrences = [];
  walk(tree, pushScope(null, { isFunction: true }), occurrences, new Set());
  return { occurrences };
}
