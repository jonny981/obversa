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
function pushScope(parent, { isFunction = false } = {}) {
  return { parent, defs: new Map(), methods: new Map(), isFunction };
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

function lookupMethod(scope, name) {
  for (let current = scope; current; current = current.parent) {
    const found = current.methods.get(name);
    if (found) return found;
  }
  return null;
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
    }
  }
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

function emitProperty(id, scope, occurrences) {
  const found = lookupMethod(scope, id.name);
  occurrences.push(occurrence(
    id,
    "property",
    found ? { line: found.line, col: found.col } : null,
  ));
}

function walkFunction(node, scope, occurrences, seenDefs, { namedInner = false } = {}) {
  if (namedInner && node.id) {
    registerDef(scope, node.id, "function", occurrences, seenDefs);
  }
  const inner = pushScope(scope, { isFunction: true });
  for (const param of node.params ?? []) {
    registerPattern(param, inner, "parameter", occurrences, seenDefs);
  }
  hoistVars(node.body, inner, occurrences, seenDefs);
  if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
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
      // A class static block owns its `var` like a function does.
      const inner = pushScope(scope, { isFunction: true });
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
      const inner = pushScope(scope);
      if (node.type === "ClassExpression" && node.id) {
        registerDef(inner, node.id, "class", occurrences, seenDefs);
      }
      if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
      return;
    }
    case "ClassBody":
      for (const child of node.body) walk(child, scope, occurrences, seenDefs, node);
      return;
    case "MethodDefinition":
    case "PropertyDefinition": {
      if (node.key?.type === "Identifier" && !node.computed) {
        const def = { line: node.key.loc.start.line, col: node.key.loc.start.column };
        seenDefs.add(node.key.start);
        scope.methods.set(node.key.name, { ...def, kind: "method" });
        occurrences.push(occurrence(node.key, "method", def));
      } else if (node.key) {
        walk(node.key, scope, occurrences, seenDefs, node);
      }
      if (node.value) walk(node.value, scope, occurrences, seenDefs, node);
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
      if (node.init) walk(node.init, scope, occurrences, seenDefs, node);
      return;
    }
    case "ImportDeclaration":
      for (const spec of node.specifiers) {
        if (
          spec.type === "ImportSpecifier"
          || spec.type === "ImportDefaultSpecifier"
          || spec.type === "ImportNamespaceSpecifier"
        ) {
          registerDef(scope, spec.local, "import", occurrences, seenDefs);
        }
      }
      return;
    case "CatchClause": {
      const inner = pushScope(scope);
      registerPattern(node.param, inner, "parameter", occurrences, seenDefs);
      if (node.body) walk(node.body, inner, occurrences, seenDefs, node);
      return;
    }
    case "ForInStatement":
    case "ForOfStatement": {
      const inner = pushScope(scope);
      if (node.right) walk(node.right, scope, occurrences, seenDefs, node);
      if (node.left?.type === "VariableDeclaration") {
        // The same rule as any declaration: `var` belongs to the nearest
        // function scope and stays visible after the loop; `let` and `const`
        // belong to the loop.
        const target = node.left.kind === "var" ? functionScope(inner) : inner;
        for (const decl of node.left.declarations) {
          registerPattern(decl.id, target, "variable", occurrences, seenDefs);
        }
      } else {
        registerPattern(node.left, inner, "variable", occurrences, seenDefs);
      }
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
        emitProperty(node.property, scope, occurrences);
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
